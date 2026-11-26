import {
  type BaseCheckout,
  removeWrittenSince,
  resetTracked,
  untrackedPaths,
} from "../verify/checkout.ts";
import type { CheckContext } from "../verify/checks.ts";
import { behaviorEvidence, behaviorLogName } from "./evidence.ts";
import type { BehaviorCheck } from "./spec.ts";
import { type BehaviorRun, runBehavior } from "./target.ts";

/**
 * The behavior checks of one verification: run against the base, so a case is known to have
 * failed or held before the change, then against the candidate. A target may write files into
 * the checkout; what it leaves untracked is removed, so later runs start from the same tree.
 */
export function behaviorMeasure(
  checks: readonly BehaviorCheck[],
  checkout: BaseCheckout,
  context: CheckContext | null,
) {
  let base: BehaviorRun[] = [];
  let candidate: BehaviorRun[] = [];
  const run = async (side: "base" | "candidate") => {
    if (context === null || checks.length === 0) return [];
    const before = await untrackedPaths(checkout);
    const runs: BehaviorRun[] = [];
    for (const check of checks) runs.push(await runBehavior(check, context, side));
    if (side === "base") await resetTracked(checkout);
    await removeWrittenSince(checkout, before);
    return runs;
  };
  return {
    async atBase(): Promise<void> {
      base = await run("base");
    },
    async onCandidate(): Promise<void> {
      candidate = await run("candidate");
    },
    /** The cases as outcomes and records; what went wrong and each run's log join the run's own. */
    evidence(
      reasons: string[],
      failures: string[],
      logs: { readonly name: string; readonly text: string }[],
    ) {
      const isolated = context?.execution.kind === "isolated";
      const found = behaviorEvidence(checks, base, candidate, isolated);
      reasons.push(...found.reasons);
      failures.push(...found.failures);
      for (const one of base)
        logs.push({ name: behaviorLogName(one.check, "base"), text: one.log });
      for (const one of candidate)
        logs.push({ name: behaviorLogName(one.check, "candidate"), text: one.log });
      return { outcomes: found.outcomes, records: found.records };
    },
  };
}
