import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CheckRun } from "./checks.ts";
import { judgeCheck } from "./judgment.ts";
import { parseJunit, type TestEvidence, type TestReport } from "./test-report.ts";

// The swarm trial on astropy__astropy-12907 in the evaluation run 2026-10-29T16-12-15-988Z got
// `unmeasured`: its check, `python3 -m pytest -q`, could not import astropy in the clean
// checkout at either commit. Replayed in that task's image with the trial's change (from its
// ledger), the task's conda environment active and the workspace's build products copied into
// the checkout by a `[verify] setup` command, the verifier at 84ef15ebf wrote these two junit
// reports. Failure, error and skip bodies are trimmed; every testcase and its status is kept.
const report = (name: string) =>
  parseJunit(
    gunzipSync(readFileSync(join(import.meta.dirname, "fixtures", "reports", name))).toString(),
  ) as TestReport;

const run = (exitCode: number): CheckRun => ({
  result: {
    name: "test",
    command: "python3 -m pytest -q",
    kind: "test",
    authority: "pre-existing",
    result: exitCode === 0 ? "pass" : "fail",
    collected: null,
    exitCode,
    durationMs: 1,
    outputSha256: "0".repeat(64),
  },
  output: "",
  outputTail: "",
  notRun: null,
});
const evidence = (value: TestReport, runner: TestEvidence["runner"]): TestEvidence => ({
  runner,
  report: runner === null ? null : value,
  unreadable: null,
  judge: null,
});

describe("replaying an evaluation trial the exit code left unmeasured", () => {
  const base = report("replay-astropy-12907-base.xml.gz");
  const head = report("replay-astropy-12907-head.xml.gz");

  const none = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
    moved: new Map<string, string>(),
    movedAndEdited: new Map<string, string>(),
    relocated: new Set<string>(),
  };
  const judge = (runner: TestEvidence["runner"]) => {
    const candidate = { run: run(1), evidence: evidence(head, runner) };
    return judgeCheck({
      base: { run: run(1), evidence: evidence(base, runner) },
      obligation: candidate,
      candidate,
      witness: null,
      changes: none,
      behaviorChange: "none",
      reruns: [],
    });
  };

  it("is measured test by test, with the suite failing at both commits", () => {
    const judged = judge("pytest");
    expect(judged.run.result.result).toBe("inherited-failures");
    expect(judged.unmeasured).toBeNull();
    expect(judged.run.result.tests?.counts).toEqual({
      preserved: 17218,
      renamed: 0,
      fixed: 0,
      newFailures: 0,
      inherited: 2483,
      removed: 0,
      superseded: 0,
      expectationChanges: 0,
      added: 0,
      addedFailing: 0,
      witnesses: 0,
      skipped: 2350,
      flaky: 0,
    });
  });

  it("would be unresolved judged by exit code, never inherited", () => {
    expect(judge(null).run.result.result).toBe("unresolved");
  });
});
