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

describe("naming evidence by suite", () => {
  it("maps a requirement named by its describe block to every test in it", async () => {
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
      "import {describe, test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {double, half} from '../half.mjs';\ndescribe('double', () => {\n  test('doubles', () => assert.equal(double(4), 8));\n  test('leaves half alone', () => assert.equal(half(4), 2));\n});\n",
    );
    const result = await probe.verify([
      requirement("R1", "export double(n)", "feature", ["double"]),
    ]);
    // Against the base's source the file cannot import double, so both of its tests fail before.
    expect(result.requirements[0]?.evidence.map((ref) => ref.outcome)).toEqual([
      "witness",
      "witness",
    ]);
    expect(result.requirements[0]?.status).toBe("satisfied");
  });

  it("maps a requirement named by a suite and test path as a runner prints it", async () => {
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
      "import {describe, test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {double} from '../half.mjs';\ndescribe('double', () => {\n  test('doubles', () => assert.equal(double(4), 8));\n});\n",
    );
    const result = await probe.verify([
      requirement("R1", "export double(n)", "feature", ["double > doubles"]),
    ]);
    expect(result.requirements[0]?.evidence.map((ref) => ref.outcome)).toEqual(["witness"]);
    expect(result.requirements[0]?.status).toBe("satisfied");
  });
});

describe("an approved behavior change", () => {
  const expects = (value: string) =>
    `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {half} from '../half.mjs';\ntest('half', () => assert.equal(half(5), ${value}));\n`;

  it("supersedes an old expectation only when the request authorizes it, and records that it did", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": expects("2.5"),
    });
    await probe.put("half.mjs", "export const half = n => Math.floor(n / 2);\n");
    await probe.put("test/half.test.mjs", expects("2"));
    const rounds = [requirement("R1", "half(n) rounds down", "fix", ["half"])];
    const refused = await probe.verify(rounds);
    expect(refused.checks[0]?.tests?.expectationChanges).toEqual(["test/half.test.mjs::half"]);
    expect(refused.state).not.toBe("complete");
    expect(refused.policy).toEqual({ behaviorChange: "none" });
    const allowed = await probe.verify(rounds, { behaviorChange: "authorized" });
    expect(allowed.checks[0]?.tests?.superseded).toEqual(["test/half.test.mjs::half"]);
    expect(allowed.requirements[0]?.status).toBe("satisfied");
    expect(allowed.state).toBe("complete");
    expect(allowed.policy).toEqual({ behaviorChange: "authorized" });
    checksOffline(allowed);
  });
});

describe("a requirement that names a check with inherited failures", () => {
  it("is satisfied by its witness and the check, and the offline checker agrees", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": `${halfTest}test("unrelated inherited",()=>assert.equal(1,2));\n`,
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fixed = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([
      { ...fixed, evidence: { ...fixed.evidence, checks: ["test"] } },
    ]);
    expect(result.checks[0]?.result).toBe("inherited-failures");
    expect(result.requirements[0]?.evidence.map((ref) => ref.outcome)).toEqual([
      "fixed",
      "passes but for inherited failures",
    ]);
    expect(result.state).toBe("complete");
    checksOffline(result);
  });
});

describe("dependencies that do not install from the lockfile", () => {
  it("blocks, says the lockfile did not install, and says what to do", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
      // The manifest asks for a package the lockfile does not hold, so npm ci refuses.
      "package.json":
        '{"name":"f","version":"1.0.0","type":"module","dependencies":{"left-pad":"1.3.0"}}\n',
      "package-lock.json":
        '{"name":"f","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"f","version":"1.0.0"}}}\n',
    });
    const result = await probe.verify([], { dependencies: "prepare" });
    expect(result.state).toBe("blocked");
    expect(result.reasons).toContain(
      "the base's dependencies did not install from its lockfile: fix the dependency the setup output names, or use the workspace's installed dependencies (dependencies: linked), reported as not reproducible",
    );
    expect(result.failureOutput).toContain("setup failed");
  });
});
