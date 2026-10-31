import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExecutionPolicy, Producer, Requirement, TrustedCheck } from "../api/request.ts";
import { detectChecks } from "../config/detect.ts";
import { readSwarmToml } from "../config/swarm-toml.ts";
import { executionOf, regressionOf, stateOf, unmeasuredOf } from "./assess.ts";
import { judgeCandidate } from "./candidate.ts";
import { type ResolvedChange, runGit } from "./change.ts";
import { applyChange, cloneBase } from "./checkout.ts";
import { allChecks, environmentOf, prepareDependencies, privateHome } from "./checks.ts";
import type { TestOutcome } from "./compare.ts";
import { dependencyIdentity } from "./deps.ts";
import { alteredSealed, measureBase, readSealed, swarmHome } from "./held-out.ts";
import { isolate } from "./isolate.ts";
import { artifactsOf } from "./paths.ts";
import { type MeasuredRun, reportPlans } from "./per-test.ts";
import type {
  Baseline,
  CheckResult,
  Coverage,
  HeldOut,
  Mutation,
  Predicate,
  Statement,
} from "./predicate.ts";
import { buildStatement } from "./predicate.ts";
import { assessRequirements } from "./requirements.ts";
import { testFileChanges } from "./test-files.ts";

export interface VerifyOptions {
  readonly workspace: string;
  readonly change: ResolvedChange;
  readonly requirements?: readonly Requirement[];
  readonly trustedChecks?: readonly TrustedCheck[];
  readonly policy: ExecutionPolicy;
  readonly behaviorChange?: "none" | "authorized";
  readonly producer?: Producer;
  readonly swarmHome?: string;
  readonly signal?: AbortSignal;
  readonly version: string;
}

export interface VerifyOutcome {
  readonly statement: Statement;
  readonly patch: Buffer;
  /** The files the statement's `logs` name, for the caller to write beside it. */
  readonly logs: readonly { readonly name: string; readonly text: string }[];
  /** What failed, as the checks printed it: the text a person or the agent acts on. */
  readonly failureText: string;
}

const skipped = (reason: string) => ({ status: "unmeasured" as const, reason });
const noTestFiles = {
  added: new Set<string>(),
  modified: new Set<string>(),
  deleted: new Set<string>(),
  moved: new Map<string, string>(),
  relocated: new Set<string>(),
};

export async function verifyChange(options: VerifyOptions): Promise<VerifyOutcome> {
  const change = options.change;
  const home = options.swarmHome ?? swarmHome();
  // A container mounts the scratch directory, and a docker VM (colima, Docker Desktop) shares the
  // user's home with it but not the system's temporary directory.
  const parent = options.policy.mode === "isolated" ? join(home, "work") : undefined;
  const checkout = await cloneBase(options.workspace, change.baseCommit, parent);
  try {
    // Read from the base before the change is applied, so the change cannot rewrite its judges.
    const config = await readSwarmToml(checkout.dir);
    const checks = allChecks(
      config?.checks ?? (await detectChecks(checkout.dir)),
      options.trustedChecks ?? [],
    );
    const sealed = await readSealed(options.workspace, home);
    const scratch = dirname(checkout.dir);
    const isolation =
      options.policy.mode === "isolated"
        ? await isolate(
            options.policy,
            checkout.dir,
            scratch,
            home,
            checks.map((check) => check.command),
          )
        : null;
    const context = {
      dir: checkout.dir,
      home: await privateHome(scratch),
      timeoutMs: (config?.timeoutMinutes ?? 20) * 60_000,
      signal: options.signal,
      sandbox: isolation !== null && "sandbox" in isolation ? isolation.sandbox : null,
      checkNetwork: options.policy.network,
    };
    const reasons: string[] = [];
    const failures: string[] = [];
    const inheritedText: string[] = [];
    const unmeasuredChecks: string[] = [];
    const blocked: string[] = [];
    const tamperedTree: string[] = [];
    const logs: { readonly name: string; readonly text: string }[] = [];
    if ((config?.allow.length ?? 0) > 0)
      reasons.push(
        "swarm.toml [protect] allow has no effect: candidate artifacts may change together",
      );
    if (isolation !== null && "unavailable" in isolation) blocked.push(isolation.unavailable);
    // An oracle whose sealed bytes changed judges nothing: the run stops before any check.
    const altered = sealed === null ? [] : await alteredSealed(options.workspace, sealed, home);
    if (altered.length > 0)
      blocked.push(
        `the sealed held-out files changed after they were sealed: ${altered.join(", ")}; seal them again`,
      );
    const isolated =
      isolation !== null && "sandbox" in isolation
        ? { image: isolation.sandbox.image, imageId: isolation.imageId }
        : null;
    let runs: CheckResult[] = [];
    let outcomes: TestOutcome[] = [];
    let baseline: Baseline = skipped("no checks are declared");
    let heldOut: HeldOut = skipped("no held-out checks are sealed for this workspace");
    let coverage: Coverage = skipped("the checks did not run");
    let mutation: Mutation = skipped("the checks did not run");
    const prepared = await prepareDependencies(
      options.workspace,
      config?.setup ?? null,
      options.policy.dependencies,
      context,
    );
    let dependencies = await dependencyIdentity(checkout.dir, prepared.mode);
    const plans = await reportPlans(checkout.dir, checks);
    let baseRuns: readonly MeasuredRun[] = [];
    if (checks.length > 0 && prepared.failure === null && blocked.length === 0) {
      const environment = await environmentOf(checkout.dir, checks, dependencies, isolated);
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
      baseRuns = measured.runs;
    }
    const applied = await applyChange(checkout, change.patch);
    const changed = applied.applied ? applied.result.changed : [];
    const artifacts = artifactsOf(changed.map((file) => file.path));
    const testFiles = applied.applied
      ? await testFileChanges(checkout.dir, change.baseCommit, changed)
      : noTestFiles;
    // A candidate that changes its lockfile or manifest gets its own dependencies, from its own files.
    const depsChanged = artifacts.some(
      (one) => one.category === "lockfiles" || one.category === "manifests",
    );
    let candidateSetup: MeasuredRun["run"] | null = null;
    if (
      depsChanged &&
      prepared.failure === null &&
      (prepared.mode === "prepared" || prepared.mode === "setup")
    ) {
      const again = await prepareDependencies(
        options.workspace,
        config?.setup ?? null,
        "prepare",
        context,
      );
      candidateSetup = again.failure;
      dependencies = await dependencyIdentity(checkout.dir, again.mode);
    } else if (depsChanged && prepared.mode === "linked") {
      reasons.push(
        "the candidate changes its lockfile or manifest, and linked dependencies cannot follow it",
      );
    }

    if (!applied.applied) {
      reasons.push(applied.reason);
      failures.push(applied.reason);
    } else if (checks.length === 0) {
      blocked.push("no checks are declared in swarm.toml or the project's manifests");
    } else if (prepared.failure !== null) {
      blocked.push("preparing the base's dependencies failed");
      failures.push(`setup failed:\n${prepared.failure.outputTail}`);
    } else if (candidateSetup !== null) {
      reasons.push("installing the candidate's dependencies from its lockfile failed");
      failures.push(`setup failed:\n${candidateSetup.outputTail}`);
    } else if (blocked.length === 0) {
      const judged = await judgeCandidate({
        checkout,
        checks,
        plans,
        context,
        scratch,
        sealed,
        home,
        baseRuns,
        testFiles,
        changed,
        artifacts,
        workspace: options.workspace,
        candidateTree: applied.result.gitTree,
        candidateSha256: applied.result.treeSha256,
        behaviorChange: options.behaviorChange ?? "none",
      });
      tamperedTree.push(...judged.problems);
      logs.push(...judged.logs);
      ({ runs, outcomes, coverage, mutation, heldOut } = judged);
      reasons.push(...judged.reasons);
      failures.push(...judged.failures);
      inheritedText.push(...judged.inherited);
      unmeasuredChecks.push(...judged.unmeasured);
    }

    const failed =
      !applied.applied ||
      failures.length > 0 ||
      (heldOut.status === "measured" && heldOut.heldOutPassRate < 1);
    const regression = regressionOf(runs);
    const requirements = await assessRequirements(options.requirements ?? [], {
      checks: runs,
      outcomes,
      dir: checkout.dir,
      readBase: async (path) => {
        const shown = await runGit(checkout.dir, ["show", `${change.baseCommit}:${path}`]);
        return shown.code === 0 ? shown.stdout.toString("utf8") : null;
      },
      sourceChanged: artifacts.filter((one) => one.category === "source").map((one) => one.path),
      changed: change.patch.length > 0,
      regression,
      freshDependencies: dependencies.mode === "prepared" && depsChanged && candidateSetup === null,
    });
    const execution = executionOf(options.policy, dependencies, isolated, tamperedTree);
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
        files: changed.map(({ path, status }) => ({ path, status })),
      },
      requirements,
      regression,
      checks: runs,
      baseline,
      heldOut,
      artifacts,
      testFiles: {
        added: [...testFiles.added],
        modified: [...testFiles.modified],
        deleted: [...testFiles.deleted],
        moved: [...testFiles.moved].map(([from, to]) => ({ from, to })),
        relocated: [...testFiles.relocated],
      },
      coverage,
      mutation,
      producer: options.producer ?? { instructions: [] },
      environment: await environmentOf(checkout.dir, checks, dependencies, isolated),
      execution,
      unmeasured: unmeasuredOf({
        checks: runs,
        unmeasuredChecks,
        baseline,
        heldOut,
        coverage,
        mutation,
      }),
      logs: logs.map(({ name, text }) => ({
        name,
        sha256: createHash("sha256").update(text).digest("hex"),
      })),
      verifier: { name: "swarm-verify", version: options.version },
    };
    const statement = buildStatement({
      treeSha256: applied.applied ? applied.result.treeSha256 : emptyTree,
      patchSha256: createHash("sha256").update(change.patch).digest("hex"),
      patchName: "change.patch",
      predicate,
    });
    const failureText = [...failures, ...inheritedText].join("\n\n");
    return { statement, patch: change.patch, logs, failureText };
  } finally {
    await checkout.remove();
  }
}

/** The tree digest of nothing, for a change that never produced a tree. */
const emptyTree = createHash("sha256").update("").digest("hex");
