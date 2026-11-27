import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ZodError } from "zod";
import { commitOf, git, type ResolvedChange, resolveChange } from "../verify/change.ts";
import type { PinnedLocks } from "../verify/generated-lock.ts";
import type { LatestTarget, Registries } from "../verify/latest-version.ts";
import { resolveSigningKey } from "../verify/signing.ts";
import { verifyChange } from "../verify/verify.ts";
import { publishEvidence } from "./publish.ts";
import { type VerifyRequest, type VerifyRequestInput, verifyRequestSchema } from "./request.ts";
import { resultVersion, type VerifyResult, verifyResultSchema } from "./result.ts";

export class InvalidRequestError extends Error {
  constructor(detail: string) {
    super(`the verification request is not valid: ${detail}`);
    this.name = "InvalidRequestError";
  }
}

export class CandidateChangedError extends Error {
  constructor(path: string, expected: string, found: string) {
    super(
      `the candidate patch ${path} has sha256 ${found}, not the ${expected} the request names; snapshot it again`,
    );
    this.name = "CandidateChangedError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("the verification was cancelled before it finished, so no evidence was published");
    this.name = "RunCancelledError";
  }
}

export interface VerifyCallOptions {
  readonly signal?: AbortSignal;
  /** Sign keylessly through cosign and Sigstore instead of with a resolved key. */
  readonly sigstore?: boolean;
  /** Whether a run that could not be signed is delivered as failed (the default) or unsigned. */
  readonly signing?: "required" | "optional";
  /** Where baselines and sealed checks live; SWARM_HOME or ~/.swarm by default. */
  readonly swarmHome?: string;
  /** Measure the base again rather than reuse a cached run of it, as a replay must. */
  readonly freshBase?: boolean;
  readonly verifierVersion: string;
  /** Where a version constraint's latest is looked up; the public npm and PyPI registries otherwise. */
  readonly registries?: Registries;
  /** The uv.lock a recording generated for each side, which a replay installs from. */
  readonly pinnedLocks?: PinnedLocks;
  /** The registry answers a recording judged "latest" by, used instead of the registry's now. */
  readonly recordedLatest?: ReadonlyMap<string, LatestTarget>;
}

export function parseRequest(input: VerifyRequestInput): VerifyRequest {
  try {
    return verifyRequestSchema.parse(input);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issue = error.issues[0];
    throw new InvalidRequestError(`${issue?.path.join(".") || "request"}: ${issue?.message ?? ""}`);
  }
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The candidate's exact bytes, refused when they are not the ones the request identifies. */
async function candidateOf(request: VerifyRequest): Promise<ResolvedChange> {
  const repository = resolve(request.repository);
  const baseCommit = await commitOf(repository, request.base.commit);
  const candidate = request.candidate;
  if (candidate.kind === "commit") {
    const head = await commitOf(repository, candidate.commit);
    const patch = await git(repository, [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--no-textconv",
      baseCommit,
      head,
      "--",
      ".",
      ":(exclude).swarm",
    ]);
    return { source: "commit", baseCommit, patch };
  }
  const patch = await readFile(candidate.path);
  const found = sha256(patch);
  if (found !== candidate.sha256)
    throw new CandidateChangedError(candidate.path, candidate.sha256, found);
  return { source: "patch", baseCommit, patch };
}

/**
 * Verifies one immutable candidate against its base under the request's policy, writes the
 * signed statement and the patch into the request's artifact directory, and returns the result.
 */
export async function verify(
  input: VerifyRequestInput,
  options: VerifyCallOptions,
): Promise<VerifyResult> {
  const request = parseRequest(input);
  const change = await candidateOf(request);
  const outcome = await verifyChange({
    workspace: resolve(request.repository),
    change,
    requirements: request.requirements,
    trustedChecks: request.checks,
    behavior: request.behavior,
    policy: request.policy.execution,
    behaviorChange: request.policy.behaviorChange,
    reruns: request.policy.reruns,
    producer: request.producer,
    version: options.verifierVersion,
    ...(options.swarmHome === undefined ? {} : { swarmHome: options.swarmHome }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.freshBase === true ? { freshBase: true } : {}),
    ...(options.registries === undefined ? {} : { registries: options.registries }),
    ...(options.pinnedLocks === undefined ? {} : { pinnedLocks: options.pinnedLocks }),
    ...(options.recordedLatest === undefined ? {} : { recordedLatest: options.recordedLatest }),
  });
  // A cancelled run measured nothing it can stand behind: its checks were refused, not failed.
  if (options.signal?.aborted === true) throw new RunCancelledError();
  const directory = resolve(request.artifacts.directory);
  const delivery = await publishEvidence({
    directory,
    statement: outcome.statement,
    patch: outcome.patch,
    logs: outcome.logs,
    sigstore: options.sigstore === true,
    signing: options.signing ?? "required",
    resolveKey: () => resolveSigningKey(),
  });
  const written = delivery.attestation;
  const subjects = outcome.statement.subject;
  const digestOf = (name: string) =>
    subjects.find((subject) => subject.name === name)?.digest.sha256 ?? sha256("");
  return verifyResultSchema.parse({
    version: resultVersion,
    ...outcome.statement.predicate,
    snapshot: {
      base: change.baseCommit,
      patchSha256: digestOf("change.patch"),
      treeSha256: digestOf("tree"),
    },
    integrity: {
      signed: written !== null,
      signer:
        written === null
          ? null
          : {
              kind: options.sigstore === true ? "sigstore" : "key",
              fingerprint: written.fingerprint,
            },
      statementSha256: sha256(JSON.stringify(outcome.statement)),
      problems: [...delivery.problems],
    },
    evidence: {
      directory,
      runId: delivery.runId,
      manifest: delivery.manifest,
      bundle: written?.bundle ?? null,
      statement: delivery.statement,
      patch: delivery.directory === null ? null : join(delivery.directory, "change.patch"),
      publicKey: written?.publicKey ?? null,
    },
    delivery: { status: delivery.status, problems: [...delivery.problems] },
    failureOutput: outcome.failureText.slice(-20_000),
  });
}

/**
 * The working tree of `repository` against `base` as one patch file, untracked files included,
 * written to `path` without touching the repository's index. The returned digest is the
 * candidate identity a request names.
 */
export async function snapshotWorkingTree(
  repository: string,
  base: string,
  path: string,
): Promise<{ readonly path: string; readonly sha256: string; readonly baseCommit: string }> {
  const change = await resolveChange(resolve(repository), { kind: "working-tree", base });
  await writeFile(path, change.patch, { mode: 0o600 });
  return { path, sha256: sha256(change.patch), baseCommit: change.baseCommit };
}
