import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement, VersionConstraint } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { LatestTarget } from "./latest-version.ts";
import { parseVersionRange, satisfies } from "./version-range.ts";

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
export async function resolvedVersion(
  read: Reader,
  claim: Pick<PackageClaim, "name" | "ecosystem">,
): Promise<string | null> {
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
  const matches = after !== null && (claim.version === undefined || within(after, claim.version));
  const moved = after !== before;
  const detail = `resolved ${before ?? "nothing"} at the base and ${after ?? "nothing"} in the candidate`;
  // A version outside the claim is the candidate contradicting the requirement: a failure.
  if (after !== null && claim.version !== undefined && !matches) {
    return {
      kind: "package",
      ref: `${claim.ecosystem}:${claim.name}`,
      authority: "pre-existing",
      outcome: "fail",
      detail: `${detail}, outside ${claim.version}`,
    };
  }
  return {
    kind: "package",
    ref: `${claim.ecosystem}:${claim.name}`,
    authority: "pre-existing",
    outcome: matches && moved ? "observed" : "not observed",
    detail,
  };
}

/**
 * A version the task's wording constrains, against the candidate's lockfile. Within the range
 * holds; with the latest asked for, only the registry's latest within the range holds, and a
 * latest that could not be read leaves it unobserved. Anything else is a failure: the candidate
 * resolves a version the user's words rule out, whatever the model claimed.
 */
export async function constraintEvidence(
  dir: string,
  constraint: VersionConstraint,
  latest: LatestTarget | undefined,
): Promise<EvidenceRef> {
  const readCandidate = (path: string) => readFile(join(dir, path), "utf8").catch(() => null);
  const installed = await resolvedVersion(readCandidate, constraint);
  const ref = `${constraint.ecosystem}:${constraint.name} within ${constraint.latest ? "the latest " : ""}${constraint.range}`;
  const from = `from the task's wording "${constraint.wording}"`;
  const result = (outcome: string, detail: string): EvidenceRef => ({
    kind: "package",
    ref,
    authority: "user-acceptance",
    outcome,
    detail: `${detail}; ${from}`,
  });
  if (installed === null) {
    return result("not observed", "the candidate's lockfile does not resolve it");
  }
  const looked = constraint.latest ? `; ${latest?.detail ?? "the latest was not looked up"}` : "";
  const range = parseVersionRange(constraint.range);
  if (range === null || !satisfies(installed, range)) {
    return result(
      "fail",
      `the candidate resolves ${installed}, outside ${constraint.range}${looked}`,
    );
  }
  if (!constraint.latest) return result("observed", `the candidate resolves ${installed}`);
  if (latest?.version === undefined || latest.version === null) {
    return result("not observed", `the candidate resolves ${installed}${looked}`);
  }
  return installed === latest.version
    ? result("observed", `the candidate resolves ${installed}; ${latest.detail}`)
    : result(
        "fail",
        `the candidate resolves ${installed}, not ${latest.version}; ${latest.detail}`,
      );
}

/** Whether `version` is the claimed one, or within a claim written with x (9.x, 9.6.x, or 9). */
function within(version: string, claim: string): boolean {
  const wanted = claim.split(".");
  const wild = (part: string) => /^[xX*]$/.test(part);
  if (wanted.length >= 3 && !wanted.some(wild)) return version === claim;
  const parts = version.split(".");
  return wanted.every((part, at) => wild(part) || part === parts[at]);
}

/** Outcomes that show behavior: a test or check failing before and passing after. */
export const witnessing = new Set(["fixed", "witness", "superseded"]);
export const holding = new Set([
  ...witnessing,
  "preserved",
  "pass",
  "observed",
  "passes before and after",
  "passes but for inherited failures",
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
    case "flaky":
      // Failed and passed on the same snapshot: it shows neither the fix nor a failure.
      return {
        kind: "test",
        ref,
        authority,
        outcome: "flaky",
        detail: `${outcome.rerun?.snapshot ?? "unknown"}: ${outcome.rerun?.results.join(", ") ?? ""}`,
      };
    default:
      return { kind: "test", ref, authority, outcome: "failing", detail: outcome.classification };
  }
}
