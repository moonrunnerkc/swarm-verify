import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotWorkingTree } from "../api/verify.ts";
import { exitCodeOf } from "../verify/report.ts";
import { halfTest, probeFixture, requirement } from "./fixture.ts";

/**
 * The verifier-side probes of the 2026-10-31 review (docs/plans/2026-10-31-product-recovery.md
 * in swarm-orchestrator, section 3 and Appendix A), each held to the behavior the review
 * requires rather than the behavior it observed.
 */
const fixHalf = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);

describe("the review's verifier probes", () => {
  it("accepts a correct source fix that adds its own regression test", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    await probe.put(
      "test/negative.test.mjs",
      halfTest.replace("half positive", "half negative").replace("half(4),2", "half(-4),-2"),
    );
    const result = await probe.verify([fixHalf]);
    expect(result.state).toBe("complete");
    expect(result.regression.status).toBe("none");
    expect(result.requirements[0]?.status).toBe("satisfied");
  });

  it("separates a repaired requirement from an unrelated inherited failure", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": `${halfTest}test("unrelated inherited",()=>assert.equal(1,2));\n`,
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify([fixHalf]);
    expect(result.regression.status).toBe("none");
    expect(result.regression.inherited.some((id) => id.endsWith("unrelated inherited"))).toBe(true);
    expect(result.requirements[0]?.status).toBe("satisfied");
    expect(result.state).toBe("complete");
  });

  it("finds a new regression inside a suite that already fails", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": `${halfTest}test("unrelated inherited",()=>assert.equal(1,2));\n`,
    });
    await probe.put("half.mjs", "export const half = n => n * 2;\n");
    const result = await probe.verify();
    expect(result.regression.status).toBe("found");
    expect(result.regression.newFailures.some((id) => id.endsWith("half positive"))).toBe(true);
    expect(exitCodeOf(result)).toBe(1);
  });

  it("does not let a weakened candidate test stand in for the requested behavior", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("test/half.test.mjs", halfTest.replace("half(4),2", "half(4),4"));
    const result = await probe.verify([fixHalf]);
    expect(result.state).not.toBe("complete");
    expect(result.requirements[0]?.status).not.toBe("satisfied");
    expect(result.reasons.join("\n")).toMatch(/expectation/);
  });

  it("never reads zero collected tests as test success", async () => {
    const probe = await probeFixture(
      { "half.mjs": "export const half = n => n;\n", "no-tests/.keep": "" },
      "cd no-tests && node --test",
    );
    await probe.put("half.mjs", "export const half = n => n * 2;\n");
    const result = await probe.verify();
    expect(result.checks[0]?.result).toBe("no-tests");
    expect(result.state).not.toBe("complete");
    expect(exitCodeOf(result)).toBe(4);
  });

  it("counts a mutant as killed only when it is valid code a test caught", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    const line = "export function half(n) { return divide(n); }";
    await probe.put("half.mjs", `${line}\nfunction divide(n) { return n / 2; }\n`);
    const result = await probe.verify();
    expect(result.mutation.status).toBe("killed");
    if (result.mutation.status === "killed") expect(result.mutation.syntax).toBe("valid");
  });

  it("never reuses a baseline measured on linked, mutable dependencies", async () => {
    const probe = await probeFixture({
      "half.mjs":
        "import {half as dependencyHalf} from './node_modules/local-dep/index.mjs';\nexport const half = n => dependencyHalf(n);\n",
      "test/half.test.mjs": halfTest,
      "package-lock.json": '{"name":"audit-fixture","lockfileVersion":3,"packages":{}}\n',
    });
    await probe.put("node_modules/local-dep/index.mjs", "export const half = n => n / 2;\n");
    await probe.put(
      "half.mjs",
      "import {half as dependencyHalf} from './node_modules/local-dep/index.mjs';\nexport const half = n => dependencyHalf(Number(n));\n",
    );
    const first = await probe.verify();
    await probe.put("node_modules/local-dep/index.mjs", "export const half = n => n;\n");
    const second = await probe.verify();
    expect(first.execution.dependencies.mode).toBe("linked");
    expect(first.execution.dependencies.reproducible).toBe(false);
    expect(second.baseline.status === "measured" && second.baseline.cached).toBe(false);
    expect(second.execution.dependencies.note).toMatch(/linked, not reproducible/);
  });

  it("snapshots a repository that ignores the verifier's output directory", async () => {
    const probe = await probeFixture({
      ".gitignore": ".swarm/\n",
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await mkdir(join(probe.repo, ".swarm", "verify"), { recursive: true });
    await probe.put(".swarm/verify/attestation.sigstore.json", "{}\n");
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const snapshot = await snapshotWorkingTree(
      probe.repo,
      "HEAD",
      join(probe.repo, "..", "c.patch"),
    );
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    const twice = await probe.verify();
    expect(twice.change.files.map((file) => file.path)).toEqual(["half.mjs"]);
  });
});
