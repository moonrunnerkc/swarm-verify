import { parsePep440, parseSpecifierSet, type SpecifierSet } from "./pep440.ts";

/**
 * A PyPI range: alternatives joined by `||`, any of which admits a version. Each alternative is a
 * PEP 440 specifier set (`>=1.4,<2`, `~=1.4.5`, `==1.2.*`, `===1.0`) or one of the forms the
 * request has always accepted, defined on PEP 440 versions:
 *
 *   `9`, `9.x`, `9.*`       `==9.*`
 *   `9.6`, `9.6.x`          `==9.6.*`
 *   `*`, `x`                every final release
 *   `1.2.3`, `1.2.3.4`      `==1.2.3`, `==1.2.3.4` (any other PEP 440 version, exactly)
 *   `^9.6.1`, `^0.3.1`      `>=9.6.1,<10`, `>=0.3.1,<0.4` (npm's caret: the first nonzero number)
 *   `~9.6.1`, `~9.6`, `~9`  `>=9.6.1,<9.7`, `>=9.6,<9.7`, `>=9,<10`
 */
export type PypiRange =
  | { readonly sets: readonly SpecifierSet[] }
  /** npm range grammar PEP 440 does not define, kept readable and judged as unverified. */
  | { readonly unsupported: string };

const operator = /^(===|~=|==|!=|<=|>=|<|>)/;
const wildcard = /^[xX*]$/;

/** `release` with the number at `at` raised by one and everything after it dropped. */
const bumped = (release: readonly number[], at: number) =>
  [...release.slice(0, at), (release[at] ?? 0) + 1].join(".");

function bounded(text: string, upperAt: (release: readonly number[]) => number): string | null {
  const version = parsePep440(text);
  if (version === null || version.local !== null) return null;
  const epoch = version.epoch === 0 ? "" : `${version.epoch}!`;
  return `>=${text.trim()},<${epoch}${bumped(version.release, upperAt(version.release))}`;
}

const caret = (release: readonly number[]) => {
  const nonzero = release.findIndex((part) => part !== 0);
  return nonzero === -1 ? release.length - 1 : nonzero;
};

/** One alternative as a PEP 440 specifier set's text, or null when it is none of the forms. */
function specifierText(text: string): string | null {
  if (operator.test(text)) return text;
  if (text.startsWith("^")) return bounded(text.slice(1), caret);
  if (text.startsWith("~"))
    return bounded(text.slice(1), (release) => (release.length > 1 ? 1 : 0));
  if (wildcard.test(text)) return "";
  const parts = text.split(".");
  const numbers = parts.findIndex((part) => !/^\d+$/.test(part));
  const counted = numbers === -1 ? parts.length : numbers;
  const rest = parts.slice(counted);
  if (counted > 0 && rest.length > 0 && rest.every((part) => wildcard.test(part))) {
    return `==${parts.slice(0, counted).join(".")}.*`;
  }
  // npm reads one or two bare numbers as every release they begin, and so does this.
  if (rest.length === 0 && counted <= 2) return `==${text}.*`;
  return parsePep440(text) === null ? null : `==${text}`;
}

/** A PyPI range, or null when it is neither one of its forms nor npm range grammar. */
export function parsePypiRange(text: string, npmReads: boolean): PypiRange | null {
  const sets: SpecifierSet[] = [];
  for (const alternative of text.split("||")) {
    const written = specifierText(alternative.trim());
    const set = written === null ? null : written === "" ? [] : parseSpecifierSet(written);
    if (set === null) {
      if (!npmReads) return null;
      const suggested = text.trim().split(/\s+/).join(",");
      const example = parseSpecifierSet(suggested) === null ? ">=1.4,<2" : suggested;
      return {
        unsupported: `${text} is npm range grammar PEP 440 does not define for a PyPI version; state it as a PEP 440 specifier set, such as ${example}`,
      };
    }
    sets.push(set);
  }
  return { sets };
}
