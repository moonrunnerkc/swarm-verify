import semver from "semver";
import { admits, comparePep440, parsePep440 } from "./pep440.ts";
import { type PypiRange, parsePypiRange } from "./pypi-range.ts";

export type Ecosystem = "npm" | "pypi";

/**
 * A version range in its ecosystem's own terms. npm's is read by npm's own parser (semver): an
 * exact version, `9`, `9.x`, `^9.6.1`, `~9.6`, `>=1.2 <2`, `1.2.3 - 1.4`, `^1 || ^2`. PyPI's is
 * read by PEP 440 (see `parsePypiRange`). A range neither reads is refused when the request is
 * parsed, not guessed at.
 */
export type VersionRange =
  | { readonly ecosystem: "npm"; readonly text: string; readonly range: semver.Range }
  | { readonly ecosystem: "pypi"; readonly text: string; readonly range: PypiRange };

export function parseVersionRange(text: string, ecosystem: Ecosystem): VersionRange | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const npmReads = semver.validRange(trimmed) !== null;
  if (ecosystem === "npm") {
    return npmReads ? { ecosystem, text: trimmed, range: new semver.Range(trimmed) } : null;
  }
  const range = parsePypiRange(trimmed, npmReads);
  return range === null ? null : { ecosystem, text: trimmed, range };
}

/** Where a resolved version stands against a range, or why it cannot be said. */
export type Placement = "within" | "outside" | { readonly unjudged: string };

/** The reason no version can be judged against `range`, or null when one can. */
export const unjudgeable = (range: VersionRange): string | null =>
  range.ecosystem === "pypi" && "unsupported" in range.range ? range.range.unsupported : null;

export function place(version: string, range: VersionRange): Placement {
  if (range.ecosystem === "npm") {
    const release = semver.parse(version.trim());
    if (release === null) {
      return { unjudged: `${version} is not a version npm's semver reads` };
    }
    return range.range.test(release) ? "within" : "outside";
  }
  if ("unsupported" in range.range) return { unjudged: range.range.unsupported };
  const candidate = parsePep440(version);
  if (candidate === null) {
    return {
      unjudged: `${version} is not a PEP 440 version, so it cannot be judged within ${range.text}: resolve a release PEP 440 reads, or judge it by a check`,
    };
  }
  return range.range.sets.some((set) => admits(set, version, candidate)) ? "within" : "outside";
}

/** The highest release among `versions` the range admits, or null when it admits none. */
export function highestWithin(versions: readonly string[], range: VersionRange): string | null {
  const admitted = versions.filter((version) => place(version, range) === "within");
  const order =
    range.ecosystem === "npm"
      ? (one: string, other: string) => semver.compare(one.trim(), other.trim())
      : comparePep440;
  return admitted.reduce<string | null>(
    (best, version) => (best === null || order(version, best) > 0 ? version : best),
    null,
  );
}

/** Whether two resolved versions are the same release, as their ecosystem compares them. */
export function sameVersion(one: string, other: string, ecosystem: Ecosystem): boolean {
  if (ecosystem === "npm") return one === other;
  return (
    parsePep440(one) !== null && parsePep440(other) !== null && comparePep440(one, other) === 0
  );
}
