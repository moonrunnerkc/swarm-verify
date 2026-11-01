import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";

type StructureClaim = Requirement["evidence"]["structure"][number];
type PackageClaim = Requirement["evidence"]["packages"][number];

/** A structural claim read from the candidate tree: a file exists, holds a text, or is gone. */
export async function structureEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  const read = await readFile(join(dir, claim.path), "utf8").then(
    (text) => ({ text, problem: null }),
    (error: NodeJS.ErrnoException) => ({ text: null, problem: error.code ?? "unreadable" }),
  );
  const text = read.text;
  const holds =
    claim.absent === true
      ? text === null
      : text !== null && (claim.contains === undefined || text.includes(claim.contains));
  const what =
    claim.absent === true ? "absent" : claim.contains === undefined ? "exists" : "contains";
  // Where it does not hold, why: what a producer needs to fix the claim or the change.
  const why =
    claim.absent === true
      ? "the path is still there"
      : read.problem === "EISDIR"
        ? `${claim.path} is a directory, not a file`
        : text === null
          ? `no file at ${claim.path}`
          : "the file does not contain it";
  return {
    kind: "structure",
    ref:
      claim.contains === undefined
        ? claim.path
        : `${claim.path} contains ${JSON.stringify(claim.contains)}`,
    authority: "pre-existing",
    outcome: holds ? "observed" : "not observed",
    detail: holds ? `expected ${what}` : why,
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

/** Outcomes that show behavior: a test or check failing before and passing after. */
export const witnessing = new Set(["fixed", "witness", "superseded"]);
export const holding = new Set([
  ...witnessing,
  "preserved",
  "pass",
  "observed",
  "passes before and after",
]);
export const failing = new Set(["failing", "fail"]);

/** A test outcome as evidence: what it shows, from its classification and its witness run. */
export function testRef(outcome: TestOutcome): EvidenceRef {
  const authority = outcome.origin === "pre-existing" ? "pre-existing" : "implementation-authored";
  const ref = outcome.id;
  switch (outcome.classification) {
    case "fixed":
      return { kind: "test", ref, authority, outcome: "fixed" };
    case "superseded":
      return {
        kind: "test",
        ref,
        authority,
        outcome: "superseded",
        detail: "authorized behavior change",
      };
    case "preserved":
    case "renamed":
      return { kind: "test", ref: outcome.movedTo ?? ref, authority, outcome: "preserved" };
    case "added":
      return outcome.before !== null && outcome.before !== "pass"
        ? {
            kind: "test",
            ref,
            authority,
            outcome: "witness",
            detail: "fails against the base's source",
          }
        : {
            kind: "test",
            ref,
            authority,
            outcome: "passes before and after",
            detail:
              outcome.before === null
                ? "no run against the base's source"
                : "passes against the base's source too",
          };
    case "skipped":
      return { kind: "test", ref, authority, outcome: "not observed", detail: "skipped" };
    default:
      return { kind: "test", ref, authority, outcome: "failing", detail: outcome.classification };
  }
}
