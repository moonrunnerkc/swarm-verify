import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ExecutionPolicy, Producer, Requirement, TrustedCheck } from "../api/request.ts";
import { detectChecks } from "../config/detect.ts";
import { readSwarmToml, type SwarmToml } from "../config/swarm-toml.ts";
import { executionOf, regressionOf, stateOf, unmeasuredOf } from "./assess.ts";
import type { ResolvedChange } from "./change.ts";
import { applyChange, cloneBase, restoreFromBase } from "./checkout.ts";
import {
  allChecks,
  type CheckRun,
  environmentOf,
  lockfileDigests,
  passRate,
  prepareDependencies,
  privateHome,
  runCheck,
} from "./checks.ts";
import { instrument } from "./coverage.ts";
import { measureBase, overlaySealed, readSealed, runSealed, swarmHome } from "./held-out.ts";
import { mutationWitness } from "./mutation.ts";
import {
  deletableIn,
  judgeCheck,
  killedBy,
  type MeasuredRun,
  reportPlans,
  runMeasured,
} from "./per-test.ts";
import type { Baseline, Coverage, HeldOut, Mutation, Predicate, Statement } from "./predicate.ts";
import { buildStatement } from "./predicate.ts";
import { categoryOf, checkProtectedPaths } from "./protected-paths.ts";
import { assessRequirements } from "./requirements.ts";
import type { TestEvidence } from "./test-report.ts";

export interface VerifyOptions {
  readonly workspace: string;
  readonly change: ResolvedChange;
  readonly requirements?: readonly Requirement[];
  readonly trustedChecks?: readonly TrustedCheck[];
  readonly policy: ExecutionPolicy;
  readonly producer?: Producer;
  readonly swarmHome?: string;
  readonly signal?: AbortSignal;
  readonly version: string;
}

export interface VerifyOutcome {
  readonly statement: Statement;
  readonly patch: Buffer;
  /** What failed, as the checks printed it: the text a person or the agent acts on. */
  readonly failureText: string;
}

const skipped = (reason: string) => ({ status: "unmeasured" as const, reason });

export async function verifyChange(options: VerifyOptions): Promise<VerifyOutcome> {
  const change = options.change;
  const checkout = await cloneBase(options.workspace, change.baseCommit);
  const home = options.swarmHome ?? swarmHome();
  try {
    // Read from the base before the change is applied, so the change cannot rewrite its judges.
    const config: SwarmToml | null = await readSwarmToml(checkout.dir);
    const checks = allChecks(
      config?.checks ?? (await detectChecks(checkout.dir)),
      options.trustedChecks ?? [],
    );
    const sealed = await readSealed(options.workspace, home);
    const scratch = dirname(checkout.dir);
    const context = {
      dir: checkout.dir,
      home: await privateHome(scratch),
      timeoutMs: (config?.timeoutMinutes ?? 20) * 60_000,
      signal: options.signal,
    };
    const reasons: string[] = [];
    const failures: string[] = [];
    // What inherited failures printed: not a refusal, but what an agent would act on.
    const inheritedText: string[] = [];
    const unmeasuredChecks: string[] = [];
    let runs: readonly CheckRun[] = [];
    let baseTests: readonly TestEvidence[] = [];
    let baseline: Baseline = skipped("no checks are declared");
    let heldOut: HeldOut = skipped("no held-out checks are sealed for this workspace");
    let coverage: Coverage = skipped("the checks did not run");
    let mutation: Mutation = skipped("the checks did not run");
    const dependencies = await prepareDependencies(
      options.workspace,
      config?.setup ?? null,
      options.policy.dependencies,
      context,
    );
    const blocked: string[] = [];
    let requirementOutcomes: Awaited<ReturnType<typeof assessRequirements>> | null = null;
    // Runners are read from the base's package.json, as the checks themselves are.
    const plans = await reportPlans(checkout.dir, checks);
    if (checks.length > 0 && dependencies.failure === null) {
      const environment = await environmentOf(checkout.dir, checks, dependencies.mode);
      const workspace = options.workspace;
      const measured = await measureBase({
        checkout,
        checks,
        plans,
        sealed,
        context,
        home,
        environment,
        workspace,
      });
      baseline = measured.baseline;
      baseTests = measured.tests;
    }
    const applied = await applyChange(checkout, change.patch);
    const paths = applied.applied ? applied.result.changed.map((file) => file.path) : [];
    const protectedPaths = checkProtectedPaths(paths, config?.allow ?? []);
    // A change to a lockfile or manifest needs the setup run again on the changed tree.
    const resetup =
      config?.setup != null &&
      dependencies.failure === null &&
      protectedPaths.changed.some((f) => f.category === "lockfiles" || f.category === "manifests")
        ? await runCheck({ name: "setup", command: config.setup, kind: "other" }, context)
        : null;
    const resetupFailure = resetup?.result.result === "pass" ? null : resetup;
    if (options.policy.mode === "isolated") {
      blocked.push(
        "isolated execution was requested and this verifier build runs only on the host",
      );
    }

    if (!applied.applied) {
      reasons.push(applied.reason);
      failures.push(applied.reason);
    } else if (checks.length === 0) {
      blocked.push("no checks are declared in swarm.toml or the project's manifests");
    } else if (dependencies.failure !== null) {
      blocked.push("preparing the base's dependencies failed");
      failures.push(`setup failed:\n${dependencies.failure.outputTail}`);
    } else if (resetupFailure !== null) {
      reasons.push("the setup command failed on the changed tree");
      failures.push(`setup failed:\n${resetupFailure.outputTail}`);
    } else if (blocked.length === 0) {
      const base = baseline.status === "measured" ? baseline.checks : [];
      const source = applied.result.changed.filter(
        (file) => file.status !== "deleted" && categoryOf(file.path) === null,
      );
      const instrumented = await instrument(checks, source, scratch, context);
      const wrap = "wrap" in instrumented ? instrumented.wrap : null;
      const heads: MeasuredRun[] = [];
      for (const [at, check] of checks.entries()) {
        const plan = plans[at] ?? null;
        heads.push(
          await runMeasured({ check, plan, context, scratch, label: "head", judge: true, wrap }),
        );
      }
      coverage = "read" in instrumented ? await instrumented.read() : instrumented;
      const deletable = deletableIn(paths, (config?.allow ?? []).includes("tests"));
      const judged = heads.map((head, at) => {
        const result = base[at];
        const evidence = baseTests[at];
        const before =
          result === undefined || evidence === undefined ? undefined : { result, evidence };
        return judgeCheck(head, before, deletable);
      });
      runs = judged.map((one) => one.run);
      for (const one of judged) {
        reasons.push(...one.reasons);
        if (one.failure !== null) failures.push(one.failure);
        if (one.inherited !== null) inheritedText.push(one.inherited);
        if (one.unmeasured !== null) unmeasuredChecks.push(one.unmeasured);
      }
      const tests = checks.flatMap((check, at) => (check.kind === "test" ? [at] : []));
      const killed = async () => {
        for (const at of tests) {
          const check = checks[at] as (typeof checks)[number];
          const plan = plans[at] ?? null;
          const mutant = await runMeasured({
            check,
            plan,
            context,
            scratch,
            label: "mutant",
            judge: false,
          });
          if (killedBy(heads[at] as MeasuredRun, mutant)) return true;
        }
        return false;
      };
      mutation = runs.every((run) => run.result.result === "pass")
        ? await mutationWitness(source, coverage, tests.length === 0 ? null : killed, context)
        : skipped("a check did not pass, so no mutant can be told apart from that failure");
      requirementOutcomes = await assessRequirements(options.requirements ?? [], {
        checks: runs.map((run) => run.result),
        dir: checkout.dir,
        changed: change.patch.length > 0,
      });
      if (sealed !== null) {
        await restoreFromBase(
          checkout,
          protectedPaths.changed.map((finding) => finding.path),
        );
        await overlaySealed(options.workspace, sealed, checkout.dir, home);
        const hidden = await runSealed(sealed, context, scratch);
        const visibleRate = passRate(runs.map((run) => run.result));
        const hiddenRate = passRate(hidden.runs.map((run) => run.result));
        heldOut = {
          status: "measured",
          checks: hidden.runs.map((run) => run.result),
          visiblePassRate: visibleRate,
          heldOutPassRate: hiddenRate,
          gap: visibleRate - hiddenRate,
          judge: { processes: hidden.processes, assertionCalls: hidden.assertionCalls },
        };
        // The author never saw these, so their output is not handed back either.
        if (hiddenRate < 1) reasons.push("a held-out check failed");
        reasons.push(...hidden.problems);
      }
    }
    for (const violation of protectedPaths.violations) {
      reasons.push(`${violation.path} (${violation.category}) changed together with source`);
    }
    if (protectedPaths.violations.length > 0) {
      failures.push(
        `protected paths changed together with source: ${protectedPaths.violations.map((v) => v.path).join(", ")}`,
      );
    }

    const failed =
      !applied.applied ||
      failures.length > 0 ||
      (heldOut.status === "measured" && heldOut.heldOutPassRate < 1);
    // Where the checks never ran, every requirement is judged on no executed evidence.
    const requirements =
      requirementOutcomes ??
      (await assessRequirements(options.requirements ?? [], {
        checks: [],
        dir: checkout.dir,
        changed: change.patch.length > 0,
      }));
    const regression = regressionOf(runs.map((run) => run.result));
    const execution = executionOf(options.policy, {
      mode: dependencies.mode,
      lockfiles: await lockfileDigests(checkout.dir),
      treeSha256: null,
    });
    reasons.unshift(...blocked);
    const state = stateOf({ blocked, requirements, regression, execution, failed });
    const predicate: Predicate = {
      state,
      scope: (options.requirements ?? []).length > 0 ? "requirements" : "regression-only",
      reasons,
      base: { commit: change.baseCommit },
      change: {
        source: change.source,
        applied: applied.applied,
        files: applied.applied
          ? applied.result.changed.map(({ path, status }) => ({ path, status }))
          : [],
      },
      requirements,
      regression,
      checks: runs.map((run) => run.result),
      baseline,
      heldOut,
      protectedPaths: {
        changed: [...protectedPaths.changed],
        violations: [...protectedPaths.violations],
        allowed: [...protectedPaths.allowed],
      },
      coverage,
      mutation,
      producer: options.producer ?? { instructions: [] },
      environment: await environmentOf(checkout.dir, checks, dependencies.mode),
      execution,
      unmeasured: unmeasuredOf({
        checks: runs.map((run) => run.result),
        unmeasuredChecks,
        baseline,
        heldOut,
        coverage,
        mutation,
      }),
      verifier: { name: "swarm-verify", version: options.version },
    };
    const statement = buildStatement({
      treeSha256: applied.applied ? applied.result.treeSha256 : emptyTree,
      patchSha256: createHash("sha256").update(change.patch).digest("hex"),
      patchName: "change.patch",
      predicate,
    });
    const failureText = [...failures, ...inheritedText].join("\n\n");
    return { statement, patch: change.patch, failureText };
  } finally {
    await checkout.remove();
  }
}

/** The tree digest of nothing, for a change that never produced a tree. */
const emptyTree = createHash("sha256").update("").digest("hex");
