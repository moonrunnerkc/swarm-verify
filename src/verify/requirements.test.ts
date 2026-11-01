import { describe, expect, it } from "vitest";
import { requirementSchema } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { CheckResult } from "./predicate.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

const check = (name: string): CheckResult => ({
  name,
  command: `npm run ${name}`,
  kind: "other",
  authority: "pre-existing",
  result: "pass",
  collected: null,
  exitCode: 0,
  durationMs: 1,
  outputSha256: "0".repeat(64),
});

const added: TestOutcome = {
  id: "test/walk.test.ts::walkRepo > skips extra directories",
  title: "walkRepo > skips extra directories",
  file: "test/walk.test.ts",
  origin: "implementation-authored",
  classification: "added",
  base: null,
  after: "pass",
  before: "fail",
  movedTo: null,
};

const inputs: RequirementInputs = {
  checks: [check("test"), check("lint"), check("build")],
  outcomes: [added],
  dir: "/nonexistent",
  readBase: async () => null,
  sourceChanged: ["src/walk.ts"],
  changed: true,
  regression: { status: "none", newFailures: [], inherited: [], removed: [], unresolved: [] },
  freshDependencies: true,
};

describe("a requirement whose evidence names nothing that ran", () => {
  it("says which checks ran when a named check is not one of them", async () => {
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "skip extra directories",
          kind: "feature",
          source: "user",
          evidence: { tests: [{ name: "skips extra directories" }], checks: ["tsc --noEmit"] },
        }),
      ],
      inputs,
    );
    expect(outcome?.status).toBe("unverified");
    expect(outcome?.nextAction).toBe(
      "name only checks that ran (test, lint, build) in place of tsc --noEmit",
    );
  });

  it("points at the result's test lists when a named test did not run", async () => {
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "skip extra directories",
          kind: "feature",
          source: "user",
          evidence: { tests: [{ name: "walkRepo skips extra directories" }] },
        }),
      ],
      inputs,
    );
    expect(outcome?.nextAction).toBe(
      "name tests as they ran (a title, a suite, or a path such as walkRepo > skips extra directories) in place of walkRepo skips extra directories",
    );
  });
});
