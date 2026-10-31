import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Requirement } from "../api/request.ts";
import type { VerifyResult } from "../api/result.ts";
import { halfTest, probeFixture, requirement } from "./fixture.ts";

const checker = join(import.meta.dirname, "..", "..", "verify.mjs");

/** The dependency-free checker re-derives the same complete state from the signed evidence. */
function checksOffline(result: VerifyResult): void {
  const { bundle, publicKey, patch } = result.evidence;
  const ran = spawnSync(
    process.execPath,
    [checker, bundle ?? "", "--key", publicKey ?? "", "--patch", patch ?? ""],
    {
      encoding: "utf8",
    },
  );
  expect(ran.stdout).toContain("ok     state     complete, supported by the recorded evidence");
  expect(ran.status).toBe(0);
}

/**
 * Legitimate engineering the verifier must accept for a stated reason, so it cannot look safe by
 * refusing everything: a feature with its own tests, a refactor that moves tests, and an upgrade
 * that changes the manifest and the lockfile.
 */
describe("changes the verifier accepts for a valid reason", () => {
  it("accepts a feature with new tests, witnessed failing before and passing after", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put(
      "half.mjs",
      "export const half = n => n / 2;\nexport const double = n => n * 2;\n",
    );
    await probe.put(
      "test/double.test.mjs",
      "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {double} from '../half.mjs';\ntest('doubles',()=>assert.equal(double(4),8));\n",
    );
    const result = await probe.verify([
      requirement("R1", "export double(n) returning n * 2", "feature", ["doubles"]),
    ]);
    expect(result.state).toBe("complete");
    expect(result.requirements[0]).toMatchObject({ status: "satisfied" });
    expect(result.requirements[0]?.evidence[0]).toMatchObject({
      outcome: "witness",
      authority: "implementation-authored",
    });
    checksOffline(result);
  });

  it("accepts a refactor that moves source and tests, matching tests by identity", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    probe.git("mv", "half.mjs", "lib-half.mjs");
    await mkdir(join(probe.repo, "test", "unit"), { recursive: true });
    probe.git("mv", "test/half.test.mjs", "test/unit/half.test.mjs");
    await probe.put(
      "test/unit/half.test.mjs",
      halfTest.replace("'../half.mjs'", "'../../lib-half.mjs'"),
    );
    const refactor: Requirement = {
      ...requirement("R1", "move half into lib-half.mjs without changing it", "refactor", [
        "half positive",
      ]),
      evidence: {
        tests: [{ name: "half positive" }],
        checks: [],
        structure: [
          { path: "lib-half.mjs", contains: "export const half" },
          { path: "half.mjs", absent: true },
        ],
        packages: [],
      },
    };
    const result = await probe.verify([refactor]);
    expect(result.testFiles.moved).toEqual([
      { from: "test/half.test.mjs", to: "test/unit/half.test.mjs" },
    ]);
    expect(result.checks[0]?.tests?.renamed).toEqual([
      "test/half.test.mjs::half positive => test/unit/half.test.mjs::half positive",
    ]);
    expect(result.regression.status).toBe("none");
    expect(result.requirements[0]?.status).toBe("satisfied");
    expect(result.state).toBe("complete");
    checksOffline(result);
  });

  it("accepts an upgrade that changes the manifest and lockfile, each side installed from its own", async () => {
    const probe = await probeFixture({
      "half.mjs": "import {divide} from 'dep';\nexport const half = n => divide(n, 2);\n",
      "test/half.test.mjs": halfTest,
      "package.json": '{"name":"fixture","version":"1.0.0","type":"module","private":true}\n',
    });
    const vendor = join(probe.repo, "vendor");
    const pack = async (version: string, body: string) => {
      const dir = join(probe.repo, "..", `dep-${version}`);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        `{"name":"dep","version":"${version}","type":"module","main":"index.js"}\n`,
      );
      await writeFile(join(dir, "index.js"), body);
      await mkdir(vendor, { recursive: true });
      execFileSync("npm", ["pack", "--silent", "--pack-destination", vendor], { cwd: dir });
    };
    const npm = (...args: string[]) =>
      execFileSync("npm", [...args, "--no-audit", "--no-fund"], {
        cwd: probe.repo,
        stdio: "ignore",
      });
    await pack("1.0.0", "export const divide = (a, b) => a / b;\n");
    await pack("2.0.0", "export const quotient = ({ dividend, divisor }) => dividend / divisor;\n");
    npm("install", "--save-exact", "./vendor/dep-1.0.0.tgz");
    await rm(join(probe.repo, "node_modules"), { recursive: true, force: true });
    probe.git("add", "-A");
    probe.git("commit", "-qm", "Depend on dep 1.0.0");
    npm("install", "--save-exact", "./vendor/dep-2.0.0.tgz");
    await rm(join(probe.repo, "node_modules"), { recursive: true, force: true });
    await probe.put(
      "half.mjs",
      "import {quotient} from 'dep';\nexport const half = n => quotient({ dividend: n, divisor: 2 });\n",
    );
    const upgrade: Requirement = {
      ...requirement("R1", "upgrade dep to 2.0.0 and adapt to its API", "upgrade", [
        "half positive",
      ]),
      evidence: {
        tests: [{ name: "half positive" }],
        checks: [],
        structure: [],
        packages: [{ name: "dep", ecosystem: "npm", version: "2.0.0" }],
      },
    };
    const result = await probe.verify([upgrade], { dependencies: "prepare" });
    expect(result.artifacts.map((one) => one.category).sort()).toEqual([
      "lockfiles",
      "manifests",
      "source",
    ]);
    expect(result.execution.dependencies).toMatchObject({ mode: "prepared", reproducible: true });
    expect(result.requirements[0]?.evidence.find((one) => one.kind === "package")).toMatchObject({
      outcome: "observed",
      detail: "resolved 1.0.0 at the base and 2.0.0 in the candidate",
    });
    expect(result.requirements[0]?.status).toBe("satisfied");
    expect(result.state).toBe("complete");
    checksOffline(result);
  });
});
