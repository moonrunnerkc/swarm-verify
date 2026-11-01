import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckRun } from "./checks.ts";
import type { TestFileChanges } from "./compare.ts";
import { type JudgmentInput, judgeCheck } from "./judgment.ts";
import { type MeasuredRun, mutantOutcome } from "./per-test.ts";
import { parseReport, type Runner, type TestEvidence, type TestReport } from "./test-report.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "reports", name), "utf8");

// Recorded from one tiny project per runner (pytest 9.0.3, jest 29.7.0, vitest 4.1.11,
// mocha 11.8.0, go 1.26.3) with the project root rewritten to /work/calc. Between the two runs
// the change fixes `fixed`, breaks `broken`, leaves `red` failing, deletes `gone` and adds `added`.
const recorded: readonly (readonly [Runner, string, string])[] = [
  ["pytest", "pytest-base.xml", "pytest-head.xml"],
  ["jest", "jest-base.json", "jest-head.json"],
  ["vitest", "vitest-base.json", "vitest-head.json"],
  ["mocha", "mocha-base.json", "mocha-head.json"],
  ["go", "go-base.jsonl", "go-head.jsonl"],
];
const read = (runner: Runner, name: string) =>
  parseReport(runner, fixture(name), "/work/calc", "example.com/calc") as TestReport;
const named = (ids: readonly string[]) => ids.map((id) => id.replace(/^.*(?:::|\s|_)/, ""));

const none: TestFileChanges = {
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
  moved: new Map(),
  relocated: new Set(),
};

const checkRun = (exitCode: number | null, notRun: string | null = null): CheckRun => ({
  result: {
    name: "test",
    command: "python3 -m pytest -q",
    kind: "test",
    authority: "pre-existing",
    result: notRun !== null ? "error" : exitCode === 0 ? "pass" : "fail",
    collected: null,
    exitCode,
    durationMs: 1,
    outputSha256: "0".repeat(64),
  },
  output: "1 failed, 3 passed",
  outputTail: "1 failed, 3 passed",
  notRun,
});
const evidence = (report: TestReport | null, extra: Partial<TestEvidence> = {}): TestEvidence => ({
  runner: "pytest",
  report,
  unreadable: null,
  judge: null,
  ...extra,
});
const measured = (
  exitCode: number | null,
  value: TestEvidence,
  notRun: string | null = null,
): MeasuredRun => ({
  run: checkRun(exitCode, notRun),
  evidence: value,
});
/** The candidate changed no test file: the obligation run is the candidate run. */
const judge = (base: MeasuredRun, head: MeasuredRun, extra: Partial<JudgmentInput> = {}) =>
  judgeCheck({
    base,
    obligation: head,
    candidate: head,
    witness: null,
    changes: none,
    behaviorChange: "none",
    ...extra,
  });

const pass = (file = "tests/test_a") => ({ status: "pass" as const, file });
const fail = (file = "tests/test_a") => ({ status: "fail" as const, file });
const skip = (file = "tests/test_a") => ({ status: "skip" as const, file });

describe.each(recorded)("judging %s reports test by test", (runner, baseFile, headFile) => {
  const base = measured(1, evidence(read(runner, baseFile), { runner }));
  const head = measured(1, evidence(read(runner, headFile), { runner }));

  it("tells fixed, new, inherited and added tests apart, and a vanished test is a new failure", () => {
    const tests = judge(base, head).run.result.tests;
    expect(named(tests?.fixed ?? [])).toEqual([expect.stringMatching(/fixed$/i)]);
    expect(named(tests?.newFailures ?? []).sort()).toEqual(
      [expect.stringMatching(/broken$/i), expect.stringMatching(/gone$/i)].sort(),
    );
    expect(named(tests?.inherited ?? [])).toEqual([expect.stringMatching(/red$/i)]);
    expect(tests?.counts).toMatchObject({ preserved: 1, added: 1, addedFailing: 0 });
  });

  it("calls a test removed only where the candidate deleted the file that held it", () => {
    const gone = Object.entries(read(runner, baseFile)).find(([id]) => /gone$/i.test(id));
    const file = gone?.[1].file ?? "";
    const tests = judge(base, head, { changes: { ...none, deleted: new Set([file]) } }).run.result
      .tests;
    expect(named(tests?.removed ?? []).some((id) => /gone$/i.test(id))).toBe(true);
  });
});

describe("a check's result from its reports", () => {
  it("passes with inherited failures where a test was fixed though the command fails at both commits", () => {
    const base = { "a::fixed": fail(), "a::red": fail(), "a::stays": pass() };
    const head = { "a::fixed": pass(), "a::red": fail(), "a::stays": pass() };
    const judged = judge(measured(1, evidence(base)), measured(1, evidence(head)));
    expect(judged.run.result.result).toBe("inherited-failures");
    expect(judged.run.result.tests).toMatchObject({ fixed: ["a::fixed"], inherited: ["a::red"] });
    expect(judged.failure).toBeNull();
    expect(judged.reasons).toEqual([
      "check test: 1 test(s) fail at the base commit and still fail, which does not block: a::red",
    ]);
  });

  it("fails on a new failure, a vanished test and a new failing test", () => {
    const base = { "a::one": pass(), "a::two": pass() };
    for (const head of [
      { "a::one": pass(), "a::two": fail() },
      { "a::one": pass() },
      { "a::one": pass(), "a::two": pass(), "a::new": fail() },
    ]) {
      const judged = judge(measured(0, evidence(base)), measured(1, evidence(head)));
      expect(judged.run.result.result).toBe("fail");
      expect(judged.failure).toContain("$ python3 -m pytest -q");
    }
  });

  it("fails a command that exits worse though every test in its report passes", () => {
    const report = { "a::one": pass() };
    const judged = judge(measured(0, evidence(report)), measured(2, evidence(report)));
    expect(judged.run.result.result).toBe("fail");
    expect(judged.reasons).toEqual([
      "check test exits 2 against the candidate and 0 at the base commit, though no test in its report fails",
    ]);
  });

  it("does not call an authorized change's failing old expectation an unexplained exit", () => {
    const report = { "a::fmt": pass() };
    const obligation = measured(1, evidence({ "a::fmt": fail() }));
    const judged = judgeCheck({
      base: measured(0, evidence(report)),
      obligation,
      candidate: measured(0, evidence(report)),
      witness: measured(1, evidence({ "a::fmt": fail() })),
      changes: { ...none, modified: new Set(["tests/test_a"]) },
      behaviorChange: "authorized",
    });
    expect(judged.run.result.tests?.superseded).toEqual(["a::fmt"]);
    expect(judged.run.result.result).toBe("pass");
    expect(judged.reasons.join("\n")).not.toContain("no test in its report fails");
  });

  it("is unresolved where a command could not run or a report did not parse", () => {
    const report = { "a::one": pass() };
    const unparsed = evidence(null, { unreadable: "the pytest report could not be parsed" });
    const timedOut = evidence(null, { unreadable: "the command could not run: it timed out" });
    expect(judge(measured(0, evidence(report)), measured(1, unparsed))).toMatchObject({
      run: { result: { result: "unresolved" } },
      unmeasured:
        "check test: against the base's tests, the pytest report could not be parsed; with the candidate, the pytest report could not be parsed",
    });
    expect(
      judge(measured(0, timedOut), measured(null, evidence(report), "it timed out")),
    ).toMatchObject({
      run: { result: { result: "unresolved" } },
    });
  });

  it("leaves unresolved a run where no test passes against the candidate, never a pass", () => {
    // pytest with a module that fails to import at both commits and nothing else collected.
    const report = { "astropy.coordinates.tests.test_frames": fail(), "a::slow": skip() };
    const judged = judge(measured(2, evidence(report)), measured(2, evidence(report)));
    expect(judged.run.result.result).toBe("unresolved");
    expect(judged.unmeasured).toBe(
      "check test: no test in its report passes against the candidate (2 collected)",
    );
  });

  it("reads an empty report as no tests", () => {
    const judged = judge(measured(0, evidence({})), measured(0, evidence({})));
    expect(judged.run.result.result).toBe("no-tests");
    expect(judged.unmeasured).toBe("check test: the run collected no tests");
  });

  it("is unresolved, never inherited, where only exit codes say both commits fail", () => {
    const unrecognized = evidence(null, { runner: null });
    const judged = judge(measured(1, unrecognized), measured(1, unrecognized));
    expect(judged.run.result.result).toBe("unresolved");
    expect(judged.reasons[0]).toBe(
      "check test: no runner report is read for it, so its exit code and printed summary judged it",
    );
  });

  it("fails a check whose assertions the change patched, but not one the base run shared", () => {
    const report = { "a::one": pass() };
    const patched = evidence(report, { judge: "the code under test changed node:assert.equal" });
    expect(judge(measured(0, evidence(report)), measured(0, patched)).run.result.result).toBe(
      "fail",
    );
    const exited = evidence(report, {
      judge: "2 process(es) exited before the judge could check them",
    });
    const exitedAgain = evidence(report, {
      judge: "3 process(es) exited before the judge could check them",
    });
    expect(judge(measured(0, exited), measured(0, exitedAgain)).run.result.result).toBe("pass");
  });
});

describe("a mutant against its reports", () => {
  const run = (exitCode: number, report: TestReport | null, notRun: string | null = null) =>
    measured(exitCode, evidence(report), notRun);

  it("is killed only when a test passing with the candidate fails under it", () => {
    const head = run(1, { "a::one": pass(), "a::red": fail() });
    expect(mutantOutcome(head, run(1, { "a::one": fail(), "a::red": fail() }))).toBe("killed");
    expect(mutantOutcome(head, run(1, { "a::one": pass(), "a::red": fail() }))).toBe("survived");
  });

  it("tells a runner that crashed or timed out apart from a test that caught the mutant", () => {
    const head = run(0, { "a::one": pass() });
    expect(mutantOutcome(head, run(1, null))).toBe("runner-crash");
    expect(mutantOutcome(head, run(1, {}))).toBe("runner-crash");
    expect(mutantOutcome(head, run(1, null, "it timed out"))).toBe("timeout");
  });
});

// depose (session 20261101T155037-25f560): the replay found the same 17 inherited failures in
// another order, read it as a divergence, and with more than 100 the capped list could hold
// different tests.
describe("the lists a check reports", () => {
  it("are sorted before they are capped, whatever order the runner reported in", () => {
    const ids = Array.from({ length: 150 }, (_, at) => `t::case_${String(at).padStart(3, "0")}`);
    const report = (order: readonly string[]): TestReport =>
      Object.fromEntries(order.map((id) => [id, fail()]));
    const forward = measured(1, evidence(report(ids)));
    const backward = measured(1, evidence(report([...ids].reverse())));
    const one = judge(forward, forward).run.result.tests?.inherited;
    const other = judge(backward, backward).run.result.tests?.inherited;
    expect(one).toEqual(ids.slice(0, 100));
    expect(other).toEqual(one);
  });
});
