import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envelopeOf } from "../verify/dsse.ts";
import { keptLockName, type PinnedLocks } from "../verify/generated-lock.ts";
import { type Statement, statementSchema } from "../verify/predicate.ts";
import { defaultReruns } from "../verify/reruns.ts";
import { divergencesOf } from "./divergences.ts";
import { type ExecutionPolicy, requestVersion, type VerifyRequestInput } from "./request.ts";
import type { VerifyResult } from "./result.ts";
import { verify } from "./verify.ts";

export interface Replay {
  readonly recorded: Statement["predicate"];
  readonly replayed: VerifyResult;
  /** What the replay found different, one line each; empty where it agrees. */
  readonly divergences: readonly string[];
}

export class UnreplayableBundleError extends Error {
  constructor(detail: string) {
    super(`the bundle cannot be replayed: ${detail}`);
    this.name = "UnreplayableBundleError";
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The signed statement and patch of an evidence directory written by `verify`. */
async function readBundle(
  directory: string,
): Promise<{ readonly statement: Statement; readonly patch: string }> {
  const document = JSON.parse(await readFile(join(directory, "attestation.sigstore.json"), "utf8"));
  const envelope = envelopeOf(document);
  if (envelope === null)
    throw new UnreplayableBundleError("attestation.sigstore.json holds no DSSE envelope");
  const statement = statementSchema.parse(
    JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
  );
  const patch = join(directory, "change.patch");
  const expected = statement.subject.find((subject) => subject.name === "change.patch")?.digest
    .sha256;
  if (expected === undefined || sha256(await readFile(patch)) !== expected) {
    throw new UnreplayableBundleError("change.patch is not the patch the statement signed");
  }
  return { statement, patch };
}

/** The uv.lock each side's preparation generated, read from the bundle and held to its signed digest. */
async function keptLocks(
  directory: string,
  recorded: Statement["predicate"],
): Promise<PinnedLocks> {
  const pinned: { base?: string; candidate?: string } = {};
  for (const side of ["base", "candidate"] as const) {
    const name = keptLockName(side);
    const logged = recorded.logs.find((log) => log.name === name);
    if (logged === undefined) continue;
    const bytes = await readFile(join(directory, name)).catch(() => null);
    if (bytes === null || sha256(bytes) !== logged.sha256)
      throw new UnreplayableBundleError(`${name} is not the lock the statement signed`);
    pinned[side] = bytes.toString("utf8");
  }
  return pinned;
}

/** This machine as a host recording names it: `darwin-arm64`, `linux-x64`. */
export const hostPlatform = () => `${process.platform}-${process.arch}`;

/**
 * The execution the recording ran under, again. A host recording runs on the host, which must be
 * the platform it was recorded on; an isolated one in a container from the recorded image. Either
 * prepares its dependencies fresh as the recording did, and a recording on linked dependencies is
 * refused: the caller's installed tree as it stood then is gone.
 */
export function replayExecution(
  recorded: Statement["predicate"],
  platform: string = hostPlatform(),
): ExecutionPolicy {
  const { execution, environment } = recorded;
  if (execution.dependencies.mode === "linked") {
    throw new UnreplayableBundleError(
      "it was verified with linked dependencies (the workspace's installed tree as it stood), which no replay can reproduce; verify it again with dependencies prepared from the lockfile",
    );
  }
  const dependencies = execution.dependencies.mode === "none" ? "none" : "prepare";
  if (execution.mode === "host") {
    if (environment.platform !== platform) {
      throw new UnreplayableBundleError(
        `it was verified on the host on ${environment.platform}, and this host is ${platform}; replay it on ${environment.platform}`,
      );
    }
    return { mode: "host", network: execution.network, dependencies };
  }
  const image = execution.image?.split(" (")[0];
  return {
    mode: "isolated",
    network: execution.network,
    dependencies,
    ...(image === undefined ? {} : { image }),
  };
}

/** The request the recording answered, for its signed patch and the replay's evidence directory. */
export function replayRequest(
  recorded: Statement["predicate"],
  input: {
    readonly repository: string;
    readonly patch: { readonly path: string; readonly sha256: string };
    readonly out: string;
    readonly platform?: string;
  },
): VerifyRequestInput {
  return {
    version: requestVersion,
    repository: input.repository,
    base: { commit: recorded.base.commit },
    candidate: { kind: "patch", ...input.patch },
    requirements: recorded.requirements.map((one) => ({
      id: one.id,
      text: one.text,
      source: one.source,
      kind: one.kind,
      required: one.required,
      assumptions: one.assumptions,
      evidence: one.expected,
      versions: one.versions,
      testsAsked: one.testsAsked,
    })),
    checks: recorded.checks
      .filter(
        (check) =>
          check.authority === "user-acceptance" || check.authority === "independently-generated",
      )
      .map((check) => ({
        name: check.name,
        command: check.command,
        kind: check.kind,
        authority:
          check.authority === "independently-generated"
            ? ("independently-generated" as const)
            : ("user-acceptance" as const),
      })),
    policy: {
      behaviorChange: recorded.policy.behaviorChange,
      // A recording made before reruns existed is replayed with them: the replay is the check.
      reruns: recorded.policy.reruns ?? defaultReruns,
      execution: replayExecution(recorded, input.platform),
    },
    artifacts: { directory: input.out },
    producer: recorded.producer,
  };
}

/**
 * Runs the recorded verification again: the same base and signed patch, the same requirements
 * and checks, under the recorded execution with dependencies prepared fresh from the lockfiles
 * in the tree, or from the uv.lock the recording resolved and kept, then compares every result
 * with what was recorded.
 */
export async function replay(
  bundle: string,
  options: {
    readonly repository: string;
    readonly out: string;
    readonly verifierVersion: string;
    readonly swarmHome?: string;
  },
): Promise<Replay> {
  const { statement, patch } = await readBundle(bundle);
  const recorded = statement.predicate;
  const request = replayRequest(recorded, {
    repository: options.repository,
    patch: { path: patch, sha256: sha256(await readFile(patch)) },
    out: options.out,
  });
  const replayed = await verify(request, {
    verifierVersion: options.verifierVersion,
    freshBase: true,
    pinnedLocks: await keptLocks(bundle, recorded),
    ...(options.swarmHome === undefined ? {} : { swarmHome: options.swarmHome }),
  });
  return { recorded, replayed, divergences: divergencesOf(recorded, replayed) };
}
