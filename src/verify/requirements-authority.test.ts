import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requirementSchema } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { CheckResult } from "./predicate.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

const passing: CheckResult = {
  name: "test",
  command: "npm test",
  kind: "test",
  authority: "pre-existing",
  result: "pass",
  collected: 3,
  exitCode: 0,
  durationMs: 1,
  outputSha256: "0".repeat(64),
};

const witness = (id: string, extra: Partial<TestOutcome> = {}): TestOutcome => ({
  id,
  title: id.split("::")[1] ?? id,
  file: id.split("::")[0] ?? null,
  origin: "implementation-authored",
  classification: "added",
  base: null,
  after: "pass",
  before: "fail",
  movedTo: null,
  ...extra,
});

const ownTest = witness("test/order.test.ts::keeps the canonical order");
const sealedTest = (classification: TestOutcome["classification"], after: "pass" | "fail") =>
  witness("test/reviewers.authored.test.ts::sorts the names", {
    origin: "pre-existing",
    classification,
    base: "fail",
    after,
    authority: "independently-generated",
    requirements: ["R1"],
  });

const inputs = (extra: Partial<RequirementInputs> = {}): RequirementInputs => ({
  checks: [passing],
  outcomes: [ownTest],
  dir: "/nonexistent",
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
  ...extra,
});

const feature = (tests: { name: string }[] = [{ name: ownTest.id }]) =>
  requirementSchema.parse({
    id: "R1",
    text: "add --reviewers",
    kind: "feature",
    source: "user",
    evidence: { tests, checks: ["test"] },
  });

describe("independent evidence", () => {
  it("calls a feature witnessed only by its implementation's own test self-attested, not satisfied", async () => {
    const [outcome] = await assessRequirements([feature()], inputs());
    expect(outcome).toMatchObject({ status: "unverified", witness: "self-attested" });
    expect(outcome?.limitation).toMatch(
      /^self-attested: every witness is the implementation's own/,
    );
    expect(outcome?.nextAction).toMatch(/independent evidence is missing/);
  });

  it("satisfies it where a sealed check written apart from the change witnesses it", async () => {
    const [outcome] = await assessRequirements(
      [feature()],
      inputs({ sealedTests: [sealedTest("fixed", "pass")] }),
    );
    expect(outcome).toMatchObject({ status: "satisfied", witness: "independent" });
    expect(outcome?.evidence.map((one) => [one.authority, one.outcome])).toContainEqual([
      "independently-generated",
      "fixed",
    ]);
  });

  it("maps a sealed check to the requirement it names without a selector, and fails it when it fails", async () => {
    const [outcome] = await assessRequirements(
      [feature([])],
      inputs({ outcomes: [], sealedTests: [sealedTest("new-failure", "fail")] }),
    );
    expect(outcome?.status).toBe("failed");
    expect(outcome?.limitation).toContain("test/reviewers.authored.test.ts::sorts the names");
  });

  it("counts a base test the change fixes as independent", async () => {
    const fixed = witness("src/a.test.ts::rejects a removed test", {
      origin: "pre-existing",
      classification: "fixed",
      base: "fail",
    });
    const [outcome] = await assessRequirements(
      [feature([{ name: fixed.id }])],
      inputs({ outcomes: [fixed] }),
    );
    expect(outcome).toMatchObject({ status: "satisfied", witness: "independent" });
  });

  it("calls a refactor self-attested when only the implementation's claims show its structure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "authority-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "claims.py"), "def _falsify():\n    pass\n");
    const refactor = (authority?: "implementation-authored") =>
      requirementSchema.parse({
        id: "R1",
        text: "move _falsify into claims.py",
        kind: "refactor",
        source: "user",
        evidence: {
          checks: ["test"],
          structure: [
            {
              path: "src/claims.py",
              contains: "def _falsify",
              ...(authority === undefined ? {} : { authority }),
            },
          ],
        },
      });
    const [own] = await assessRequirements([refactor("implementation-authored")], inputs({ dir }));
    expect(own).toMatchObject({ status: "unverified", witness: "self-attested" });
    const [caller] = await assessRequirements([refactor()], inputs({ dir }));
    expect(caller).toMatchObject({ status: "satisfied", witness: "independent" });
  });

  it("says none where nothing decisive holds", async () => {
    const [outcome] = await assessRequirements([feature([])], inputs({ outcomes: [] }));
    expect(outcome?.witness).toBe("none");
  });

  it("asks for the change's own witnessing test too where the wording asks for tests", async () => {
    const asked = { ...feature([]), testsAsked: true };
    const sealedOnly = inputs({ outcomes: [], sealedTests: [sealedTest("fixed", "pass")] });
    const [without] = await assessRequirements([asked], sealedOnly);
    expect(without).toMatchObject({ status: "unverified", witness: "independent" });
    expect(without?.limitation).toBe(
      "the task asks for tests, and the change adds none that fails before it and passes after it",
    );
    // Its own test counts wherever it is, mapped or not, beside the independent witness.
    const both = inputs({ sealedTests: [sealedTest("fixed", "pass")] });
    const [with_] = await assessRequirements([asked], both);
    expect(with_).toMatchObject({ status: "satisfied", witness: "independent", testsAsked: true });
    // The sealed witness, the change's own test, and the declared check it maps.
    expect(with_?.evidence.map((one) => one.authority)).toEqual([
      "independently-generated",
      "implementation-authored",
      "pre-existing",
    ]);
  });
});
