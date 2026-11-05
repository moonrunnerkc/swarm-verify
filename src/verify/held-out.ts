import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import {
  type BaseCheckout,
  removeWrittenSince,
  resetTracked,
  restoreFromBase,
  untrackedPaths,
} from "./checkout.ts";
import { baseCache, type CheckContext, type CheckRun } from "./checks.ts";
import { baselineKey, codeSha256 } from "./code-digest.ts";
import { type MeasuredRun, reportPlans, runMeasured } from "./per-test.ts";
import type { Baseline, Predicate } from "./predicate.ts";
import type { ReportPlan } from "./report-plan.ts";
import { overlaySealed, type SealedSet } from "./sealed-store.ts";

export {
  alteredSealed,
  globPattern,
  overlaySealed,
  readSealed,
  SealError,
  type SealedSet,
  seal,
  sealedDirectory,
  swarmHome,
} from "./sealed-store.ts";

export interface SealedRun {
  readonly runs: readonly CheckRun[];
  /** Each sealed check's run with its runner's report, in the order of `sealed.checks`. */
  readonly measured: readonly MeasuredRun[];
  readonly processes: number;
  readonly assertionCalls: number;
  /** What the judge found, one line per check it failed. */
  readonly problems: readonly string[];
  /** Worker threads the judge could not check, one line per check that had any. */
  readonly unchecked: readonly string[];
}

/**
 * Runs the sealed checks with the judge loaded into their Node and Python processes and their
 * runner's reporter attached, so each test in them is known by its identity. A check whose
 * assertions the code under test changed fails, whatever its exit code says.
 */
export async function runSealed(
  sealed: SealedSet,
  context: CheckContext,
  scratch: string,
  side: "base" | "candidate" = "candidate",
): Promise<SealedRun> {
  const measured: MeasuredRun[] = [];
  const problems: string[] = [];
  const unchecked: string[] = [];
  let processes = 0;
  let assertionCalls = 0;
  const plans = await reportPlans(context.dir, sealed.checks);
  for (const [at, check] of sealed.checks.entries()) {
    const plan = plans[at] ?? null;
    const label = `${side}-held-out`;
    const declared = { ...check, authority: sealed.authority };
    const one = await runMeasured({ check: declared, plan, context, scratch, label, judge: true });
    const reading = one.reading ?? null;
    processes += reading?.processes ?? 0;
    assertionCalls += reading?.assertionCalls ?? 0;
    if ((reading?.uncheckedThreads ?? 0) > 0) {
      unchecked.push(
        `held-out check ${check.name}: ${reading?.uncheckedThreads} worker thread(s) its runner terminated were not checked by the judge`,
      );
    }
    if (reading?.problem === null || reading === null) {
      measured.push(one);
      continue;
    }
    problems.push(`held-out check ${check.name}: ${reading.problem}`);
    const failed = { ...one.run, result: { ...one.run.result, result: "fail" as const } };
    measured.push({ ...one, run: failed });
  }
  const runs = measured.map((one) => one.run);
  return { runs, measured, processes, assertionCalls, problems, unchecked };
}

/** A digest of the sealed set, so a base run is reused only for the same held-out checks. */
export function sealedSha256(sealed: SealedSet | null): string {
  return createHash("sha256").update(JSON.stringify(sealed)).digest("hex");
}

/**
 * Every declared and held-out check at the base commit, before the change applies, reused from
 * SWARM_HOME when the same base, environment (which holds the commands), sealed set and judge
 * were measured before. Declared checks run with their runner's reporter and the judge, as they
 * will with the change. The checkout is put back to the base as committed afterwards.
 */
export async function measureBase(input: {
  readonly checkout: BaseCheckout;
  readonly checks: readonly DeclaredCheck[];
  readonly plans: readonly (ReportPlan | null)[];
  readonly sealed: SealedSet | null;
  readonly context: CheckContext;
  readonly home: string;
  readonly environment: Predicate["environment"];
  readonly workspace: string;
  /** Run the base even where a cached run exists; the fresh run is still written to the cache. */
  readonly fresh: boolean;
}): Promise<{
  readonly baseline: Baseline;
  readonly runs: readonly MeasuredRun[];
  /** The sealed checks at the base, with their runners' reports. */
  readonly sealedRuns: readonly MeasuredRun[];
}> {
  // The judge is part of the verifier's code, so its digest is in codeSha256.
  const key = baselineKey({
    baseCommit: input.checkout.baseCommit,
    environmentSha256: input.environment.sha256,
    sealedSha256: sealedSha256(input.sealed),
    codeSha256,
  });
  const file = baseCache.file(input.home, key);
  const environmentSha256 = input.environment.sha256;
  // A base measured on an environment no later run can reproduce (linked or set up by a
  // command no lockfile pins) is neither read from the cache nor written to it.
  const reuse = input.environment.reproducible;
  const cached = reuse && !input.fresh ? await baseCache.read(file) : null;
  if (cached !== null) {
    const { checks, heldOut, tests, heldOutTests } = cached;
    const replayed = (results: readonly CheckRun["result"][], reports: typeof tests) =>
      results.map((result, at) => ({
        run: { result, output: "", outputTail: "", notRun: null },
        evidence: reports[at] ?? { runner: null, report: null, unreadable: null, judge: null },
      }));
    return {
      baseline: { status: "measured", cached: true, environmentSha256, checks, heldOut },
      runs: replayed(checks, tests),
      sealedRuns: replayed(heldOut, heldOutTests),
    };
  }
  const scratch = dirname(input.checkout.dir);
  const before = await untrackedPaths(input.checkout);
  const runs: MeasuredRun[] = [];
  for (const [at, check] of input.checks.entries()) {
    const plan = input.plans[at] ?? null;
    const context = input.context;
    runs.push(await runMeasured({ check, plan, context, scratch, label: "base", judge: true }));
  }
  const checks = runs.map((one) => one.run.result);
  const tests = runs.map((one) => one.evidence);
  let sealedRuns: readonly MeasuredRun[] = [];
  if (input.sealed !== null) {
    await overlaySealed(input.workspace, input.sealed, input.checkout.dir, input.home);
    sealedRuns = (await runSealed(input.sealed, input.context, scratch, "base")).measured;
    await restoreFromBase(
      input.checkout,
      input.sealed.files.map((entry) => entry.path),
    );
  }
  await resetTracked(input.checkout);
  await removeWrittenSince(input.checkout, before);
  const heldOut = sealedRuns.map((one) => one.run.result);
  const heldOutTests = sealedRuns.map((one) => one.evidence);
  if (reuse) await baseCache.write(file, { checks, tests, heldOut, heldOutTests });
  return {
    baseline: { status: "measured", cached: false, environmentSha256, checks, heldOut },
    runs,
    sealedRuns,
  };
}
