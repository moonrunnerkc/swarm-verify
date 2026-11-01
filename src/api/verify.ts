import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ZodError } from "zod";
import { commitOf, git, type ResolvedChange, resolveChange } from "../verify/change.ts";
import { writeAttestation } from "../verify/dsse.ts";
import type { Registries } from "../verify/latest-version.ts";
import { resolveSigningKey } from "../verify/signing.ts";
import { verifyChange } from "../verify/verify.ts";
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

export interface VerifyCallOptions {
  readonly signal?: AbortSignal;
  /** Sign keylessly through cosign and Sigstore instead of with a resolved key. */
  readonly sigstore?: boolean;
  /** Where baselines and sealed checks live; SWARM_HOME or ~/.swarm by default. */
  readonly swarmHome?: string;
  /** Measure the base again rather than reuse a cached run of it, as a replay must. */
  readonly freshBase?: boolean;
  readonly verifierVersion: string;
  /** Where a version constraint's latest is looked up; the public npm and PyPI registries otherwise. */
  readonly registries?: Registries;
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
    policy: request.policy.execution,
    behaviorChange: request.policy.behaviorChange,
    reruns: request.policy.reruns,
    producer: request.producer,
    version: options.verifierVersion,
    ...(options.swarmHome === undefined ? {} : { swarmHome: options.swarmHome }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.freshBase === true ? { freshBase: true } : {}),
    ...(options.registries === undefined ? {} : { registries: options.registries }),
  });
  const directory = resolve(request.artifacts.directory);
  const problems: string[] = [];
  let written: Awaited<ReturnType<typeof writeAttestation>> | null = null;
  try {
    written = await writeAttestation(outcome.statement, outcome.patch, directory, {
      sigstore: options.sigstore === true,
      resolveKey: () => resolveSigningKey(),
    });
    if (written.notice !== null) problems.push(written.notice);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  for (const log of outcome.logs) {
    await mkdir(dirname(join(directory, log.name)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, log.name), log.text, { mode: 0o600 });
  }
  const statementText = `${JSON.stringify(outcome.statement, null, 2)}\n`;
  const statementPath = join(directory, "statement.json");
  await writeFile(statementPath, statementText, { mode: 0o600 });
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
      problems,
    },
    evidence: {
      directory,
      bundle: written?.bundle ?? null,
      statement: statementPath,
      patch: written?.patch ?? null,
      publicKey: written?.publicKey ?? null,
    },
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
