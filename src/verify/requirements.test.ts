import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  latest: new Map(),
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
      "name tests as they ran (a title, a suite, or a path such as walkRepo > skips extra directories) in place of walkRepo skips extra directories; these tests fail before the change and pass after it, and this requirement does not map them: walkRepo > skips extra directories",
    );
  });

  it("names the tests that witness the change when a requirement maps none", async () => {
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "skip extra directories",
          kind: "feature",
          source: "user",
        }),
      ],
      inputs,
    );
    expect(outcome?.status).toBe("unverified");
    expect(outcome?.nextAction).toBe(
      "map the tests that exercise it; these fail before the change and pass after it: walkRepo > skips extra directories",
    );
  });

  it("says why a structure claim fails, and names the witnesses it left unmapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "structure-"));
    await mkdir(join(dir, "config"));
    await writeFile(join(dir, "config", "schema.ts"), "export const ruleset = 'auto';\n");
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "accept an array of rulesets",
          kind: "feature",
          source: "user",
          evidence: {
            structure: [
              { path: "config/", contains: "semgrep" },
              { path: "config/schema.ts", contains: "string[]" },
              { path: "config/missing.ts" },
            ],
          },
        }),
      ],
      { ...inputs, dir },
    );
    expect(outcome?.evidence.map((one) => one.detail)).toEqual([
      "config/ is a directory, not a file",
      "the file does not contain it",
      "no file at config/missing.ts",
    ]);
    expect(outcome?.nextAction).toBe(
      'fix or drop the structure claims that do not hold (config/ contains "semgrep": config/ is a directory, not a file; config/schema.ts contains "string[]": the file does not contain it; config/missing.ts: no file at config/missing.ts); these tests fail before the change and pass after it, and this requirement does not map them: walkRepo > skips extra directories',
    );
  });

  it("counts a check that fails only on inherited failures as holding, not as unobserved", async () => {
    const inheritedOnly = { ...check("test"), result: "inherited-failures" as const, exitCode: 1 };
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "skip extra directories",
          kind: "feature",
          source: "user",
          evidence: { tests: [{ name: "skips extra directories" }], checks: ["test"] },
        }),
      ],
      { ...inputs, checks: [inheritedOnly, check("lint")] },
    );
    expect(outcome?.evidence.find((one) => one.kind === "check")).toMatchObject({
      outcome: "passes but for inherited failures",
      detail: "inherited-failures",
    });
    expect(outcome?.status).toBe("satisfied");
  });

  it("takes a test named with its file first, as runners print it, or by its id", async () => {
    for (const name of [
      "test/walk.test.ts > walkRepo > skips extra directories",
      "test/walk.test.ts::walkRepo > skips extra directories",
      // A file alone names every test in it.
      "test/walk.test.ts",
    ]) {
      const [outcome] = await assessRequirements(
        [
          requirementSchema.parse({
            id: "R1",
            text: "skip extra directories",
            kind: "feature",
            source: "user",
            evidence: { tests: [{ name }] },
          }),
        ],
        inputs,
      );
      expect(outcome?.evidence.map((one) => one.outcome)).toEqual(["witness"]);
      expect(outcome?.status).toBe("satisfied");
    }
    const [elsewhere] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "skip extra directories",
          kind: "feature",
          source: "user",
          evidence: {
            tests: [{ name: "test/other.test.ts > walkRepo > skips extra directories" }],
          },
        }),
      ],
      inputs,
    );
    expect(elsewhere?.status).toBe("unverified");
  });

  it("takes a test by the id the verifier printed for it, a pytest classname included", async () => {
    const pytest: TestOutcome = {
      ...added,
      id: "tests.e2e.test_limits::test_event_limit_retains_status",
      title: "test_event_limit_retains_status",
      file: "tests/e2e/test_limits",
      origin: "pre-existing",
      classification: "fixed",
    };
    for (const name of [
      "tests.e2e.test_limits::test_event_limit_retains_status",
      "tests/e2e/test_limits.py::test_event_limit_retains_status",
    ]) {
      const [outcome] = await assessRequirements(
        [
          requirementSchema.parse({
            id: "R1",
            text: "keep the event limit status",
            kind: "fix",
            source: "user",
            evidence: { tests: [{ name }] },
          }),
        ],
        { ...inputs, outcomes: [pytest] },
      );
      expect(outcome?.evidence.map((one) => one.outcome)).toEqual(["fixed"]);
    }
  });

  it("tells an upgrade with no package claim what to name, or how to record a change of no version", async () => {
    const [outcome] = await assessRequirements(
      [
        requirementSchema.parse({
          id: "R1",
          text: "support Node 24",
          kind: "upgrade",
          source: "user",
          evidence: { checks: ["test"] },
        }),
      ],
      inputs,
    );
    expect(outcome?.status).toBe("unverified");
    expect(outcome?.nextAction).toBe(
      "name the upgraded package with the version it resolves to; where no package version changes, the requirement is not an upgrade: record it as kind other, with the structure and checks that show it",
    );
  });
});
