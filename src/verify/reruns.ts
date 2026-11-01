import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { type BaseCheckout, restoreFrom, treeDigest } from "./checkout.ts";
import type { CheckContext } from "./checks.ts";
import type { TestOutcome } from "./compare.ts";
import { type MeasuredRun, runMeasured } from "./per-test.ts";
import type { RerunSnapshot, TestRuns } from "./predicate.ts";
import type { ReportPlan } from "./report-plan.ts";

export const defaultReruns = 3;

/** A test to run again: the check it belongs to, its id there, and the snapshot it failed on. */
export interface Suspect {
  readonly check: number;
  readonly id: string;
  readonly snapshot: RerunSnapshot;
}

/**
 * Where a failing first run decides a test's verdict, so a rerun could change it: a new failure
 * or a rescued expectation in the obligation run, a failing added test in the candidate's, a fix
 * at the base, and a witness against the base's source. Without a rewritten test file the
 * obligation run is the candidate's. Every other verdict stands whatever a rerun shows.
 */
export function suspectOf(
  outcome: TestOutcome,
  obligationIsCandidate: boolean,
): Omit<Suspect, "check"> | null {
  switch (outcome.classification) {
    case "new-failure":
    case "expectation-changed":
      if (outcome.movedTo !== null) return { id: outcome.movedTo, snapshot: "candidate" };
      return { id: outcome.id, snapshot: obligationIsCandidate ? "candidate" : "obligation" };
    case "added-failing":
      return { id: outcome.id, snapshot: "candidate" };
    case "fixed":
      return { id: outcome.id, snapshot: "base" };
    case "superseded":
    case "added":
      return { id: outcome.id, snapshot: "witness" };
    default:
      return null;
  }
}

/** A test's runs as a reason names them: `id (base: fail, pass)`. */
export const describeRuns = (runs: TestRuns) =>
  `${runs.id} (${runs.snapshot}: ${runs.results.join(", ")})`;

/** Each outcome with its reruns attached, and classified flaky where one of them passed. */
export function withReruns(
  outcomes: readonly TestOutcome[],
  reruns: readonly TestRuns[],
): TestOutcome[] {
  const byId = new Map(reruns.map((one) => [one.id, one]));
  return outcomes.map((outcome) => {
    // A moved test reruns under its candidate id on the candidate's side, its base id at the base.
    const rerun =
      byId.get(outcome.id) ?? (outcome.movedTo === null ? undefined : byId.get(outcome.movedTo));
    if (rerun === undefined) return outcome;
    const flaky = rerun.results.includes("pass");
    return { ...outcome, rerun, classification: flaky ? "flaky" : outcome.classification };
  });
}

export interface RerunInput {
  readonly checkout: BaseCheckout;
  readonly checks: readonly DeclaredCheck[];
  readonly plans: readonly (ReportPlan | null)[];
  readonly context: CheckContext;
  readonly scratch: string;
  /** The tree the candidate produced, laid back after each snapshot. */
  readonly candidateTree: string;
  readonly times: number;
}

export interface Reruns {
  /** Each rerun test, with the index of the check it belongs to. */
  readonly runs: readonly { readonly check: number; readonly test: TestRuns }[];
  /** Checks that rewrote tracked files while rerun, so those reruns measured something else. */
  readonly rewrites: readonly string[];
}

/**
 * The suspects of one snapshot run again, check by check, up to `times` rounds. A test leaves
 * the rounds at its first pass, since one pass after a failure already makes it flaky; one that
 * keeps failing is run every round, so its record says how often it failed. The snapshot is the
 * candidate tree with `paths` laid out as the base has them, and the candidate is put back after.
 */
export async function rerunSnapshot(
  input: RerunInput,
  snapshot: RerunSnapshot,
  paths: readonly string[],
  suspects: readonly Suspect[],
): Promise<Reruns> {
  const results = new Map<Suspect, TestRuns["results"][number][]>(
    suspects.map((one) => [one, ["fail"]]),
  );
  const rewrites: string[] = [];
  if (suspects.length === 0 || input.times === 0) return { runs: [], rewrites };
  const { checkout, context, scratch } = input;
  await restoreFrom(checkout, checkout.baseCommit, paths);
  try {
    for (let round = 1; round <= input.times; round += 1) {
      const open = suspects.filter((one) => !results.get(one)?.includes("pass"));
      for (const at of new Set(open.map((one) => one.check))) {
        const check = input.checks[at] as DeclaredCheck;
        const plan = input.plans[at] ?? null;
        const label = `rerun-${snapshot}-${round}`;
        const before = await treeDigest(checkout.dir);
        const run = await runMeasured({ check, plan, context, scratch, label, judge: false });
        if ((await treeDigest(checkout.dir)) !== before)
          rewrites.push(
            `check ${check.name} rewrote tracked files while rerun on the ${snapshot}, so its reruns there measured something else`,
          );
        for (const one of open.filter((suspect) => suspect.check === at))
          results.get(one)?.push(run.evidence.report?.[one.id]?.status ?? "missing");
      }
    }
  } finally {
    await restoreFrom(checkout, input.candidateTree, paths);
  }
  const runs = suspects.map((one) => ({
    check: one.check,
    test: { id: one.id, snapshot, results: results.get(one) ?? ["fail"] },
  }));
  return { runs, rewrites };
}

/**
 * The suspects among `outcomes` (each check's, in check order) whose snapshot is one of
 * `snapshots`, kept only where the first run on that snapshot reported the test as failing: a
 * test missing from a report is not a failure a rerun could show to be flaky.
 */
export function suspectsOn(
  snapshots: readonly RerunSnapshot[],
  outcomes: readonly (readonly TestOutcome[])[],
  firstRuns: Readonly<Record<RerunSnapshot, readonly (MeasuredRun | null)[]>>,
): Suspect[] {
  return outcomes.flatMap((ofCheck, check) => {
    const obligationIsCandidate = firstRuns.obligation[check] === firstRuns.candidate[check];
    return ofCheck.flatMap((outcome) => {
      const found = suspectOf(outcome, obligationIsCandidate);
      if (found === null || !snapshots.includes(found.snapshot)) return [];
      const first = firstRuns[found.snapshot][check]?.evidence.report?.[found.id]?.status;
      return first === "fail" ? [{ check, ...found }] : [];
    });
  });
}
