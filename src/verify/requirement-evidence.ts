import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";

type StructureClaim = Requirement["evidence"]["structure"][number];
type PackageClaim = Requirement["evidence"]["packages"][number];

/** A structural claim read from the candidate tree: a file exists, holds a text, or is gone. */
export async function structureEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  const text = await readFile(join(dir, claim.path), "utf8").catch(() => null);
  const holds =
    claim.absent === true
      ? text === null
      : text !== null && (claim.contains === undefined || text.includes(claim.contains));
  const what =
    claim.absent === true ? "absent" : claim.contains === undefined ? "exists" : "contains";
  return {
    kind: "structure",
    ref:
      claim.contains === undefined
        ? claim.path
        : `${claim.path} contains ${JSON.stringify(claim.contains)}`,
    authority: "pre-existing",
    outcome: holds ? "observed" : "not observed",
    detail: `expected ${what}`,
  };
}

type Reader = (path: string) => Promise<string | null>;

/** The version the lockfile `read` returns resolves `name` to, or null. */
export async function resolvedVersion(read: Reader, claim: PackageClaim): Promise<string | null> {
  if (claim.ecosystem === "npm") {
    const text = await read("package-lock.json");
    if (text === null) return null;
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
    return lock.packages?.[`node_modules/${claim.name}`]?.version ?? null;
  }
  const text = await read("uv.lock");
  if (text === null) return null;
  const lock = parseToml(text) as { package?: { name?: string; version?: string }[] };
  const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
  return (
    lock.package?.find((one) => normalized(one.name ?? "") === normalized(claim.name))?.version ??
    null
  );
}

/**
 * An upgrade's resolved version: observed when the candidate's lockfile resolves the package to
 * the named version (or any version, when none is named) and that differs from the base's.
 */
export async function packageEvidence(
  readBase: Reader,
  dir: string,
  claim: PackageClaim,
): Promise<EvidenceRef> {
  const readCandidate = (path: string) => readFile(join(dir, path), "utf8").catch(() => null);
  const before = await resolvedVersion(readBase, claim);
  const after = await resolvedVersion(readCandidate, claim);
  const matches = after !== null && (claim.version === undefined || after === claim.version);
  const moved = after !== before;
  return {
    kind: "package",
    ref: `${claim.ecosystem}:${claim.name}`,
    authority: "pre-existing",
    outcome: matches && moved ? "observed" : "not observed",
    detail: `resolved ${before ?? "nothing"} at the base and ${after ?? "nothing"} in the candidate`,
  };
}
