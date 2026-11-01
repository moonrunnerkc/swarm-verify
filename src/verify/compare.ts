import type { TestRuns } from "./predicate.ts";
import { livesIn, type TestReport } from "./test-report.ts";

type Status = TestReport[string]["status"];

/** Where a test in the candidate came from, relative to the base. */
export type Origin = "pre-existing" | "candidate-modified" | "implementation-authored";

export type Classification =
  | "preserved"
  | "renamed"
  | "fixed"
  | "new-failure"
  | "inherited"
  | "removed"
  | "superseded"
  | "expectation-changed"
  | "added"
  | "added-failing"
  | "skipped"
  | "flaky";

/** What the candidate did to the base's test files. */
export interface TestFileChanges {
  readonly added: ReadonlySet<string>;
  readonly modified: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
  /** Base path to candidate path, for a file moved with only its imports changed. */
  readonly moved: ReadonlyMap<string, string>;
  /** Modified in place with only its imports changed. */
  readonly relocated: ReadonlySet<string>;
}

/**
 * The runs of one check. obligation: the candidate's source with the base's versions of the test
 * files it modified or deleted, so the original obligations judge the new code. witness: the
 * base's source with the candidate's test files, null where the candidate changed no test file.
 */
export interface CheckRuns {
  readonly base: TestReport;
  readonly obligation: TestReport;
  readonly candidate: TestReport;
  readonly witness: TestReport | null;
}

export interface TestOutcome {
  readonly id: string;
  readonly title: string;
  readonly file: string | null;
  readonly origin: Origin;
  readonly classification: Classification;
  readonly base: Status | null;
  readonly after: Status | null;
  /** The test's status against the base's source, where a witness run measured it. */
  readonly before: Status | null;
  /** The candidate's id for a base test that moved. */
  readonly movedTo: string | null;
  /** Every run of the test where its failing first run was rerun. */
  readonly rerun?: TestRuns;
}

export const titleOf = (id: string) => {
  const at = id.indexOf("::");
  return at < 0 ? id : id.slice(at + 2);
};

function originOf(file: string | null, changes: TestFileChanges): Origin {
  if (file === null) return "pre-existing";
  const within = (paths: Iterable<string>) => [...paths].some((path) => livesIn(file, path));
  if (within(changes.added) || within(changes.moved.values())) return "implementation-authored";
  if (within(changes.modified)) return "candidate-modified";
  return "pre-existing";
}

/** The candidate's test with the same title in `path`, when exactly one has it. */
function counterpart(candidate: TestReport, path: string, title: string): string | null {
  const found = Object.entries(candidate).filter(
    ([id, entry]) => titleOf(id) === title && livesIn(entry.file, path),
  );
  return found.length === 1 ? (found[0]?.[0] ?? null) : null;
}

function beforeAfter(base: Status, after: Status | null): Classification {
  if (after === null) return "new-failure";
  if (base === "pass") return after === "pass" ? "preserved" : "new-failure";
  if (after === "pass") return "fixed";
  return base === "fail" ? "inherited" : after === "fail" ? "new-failure" : "skipped";
}

/**
 * Every test classified test by test. A base test judges the candidate through its original
 * version; a test the candidate rewrote counts only where the task authorized a behavior change
 * and the new version fails against the base's source and passes against the candidate's.
 */
export function compareRuns(
  runs: CheckRuns,
  changes: TestFileChanges,
  behaviorChange: "none" | "authorized",
): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  const claimed = new Set<string>();
  const witnessOf = (id: string) =>
    runs.witness?.[id]?.status ?? (runs.witness === null ? null : "fail");
  for (const [id, entry] of Object.entries(runs.base)) {
    const title = titleOf(id);
    const file = entry.file;
    const moved = [...changes.moved].find(([from]) => livesIn(file, from));
    const relocated = [...changes.relocated].find((path) => livesIn(file, path));
    const shared = { id, title, file, origin: "pre-existing" as const, base: entry.status };
    if (moved !== undefined || relocated !== undefined) {
      const path = moved?.[1] ?? relocated ?? "";
      const other = counterpart(runs.candidate, path, title);
      if (other !== null) claimed.add(other);
      const after = other === null ? null : (runs.candidate[other]?.status ?? null);
      const judged = other === null ? "removed" : beforeAfter(entry.status, after);
      const classification = judged === "preserved" && moved !== undefined ? "renamed" : judged;
      outcomes.push({ ...shared, classification, after, before: null, movedTo: other });
      continue;
    }
    const deleted = [...changes.deleted].some((path) => livesIn(file, path));
    const obliged = runs.obligation[id]?.status ?? null;
    let classification = beforeAfter(entry.status, obliged);
    if (deleted) {
      classification = "removed";
    } else if ([...changes.modified].some((path) => livesIn(file, path))) {
      const rewritten = runs.candidate[id]?.status ?? null;
      if (rewritten !== null) claimed.add(id);
      const rescued = obliged !== "pass" && rewritten === "pass";
      if (rescued) {
        const failsBefore = witnessOf(id) !== "pass";
        classification =
          behaviorChange === "authorized" && failsBefore ? "superseded" : "expectation-changed";
      }
    }
    // A superseded expectation is replaced by the candidate's version: that is what now holds,
    // and the witness run is what it did before the change.
    const superseded = classification === "superseded";
    outcomes.push({
      ...shared,
      classification,
      after: superseded ? (runs.candidate[id]?.status ?? null) : obliged,
      before: superseded ? witnessOf(id) : null,
      movedTo: null,
    });
  }
  for (const [id, entry] of Object.entries(runs.candidate)) {
    if (claimed.has(id) || id in runs.base) continue;
    const origin = originOf(entry.file, changes);
    outcomes.push({
      id,
      title: titleOf(id),
      file: entry.file,
      origin,
      classification:
        entry.status === "pass" ? "added" : entry.status === "fail" ? "added-failing" : "skipped",
      base: null,
      after: entry.status,
      before: runs.witness === null ? null : witnessOf(id),
      movedTo: null,
    });
  }
  return outcomes;
}

/** The classifications that make the candidate's regression status `found`. */
export const regressing: ReadonlySet<Classification> = new Set([
  "new-failure",
  "removed",
  "expectation-changed",
  "added-failing",
]);
