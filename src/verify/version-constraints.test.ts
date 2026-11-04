import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requirementSchema, type VersionConstraint } from "../api/request.ts";
import { type LatestTarget, targetKey } from "./latest-version.ts";
import type { CheckResult } from "./predicate.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

// claimcheck's task: "Bump vitest from 4.1.8 to 4.1.10 (or both Stryker packages to the latest
// 9.x if one exists) ...". Two runs delivered Stryker 10.1.1 and were reported complete.
const lockfile = (versions: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }]),
    ),
  });
const base = lockfile({ vitest: "4.1.8", "@stryker-mutator/core": "9.6.1" });

const stryker: VersionConstraint = {
  name: "@stryker-mutator/core",
  ecosystem: "npm",
  range: "9.x",
  latest: true,
  wording: "the latest 9.x",
};
const vitest: VersionConstraint = {
  name: "vitest",
  ecosystem: "npm",
  range: "4.1.10",
  latest: false,
  wording: "from 4.1.8 to 4.1.10",
};
const resolved = (version: string | null): Map<string, LatestTarget> =>
  new Map([
    [
      targetKey(stryker),
      {
        version,
        source: "https://registry.npmjs.org/@stryker-mutator%2fcore",
        detail:
          version === null
            ? "the latest within 9.x was not resolved: offline"
            : `${version} is the latest within 9.x`,
      },
    ],
  ]);

const passing: CheckResult = {
  name: "test",
  command: "npm test",
  kind: "test",
  authority: "pre-existing",
  result: "pass",
  collected: null,
  exitCode: 0,
  durationMs: 1,
  outputSha256: "0".repeat(64),
};

async function judge(
  candidate: Record<string, string>,
  latest: Map<string, LatestTarget>,
  claimed = "10.1.1",
) {
  const dir = await mkdtemp(join(tmpdir(), "version-constraint-"));
  await writeFile(join(dir, "package-lock.json"), lockfile(candidate));
  const inputs: RequirementInputs = {
    checks: [passing],
    outcomes: [],
    dir,
    readBase: async (path) => (path === "package-lock.json" ? base : null),
    changed: true,
    regression: {
      status: "none",
      newFailures: [],
      inherited: [],
      removed: [],
      unresolved: [],
      flaky: [],
    },
    freshDependencies: true,
    latest,
  };
  const [outcome] = await assessRequirements(
    [
      requirementSchema.parse({
        id: "R1",
        text: "Bump vitest from 4.1.8 to 4.1.10 (or both Stryker packages to the latest 9.x if one exists)",
        source: "user",
        kind: "upgrade",
        // The model's own claim, as attempt 1 wrote it: its version, not the task's.
        evidence: {
          checks: ["test"],
          packages: [{ name: "@stryker-mutator/core", ecosystem: "npm", version: claimed }],
        },
        versions: [vitest, stryker],
      }),
    ],
    inputs,
  );
  if (outcome === undefined) throw new Error("no outcome");
  return outcome;
}

describe("a version the task's wording constrains", () => {
  it("fails Stryker 10.1.1 against the latest 9.x, whatever the model claimed", async () => {
    const outcome = await judge(
      { vitest: "4.1.10", "@stryker-mutator/core": "10.1.1" },
      resolved("9.6.1"),
    );
    expect(outcome.status).toBe("failed");
    const constraint = outcome.evidence.find((one) =>
      one.ref.includes("stryker-mutator/core within"),
    );
    expect(constraint).toMatchObject({
      kind: "package",
      ref: "npm:@stryker-mutator/core within the latest 9.x",
      outcome: "fail",
    });
    expect(constraint?.detail).toContain("10.1.1");
    expect(constraint?.detail).toContain("9.6.1");
    expect(outcome.versions).toEqual([vitest, stryker]);
  });

  it("holds when the candidate resolves the latest 9.x and the pinned vitest", async () => {
    const outcome = await judge(
      { vitest: "4.1.10", "@stryker-mutator/core": "9.6.1" },
      new Map([[targetKey(stryker), { version: "9.6.1", source: "s", detail: "read" }]]),
      "9.6.1",
    );
    const constraints = outcome.evidence.filter((one) => one.authority === "user-acceptance");
    expect(constraints.map((one) => one.outcome)).toEqual(["observed", "observed"]);
  });

  it("fails a version inside the range that is not the latest the wording asked for", async () => {
    const outcome = await judge(
      { vitest: "4.1.10", "@stryker-mutator/core": "9.5.1" },
      resolved("9.6.1"),
    );
    expect(outcome.status).toBe("failed");
  });

  it("leaves the requirement unverified when the latest could not be resolved", async () => {
    const outcome = await judge(
      { vitest: "4.1.10", "@stryker-mutator/core": "9.6.1" },
      resolved(null),
      "9.6.1",
    );
    expect(outcome.status).toBe("unverified");
    expect(outcome.limitation).toContain("npm:@stryker-mutator/core within the latest 9.x");
  });

  it("fails a pinned version the candidate does not resolve to", async () => {
    const outcome = await judge(
      { vitest: "4.1.11", "@stryker-mutator/core": "9.6.1" },
      resolved("9.6.1"),
      "9.6.1",
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.limitation).toContain("npm:vitest within 4.1.10");
  });
});
