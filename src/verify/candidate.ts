import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { type BaseCheckout, type ChangedFile, restoreFrom } from "./checkout.ts";
import { type CheckContext, passRate } from "./checks.ts";
import type { TestFileChanges, TestOutcome } from "./compare.ts";
import { instrument } from "./coverage.ts";
import { overlaySealed, runSealed, type SealedSet } from "./held-out.ts";
import { judgeCheck } from "./judgment.ts";
import { mutationWitness } from "./mutation.ts";
import { type ChangedArtifact, categoryOf } from "./paths.ts";
import { type MeasuredRun, mutantOutcome, runMeasured } from "./per-test.ts";
import type { CheckResult, Coverage, HeldOut, Mutation } from "./predicate.ts";
import type { ReportPlan } from "./report-plan.ts";
import { measureCandidate } from "./runs.ts";

export interface CandidateInput {
  readonly checkout: BaseCheckout;
  readonly checks: readonly DeclaredCheck[];
  readonly plans: readonly (ReportPlan | null)[];
  readonly context: CheckContext;
  readonly scratch: string;
  readonly sealed: SealedSet | null;
  readonly home: string;
  readonly workspace: string;
  readonly baseRuns: readonly MeasuredRun[];
  readonly testFiles: TestFileChanges;
  readonly changed: readonly ChangedFile[];
  readonly artifacts: readonly ChangedArtifact[];
  readonly candidateTree: string;
  readonly behaviorChange: "none" | "authorized";
}

export interface CandidateJudgment {
  readonly runs: CheckResult[];
  readonly outcomes: TestOutcome[];
  readonly coverage: Coverage;
  readonly mutation: Mutation;
  readonly heldOut: HeldOut;
  readonly reasons: string[];
  readonly failures: string[];
  readonly inherited: string[];
  readonly unmeasured: string[];
}

const skipped = (reason: string) => ({ status: "unmeasured" as const, reason });

/**
 * The candidate measured and judged: its runs against the base's, test by test, then changed-line
 * coverage, one syntax-checked mutant, and the held-out checks with the base's tests in place.
 */
export async function judgeCandidate(input: CandidateInput): Promise<CandidateJudgment> {
  const { checkout, checks, plans, context, scratch, testFiles, changed, artifacts } = input;
  const source = changed.filter(
    (file) => file.status !== "deleted" && categoryOf(file.path) === null,
  );
  const instrumented = await instrument(checks, source, scratch, context);
  const testPaths = new Set([
    ...testFiles.added,
    ...testFiles.modified,
    ...testFiles.moved.values(),
    ...testFiles.relocated,
  ]);
  const sets = await measureCandidate({
    checkout,
    checks,
    plans,
    context,
    scratch,
    changes: testFiles,
    wrap: "wrap" in instrumented ? instrumented.wrap : null,
    candidateTree: input.candidateTree,
    otherPaths: changed
      .map((file) => file.path)
      .filter(
        (path) =>
          !testPaths.has(path) && !testFiles.deleted.has(path) && !testFiles.moved.has(path),
      ),
  });
  const coverage = "read" in instrumented ? await instrumented.read() : instrumented;
  const judged = checks.map((_, at) =>
    judgeCheck({
      base: input.baseRuns[at] as MeasuredRun,
      obligation: sets.obligation[at] as MeasuredRun,
      candidate: sets.candidate[at] as MeasuredRun,
      witness: sets.witness[at] ?? null,
      changes: testFiles,
      behaviorChange: input.behaviorChange,
    }),
  );
  const runs = judged.map((one) => one.run.result);
  const reasons = judged.flatMap((one) => one.reasons);
  const failures = judged.flatMap((one) => (one.failure === null ? [] : [one.failure]));
  const tests = checks.flatMap((check, at) => (check.kind === "test" ? [at] : []));
  const outcome = async () => {
    const seen = [];
    for (const at of tests) {
      const check = checks[at] as DeclaredCheck;
      const plan = plans[at] ?? null;
      const mutant = await runMeasured({
        check,
        plan,
        context,
        scratch,
        label: "mutant",
        judge: false,
      });
      const one = mutantOutcome(sets.candidate[at] as MeasuredRun, mutant);
      if (one === "killed") return one;
      seen.push(one);
    }
    return seen.includes("runner-crash")
      ? "runner-crash"
      : seen.includes("timeout")
        ? "timeout"
        : "survived";
  };
  const mutation: Mutation = runs.every((run) => run.result !== "fail" && run.result !== "error")
    ? await mutationWitness(source, coverage, tests.length === 0 ? null : outcome, context)
    : skipped("a check failed, so no mutant can be told apart from that failure");
  let heldOut: HeldOut = skipped("no held-out checks are sealed for this workspace");
  if (input.sealed !== null) {
    // The base's tests and test configuration judge the held-out run, not the candidate's.
    const tested = artifacts.filter((one) => one.category === "tests").map((one) => one.path);
    await restoreFrom(checkout, checkout.baseCommit, tested);
    await overlaySealed(input.workspace, input.sealed, checkout.dir, input.home);
    const hidden = await runSealed(input.sealed, context, scratch);
    const visiblePassRate = passRate(runs);
    const heldOutPassRate = passRate(hidden.runs.map((run) => run.result));
    heldOut = {
      status: "measured",
      checks: hidden.runs.map((run) => run.result),
      visiblePassRate,
      heldOutPassRate,
      gap: visiblePassRate - heldOutPassRate,
      judge: { processes: hidden.processes, assertionCalls: hidden.assertionCalls },
    };
    // The author never saw these, so their output is not handed back either.
    if (heldOutPassRate < 1) reasons.push("a held-out check failed");
    reasons.push(...hidden.problems);
    await restoreFrom(checkout, input.candidateTree, tested);
  }
  return {
    runs,
    outcomes: judged.flatMap((one) => [...one.outcomes]),
    coverage,
    mutation,
    heldOut,
    reasons,
    failures,
    inherited: judged.flatMap((one) => (one.inherited === null ? [] : [one.inherited])),
    unmeasured: judged.flatMap((one) => (one.unmeasured === null ? [] : [one.unmeasured])),
  };
}
