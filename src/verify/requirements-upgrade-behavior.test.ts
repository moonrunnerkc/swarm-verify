import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requirementSchema } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

/** A candidate whose lockfile resolves vitest 5, as claimcheck's upgrade wants. */
async function candidate(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "upgrade-behavior-"));
  const lock = { lockfileVersion: 3, packages: { "node_modules/vitest": { version: "5.1.0" } } };
  await writeFile(join(dir, "package-lock.json"), JSON.stringify(lock));
  return dir;
}

const test = (authority: TestOutcome["authority"]): TestOutcome => ({
  id: "src/adapters/stryker.swarm-r1.test.ts::overlays Stryker 10",
  title: "overlays Stryker 10",
  file: "src/adapters/stryker.swarm-r1.test.ts",
  origin: authority === undefined ? "implementation-authored" : "pre-existing",
  classification: authority === undefined ? "added" : "fixed",
  base: authority === undefined ? null : "fail",
  before: "fail",
  after: "pass",
  movedTo: null,
  ...(authority === undefined ? {} : { authority, requirements: ["R1"] }),
});

const inputs = (dir: string, outcomes: TestOutcome[]): RequirementInputs => ({
  checks: [],
  outcomes,
  sealedTests: outcomes.filter((one) => one.authority !== undefined),
  dir,
  readBase: async () => null,
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
  latest: new Map(),
});

// claimcheck's upgrade (2026-11-05, rc.10): the versions resolved, the Stryker version it
// installs did not move, no check of that change was written, and the run read satisfied.
const upgrade = requirementSchema.parse({
  id: "R1",
  text: "vitest to ^5, and move the Stryker version claimcheck installs to 10.x",
  kind: "upgrade",
  source: "user",
  versions: [{ name: "vitest", ecosystem: "npm", range: "^5", wording: "vitest to ^5" }],
  behaviorAsked: true,
});

describe("an upgrade whose wording asks for a code change too", () => {
  it("is not satisfied by its versions alone", async () => {
    const [outcome] = await assessRequirements([upgrade], inputs(await candidate(), []));
    expect(outcome).toMatchObject({ status: "unverified", behaviorAsked: true, witness: "none" });
    expect(outcome?.limitation).toMatch(/asks for code to change with the versions/);
  });

  it("is satisfied where a test written apart from the change witnesses the change", async () => {
    const outcomes = [test("independently-generated")];
    const [outcome] = await assessRequirements([upgrade], inputs(await candidate(), outcomes));
    expect(outcome).toMatchObject({ status: "satisfied", witness: "independent" });
  });

  it("is self-attested where only the implementation's own test witnesses it", async () => {
    const own = test(undefined);
    const named = requirementSchema.parse({
      ...upgrade,
      evidence: { tests: [{ name: own.id }], checks: [], structure: [], packages: [] },
    });
    const [outcome] = await assessRequirements([named], inputs(await candidate(), [own]));
    expect(outcome).toMatchObject({ status: "unverified", witness: "self-attested" });
  });

  it("is, without the flag, satisfied by its versions as before", async () => {
    const plain = requirementSchema.parse({ ...upgrade, behaviorAsked: false });
    const [outcome] = await assessRequirements([plain], inputs(await candidate(), []));
    expect(outcome).toMatchObject({ status: "satisfied", witness: "independent" });
  });
});
