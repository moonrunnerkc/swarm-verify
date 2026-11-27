import { dirname, join, resolve } from "node:path";
import type { ExecutionPolicy } from "../api/request.ts";
import { detectChecks } from "../config/detect.ts";
import { readSwarmToml } from "../config/swarm-toml.ts";
import { cloneBase } from "../verify/checkout.ts";
import { allChecks, type CheckContext, privateHome } from "../verify/checks.ts";
import { swarmHome } from "../verify/held-out.ts";
import { readiness } from "../verify/isolate.ts";
import { prepareDependencies } from "../verify/prepare.ts";
import { type SecurityFile, securityClasses } from "./binding.ts";
import { securityChecks, signedInCase } from "./security.ts";
import { type BehaviorCheckInput, behaviorCheckSchema } from "./spec.ts";
import { type BehaviorRun, runBehavior } from "./target.ts";

/**
 * What behavior checks do on a commit as it stands, with no change applied: the same clean
 * checkout, dependencies, target and driver a verification uses for its base. It is how a
 * binding nobody has read yet is tried before anything is built on it: whether its target
 * starts, and which of its cases already hold. `blocked` says why nothing could be run.
 */
async function probeBehavior(input: {
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

/**
 * A security binding tried on a commit before anything is built on it. `problem` says what real
 * requests showed is wrong with the binding itself: its target did not come up, or a user it
 * names is not one the server knows. A legitimate use the commit does not serve yet is not a
 * problem, since the change may be what adds it; `observed` lists what every case did.
 */
export async function tryBinding(
  file: SecurityFile,
  at: Omit<Parameters<typeof probeBehavior>[0], "checks">,
): Promise<{ readonly problem: string | null; readonly observed: readonly string[] }> {
  const ids = new Map(securityClasses.map((name, index) => [name, `R${index + 1}`]));
  const probe = await probeBehavior({
    ...at,
    checks: securityChecks(file, "independently-generated", ids),
  });
  if (probe.blocked !== null)
    return { problem: `it could not be tried at the base: ${probe.blocked}`, observed: [] };
  const observed: string[] = [];
  for (const run of probe.runs) {
    if (run.notRun !== null)
      return {
        problem: `at the base, ${run.notRun}; the target printed: ${run.log.slice(-400)}`,
        observed,
      };
    const signed = run.cases.find((one) => one.name === signedInCase);
    if (signed?.status === "fail")
      return {
        problem: `at the base, the users it names did not check out: ${signed.detail}`,
        observed,
      };
    observed.push(
      `${run.check}: ${run.cases.map((one) => `${one.name}: ${one.status}`).join("; ")}`,
    );
  }
  return { problem: null, observed };
}
