import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement, VersionConstraint } from "../api/request.ts";
import { readCandidateText } from "./candidate-read.ts";
import type { TestOutcome } from "./compare.ts";
import type { LatestTarget } from "./latest-version.ts";
import { listed, type Reader, resolvedVersions } from "./lock-resolutions.ts";
import { unresolvedClaim } from "./structure-claims.ts";
import {
  type Ecosystem,
  type Placement,
  parseVersionRange,
  place,
  sameVersion,
} from "./version-range.ts";

type PackageClaim = Requirement["evidence"]["packages"][number];

export { structureEvidence } from "./structure-claims.ts";

/**
 * Each version against a range: those outside it, and the first reason one cannot be judged. A
 * claim that reads as no range holds nothing, so every version is outside it.
 */
function placed(versions: readonly string[], range: string, ecosystem: Ecosystem) {
  const parsed = parseVersionRange(range, ecosystem);
  const placements: Placement[] = versions.map((version) =>
    parsed === null ? "outside" : place(version, parsed),
  );
  const unjudged = placements.find((one) => typeof one === "object");
  return {
    outside: versions.filter((_, at) => placements[at] === "outside"),
    unjudged: typeof unjudged === "object" ? unjudged.unjudged : null,
  };
}

/** Thrown where a candidate lockfile is there and was not read: never taken for its absence. */
export class UnreadLockfileError extends Error {
  constructor(detail: string) {
    super(`${detail}; replace it with a regular file in the checkout`);
    this.name = "UnreadLockfileError";
  }
}

/** A reader of the candidate tree that refuses links and paths outside it, null only when absent. */
const candidateReader =
  (dir: string): Reader =>
  async (path) => {
    const read = await readCandidateText(dir, path);
    if (read.kind === "absent") return null;
    if (read.kind === "file") return read.text;
    throw new UnreadLockfileError(read.detail);
  };

/** Every version the candidate's lockfile resolves, or why its lockfile was not read. */
async function candidateVersions(
  dir: string,
  claim: { readonly name: string; readonly ecosystem: Ecosystem },
): Promise<{ readonly versions: string[] } | { readonly unread: string }> {
  try {
    return { versions: await resolvedVersions(candidateReader(dir), claim) };
  } catch (error) {
    // A parse error's message can quote the file; only the containment refusal is named.
    if (error instanceof UnreadLockfileError) return { unread: error.message };
    return { unread: "the candidate's lockfile does not parse" };
  }
}

/** How a detail says which of several resolutions fall outside a range. */
const outsideOf = (all: readonly string[], outside: readonly string[], range: string) =>
  all.length === 1 ? `outside ${range}` : `${listed(outside)} outside ${range}`;

/**
 * An upgrade's resolved versions: observed when the candidate's lockfile resolves the package,
 * every time it does, to the named version (or any version, when none is named) and that differs
 * from the base's.
 */
export async function packageEvidence(
  readBase: Reader,
  dir: string,
  claim: PackageClaim,
): Promise<EvidenceRef> {
  const evidence = (outcome: string, detail: string): EvidenceRef => ({
    kind: "package",
    ref: `${claim.ecosystem}:${claim.name}`,
    authority: claim.authority ?? "user-acceptance",
    outcome,
    detail,
  });
  const candidate = await candidateVersions(dir, claim);
  if ("unread" in candidate) return evidence(unresolvedClaim, candidate.unread);
  const before = await resolvedVersions(readBase, claim);
  const after = candidate.versions;
  const judged = claim.version === undefined ? null : placed(after, claim.version, claim.ecosystem);
  const moved = [...before].sort().join() !== [...after].sort().join();
  const detail = `resolved ${listed(before)} at the base and ${listed(after)} in the candidate`;
  // A version outside the claim is the candidate contradicting the requirement: a failure.
  if (judged !== null && claim.version !== undefined && judged.outside.length > 0) {
    return evidence("fail", `${detail}, ${outsideOf(after, judged.outside, claim.version)}`);
  }
  if (judged?.unjudged) return evidence("not observed", `${detail}; ${judged.unjudged}`);
  return evidence(after.length > 0 && moved ? "observed" : "not observed", detail);
}

/**
 * A version the task's wording constrains, against the candidate's lockfile, which must resolve
 * the package within the range every time it resolves it. Within the range holds; with the latest
 * asked for, only the registry's latest within the range holds, and a latest that could not be
 * read leaves it unobserved, as does a version that cannot be judged. Anything else is a
 * failure: the candidate resolves a version the user's words rule out, whatever the model claimed.
 */
export async function constraintEvidence(
  dir: string,
  constraint: VersionConstraint,
  latest: LatestTarget | undefined,
): Promise<EvidenceRef> {
  const candidate = await candidateVersions(dir, constraint);
  const ref = `${constraint.ecosystem}:${constraint.name} within ${constraint.latest ? "the latest " : ""}${constraint.range}`;
  const from = `from the task's wording "${constraint.wording}"`;
  const result = (outcome: string, detail: string): EvidenceRef => ({
    kind: "package",
    ref,
    authority: "user-acceptance",
    outcome,
    detail: `${detail}; ${from}`,
  });
  if ("unread" in candidate) return result(unresolvedClaim, candidate.unread);
  const installed = candidate.versions;
  if (installed.length === 0) {
    return result("not observed", "the candidate's lockfile does not resolve it");
  }
  const resolves = `the candidate resolves ${listed(installed)}`;
  const looked = constraint.latest ? `; ${latest?.detail ?? "the latest was not looked up"}` : "";
  const { outside, unjudged } = placed(installed, constraint.range, constraint.ecosystem);
  if (outside.length > 0) {
    return result(
      "fail",
      `${resolves}, ${outsideOf(installed, outside, constraint.range)}${looked}`,
    );
  }
  if (unjudged !== null) return result("not observed", `${resolves}; ${unjudged}`);
  if (!constraint.latest) return result("observed", resolves);
  if (latest?.version === undefined || latest.version === null) {
    return result("not observed", `${resolves}${looked}`);
  }
  const target = latest.version;
  const behind = installed.filter((one) => !sameVersion(one, target, constraint.ecosystem));
  if (behind.length === 0) return result("observed", `${resolves}; ${latest.detail}`);
  const which = installed.length === 1 ? resolves : `${resolves}, ${listed(behind)}`;
  return result("fail", `${which}, not ${target}; ${latest.detail}`);
}

/** Whether a package ref is a version constraint read from the task's wording, not a claim. */
export const isConstraint = (ref: EvidenceRef) =>
  ref.kind === "package" && ref.ref.includes(" within ");

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
  const authority =
    outcome.authority ??
    (outcome.origin === "pre-existing" ? "pre-existing" : "implementation-authored");
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
      return {
        kind: "test",
        ref,
        authority,
        outcome: "not observed",
        detail: outcome.unobserved ?? "skipped",
      };
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
