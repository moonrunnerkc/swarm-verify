import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  coverage,
  judged,
  keyOf,
  loadPlan,
  runRecordVersion,
  select,
  specification,
} from "./corpus-plan.mjs";

const sealed = { heldOut: { command: "t", glob: "g" } };
const open = { heldOut: null };

describe("how fully an expectation is specified", () => {
  it.each([
    [null, sealed, "observed-only"],
    [{ state: null, requirements: { R1: null }, heldOut: null }, sealed, "observed-only"],
    [{ state: null, requirements: {}, heldOut: "pass" }, sealed, "partial"],
    [{ state: "incomplete", requirements: { R1: null }, heldOut: null }, open, "partial"],
    [{ state: "complete", requirements: { R1: "satisfied" }, heldOut: "pass" }, sealed, "full"],
    [{ state: "complete", requirements: { R1: "satisfied" }, heldOut: null }, open, "full"],
    [{ state: "complete", requirements: { R1: "satisfied" }, heldOut: null }, sealed, "partial"],
  ])("reads %j on an entry %j as %s", (expected, entry, kind) => {
    expect(specification(expected, entry)).toBe(kind);
  });

  it("never counts an observed-only patch as agreeing", () => {
    const seen = { state: "complete", requirements: {}, heldOut: null };
    expect(judged({ expected: null, specification: "observed-only" }, seen).outcome).toBe(
      "observed",
    );
    const partial = {
      expected: { state: "incomplete", requirements: {}, heldOut: null },
      specification: "partial",
    };
    expect(judged(partial, seen)).toEqual({
      outcome: "differs",
      differences: ["state complete, expected incomplete"],
    });
  });
});

const plan = [
  { id: "a", patch: "p1", local: false, specification: "full", expected: {} },
  { id: "a", patch: "p2", local: false, specification: "observed-only", expected: null },
  { id: "b", patch: "p1", local: true, specification: "partial", expected: {} },
];
const record = (...results) => ({ version: runRecordVersion, results });
const ran = (id, patch, outcome) => ({ id, patch, outcome });

describe("selecting a scope", () => {
  it("names every filter that selects nothing", () => {
    expect(select(plan, { only: ["a", "zz"], patches: ["p2", "p9"] })).toEqual({
      selected: [plan[1]],
      unmatched: ["--only zz", "--patches p9"],
    });
    expect(select(plan, {}).selected).toHaveLength(3);
  });
});

describe("combining run records into coverage", () => {
  it("is complete only when every required patch reached a verdict once", () => {
    const report = coverage(
      plan,
      [record(ran("a", "p1", "agrees")), record(ran("a", "p2", "observed"))],
      "public",
    );
    expect(report.complete).toBe(true);
    expect(report.counts).toMatchObject({
      planned: 2,
      executed: 2,
      agrees: 1,
      agreesFull: 1,
      observedOnly: 1,
    });
    const all = coverage(
      plan,
      [record(ran("a", "p1", "agrees"), ran("a", "p2", "observed"))],
      "all",
    );
    expect(all.complete).toBe(false);
    expect(all.counts).toMatchObject({ planned: 3, executed: 2, missing: 1 });
  });

  it.each([
    ["a setup failure", "not set up", "setupFailed"],
    ["a run with no verdict", "no verdict", "noVerdict"],
    ["a patch not run", "not run", "notRun"],
  ])("keeps %s visible and incomplete", (_, outcome, counted) => {
    const report = coverage(
      plan,
      [record(ran("a", "p1", outcome), ran("a", "p2", "observed"))],
      "public",
    );
    expect(report.complete).toBe(false);
    expect(report.counts[counted]).toBe(1);
  });

  it("finds a patch run twice and one the manifest does not plan", () => {
    const report = coverage(
      plan,
      [
        record(ran("a", "p1", "agrees"), ran("a", "p2", "observed")),
        record(ran("a", "p1", "differs"), ran("c", "x", "agrees")),
      ],
      "public",
    );
    expect(report.duplicates).toEqual(["a/p1"]);
    expect(report.unplanned).toEqual(["c/x"]);
    expect(report.complete).toBe(false);
  });
});

describe("the live corpus", () => {
  it("plans every manifest entry's patches, each file matching its recorded digest", () => {
    const live = loadPlan(join(import.meta.dirname, "..", "corpus"));
    expect(live.problems).toEqual([]);
    expect(new Set(live.plan.map(keyOf)).size).toBe(live.plan.length);
    expect(live.plan.some((one) => one.local)).toBe(true);
  });
});
