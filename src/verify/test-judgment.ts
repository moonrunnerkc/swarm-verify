import type { TestOutcome } from "./compare.ts";
import type { MeasuredRun } from "./per-test.ts";
import type { TestJudgment } from "./predicate.ts";

/** The per-test lists and counts a check's result records, from its classified outcomes. */
export function testJudgmentOf(
  runner: TestJudgment["runner"],
  outcomes: readonly TestOutcome[],
  runs: { readonly base: MeasuredRun; readonly candidate: MeasuredRun },
): TestJudgment {
  const ids = (...kinds: TestOutcome["classification"][]) =>
    outcomes.filter((one) => kinds.includes(one.classification)).map((one) => one.id);
  const witnesses = outcomes
    .filter(
      (one) =>
        one.origin !== "pre-existing" &&
        one.classification !== "flaky" &&
        one.after === "pass" &&
        one.before !== null &&
        one.before !== "pass",
    )
    .map((one) => one.id);
  const lists = {
    fixed: ids("fixed"),
    newFailures: ids("new-failure"),
    inherited: ids("inherited"),
    removed: ids("removed"),
    renamed: outcomes
      .filter((one) => one.classification === "renamed")
      .map((one) => `${one.id} => ${one.movedTo}`),
    superseded: ids("superseded"),
    expectationChanges: ids("expectation-changed"),
    added: ids("added"),
    addedFailing: ids("added-failing"),
    witnesses,
    flaky: ids("flaky"),
  };
  const counts = {
    preserved: ids("preserved").length,
    renamed: lists.renamed.length,
    fixed: lists.fixed.length,
    newFailures: lists.newFailures.length,
    inherited: lists.inherited.length,
    removed: lists.removed.length,
    superseded: lists.superseded.length,
    expectationChanges: lists.expectationChanges.length,
    added: lists.added.length,
    addedFailing: lists.addedFailing.length,
    witnesses: witnesses.length,
    skipped: ids("skipped").length,
    flaky: lists.flaky.length,
  };
  // Sorted before capping: a runner's order is not the verdict's, and a replay compares these.
  const capped = Object.fromEntries(
    Object.entries(lists).map(([key, value]) => [key, [...value].sort().slice(0, 100)]),
  ) as typeof lists;
  const reruns = outcomes
    .flatMap((one) => (one.rerun === undefined ? [] : [one.rerun]))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 100);
  const size = (run: MeasuredRun) => Object.keys(run.evidence.report ?? {}).length;
  return {
    runner,
    collected: { base: size(runs.base), candidate: size(runs.candidate) },
    counts,
    ...capped,
    reruns,
  };
}
