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
export function divergencesOf(recorded: Predicate, replayed: VerifyResult): string[] {
  const found: string[] = [];
  const same = (what: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      found.push(`${what}: recorded ${JSON.stringify(before)}, replayed ${JSON.stringify(after)}`);
    }
  };
  same("state", recorded.state, replayed.state);
  same("execution", recorded.execution.mode, replayed.execution.mode);
  same("regression", recorded.regression.status, replayed.regression.status);
  same(
    "lockfiles",
    recorded.execution.dependencies.lockfiles,
    replayed.execution.dependencies.lockfiles,
  );
  for (const check of recorded.checks) {
    const again = replayed.checks.find((one) => one.name === check.name);
    same(`check ${check.name}`, check.result, again?.result ?? "not run");
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
  }
  return found;
}
