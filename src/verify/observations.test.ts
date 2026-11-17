import { describe, expect, it } from "vitest";
import type { TestOutcome } from "./compare.ts";
import {
  maxObservations,
  observationDifferences,
  observationsOf,
  parseObservations,
} from "./observations.ts";
import type { CheckResult } from "./predicate.ts";

const result = (durationMs = 1): CheckResult => ({
  name: "test",
  command: "npm test",
  kind: "test",
  authority: "pre-existing",
  result: "pass",
  collected: 120,
  exitCode: 0,
  durationMs,
  outputSha256: "0".repeat(64),
});
const outcome = (
  id: string,
  classification: TestOutcome["classification"] = "preserved",
): TestOutcome => ({
  id,
  title: id,
  file: null,
  origin: "pre-existing",
  classification,
  base: "pass",
  after: "pass",
  before: null,
  movedTo: null,
});
const tests = Array.from({ length: 120 }, (_, at) => outcome(`t${String(at).padStart(3, "0")}`));
const recordOf = (list: readonly TestOutcome[], durationMs = 1) => {
  const made = observationsOf([{ result: result(durationMs), outcomes: list }], []);
  if (!("record" in made)) throw new Error("overflow");
  return made.record;
};

describe("observation records", () => {
  it("agree where only timing differs", () => {
    expect(observationDifferences(recordOf(tests, 5), recordOf(tests, 9000))).toEqual([]);
  });

  it("find a test missing, a test added and a changed outcome past the first 100, both ways", () => {
    const changed = [
      ...tests.slice(0, 110),
      outcome("t110", "fixed"),
      ...tests.slice(112),
      outcome("t999"),
    ];
    const found = observationDifferences(recordOf(tests), recordOf(changed));
    expect(found).toContain(
      "check test: t110 was preserved (base pass, after pass, before none) and is fixed (base pass, after pass, before none)",
    );
    expect(found).toContain("check test: t111 was observed in the recording and not in the replay");
    expect(found).toContain(
      "check test: t999 is observed in the replay and was not in the recording",
    );
  });

  it("reads back what it wrote and refuses anything else", () => {
    const record = recordOf(tests);
    expect(parseObservations(Buffer.from(JSON.stringify(record)))).toEqual(record);
    expect(parseObservations(Buffer.from(JSON.stringify({ ...record, version: "v0" })))).toBeNull();
    expect(parseObservations(Buffer.from("{"))).toBeNull();
  });

  it("says the record is incomplete instead of truncating it", () => {
    const many = Array.from({ length: maxObservations + 1 }, (_, at) => outcome(`t${at}`));
    const made = observationsOf([{ result: result(), outcomes: many }], []);
    expect("overflow" in made && made.overflow).toMatch(/observations are incomplete/);
  });
});
