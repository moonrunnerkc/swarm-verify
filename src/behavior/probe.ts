import { dirname, join, resolve } from "node:path";
import type { ExecutionPolicy } from "../api/request.ts";
import { detectChecks } from "../config/detect.ts";
import { readSwarmToml } from "../config/swarm-toml.ts";
import { cloneBase } from "../verify/checkout.ts";
import { allChecks, type CheckContext, privateHome } from "../verify/checks.ts";
import { swarmHome } from "../verify/held-out.ts";
import { readiness } from "../verify/isolate.ts";
import { prepareDependencies } from "../verify/prepare.ts";
import { type BehaviorCheckInput, behaviorCheckSchema } from "./spec.ts";
import { type BehaviorRun, runBehavior } from "./target.ts";

/**
 * What behavior checks do on a commit as it stands, with no change applied: the same clean
 * checkout, dependencies, target and driver a verification uses for its base. It is how a
 * binding nobody has read yet is tried before anything is built on it: whether its target
 * starts, and which of its cases already hold. `blocked` says why nothing could be run.
 */
export async function probeBehavior(input: {
  readonly workspace: string;
  readonly baseCommit: string;
  readonly checks: readonly BehaviorCheckInput[];
  readonly policy: ExecutionPolicy;
  readonly swarmHome?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly blocked: string | null; readonly runs: readonly BehaviorRun[] }> {
  const checks = input.checks.map((one) => behaviorCheckSchema.parse(one));
  const home = resolve(input.swarmHome ?? swarmHome());
  const parent = input.policy.mode === "isolated" ? join(home, "work") : undefined;
  const checkout = await cloneBase(input.workspace, input.baseCommit, parent);
  try {
    const config = await readSwarmToml(checkout.dir);
    const declared = allChecks(config?.checks ?? (await detectChecks(checkout.dir)), []);
    const scratch = dirname(checkout.dir);
    const ready = await readiness(input.policy, checkout.dir, scratch, home, declared);
    if (!ready.ready) return { blocked: ready.reason, runs: [] };
    const context: CheckContext = {
      dir: checkout.dir,
      home: await privateHome(scratch),
      timeoutMs: (config?.timeoutMinutes ?? 20) * 60_000,
      signal: input.signal,
      execution: ready.execution,
      checkNetwork: input.policy.network,
    };
    const prepared = await prepareDependencies(
      input.workspace,
      config?.setup ?? null,
      input.policy.dependencies,
      context,
    );
    const failed = prepared.refused ?? prepared.failure?.notRun ?? null;
    if (failed !== null || prepared.failure !== null)
      return {
        blocked: `the base's dependencies did not install: ${failed ?? "setup failed"}`,
        runs: [],
      };
    const runs: BehaviorRun[] = [];
    for (const check of checks) runs.push(await runBehavior(check, context, "base"));
    return { blocked: null, runs };
  } finally {
    await checkout.remove();
  }
}
