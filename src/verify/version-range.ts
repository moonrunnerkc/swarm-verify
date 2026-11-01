/**
 * The version ranges a task's wording names: three numbers for that version alone, a major or
 * major.minor with or without x, a caret, a tilde. Anything else is not read as a range, so a
 * constraint the verifier cannot judge is refused when the request is parsed, not guessed at.
 */
export interface VersionRange {
  readonly text: string;
  /** Exactly this release, or from `low` (inclusive) to `high` (exclusive). */
  readonly exact: readonly number[] | null;
  readonly low: readonly number[];
  readonly high: readonly number[];
}

const numbers = (text: string) => text.split(".").map(Number);

/** The release numbers of a version, or null for a prerelease or anything not numeric. */
function releaseOf(version: string): number[] | null {
  const bare = version.replace(/^v/, "");
  return /^\d+(?:\.\d+)*$/.test(bare) ? numbers(bare) : null;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseVersionRange(text: string): VersionRange | null {
  const trimmed = text.trim();
  const exact = /^[v=]?(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (exact?.[1] !== undefined) {
    const release = numbers(exact[1]);
    return { text: trimmed, exact: release, low: release, high: release };
  }
  const shaped = /^([\^~]?)v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(trimmed);
  if (shaped === null) return null;
  const [, operator = "", majorText = "", minorText, patchText] = shaped;
  const wild = (part: string | undefined) => part === undefined || /^[xX*]$/.test(part);
  // A number after a wildcard (9.x.1) says nothing a reader could rely on.
  if (wild(minorText) && !wild(patchText)) return null;
  const major = Number(majorText);
  const minor = wild(minorText) ? null : Number(minorText);
  const patch = wild(patchText) ? null : Number(patchText);
  const nextMajor = [major + 1, 0, 0];
  const nextMinor = [major, (minor ?? 0) + 1, 0];
  // A caret allows what npm calls compatible: below the first nonzero number's next value.
  const high =
    operator !== "^"
      ? minor === null
        ? nextMajor
        : nextMinor
      : major > 0 || minor === null
        ? nextMajor
        : minor > 0 || patch === null
          ? nextMinor
          : [0, 0, patch + 1];
  return { text: trimmed, exact: null, low: [major, minor ?? 0, patch ?? 0], high };
}

export function satisfies(version: string, range: VersionRange): boolean {
  const release = releaseOf(version);
  if (release === null) return false;
  if (range.exact !== null) return compare(release, range.exact) === 0;
  return compare(release, range.low) >= 0 && compare(release, range.high) < 0;
}

/** The highest release among `versions` the range admits, or null when it admits none. */
export function highestWithin(versions: readonly string[], range: VersionRange): string | null {
  let best: { readonly version: string; readonly release: number[] } | null = null;
  for (const version of versions) {
    const release = releaseOf(version);
    if (release === null || !satisfies(version, range)) continue;
    if (best === null || compare(release, best.release) > 0) best = { version, release };
  }
  return best?.version ?? null;
}
