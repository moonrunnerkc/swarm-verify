import type { Execution, OverallState, Regression, RequirementOutcome } from "../api/outcome.ts";
import type { ExecutionPolicy } from "../api/request.ts";
import type { Baseline, CheckResult, Coverage, HeldOut, Mutation } from "./predicate.ts";

const capped = (ids: readonly string[]) => ids.slice(0, 100);

/**
 * The candidate against the base across every check. A check judged test by test contributes
 * its test ids; a check judged by exit code contributes its name.
 */
export function regressionOf(checks: readonly CheckResult[]): Regression {
  const newFailures: string[] = [];
  const inherited: string[] = [];
  const removed: string[] = [];
  const unresolved: string[] = [];
  for (const check of checks) {
    const tests = check.tests;
    if (tests !== undefined) {
      newFailures.push(...tests.regressed, ...tests.newlyFailing);
      inherited.push(...tests.preExisting);
      removed.push(...tests.deleted);
    }
    if (check.result === "fail" || check.result === "error") {
      if (tests === undefined || tests.counts.regressed + tests.counts.newlyFailing === 0) {
        newFailures.push(`check ${check.name}`);
      }
    } else if (check.result === "pre-existing-failure" || check.result === "unmeasured") {
      unresolved.push(`check ${check.name}`);
    }
  }
  const status =
    newFailures.length > 0 || removed.length > 0
      ? "found"
      : unresolved.length > 0
        ? "unresolved"
        : "none";
  return {
    status,
    newFailures: capped(newFailures),
    inherited: capped(inherited),
    removed: capped(removed),
    unresolved: capped(unresolved),
  };
}

export interface PreparedDependencies {
  readonly mode: Execution["dependencies"]["mode"];
  readonly lockfiles: Readonly<Record<string, string>>;
  readonly treeSha256: string | null;
}

/** What the execution policy asked for against what the run did. */
export function executionOf(policy: ExecutionPolicy, prepared: PreparedDependencies): Execution {
  const problems: string[] = [];
  const reproducible = prepared.mode === "prepared" && prepared.treeSha256 !== null;
  const note =
    prepared.mode === "linked"
      ? "linked, not reproducible: the caller's installed tree was used as it stood"
      : prepared.mode === "setup"
        ? "prepared by the base's declared setup command; its result is not digested"
        : prepared.mode === "none"
          ? "no dependencies were prepared"
          : reproducible
            ? "prepared from the lockfile and digested"
            : "prepared from the lockfile; the installed tree was not digested";
  if (policy.mode === "isolated") {
    problems.push("isolated execution was requested and this run did not provide it");
  }
  if (policy.network === "closed") {
    problems.push("a closed network was requested and a host run cannot close it");
  }
  return {
    mode: "host",
    statement: "host, not isolated",
    network: "open",
    image: null,
    dependencies: {
      mode: prepared.mode,
      reproducible,
      lockfiles: { ...prepared.lockfiles },
      treeSha256: prepared.treeSha256,
      note,
    },
    policyMet: problems.length === 0,
    problems,
  };
}

/**
 * The overall state, derived only here. Blocked when nothing could be measured for a reason
 * outside the candidate; complete only when every required requirement is satisfied, nothing
 * regressed or stayed unresolved, and the execution policy was met.
 */
export function stateOf(input: {
  readonly blocked: readonly string[];
  readonly requirements: readonly RequirementOutcome[];
  readonly regression: Regression;
  readonly execution: Execution;
  readonly failed: boolean;
}): OverallState {
  if (input.blocked.length > 0) return "blocked";
  const required = input.requirements.filter((requirement) => requirement.required);
  if (required.some((requirement) => requirement.status === "blocked")) return "blocked";
  const satisfied = required.every((requirement) => requirement.status === "satisfied");
  return satisfied &&
    !input.failed &&
    input.regression.status === "none" &&
    input.execution.policyMet
    ? "complete"
    : "incomplete";
}

/** Every part of the run that measured nothing, each with why. */
export function unmeasuredOf(input: {
  readonly checks: readonly CheckResult[];
  readonly unmeasuredChecks: readonly string[];
  readonly baseline: Baseline;
  readonly heldOut: HeldOut;
  readonly coverage: Coverage;
  readonly mutation: Mutation;
}): string[] {
  const { baseline, heldOut, coverage, mutation } = input;
  return [
    ...input.checks
      .filter((check) => check.result === "pre-existing-failure")
      .map(
        (check) =>
          `check ${check.name}: fails at the base commit (output sha256:${check.baseOutputSha256}) and still fails`,
      ),
    ...input.unmeasuredChecks,
    ...(baseline.status === "measured" ? baseline.heldOut : [])
      .filter((check) => check.result === "pass")
      .map(
        (check) =>
          `held-out check ${check.name}: passes at the base commit, so it does not tell this change apart`,
      ),
    ...(
      [
        ["baseline", baseline],
        ["held-out", heldOut],
        ["coverage", coverage],
        ["mutation", mutation],
      ] as const
    ).flatMap(([name, value]) =>
      value.status === "unmeasured" ? [`${name}: ${value.reason}`] : [],
    ),
  ];
}
