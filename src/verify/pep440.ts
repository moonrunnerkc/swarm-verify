import { compare, explain, type Pep440Version } from "@renovatebot/pep440";

/**
 * PEP 440 versions and specifier sets. Parsing, normalization and ordering are
 * @renovatebot/pep440's (a port of pypa/packaging). Matching is written here from the PEP and
 * packaging's `Specifier`, because the library's own gets exclusive comparisons wrong
 * (`2.0 > 2.0rc1` is false there), pads no short release in a prefix match (`1` is not in
 * `==1.0.*` there), and falls back to prereleases when no final release matches.
 */
export type Pep440 = Pep440Version;

type Operator = "===" | "~=" | "==" | "!=" | "<=" | ">=" | "<" | ">";

export interface Specifier {
  readonly operator: Operator;
  /** The operand as written, without a trailing `.*`. */
  readonly operand: string;
  /** The operand read as a version; null only for an arbitrary `===` operand PEP 440 cannot read. */
  readonly version: Pep440 | null;
  readonly prefix: boolean;
}

/** Clauses that must all hold, as a comma joins them. Empty admits every final release. */
export type SpecifierSet = readonly Specifier[];

export function parsePep440(text: string): Pep440 | null {
  return explain(text.trim());
}

const clause = /^(===|~=|==|!=|<=|>=|<|>)\s*(\S+)$/;

function parseSpecifier(text: string): Specifier | null {
  const match = clause.exec(text.trim());
  if (match === null) return null;
  const operator = match[1] as Operator;
  const written = match[2] ?? "";
  if (operator === "===") {
    return { operator, operand: written, version: explain(written), prefix: false };
  }
  const prefix = written.endsWith(".*");
  const operand = prefix ? written.slice(0, -2) : written;
  const version = explain(operand);
  if (version === null) return null;
  const local = version.local !== null;
  if (prefix) {
    // A prefix names a release only: `==1.2.*`, `!=1!2.*`.
    const releaseOnly = !version.is_prerelease && !version.is_postrelease && !local;
    return (operator === "==" || operator === "!=") && releaseOnly
      ? { operator, operand, version, prefix }
      : null;
  }
  if (local && operator !== "==" && operator !== "!=") return null;
  if (operator === "~=" && version.release.length < 2) return null;
  return { operator, operand, version, prefix };
}

/** A comma-separated PEP 440 specifier set (`>=1.4,<2`, `~=1.4.5`, `==1.2.*`), or null. */
export function parseSpecifierSet(text: string): SpecifierSet | null {
  const specifiers = text.split(",").map(parseSpecifier);
  return specifiers.every((one) => one !== null) ? specifiers : null;
}

/** Whether `candidate`'s release, padded with zeros, begins with `release`, in the same epoch. */
function startsWith(candidate: Pep440, epoch: number, release: readonly number[]): boolean {
  return (
    candidate.epoch === epoch && release.every((part, at) => (candidate.release[at] ?? 0) === part)
  );
}

const sameBase = (one: Pep440, other: Pep440) =>
  compare(one.base_version, other.base_version) === 0;

function holds(spec: Specifier, written: string, candidate: Pep440): boolean {
  const { version } = spec;
  if (spec.operator === "===") return written.toLowerCase() === spec.operand.toLowerCase();
  if (version === null) return false;
  // A candidate's local label is ignored unless the operand has one of its own.
  const against = version.local === null ? candidate.public : written;
  switch (spec.operator) {
    case "~=":
      return (
        compare(candidate.public, spec.operand) >= 0 &&
        startsWith(candidate, version.epoch, version.release.slice(0, -1))
      );
    case "==":
      return spec.prefix
        ? startsWith(candidate, version.epoch, version.release)
        : compare(against, spec.operand) === 0;
    case "!=":
      return spec.prefix
        ? !startsWith(candidate, version.epoch, version.release)
        : compare(against, spec.operand) !== 0;
    case "<=":
      return compare(candidate.public, spec.operand) <= 0;
    case ">=":
      return compare(candidate.public, spec.operand) >= 0;
    case "<":
      // `<V` admits no prerelease of V itself unless V is one.
      return (
        compare(written, spec.operand) < 0 &&
        !(!version.is_prerelease && candidate.is_prerelease && sameBase(candidate, version))
      );
    case ">":
      // `>V` admits no post release or local version of V itself unless V is a post release.
      return (
        compare(written, spec.operand) > 0 &&
        !(!version.is_postrelease && candidate.is_postrelease && sameBase(candidate, version)) &&
        !(candidate.local !== null && sameBase(candidate, version))
      );
  }
}

/** Whether a set names a prerelease, which is what lets it admit one. */
const namesPrerelease = (set: SpecifierSet) =>
  set.some((spec) => spec.operator !== "!=" && spec.version?.is_prerelease === true);

/**
 * Whether the set admits `written`, already read as `candidate`. A prerelease or development
 * release is admitted only by a set that names one, whatever an installer may have chosen.
 */
export function admits(set: SpecifierSet, written: string, candidate: Pep440): boolean {
  if (candidate.is_prerelease && !namesPrerelease(set)) return false;
  return set.every((spec) => holds(spec, written.trim(), candidate));
}

/** PEP 440's order of two versions PEP 440 reads. */
export const comparePep440 = (one: string, other: string) => compare(one.trim(), other.trim());
