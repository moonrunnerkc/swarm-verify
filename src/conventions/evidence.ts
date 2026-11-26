import type { EvidenceRef } from "../api/outcome.ts";
import { readCandidateText } from "../verify/candidate-read.ts";
import { conventionSources, conventionViolations, type Violation } from "./measure.ts";
import { type ConventionRule, type ConventionSet, conventionRules } from "./rules.ts";

interface ChangedPath {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
}

/** The violations the candidate's version of a file has beyond those its base version had. */
function introduced(base: readonly Violation[], candidate: readonly Violation[]): Violation[] {
  const had = new Map<string, number>();
  for (const one of base) had.set(one.found, (had.get(one.found) ?? 0) + 1);
  const extra = Math.max(0, candidate.length - base.length);
  const fresh = candidate.filter((one) => {
    const left = had.get(one.found) ?? 0;
    if (left > 0) had.set(one.found, left - 1);
    return left === 0;
  });
  return (fresh.length >= extra ? fresh : candidate).slice(0, extra);
}

/**
 * Each convention the requirement names, against the JavaScript and TypeScript files the
 * candidate adds or changes. A rule holds where no such file breaks it more often than its base
 * version did, so code that was already there is not the change's to answer for. A file that
 * could not be read leaves its rules unobserved.
 */
export async function conventionEvidence(
  set: ConventionSet,
  input: {
    readonly dir: string;
    readonly readBase: (path: string) => Promise<string | null>;
    readonly changed: readonly ChangedPath[];
  },
): Promise<EvidenceRef[]> {
  const paths = input.changed.filter(
    (file) => file.status !== "deleted" && conventionSources.test(file.path),
  );
  const added = new Map<ConventionRule, Violation[]>();
  let unread: string | null = null;
  for (const file of paths) {
    const read = await readCandidateText(input.dir, file.path);
    if (read.kind !== "file") {
      unread = `${file.path} could not be read in the candidate`;
      continue;
    }
    const before = file.status === "added" ? null : await input.readBase(file.path);
    const now = conventionViolations(set, [{ path: file.path, text: read.text }]);
    const was =
      before === null ? [] : conventionViolations(set, [{ path: file.path, text: before }]);
    for (const rule of conventionRules) {
      const of = (all: readonly Violation[]) => all.filter((one) => one.rule === rule);
      added.set(rule, [...(added.get(rule) ?? []), ...introduced(of(was), of(now))]);
    }
  }
  return conventionRules.flatMap((rule): EvidenceRef[] => {
    const value = set[rule];
    if (value === undefined) return [];
    const broken = added.get(rule) ?? [];
    const shared = { kind: "convention" as const, ref: `${rule}: ${value}` };
    const authority = "user-acceptance" as const;
    if (broken.length > 0)
      return [
        {
          ...shared,
          authority,
          outcome: "fail",
          detail: broken
            .slice(0, 8)
            .map((one) => `${one.path}:${one.line} ${one.found}`)
            .join("; "),
        },
      ];
    if (unread !== null) return [{ ...shared, authority, outcome: "not observed", detail: unread }];
    return [
      {
        ...shared,
        authority,
        outcome: "observed",
        detail:
          paths.length === 0
            ? "the change touches no JavaScript or TypeScript file"
            : `no new violation in ${paths.length} changed file(s)`,
      },
    ];
  });
}
