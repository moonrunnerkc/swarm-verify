import { createHash } from "node:crypto";
import { join } from "node:path";
import { ContainmentError, readContained } from "../fs/contained.ts";
import { keptLockName, type PinnedLocks } from "../verify/generated-lock.ts";
import { type LatestTarget, latestLogName, parseLatestLog } from "../verify/latest-version.ts";
import {
  type Observations,
  observationsLogName,
  parseObservations,
} from "../verify/observations.ts";
import type { Statement } from "../verify/predicate.ts";
import {
  type SealedSet,
  sealedFileLogName,
  sealedLogName,
  sealedSchema,
} from "../verify/sealed-store.ts";
import { authenticatedStatement, type SignerPolicy } from "./bundle-auth.ts";
import type { VerifyResult } from "./result.ts";

export class UnreplayableBundleError extends Error {
  constructor(detail: string) {
    super(`the bundle cannot be replayed: ${detail}`);
    this.name = "UnreplayableBundleError";
  }
}

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The signed statement and patch of an evidence directory written by `verify`, the envelope
 * authenticated against the caller's signer policy before anything in it is read.
 */
export async function readBundle(
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
export async function bundleFile(directory: string, name: string): Promise<Buffer | null> {
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
export async function keptLocks(
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
export async function recordedSealed(
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

/** The complete observation records of the recording and the replay, where both have one. */
export async function observationsOfBoth(
  bundle: string,
  recorded: Statement["predicate"],
  replayed: VerifyResult,
): Promise<{ readonly recorded: Observations; readonly replayed: Observations } | null> {
  const signed = recorded.logs.find((log) => log.name === observationsLogName);
  if (signed === undefined) return null;
  const bytes = await bundleFile(bundle, observationsLogName);
  if (bytes === null || sha256(bytes) !== signed.sha256)
    throw new UnreplayableBundleError(
      `${observationsLogName} is not the record the statement signed`,
    );
  const again =
    replayed.evidence.manifest === null
      ? null
      : await bundleFile(replayed.evidence.directory, observationsLogName);
  if (again === null) return null;
  const before = parseObservations(bytes);
  if (before === null) throw new UnreplayableBundleError(`${observationsLogName} does not parse`);
  const after = parseObservations(again);
  return after === null ? null : { recorded: before, replayed: after };
}

/** The registry answers the recording judged "latest" by, held to their signed digest. */
export async function recordedLatest(
  directory: string,
  recorded: Statement["predicate"],
): Promise<Map<string, LatestTarget> | null> {
  const signed = recorded.logs.find((log) => log.name === latestLogName);
  if (signed === undefined) return null;
  const bytes = await bundleFile(directory, latestLogName);
  if (bytes === null || sha256(bytes) !== signed.sha256)
    throw new UnreplayableBundleError(`${latestLogName} is not the record the statement signed`);
  const parsed = parseLatestLog(bytes);
  if (parsed === null) throw new UnreplayableBundleError(`${latestLogName} does not parse`);
  return parsed;
}
