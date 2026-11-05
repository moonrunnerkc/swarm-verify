import type { Classification, TestOutcome } from "./compare.ts";
import { titleOf } from "./compare.ts";
import type { MeasuredRun } from "./per-test.ts";
import type { SealedSet } from "./sealed-store.ts";

type Status = TestOutcome["base"];

/** What a sealed test did between the base and the candidate. */
function classify(base: Status, after: Status): Classification {
  if (after === "pass") return base === "pass" ? "preserved" : "fixed";
  if (after === "skip") return "skipped";
  return after === null ? "removed" : "new-failure";
}

const statusOf = (run: MeasuredRun | undefined): Status => {
  const result = run?.run.result.result;
  if (result === undefined) return null;
  return result === "pass" ? "pass" : "fail";
};

/**
 * Every test of every sealed check as an outcome against the base, carrying the set's authority
 * and the requirements its check names. Where a runner's report was read, test by test; where
 * none was, the check by its exit code, as one outcome named for the check.
 */
export function sealedOutcomes(
  sealed: SealedSet,
  base: readonly MeasuredRun[],
  candidate: readonly MeasuredRun[],
): TestOutcome[] {
  const outcomes: TestOutcome[] = [];
  for (const [at, check] of sealed.checks.entries()) {
    const shared = { authority: sealed.authority, requirements: check.requirements };
    const before = base[at];
    const after = candidate[at];
    const report = after?.evidence.report ?? null;
    const baseReport = before?.evidence.report ?? null;
    if (report === null) {
      const id = `held-out ${check.name}`;
      const [was, now] = [statusOf(before), statusOf(after)];
      outcomes.push({
        id,
        title: id,
        file: null,
        origin: "pre-existing",
        classification: classify(was, now),
        base: was,
        after: now,
        before: was,
        movedTo: null,
        ...shared,
      });
      continue;
    }
    const ids = new Set([...Object.keys(report), ...Object.keys(baseReport ?? {})]);
    for (const id of [...ids].sort()) {
      const entry = report[id];
      const was = baseReport?.[id]?.status ?? null;
      const now = entry?.status ?? null;
      // A file that could not load at the base stands for its tests as one failing entry, which
      // the candidate's report replaces with the tests themselves: it is not a test removed.
      if (now === null && was !== "pass") continue;
      outcomes.push({
        id,
        title: titleOf(id),
        file: entry?.file ?? baseReport?.[id]?.file ?? null,
        origin: "pre-existing",
        classification: classify(was, now),
        base: was,
        after: now,
        before: was,
        movedTo: null,
        ...shared,
      });
    }
  }
  return outcomes;
}
