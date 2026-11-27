import { conventionSites, type Site } from "./measure-sites.ts";
import {
  type ConventionRule,
  type ConventionSet,
  conventionRules,
  conventionValues,
} from "./rules.ts";

export { conventionSources, type SourceText } from "./measure-sites.ts";

import type { SourceText } from "./measure-sites.ts";

export interface Tally {
  readonly rule: ConventionRule;
  readonly sites: number;
  readonly counts: Readonly<Record<string, number>>;
}

/** A file is one site of explicit-any however many times it says `any`. */
function tallied(rule: ConventionRule, sites: readonly Site[]): readonly Site[] {
  const own = sites.filter((site) => site.rule === rule);
  if (rule !== "explicit-any") return own;
  return own.filter((site, at) => own.findIndex((other) => other.path === site.path) === at);
}

/** For each rule, how many sites there were and how many conform to each of its values. */
export function measureConventions(files: readonly SourceText[]): Tally[] {
  const sites = conventionSites(files);
  return conventionRules.map((rule) => {
    const own = tallied(rule, sites);
    const counts: Record<string, number> = {};
    for (const value of conventionValues[rule])
      counts[value] = own.filter((site) => site.conforms.includes(value)).length;
    return { rule, sites: own.length, counts };
  });
}

export interface Violation {
  readonly rule: ConventionRule;
  readonly expected: string;
  readonly path: string;
  readonly line: number;
  readonly found: string;
}

/**
 * Every site that does not conform to the value the set gives its rule. Rules the set leaves
 * out are not checked.
 */
export function conventionViolations(
  set: ConventionSet,
  files: readonly SourceText[],
): Violation[] {
  return conventionSites(files).flatMap((site) => {
    const expected = set[site.rule];
    if (expected === undefined || site.conforms.includes(expected)) return [];
    return [{ rule: site.rule, expected, path: site.path, line: site.line, found: site.found }];
  });
}
