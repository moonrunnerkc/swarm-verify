import { describe, expect, it } from "vitest";
import { sealFiles } from "../verify/sealed-store.ts";
import { checksOffline, halfTest, probeFixture, requirement } from "./fixture.ts";

const doubled = "export const half = n => n / 2;\nexport const double = n => n * 2;\n";
const doubleTest = (title: string) =>
  `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {double} from '../half.mjs';\ntest(${JSON.stringify(title)},()=>assert.equal(double(4),8));\n`;

/**
 * A requirement is satisfied only on evidence its implementation's author did not choose: a
 * feature witnessed by nothing but its own new tests is self-attested, and one that a check sealed
 * apart from the change witnesses is complete.
 */
describe("independent evidence", () => {
  it("calls a feature witnessed only by its own new tests self-attested, not complete", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", doubled);
    await probe.put("test/double.test.mjs", doubleTest("doubles"));
    const result = await probe.verify([
      requirement("R1", "export double(n) returning n * 2", "feature", ["doubles"]),
    ]);
    expect(result.state).toBe("incomplete");
    expect(result.requirements[0]).toMatchObject({
      status: "unverified",
      witness: "self-attested",
    });
    expect(result.requirements[0]?.evidence[0]).toMatchObject({
      outcome: "witness",
      authority: "implementation-authored",
    });
    expect(result.reasons).toContain(
      "independent evidence missing: R1 is self-attested (every witness is the implementation's own)",
    );
  });

  it("accepts a feature with new tests where a check sealed apart from the change witnesses it", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    await sealFiles({
      workspace: probe.repo,
      home: probe.home,
      authority: "independently-generated",
      files: [{ path: "test/double.authored.test.mjs", content: doubleTest("double(4) is 8") }],
      checks: [
        {
          name: "authored-R1",
          command: "node --test test/double.authored.test.mjs",
          kind: "test",
          requirements: ["R1"],
        },
      ],
    });
    await probe.put("half.mjs", doubled);
    await probe.put("test/double.test.mjs", doubleTest("doubles"));
    const result = await probe.verify([
      requirement("R1", "export double(n) returning n * 2", "feature", ["doubles"]),
    ]);
    expect(result.state).toBe("complete");
    expect(result.requirements[0]).toMatchObject({ status: "satisfied", witness: "independent" });
    expect(
      result.requirements[0]?.evidence.map((one) => [one.ref, one.authority, one.outcome]),
    ).toContainEqual([
      "test/double.authored.test.mjs::double(4) is 8",
      "independently-generated",
      "fixed",
    ]);
    expect(result.heldOut).toMatchObject({
      status: "measured",
      checks: [{ name: "authored-R1", authority: "independently-generated", result: "pass" }],
    });
    checksOffline(result);
  });
});
