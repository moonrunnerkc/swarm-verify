import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContainmentError, readContained } from "../fs/contained.ts";
import { keptLockName, type PinnedLocks } from "../verify/generated-lock.ts";
import type { Statement } from "../verify/predicate.ts";
import { defaultReruns } from "../verify/reruns.ts";
import {
  placeSealed,
  type SealedSet,
  sealedFileLogName,
  sealedLogName,
  sealedSchema,
  swarmHome,
} from "../verify/sealed-store.ts";
import { authenticatedStatement, type SignerPolicy } from "./bundle-auth.ts";
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

/**
 * The signed statement and patch of an evidence directory written by `verify`, the envelope
 * authenticated against the caller's signer policy before anything in it is read.
 */
async function readBundle(
  directory: string,
  signer: SignerPolicy,
  signal: AbortSignal | undefined,
): Promise<{ readonly statement: Statement; readonly patch: string }> {
  const { statement } = await authenticatedStatement(
    join(directory, "attestation.sigstore.json"),
    signer,
    signal,
  );
  const patch = join(directory, "change.patch");
  const expected = statement.subject.find((subject) => subject.name === "change.patch")?.digest
    .sha256;
  const bytes = await bundleFile(directory, "change.patch");
  if (expected === undefined || bytes === null || sha256(bytes) !== expected) {
    throw new UnreplayableBundleError("change.patch is not the patch the statement signed");
  }
  return { statement, patch };
}

/** A file of the evidence directory, read without following links; null where it is absent. */
async function bundleFile(directory: string, name: string): Promise<Buffer | null> {
  try {
    return await readContained(directory, name);
  } catch (error) {
    if (error instanceof ContainmentError)
      throw new UnreplayableBundleError(
        `${name} is not a plain file of the bundle: ${error.message}`,
      );
    throw error;
  }
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
    const bytes = await bundleFile(directory, name);
    if (bytes === null || sha256(bytes) !== logged.sha256)
      throw new UnreplayableBundleError(`${name} is not the lock the statement signed`);
    pinned[side] = bytes.toString("utf8");
  }
  return pinned;
}

/** The sealed set the recording judged with, read from the bundle and held to its signed digests. */
async function recordedSealed(
  directory: string,
  recorded: Statement["predicate"],
): Promise<{ readonly sealed: SealedSet; readonly contents: Map<string, string> } | null> {
  const signed = (name: string) => recorded.logs.find((log) => log.name === name)?.sha256;
  const read = async (name: string) => {
    const bytes = await bundleFile(directory, name);
    if (bytes === null || sha256(bytes) !== signed(name))
      throw new UnreplayableBundleError(`${name} is not the sealed file the statement signed`);
    return bytes.toString("utf8");
  };
  if (signed(sealedLogName) === undefined) return null;
  const sealed = sealedSchema.parse(JSON.parse(await read(sealedLogName)));
  const contents = new Map<string, string>();
  for (const file of sealed.files)
    contents.set(file.path, await read(sealedFileLogName(file.path)));
  return { sealed, contents };
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
  allowHost = false,
): ExecutionPolicy {
  const { execution, environment } = recorded;
  if (execution.dependencies.mode === "linked") {
    throw new UnreplayableBundleError(
      "it was verified with linked dependencies (the workspace's installed tree as it stood), which no replay can reproduce; verify it again with dependencies prepared from the lockfile",
    );
  }
  const dependencies = execution.dependencies.mode === "none" ? "none" : "prepare";
  if (execution.mode === "host") {
    // The recording's own setting is not the caller's permission to run its commands here.
    if (!allowHost)
      throw new UnreplayableBundleError(
        "it was verified on the host, and replaying it runs its commands on this host unisolated; authorize that explicitly (--allow-host, or allowHost in the API) to replay it",
      );
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
    readonly allowHost?: boolean;
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
      behaviorAsked: one.behaviorAsked,
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
      execution: replayExecution(recorded, input.platform, input.allowHost === true),
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
    /** Who the caller trusts to have signed the bundle; checked before anything in it is used. */
    readonly signer: SignerPolicy;
    /** The caller's permission to run a host recording's commands on this host. */
    readonly allowHost?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<Replay> {
  const { statement, patch } = await readBundle(bundle, options.signer, options.signal);
  const recorded = statement.predicate;
  const request = replayRequest(recorded, {
    repository: options.repository,
    patch: { path: patch, sha256: sha256(await readFile(patch)) },
    out: options.out,
    allowHost: options.allowHost === true,
  });
  // The recording's sealed set, placed for this checkout under a home of the replay's own: the
  // sealed store is keyed by checkout, and the recording may have sealed for another one.
  const sealed = await recordedSealed(bundle, recorded);
  const home = resolve(options.swarmHome ?? swarmHome());
  const own = sealed === null ? null : await mkdtemp(join(home, "replay-"));
  try {
    if (sealed !== null && own !== null)
      await placeSealed(resolve(options.repository), own, sealed.sealed, sealed.contents);
    const replayed = await verify(request, {
      verifierVersion: options.verifierVersion,
      freshBase: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      pinnedLocks: await keptLocks(bundle, recorded),
      ...(own !== null
        ? { swarmHome: own }
        : options.swarmHome === undefined
          ? {}
          : { swarmHome: options.swarmHome }),
    });
    return { recorded, replayed, divergences: divergencesOf(recorded, replayed) };
  } finally {
    if (own !== null) await rm(own, { recursive: true, force: true });
  }
}
