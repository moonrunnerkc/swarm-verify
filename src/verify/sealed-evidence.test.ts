import { describe, expect, it } from "vitest";
import type { MeasuredRun } from "./per-test.ts";
import type { CheckResult } from "./predicate.ts";
import { sealedOutcomes } from "./sealed-evidence.ts";
import type { SealedSet } from "./sealed-store.ts";
import type { TestReport } from "./test-report.ts";

const sealed: SealedSet = {
  glob: "test/a.authored.test.ts",
  authority: "independently-generated",
  checks: [{ name: "authored-R1", command: "npx vitest run", kind: "test", requirements: ["R1"] }],
  files: [{ path: "test/a.authored.test.ts", sha256: "0".repeat(64) }],
};

const run = (result: CheckResult["result"], report: TestReport | null): MeasuredRun => ({
  run: {
    result: {
      name: "authored-R1",
      command: "npx vitest run",
      kind: "test",
      authority: "independently-generated",
      result,
      collected: null,
      exitCode: result === "pass" ? 0 : 1,
      durationMs: 1,
      outputSha256: "0".repeat(64),
    },
    output: "",
    outputTail: "",
    notRun: null,
  },
  evidence: { runner: report === null ? null : "vitest", report, unreadable: null, judge: null },
});

const file = "test/a.authored.test.ts";

describe("sealed tests as outcomes", () => {
  it("drops the one failing entry a file that could not load at the base stood for", () => {
    const base = run("fail", { [`${file}::${file}`]: { status: "fail", file } });
    const after = run("pass", { [`${file}::sorts`]: { status: "pass", file } });
    const outcomes = sealedOutcomes(sealed, [base], [after]);
    expect(outcomes.map((one) => [one.id, one.classification, one.authority])).toEqual([
      [`${file}::sorts`, "fixed", "independently-generated"],
    ]);
    expect(outcomes[0]?.requirements).toEqual(["R1"]);
  });

  it("calls a sealed test that passed at the base and is gone on the candidate removed", () => {
    const base = run("pass", { [`${file}::sorts`]: { status: "pass", file } });
    const after = run("fail", {});
    expect(sealedOutcomes(sealed, [base], [after]).map((one) => one.classification)).toEqual([
      "removed",
    ]);
  });

  it("falls back to the check's exit code where no report was read", () => {
    const outcomes = sealedOutcomes(sealed, [run("fail", null)], [run("fail", null)]);
    expect(outcomes).toMatchObject([
      { id: "held-out authored-R1", classification: "new-failure", base: "fail", after: "fail" },
    ]);
  });
});
