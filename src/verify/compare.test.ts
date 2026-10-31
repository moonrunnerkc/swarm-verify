import { describe, expect, it } from "vitest";
import { type CheckRuns, compareRuns, type TestFileChanges } from "./compare.ts";
import type { TestReport } from "./test-report.ts";

const report = (entries: Record<string, "pass" | "fail" | "skip">): TestReport =>
  Object.fromEntries(
    Object.entries(entries).map(([id, status]) => [
      id,
      { status, file: id.split("::")[0] ?? null },
    ]),
  );

const none: TestFileChanges = {
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
  moved: new Map(),
  relocated: new Set(),
};

const classes = (outcomes: ReturnType<typeof compareRuns>) =>
  Object.fromEntries(outcomes.map((one) => [one.id, one.classification]));

describe("classifying tests across the base and the candidate", () => {
  it("separates fixed, preserved, inherited and new failures in an untouched suite", () => {
    const base = report({
      "t.js::a": "pass",
      "t.js::b": "fail",
      "t.js::c": "fail",
      "t.js::d": "pass",
    });
    const after = report({
      "t.js::a": "pass",
      "t.js::b": "pass",
      "t.js::c": "fail",
      "t.js::d": "fail",
    });
    const runs: CheckRuns = { base, obligation: after, candidate: after, witness: null };
    expect(classes(compareRuns(runs, none, "none"))).toEqual({
      "t.js::a": "preserved",
      "t.js::b": "fixed",
      "t.js::c": "inherited",
      "t.js::d": "new-failure",
    });
  });

  it("labels a new test file's tests as implementation-authored, with their state before", () => {
    const base = report({ "t.js::a": "pass" });
    const after = report({ "t.js::a": "pass", "n.js::neg": "pass", "n.js::old": "pass" });
    const witness = report({ "t.js::a": "pass", "n.js::old": "pass" });
    const changes = { ...none, added: new Set(["n.js"]) };
    const outcomes = compareRuns(
      { base, obligation: after, candidate: after, witness },
      changes,
      "none",
    );
    const neg = outcomes.find((one) => one.id === "n.js::neg");
    expect(neg).toMatchObject({ classification: "added", origin: "implementation-authored" });
    expect(neg?.before).toBe("fail");
    expect(outcomes.find((one) => one.id === "n.js::old")?.before).toBe("pass");
  });

  it("refuses a rewritten expectation that rescues a failing original", () => {
    const base = report({ "t.js::half": "fail" });
    const obligation = report({ "t.js::half": "fail" });
    const candidate = report({ "t.js::half": "pass" });
    const witness = report({ "t.js::half": "pass" });
    const changes = { ...none, modified: new Set(["t.js"]) };
    const runs = { base, obligation, candidate, witness };
    expect(classes(compareRuns(runs, changes, "none"))).toEqual({
      "t.js::half": "expectation-changed",
    });
    // Authorized, it still has to fail against the base's source to show the new behavior.
    expect(classes(compareRuns(runs, changes, "authorized"))).toEqual({
      "t.js::half": "expectation-changed",
    });
  });

  it("supersedes an old expectation for an authorized change the new version witnesses", () => {
    const base = report({ "t.js::fmt": "pass" });
    const obligation = report({ "t.js::fmt": "fail" });
    const candidate = report({ "t.js::fmt": "pass" });
    const witness = report({ "t.js::fmt": "fail" });
    const changes = { ...none, modified: new Set(["t.js"]) };
    const runs = { base, obligation, candidate, witness };
    expect(classes(compareRuns(runs, changes, "authorized"))).toEqual({
      "t.js::fmt": "superseded",
    });
    expect(classes(compareRuns(runs, changes, "none"))).toEqual({
      "t.js::fmt": "expectation-changed",
    });
  });

  it("follows a moved test file by its tests' names rather than calling them removed", () => {
    const base = report({ "old/t.js::a": "pass", "old/t.js::b": "fail" });
    const candidate = report({ "new/t.js::a": "pass", "new/t.js::b": "pass" });
    const changes = { ...none, moved: new Map([["old/t.js", "new/t.js"]]) };
    const outcomes = compareRuns(
      { base, obligation: candidate, candidate, witness: null },
      changes,
      "none",
    );
    expect(classes(outcomes)).toEqual({ "old/t.js::a": "renamed", "old/t.js::b": "fixed" });
    expect(outcomes[0]?.movedTo).toBe("new/t.js::a");
  });

  it("calls a deleted test file's tests removed, and a missing original a new failure", () => {
    const base = report({ "gone.js::a": "pass", "t.js::b": "pass" });
    const after = report({ "t.js::t.js": "fail" });
    const changes = { ...none, deleted: new Set(["gone.js"]) };
    expect(
      classes(
        compareRuns({ base, obligation: after, candidate: after, witness: null }, changes, "none"),
      ),
    ).toEqual({
      "gone.js::a": "removed",
      "t.js::b": "new-failure",
      "t.js::t.js": "added-failing",
    });
  });
});
