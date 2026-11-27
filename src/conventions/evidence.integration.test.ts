import { describe, expect, it } from "vitest";
import type { Requirement } from "../api/request.ts";
import { checksOffline, probeFixture } from "../probes/fixture.ts";

/** Approved conventions as a requirement of their own, judged on the files a change touches. */
const profile: Requirement = {
  id: "R2",
  text: "The change follows the approved coding conventions",
  source: "profile",
  kind: "other",
  required: true,
  testsAsked: false,
  behaviorAsked: false,
  assumptions: [],
  evidence: {
    tests: [],
    checks: [],
    structure: [],
    packages: [],
    conventions: { exports: "named", "function-names": "camelCase", "empty-catch": "forbidden" },
  },
  versions: [],
};

const files = {
  // Code that was already there breaks the conventions; a change is not held to it.
  "legacy.mjs": "export default function old_name() {\n  try {\n    return 1;\n  } catch {}\n}\n",
  "test/legacy.test.mjs":
    "import { test } from 'node:test';\nimport '../legacy.mjs';\ntest('loads', () => {});\n",
  "package.json":
    '{"name":"fixture","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n',
};

describe("conventions as a requirement", () => {
  it("fails a change that adds a default export and a snake_case function, naming each line", async () => {
    const probe = await probeFixture(files);
    await probe.put(
      "price.mjs",
      "export default function total_price(a, b) {\n  return a + b;\n}\n",
    );
    const result = await probe.verify([profile]);
    const [outcome] = result.requirements;
    expect(outcome).toMatchObject({ status: "failed", source: "profile" });
    expect(outcome?.evidence.filter((one) => one.outcome === "fail")).toEqual([
      expect.objectContaining({
        kind: "convention",
        ref: "exports: named",
        detail: expect.stringContaining("price.mjs:1"),
      }),
      expect.objectContaining({
        ref: "function-names: camelCase",
        detail: expect.stringContaining("total_price"),
      }),
    ]);
    expect(result.state).toBe("incomplete");
  });

  it("is satisfied by a change that follows them, and does not charge it with what the base already held", async () => {
    const probe = await probeFixture(files);
    await probe.put("price.mjs", "export function totalPrice(a, b) {\n  return a + b;\n}\n");
    await probe.put(
      "legacy.mjs",
      "export default function old_name() {\n  try {\n    return 2;\n  } catch {}\n}\n",
    );
    const result = await probe.verify([profile]);
    expect(result.requirements[0]).toMatchObject({ status: "satisfied", witness: "independent" });
    expect(result.requirements[0]?.evidence.map((one) => one.outcome)).toEqual([
      "observed",
      "observed",
      "observed",
    ]);
    expect(result.state).toBe("complete");
    checksOffline(result);
  });

  it("is not satisfied by a changed file that does not parse, whose conventions nobody measured", async () => {
    const probe = await probeFixture(files);
    await probe.put("price.mjs", "export function totalPrice(a, b) {\n  return a + ;\n");
    const result = await probe.verify([profile]);
    const [outcome] = result.requirements;
    expect(outcome?.status).not.toBe("satisfied");
    expect(
      outcome?.evidence.some(
        (one) => one.outcome === "not observed" && /does not parse/.test(one.detail ?? ""),
      ),
    ).toBe(true);
  });
});
