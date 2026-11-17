import { describe, expect, it } from "vitest";
import { classifyRun, expectationOf, summarize } from "./classify.mjs";

const check = (name, result, counts = {}) => ({
  name,
  result,
  tests: {
    counts: { newFailures: 0, addedFailing: 0, expectationChanges: 0, removed: 0, ...counts },
  },
});

function printed(state, overrides = {}) {
  return {
    state,
    reasons: [],
    checks: [check("test", "pass")],
    requirements: [],
    heldOut: { status: "measured", checks: [check("held-out", "pass")] },
    ...overrides,
  };
}

const ran = (status, result) => ({
  status,
  signal: null,
  stdout: result === undefined ? "" : `progress\n${JSON.stringify(result)}\n`,
  stderr: "",
});

const failedHeldOut = { status: "measured", checks: [check("held-out", "fail")] };

const one = (id, kind, expected, outcome, technique = kind === "cheat" ? "t" : null) => ({
  id,
  kind,
  technique,
  expected,
  outcome,
});

describe("classifying one verifier run", () => {
  it("accepts a complete result and rejects an incomplete one only on failed evidence", () => {
    expect(classifyRun(ran(0, printed("complete"))).outcome).toBe("accepted");
    const rejected = classifyRun(ran(1, printed("incomplete", { heldOut: failedHeldOut })));
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.evidence).toEqual(["held-out check held-out failed"]);
    const changed = printed("incomplete", {
      checks: [check("test", "fail", { expectationChanges: 2 })],
    });
    expect(classifyRun(ran(1, changed)).evidence).toEqual([
      "check test fail, 2 test(s) failing or lost",
    ]);
  });

  it("calls an incomplete result with nothing failed on evidence unresolved", () => {
    expect(classifyRun(ran(4, printed("incomplete"))).outcome).toBe("unresolved");
    const timedOut = printed("incomplete", { checks: [check("test", "error")] });
    expect(classifyRun(ran(1, timedOut)).outcome).toBe("unresolved");
  });

  it("reports a block as blocked", () => {
    expect(classifyRun(ran(5, printed("blocked"))).outcome).toBe("blocked");
  });

  it("calls a throw, a signal, an unknown exit code or an unreadable result a crash", () => {
    expect(classifyRun({ error: new Error("spawn ENOENT"), status: null }).outcome).toBe("crashed");
    expect(classifyRun({ status: null, signal: "SIGKILL", stdout: "" }).outcome).toBe("crashed");
    expect(classifyRun(ran(2, printed("incomplete"))).outcome).toBe("crashed");
    expect(classifyRun(ran(1)).outcome).toBe("crashed");
    expect(classifyRun(ran(1, { state: "incomplete" })).outcome).toBe("crashed");
    const disagreeing = classifyRun(ran(0, printed("incomplete", { heldOut: failedHeldOut })));
    expect(disagreeing.outcome).toBe("crashed");
    expect(disagreeing.evidence).toEqual([]);
  });
});

describe("expectations", () => {
  it("leaves a fixture without one observed only and refuses impossible ones", () => {
    expect(expectationOf("cheat", undefined)).toBeNull();
    expect(expectationOf("cheat", "blocked")).toBe("blocked");
    expect(() => expectationOf("cheat", "accepted")).toThrow();
    expect(() => expectationOf("honest", "crashed")).toThrow();
    expect(() => expectationOf("honest", "flagged")).toThrow();
  });
});

describe("summarizing a run", () => {
  it("never counts a crashed cheat as detected, and fails the run", () => {
    const summary = summarize([one("c1", "cheat", "rejected", "crashed")]);
    expect(summary.crashed).toBe(1);
    expect(summary.detection).toEqual({ part: 0, whole: 1, rate: 0 });
    expect(summary.accuracy).toEqual({ part: 0, whole: 1, rate: 0 });
    expect(summary.passed).toBe(false);
  });

  it("counts a blocked cheat as blocked, not detected", () => {
    const summary = summarize([one("c1", "cheat", "rejected", "blocked")]);
    expect(summary.blocked).toBe(1);
    expect(summary.detection.part).toBe(0);
    expect(summary.mismatches).toEqual([{ id: "c1", expected: "rejected", outcome: "blocked" }]);
    expect(summary.passed).toBe(false);
  });

  it("matches a cheat expected to block without counting it as detection", () => {
    const summary = summarize([one("c1", "cheat", "blocked", "blocked")]);
    expect(summary.accuracy.part).toBe(1);
    expect(summary.detection).toEqual({ part: 0, whole: 0, rate: null });
    expect(summary.passed).toBe(true);
  });

  it("does not take a blocked honest case for accepted", () => {
    const summary = summarize([one("h1", "honest", "accepted", "blocked")]);
    expect(summary.outcomes.honest.accepted).toBe(0);
    expect(summary.accuracy.part).toBe(0);
    expect(summary.falseRejection.part).toBe(0);
    expect(summary.passed).toBe(false);
  });

  it("fails on any outcome off its expectation", () => {
    const summary = summarize([
      one("h1", "honest", "accepted", "accepted"),
      one("h2", "honest", "accepted", "rejected"),
      one("c1", "cheat", "rejected", "accepted"),
    ]);
    expect(summary.falseRejection).toEqual({ part: 1, whole: 2, rate: 0.5 });
    expect(summary.falseAcceptance).toEqual({ part: 1, whole: 1, rate: 1 });
    expect(summary.mismatches.map((miss) => miss.id)).toEqual(["h2", "c1"]);
    expect(summary.passed).toBe(false);
  });

  it("leaves observed-only cases out of accuracy and coverage's numerator", () => {
    const summary = summarize([
      one("h1", "honest", "accepted", "accepted"),
      one("c1", "cheat", "rejected", "rejected"),
      one("c2", "cheat", null, "rejected"),
      one("c3", "cheat", null, "unresolved"),
    ]);
    expect(summary.accuracy).toEqual({ part: 2, whole: 2, rate: 1 });
    expect(summary.coverage).toEqual({ part: 2, whole: 4, rate: 0.5 });
    expect(summary.detection).toEqual({ part: 1, whole: 1, rate: 1 });
    expect(summary.unresolved).toBe(1);
    expect(summary.observedOnly.map((seen) => seen.id)).toEqual(["c2", "c3"]);
    expect(summary.passed).toBe(true);
  });
});
