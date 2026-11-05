import semver from "semver";

/**
 * A version range as npm reads one, by npm's own parser (semver): an exact version, `9`, `9.x`,
 * `^9.6.1`, `~9.6`, `>=1.2 <2`, `1.2.3 - 1.4`, `^1 || ^2`. A range semver cannot read is refused
 * when the request is parsed, not guessed at.
 */
export interface VersionRange {
  readonly text: string;
  readonly range: semver.Range;
}

export function parseVersionRange(text: string): VersionRange | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || semver.validRange(trimmed) === null) return null;
  return { text: trimmed, range: new semver.Range(trimmed) };
}

/**
 * A resolved version as semver reads it: npm's own, or a plain numeric release (`2024.1`,
 * PyPI's form) padded to three numbers. A prerelease, or anything else, is never a release a
 * range admits.
 */
function releaseOf(version: string): semver.SemVer | null {
  const bare = version.trim().replace(/^v/, "");
  const parsed = semver.parse(bare);
  if (parsed !== null) return parsed.prerelease.length === 0 ? parsed : null;
  // PyPI's releases may have more than three numbers; a range speaks of the first three.
  const numeric = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)*$/.exec(bare);
  if (numeric === null) return null;
  return semver.parse(
    `${Number(numeric[1])}.${Number(numeric[2] ?? 0)}.${Number(numeric[3] ?? 0)}`,
  );
}

export function satisfies(version: string, range: VersionRange): boolean {
  const release = releaseOf(version);
  return release !== null && range.range.test(release);
}

/** The highest release among `versions` the range admits, or null when it admits none. */
export function highestWithin(versions: readonly string[], range: VersionRange): string | null {
  let best: { readonly version: string; readonly release: semver.SemVer } | null = null;
  for (const version of versions) {
    const release = releaseOf(version);
    if (release === null || !range.range.test(release)) continue;
    if (best === null || semver.gt(release, best.release)) best = { version, release };
  }
  return best?.version ?? null;
}
