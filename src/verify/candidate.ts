import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { type BaseCheckout, type ChangedFile, restoreFrom, treeDigest } from "./checkout.ts";
import { type CheckContext, passRate } from "./checks.ts";
import type { TestFileChanges, TestOutcome } from "./compare.ts";
import { instrument } from "./coverage.ts";
import { overlaySealed, runSealed, type SealedSet } from "./held-out.ts";
import { judgeCheck } from "./judgment.ts";
import { mutationWitness } from "./mutation.ts";
import { type ChangedArtifact, categoryOf } from "./paths.ts";
import { type MeasuredRun, mutantOutcome, runMeasured } from "./per-test.ts";
import type { CheckResult, Coverage, HeldOut, Mutation, RerunSnapshot } from "./predicate.ts";
import type { ReportPlan } from "./report-plan.ts";
import { type RerunInput, type Reruns, rerunSnapshot, suspectsOn } from "./reruns.ts";
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
  /** The candidate tree's digest when it was applied, to tell whether a check rewrote it. */
  readonly candidateSha256: string;
  readonly behaviorChange: "none" | "authorized";
  /** Reruns of a test whose failing first run decides its verdict. */
  readonly reruns: number;
  /**
   * Installs the base's dependencies again from the base's lockfile laid out in the checkout,
   * where the candidate installed its own; null where the base's are still in place.
   */
  readonly reinstallBase: (() => Promise<boolean>) | null;
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
  /** Why the measurement cannot be trusted as one of the delivered candidate. */
  readonly problems: string[];
  /** Each check's full output against the candidate, and against the base's tests where they differ. */
  readonly logs: { readonly name: string; readonly text: string }[];
}

const skipped = (reason: string) => ({ status: "unmeasured" as const, reason });

type FirstRuns = Readonly<Record<RerunSnapshot, readonly (MeasuredRun | null)[]>>;

/** One mutant run through every test check until one kills it. */
function mutantRunner(input: CandidateInput, candidate: readonly MeasuredRun[]) {
  const { checks, plans, context, scratch } = input;
  const tests = checks.flatMap((check, at) => (check.kind === "test" ? [at] : []));
  if (tests.length === 0) return null;
  return async () => {
    const seen = [];
    for (const at of tests) {
      const check = checks[at] as DeclaredCheck;
      const plan = plans[at] ?? null;
      const label = "mutant";
      const mutant = await runMeasured({ check, plan, context, scratch, label, judge: false });
      const one = mutantOutcome(candidate[at] as MeasuredRun, mutant);
      if (one === "killed") return one;
      seen.push(one);
    }
    return seen.includes("runner-crash")
      ? "runner-crash"
      : seen.includes("timeout")
        ? "timeout"
        : "survived";
  };
}

/**
 * Reruns at the base and against the base's source: a fix, and a witness, that rest on a failing
 * first run there. They come last, since the base's dependencies may have to be installed again
 * for them, and nothing runs on the candidate afterwards.
 */
async function rerunBaseSide(
  input: CandidateInput,
  rerun: RerunInput,
  outcomes: readonly (readonly TestOutcome[])[],
  firstRuns: FirstRuns,
  otherPaths: readonly string[],
): Promise<Reruns & { readonly notice: string | null }> {
  const atBase = suspectsOn(["base"], outcomes, firstRuns);
  const atWitness = suspectsOn(["witness"], outcomes, firstRuns);
  const suspects = atBase.length + atWitness.length;
  if (suspects === 0 || rerun.times === 0) return { runs: [], rewrites: [], notice: null };
  const { checkout } = input;
  if (input.reinstallBase !== null) {
    const manifests = input.artifacts
      .filter((one) => one.category === "lockfiles" || one.category === "manifests")
      .map((one) => one.path);
    await restoreFrom(checkout, checkout.baseCommit, manifests);
    if (!(await input.reinstallBase())) {
      await restoreFrom(checkout, input.candidateTree, manifests);
      const notice = `the base's dependencies did not install again for its reruns, so ${suspects} test(s) that fail at the base and pass after rest on one run`;
      return { runs: [], rewrites: [], notice };
    }
  }
  const changed = input.changed.map((file) => file.path);
  const base = await rerunSnapshot(rerun, "base", changed, atBase);
  const witness = await rerunSnapshot(rerun, "witness", otherPaths, atWitness);
  return {
    runs: [...base.runs, ...witness.runs],
    rewrites: [...base.rewrites, ...witness.rewrites],
    notice: null,
  };
}

/**
 * The candidate measured and judged: its runs against the base's, test by test, with a test
 * whose failing first run decides its verdict run again on the same snapshot, then changed-line
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
    ...testFiles.movedAndEdited.values(),
    ...testFiles.relocated,
  ]);
  const otherPaths = changed
    .map((file) => file.path)
    .filter(
      (path) =>
        !testPaths.has(path) &&
        !testFiles.deleted.has(path) &&
        !testFiles.moved.has(path) &&
        !testFiles.movedAndEdited.has(path),
    );
  const sets = await measureCandidate({
    checkout,
    checks,
    plans,
    context,
    scratch,
    changes: testFiles,
    wrap: "wrap" in instrumented ? instrumented.wrap : null,
    candidateTree: input.candidateTree,
    otherPaths,
  });
  const coverage = "read" in instrumented ? await instrumented.read() : instrumented;
  const firstRuns: FirstRuns = {
    base: input.baseRuns,
    obligation: sets.obligation,
    candidate: sets.candidate,
    witness: sets.witness,
  };
  const judgeAll = (reruns: Reruns["runs"]) =>
    checks.map((_, at) =>
      judgeCheck({
        base: input.baseRuns[at] as MeasuredRun,
        obligation: sets.obligation[at] as MeasuredRun,
        candidate: sets.candidate[at] as MeasuredRun,
        witness: sets.witness[at] ?? null,
        changes: testFiles,
        behaviorChange: input.behaviorChange,
        reruns: reruns.flatMap((one) => (one.check === at ? [one.test] : [])),
      }),
    );
  const outcomesOf = (judged: ReturnType<typeof judgeAll>) => judged.map((one) => one.outcomes);
  const rerun: RerunInput = { ...input, times: input.reruns };
  // The candidate's side first: whether a check fails there decides the mutation pass.
  const first = outcomesOf(judgeAll([]));
  const rewrittenTests = [
    ...testFiles.modified,
    ...testFiles.deleted,
    ...[...testFiles.movedAndEdited].flat(),
  ];
  const atObligation = suspectsOn(["obligation"], first, firstRuns);
  const atCandidate = suspectsOn(["candidate"], first, firstRuns);
  const candidateSide = [
    await rerunSnapshot(rerun, "obligation", rewrittenTests, atObligation),
    await rerunSnapshot(rerun, "candidate", [], atCandidate),
  ];
  const candidateReruns = candidateSide.flatMap((one) => one.runs);
  const afterCandidate = judgeAll(candidateReruns);
  const failing = afterCandidate.some(
    (one) => one.run.result.result === "fail" || one.run.result.result === "error",
  );
  const mutation: Mutation = !failing
    ? await mutationWitness(source, coverage, mutantRunner(input, sets.candidate), context)
    : skipped("a check failed, so no mutant can be told apart from that failure");
  // Read again after every candidate-side run: a check that rewrote the candidate's tracked files
  // measured something other than what was delivered.
  const after = await treeDigest(checkout.dir);
  const rewritten =
    after === input.candidateSha256
      ? []
      : [
          `the checks rewrote tracked files of the candidate (tree sha256 ${after}, delivered ${input.candidateSha256}), so this measurement is not of the delivered candidate`,
        ];
  let hidden: Awaited<ReturnType<typeof runSealed>> | null = null;
  if (input.sealed !== null) {
    // The base's tests and test configuration judge the held-out run, not the candidate's.
    const tested = artifacts.filter((one) => one.category === "tests").map((one) => one.path);
    await restoreFrom(checkout, checkout.baseCommit, tested);
    await overlaySealed(input.workspace, input.sealed, checkout.dir, input.home);
    hidden = await runSealed(input.sealed, context, scratch);
    await restoreFrom(checkout, input.candidateTree, tested);
  }
  const baseSide = await rerunBaseSide(
    input,
    rerun,
    outcomesOf(afterCandidate),
    firstRuns,
    otherPaths,
  );
  const judged = judgeAll([...candidateReruns, ...baseSide.runs]);
  const runs = judged.map((one) => one.run.result);
  const reasons = judged.flatMap((one) => one.reasons);
  // An environment that could not be rebuilt for the reruns: the fixes it leaves are not trusted.
  const problems = [
    ...(baseSide.notice === null ? [] : [baseSide.notice]),
    ...sets.rewrites.map((one) => `${one}, so the checks did not measure the delivered candidate`),
    ...rewritten,
    ...candidateSide.flatMap((one) => one.rewrites),
    ...baseSide.rewrites,
  ];
  let heldOut: HeldOut = skipped("no held-out checks are sealed for this workspace");
  if (hidden !== null) {
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
  }
  return {
    runs,
    outcomes: judged.flatMap((one) => [...one.outcomes]),
    coverage,
    mutation,
    heldOut,
    reasons,
    failures: judged.flatMap((one) => (one.failure === null ? [] : [one.failure])),
    inherited: judged.flatMap((one) => (one.inherited === null ? [] : [one.inherited])),
    unmeasured: [
      ...judged.flatMap((one) => (one.unmeasured === null ? [] : [one.unmeasured])),
      ...(hidden?.unchecked ?? []),
    ],
    problems,
    logs: checks.flatMap((check, at) => {
      const candidate = sets.candidate[at] as MeasuredRun;
      const obligation = sets.obligation[at] as MeasuredRun;
      const name = check.name.replace(/[^\w.-]/g, "_");
      return [
        { name: `logs/${name}.txt`, text: candidate.run.output },
        ...(obligation === candidate
          ? []
          : [{ name: `logs/${name}.base-tests.txt`, text: obligation.run.output }]),
      ];
    }),
  };
}
