import type { CheckRun } from "./checks.ts";
import {
  type CheckRuns,
  compareRuns,
  regressing,
  type TestFileChanges,
  type TestOutcome,
} from "./compare.ts";
import type { MeasuredRun } from "./per-test.ts";
import type { CheckResult, TestJudgment } from "./predicate.ts";

export interface CheckJudgment {
  readonly run: CheckRun;
  readonly outcomes: readonly TestOutcome[];
  readonly reasons: readonly string[];
  /** What blocks the result, as the check printed it; null when nothing does. */
  readonly failure: string | null;
  /** What still fails as it did at base: not a refusal, but what a repair would act on. */
  readonly inherited: string | null;
  /** Why the check measured nothing; null when it did. */
  readonly unmeasured: string | null;
}

export interface JudgmentInput {
  readonly base: MeasuredRun;
  /** The candidate's source with the base's versions of the test files it modified or deleted. */
  readonly obligation: MeasuredRun;
  readonly candidate: MeasuredRun;
  /** The base's source with the candidate's test files, or null where it changed none. */
  readonly witness: MeasuredRun | null;
  readonly changes: TestFileChanges;
  readonly behaviorChange: "none" | "authorized";
}

const listed = (ids: readonly string[]) =>
  ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} and ${ids.length - 5} more`;

const withResult = (
  run: CheckRun,
  result: CheckResult["result"],
  tests?: TestJudgment,
): CheckRun => ({
  ...run,
  result: { ...run.result, result, ...(tests === undefined ? {} : { tests }) },
});

/** A judge finding the base did not share: the code under test patched something more. */
function tamperOf(name: string, input: JudgmentInput): string | null {
  const found = input.obligation.evidence.judge ?? input.candidate.evidence.judge;
  const atBase = input.base.evidence.judge;
  return found !== null &&
    (atBase === null || (found.startsWith("the code under test") && found !== atBase))
    ? `check ${name}: ${found}`
    : null;
}

/** A check without a recognized runner: its exit codes and the count its runner printed. */
function byExitCode(input: JudgmentInput, tampered: string | null): CheckJudgment {
  const head = input.obligation.run;
  const { name, command, kind } = head.result;
  const output = `$ ${command}\n${head.outputTail}`;
  const reasons =
    kind === "test"
      ? [
          `check ${name}: no runner report is read for it, so its exit code and printed summary judged it`,
        ]
      : [];
  if (tampered !== null) reasons.push(tampered);
  const base = input.base.run.result;
  if (kind === "test" && head.result.collected === 0) {
    const why = "the run collected no tests";
    return {
      run: withResult(head, "no-tests"),
      outcomes: [],
      reasons: [...reasons, `check ${name}: ${why}`],
      failure: null,
      inherited: null,
      unmeasured: `check ${name}: ${why}`,
    };
  }
  if (head.result.result === "error") {
    reasons.push(`check ${name} could not run with the candidate: ${head.notRun ?? "unknown"}`);
    return { run: head, outcomes: [], reasons, failure: output, inherited: null, unmeasured: null };
  }
  if (head.result.result === "pass") {
    if (tampered !== null)
      return {
        run: withResult(head, "fail"),
        outcomes: [],
        reasons,
        failure: output,
        inherited: null,
        unmeasured: null,
      };
    return { run: head, outcomes: [], reasons, failure: null, inherited: null, unmeasured: null };
  }
  if (base.result === "pass") {
    reasons.push(
      `check ${name} regressed: it passes at the base commit and fails with the candidate`,
    );
    return {
      run: withResult(head, "fail"),
      outcomes: [],
      reasons,
      failure: output,
      inherited: null,
      unmeasured: null,
    };
  }
  // Failing at both, with no per-test report, says nothing about whether anything new broke.
  const why =
    "it fails at the base commit and with the candidate, and no per-test report tells a new failure from an old one";
  return {
    run: withResult(head, "unresolved"),
    outcomes: [],
    reasons: [...reasons, `check ${name} is unresolved: ${why}`],
    failure: null,
    inherited: output,
    unmeasured: `check ${name}: ${why}`,
  };
}

function judgmentOf(
  runner: TestJudgment["runner"],
  outcomes: readonly TestOutcome[],
  input: JudgmentInput,
): TestJudgment {
  const ids = (...kinds: TestOutcome["classification"][]) =>
    outcomes.filter((one) => kinds.includes(one.classification)).map((one) => one.id);
  const witnesses = outcomes
    .filter(
      (one) =>
        one.origin !== "pre-existing" &&
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
  };
  const capped = Object.fromEntries(
    Object.entries(lists).map(([key, value]) => [key, value.slice(0, 100)]),
  ) as typeof lists;
  const size = (run: MeasuredRun) => Object.keys(run.evidence.report ?? {}).length;
  return {
    runner,
    collected: { base: size(input.base), candidate: size(input.candidate) },
    counts,
    ...capped,
  };
}

/** One check judged test by test across the base, obligation, candidate and witness runs. */
export function judgeCheck(input: JudgmentInput): CheckJudgment {
  const head = input.obligation.run;
  const { name, command } = head.result;
  const tampered = tamperOf(name, input);
  const runner = input.candidate.evidence.runner;
  if (runner === null) return byExitCode(input, tampered);
  const unreadable = [
    ["at the base commit", input.base],
    ["against the base's tests", input.obligation],
    ["with the candidate", input.candidate],
  ].flatMap(([where, run]) => {
    const measured = run as MeasuredRun;
    return measured.evidence.unreadable !== null
      ? [`${where as string}, ${measured.evidence.unreadable}`]
      : measured.evidence.report === null
        ? [`${where as string}, a report is missing`]
        : [];
  });
  if (unreadable.length > 0) {
    const why = unreadable.join("; ");
    return {
      run: withResult(head, "unresolved"),
      outcomes: [],
      reasons: [`check ${name} is unresolved: ${why}`],
      failure: null,
      inherited: null,
      unmeasured: `check ${name}: ${why}`,
    };
  }
  const runs: CheckRuns = {
    base: input.base.evidence.report ?? {},
    obligation: input.obligation.evidence.report ?? {},
    candidate: input.candidate.evidence.report ?? {},
    witness: input.witness?.evidence.report ?? null,
  };
  const outcomes = compareRuns(runs, input.changes, input.behaviorChange);
  const tests = judgmentOf(runner, outcomes, input);
  const reasons: string[] = [];
  const say = (ids: readonly string[], total: number, what: string) => {
    if (total > 0) reasons.push(`check ${name}: ${total} test(s) ${what}: ${listed(ids)}`);
  };
  say(
    tests.newFailures,
    tests.counts.newFailures,
    "pass at the base commit and fail against the candidate",
  );
  say(tests.addedFailing, tests.counts.addedFailing, "the candidate added fail against it");
  say(tests.removed, tests.counts.removed, "at the base commit are gone from the candidate");
  say(
    tests.expectationChanges,
    tests.counts.expectationChanges,
    "pass only because the candidate rewrote their expectation, which the task did not authorize or the new version does not witness",
  );
  say(
    tests.superseded,
    tests.counts.superseded,
    "had their expectation replaced under an authorized behavior change, with the new version failing before and passing after",
  );
  say(
    tests.inherited,
    tests.counts.inherited,
    "fail at the base commit and still fail, which does not block",
  );
  if (tampered !== null) reasons.push(tampered);
  const blocks = outcomes.some((one) => regressing.has(one.classification)) || tampered !== null;
  // A nonzero exit that no failing test explains: the obligation run, or the candidate's own. A
  // superseded expectation fails in the obligation run by design, which explains its exit.
  const unexplained = [input.obligation, input.candidate].find(
    (one) =>
      one.run.result.exitCode !== 0 &&
      !Object.values(one.evidence.report ?? {}).some((test) => test.status === "fail"),
  );
  const exitedWorse = !blocks && input.base.run.result.exitCode === 0 && unexplained !== undefined;
  if (exitedWorse)
    reasons.push(
      `check ${name} exits ${unexplained.run.result.exitCode} against the candidate and 0 at the base commit, though no test in its report fails`,
    );
  const output = `$ ${command}\n${input.candidate.run.outputTail}`;
  if (blocks || exitedWorse) {
    return {
      run: withResult(head, "fail", tests),
      outcomes,
      reasons,
      failure: output,
      inherited: null,
      unmeasured: null,
    };
  }
  const passing = outcomes.filter((one) => one.after === "pass").length;
  if (passing === 0) {
    // Collected nothing: no-tests. Collected some and none passes: the run cannot tell the
    // candidate from no change, so nothing is claimed either way.
    const collected = tests.collected.candidate;
    const result = collected === 0 ? "no-tests" : "unresolved";
    const why =
      collected === 0
        ? "the run collected no tests"
        : `no test in its report passes against the candidate (${collected} collected)`;
    return {
      run: withResult(head, result, tests),
      outcomes,
      reasons: [`check ${name}: ${why}`, ...reasons],
      failure: null,
      inherited: tests.counts.inherited > 0 ? output : null,
      unmeasured: `check ${name}: ${why}`,
    };
  }
  const result = tests.counts.inherited > 0 ? "inherited-failures" : "pass";
  return {
    run: withResult(head, result, tests),
    outcomes,
    reasons,
    failure: null,
    inherited: result === "inherited-failures" ? output : null,
    unmeasured: null,
  };
}
