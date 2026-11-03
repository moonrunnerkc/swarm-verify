import type { Execution, OverallState, Regression, RequirementOutcome } from "../api/outcome.ts";
import type { ExecutionPolicy } from "../api/request.ts";
import type { Baseline, CheckResult, Coverage, HeldOut, Mutation } from "./predicate.ts";

/** Sorted, then the first hundred: the same ids give the same list whatever order they came in. */
const capped = (ids: readonly string[]) => [...ids].sort().slice(0, 100);

/**
 * The candidate against the base across every check. A check judged test by test contributes
 * its test ids; a check judged by exit code contributes its name. A check that measured nothing
 * (no tests, or no comparison) leaves the regression unresolved rather than absent, and so does
 * a flaky test: its check is unresolved, and the test is named here.
 */
export function regressionOf(checks: readonly CheckResult[]): Regression {
  const newFailures: string[] = [];
  const inherited: string[] = [];
  const removed: string[] = [];
  const unresolved: string[] = [];
  const flaky: string[] = [];
  for (const check of checks) {
    const tests = check.tests;
    if (tests !== undefined) {
      newFailures.push(...tests.newFailures, ...tests.addedFailing, ...tests.expectationChanges);
      inherited.push(...tests.inherited);
      removed.push(...tests.removed);
      flaky.push(...tests.flaky);
    }
    if (check.result === "fail" || check.result === "error") {
      const counted =
        tests !== undefined &&
        tests.counts.newFailures +
          tests.counts.addedFailing +
          tests.counts.expectationChanges +
          tests.counts.removed >
          0;
      if (!counted) newFailures.push(`check ${check.name}`);
    } else if (check.result === "unresolved" || check.result === "no-tests") {
      unresolved.push(`check ${check.name}`);
    }
  }
  // Nothing ran against the candidate: nothing is known about a regression either way.
  const status =
    newFailures.length > 0 || removed.length > 0
      ? "found"
      : unresolved.length > 0 || checks.length === 0
        ? "unresolved"
        : "none";
  return {
    status,
    newFailures: capped(newFailures),
    inherited: capped(inherited),
    removed: capped(removed),
    unresolved: capped(unresolved),
    flaky: capped(flaky),
  };
}

export interface PreparedDependencies {
  readonly mode: Execution["dependencies"]["mode"];
  readonly lockfiles: Readonly<Record<string, string>>;
  readonly treeSha256: string | null;
  readonly refused?: string | null;
}

/** The container the checks ran in, or null for a host run. */
export interface Isolation {
  readonly image: string;
  /** The image's content digest and architecture as the daemon reports them. */
  readonly imageId: string;
}

/**
 * What the execution policy asked for against what the run did. A host run is never reported as
 * isolated, and a request for isolation is never met by one.
 */
export function executionOf(
  policy: ExecutionPolicy,
  prepared: PreparedDependencies,
  isolation: Isolation | null,
  problems: readonly string[] = [],
): Execution {
  const found = [...problems];
  const reproducible = prepared.mode === "prepared" && prepared.treeSha256 !== null;
  const note =
    prepared.mode === "linked"
      ? "linked, not reproducible: the caller's installed tree was used as it stood"
      : prepared.mode === "setup"
        ? "prepared by the base's declared setup command; its result is not digested"
        : prepared.mode === "refused"
          ? `not prepared: ${prepared.refused ?? "the preparation was refused"}`
          : prepared.mode === "none"
            ? "no dependencies were prepared"
            : reproducible
              ? "prepared from the lockfile and digested"
              : "prepared from the lockfile; the installed tree was not digested";
  if (policy.mode === "isolated" && isolation === null) {
    found.push("isolated execution was requested and this run did not provide it");
  }
  if (isolation === null && policy.network === "closed") {
    found.push("a closed network was requested and a host run cannot close it");
  }
  const network = isolation !== null && policy.network === "closed" ? "closed" : "open";
  return {
    mode: isolation === null ? "host" : "isolated",
    statement:
      isolation === null
        ? "host, not isolated"
        : `isolated: docker ${isolation.image}, network ${network} for checks and open only while dependencies were prepared`,
    network,
    image: isolation === null ? null : `${isolation.image} (${isolation.imageId})`,
    dependencies: {
      mode: prepared.mode,
      reproducible,
      lockfiles: { ...prepared.lockfiles },
      treeSha256: prepared.treeSha256,
      note,
    },
    policyMet: found.length === 0,
    problems: found,
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
