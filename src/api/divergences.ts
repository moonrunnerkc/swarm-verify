import { type Observations, observationDifferences } from "../verify/observations.ts";
import type { Statement, TestJudgment } from "../verify/predicate.ts";
import { describeRuns } from "../verify/reruns.ts";
import type { VerifyResult } from "./result.ts";

type Predicate = Statement["predicate"];
type Check = Predicate["checks"][number];

const listed = [
  "fixed",
  "newFailures",
  "inherited",
  "removed",
  "expectationChanges",
  "witnesses",
] as const;

/** Where a run's judgment lists a test, in words; a preserved, added or skipped test is in none. */
function placeOf(tests: TestJudgment | undefined, id: string): string {
  const key = listed.find((one) => tests?.[one].includes(id));
  return key === undefined ? "listed nowhere (preserved, added or skipped)" : `among ${key}`;
}

/**
 * A test flaky in one run and not the other, one line each: the flaky side's runs, and where the
 * other side put it. A recording made without reruns let one failing run decide.
 */
function flakyDivergences(
  name: string,
  recorded: Check,
  replayed: Check | undefined,
  recordedReruns: number,
): { readonly lines: string[]; readonly ids: ReadonlySet<string> } {
  const before = new Set(recorded.tests?.flaky ?? []);
  const after = new Set(replayed?.tests?.flaky ?? []);
  const line = (
    id: string,
    flakyIn: "recording" | "replay",
    tests: TestJudgment | undefined,
    otherTests: TestJudgment | undefined,
  ) => {
    const runs = tests?.reruns.find((one) => one.id === id);
    const other =
      flakyIn === "replay"
        ? `the recording${recordedReruns === 0 ? ", which reran no test" : ""}`
        : "the replay";
    return `check ${name}: ${runs === undefined ? id : describeRuns(runs)} is flaky in the ${flakyIn} and ${placeOf(otherTests, id)} in ${other}`;
  };
  const lines = [
    ...[...after]
      .filter((id) => !before.has(id))
      .map((id) => line(id, "replay", replayed?.tests, recorded.tests)),
    ...[...before]
      .filter((id) => !after.has(id))
      .map((id) => line(id, "recording", recorded.tests, replayed?.tests)),
  ];
  return { lines, ids: new Set([...before, ...after]) };
}

/**
 * Every recorded check, test and requirement result the replay does not reproduce. Test ids are
 * compared as sets. A test flaky in either run is compared by its flakiness alone: flaky in both
 * agrees, and flaky in one is a single divergence that says so, rather than a difference in
 * every list it moved between.
 */
export function divergencesOf(
  recorded: Predicate,
  replayed: VerifyResult,
  observed: { readonly recorded: Observations; readonly replayed: Observations } | null = null,
): string[] {
  const found: string[] = [];
  const same = (what: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      found.push(`${what}: recorded ${JSON.stringify(before)}, replayed ${JSON.stringify(after)}`);
    }
  };
  same("state", recorded.state, replayed.state);
  same("execution", recorded.execution.mode, replayed.execution.mode);
  same("execution network", recorded.execution.network, replayed.execution.network);
  same("execution image", recorded.execution.image, replayed.execution.image);
  same(
    "dependency preparation",
    recorded.execution.dependencies?.mode,
    replayed.execution.dependencies?.mode,
  );
  const heldOut = (one: Predicate["heldOut"] | undefined) =>
    one === undefined
      ? "not recorded"
      : one.status === "measured"
        ? {
            pass: one.heldOutPassRate,
            checks: one.checks.map((check) => [check.name, check.result]),
          }
        : one.status;
  same("held-out", heldOut(recorded.heldOut), heldOut(replayed.heldOut));
  same("regression", recorded.regression.status, replayed.regression.status);
  same(
    "lockfiles",
    recorded.execution.dependencies.lockfiles,
    replayed.execution.dependencies.lockfiles,
  );
  for (const check of replayed.checks)
    if (!recorded.checks.some((one) => one.name === check.name))
      found.push(`check ${check.name}: not in the recording, ran in the replay`);
  if (observed !== null)
    found.push(...observationDifferences(observed.recorded, observed.replayed));
  for (const check of recorded.checks) {
    const again = replayed.checks.find((one) => one.name === check.name);
    same(`check ${check.name}`, check.result, again?.result ?? "not run");
    if (observed !== null) continue;
    const flaky = flakyDivergences(check.name, check, again, recorded.policy.reruns ?? 0);
    found.push(...flaky.lines);
    for (const key of listed) {
      // Sets of test ids: a statement recorded before they were sorted still compares.
      const ids = (list: readonly string[] | undefined) =>
        (list ?? []).filter((id) => !flaky.ids.has(id)).sort();
      same(`check ${check.name} ${key}`, ids(check.tests?.[key]), ids(again?.tests?.[key]));
    }
  }
  for (const requirement of recorded.requirements) {
    const again = replayed.requirements.find((one) => one.id === requirement.id);
    same(`requirement ${requirement.id}`, requirement.status, again?.status ?? "not judged");
    const refs = (list: readonly { kind: string; ref: string; outcome: string }[] | undefined) =>
      (list ?? []).map((one) => `${one.kind} ${one.ref}: ${one.outcome}`).sort();
    same(
      `requirement ${requirement.id} evidence`,
      refs(requirement.evidence),
      refs(again?.evidence),
    );
  }
  for (const requirement of replayed.requirements)
    if (!recorded.requirements.some((one) => one.id === requirement.id))
      found.push(`requirement ${requirement.id}: not in the recording, judged in the replay`);
  return found;
}

/**
 * Where the replay ran on something other than what the recording ran on: toolchain, platform or
 * installed dependency tree. Reported apart from divergences, since outcomes may still agree.
 */
export function environmentDrift(recorded: Predicate, replayed: VerifyResult): string[] {
  const keys = ["node", "platform", "git", "dependencyTreeSha256"] as const;
  return keys
    .filter((key) => recorded.environment[key] !== replayed.environment[key])
    .map(
      (key) =>
        `${key}: recorded ${JSON.stringify(recorded.environment[key])}, replayed ${JSON.stringify(replayed.environment[key])}`,
    );
}
