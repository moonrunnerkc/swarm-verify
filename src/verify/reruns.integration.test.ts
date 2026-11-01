import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { halfTest, probeFixture, requirement } from "../probes/fixture.ts";
import { writeAttestation } from "./dsse.ts";
import { exitCodeOf } from "./report.ts";
import { resolveSigningKey } from "./signing.ts";

/**
 * tracemantle (session 20261101T150922-f837ff): a parametrized test failed in the recorded
 * verification and passed in its replay, on the same snapshot, so one run decided a regression
 * the next one did not see. These fixtures stand in for that nondeterminism with a run counter
 * kept outside the checkout: the test fails on exactly one numbered run of the suite.
 */
const failsOnRun = (counter: string, run: number) => `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {half} from '../half.mjs';
test('half settles', () => {
  const run = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;
  writeFileSync(${JSON.stringify(counter)}, String(run));
  assert.notEqual(run, ${run}, 'the run this test fails on');
  assert.equal(half(4), 2);
});
`;

const id = "test/half.test.mjs::half settles";

async function counted(failing: number, files: Readonly<Record<string, string>> = {}) {
  const probe = await probeFixture({ "half.mjs": "export const half = n => n / 2;\n", ...files });
  const counter = join(probe.repo, "..", "runs");
  await writeFile(counter, "0");
  await probe.put("test/half.test.mjs", failsOnRun(counter, failing));
  probe.git("add", "-A");
  probe.git("commit", "-qm", "the counted test");
  // The same behavior written another way: a change that cannot fix or break the test.
  await probe.put("half.mjs", "export const half = n => n * 0.5;\n");
  return probe;
}

describe("a test that fails and then passes on the same snapshot", () => {
  it("is flaky at the candidate: recorded run by run, and neither a regression nor a pass", async () => {
    // Run 1 is the base, run 2 the candidate, run 3 the candidate's first rerun.
    const probe = await counted(2);
    const result = await probe.verify();
    const tests = result.checks[0]?.tests;
    expect(tests?.flaky).toEqual([id]);
    expect(tests?.reruns).toEqual([{ id, snapshot: "candidate", results: ["fail", "pass"] }]);
    expect(tests?.newFailures).toEqual([]);
    expect(result.checks[0]?.result).toBe("unresolved");
    expect(result.regression).toMatchObject({ status: "unresolved", newFailures: [], flaky: [id] });
    expect(result.state).toBe("incomplete");
    expect(exitCodeOf(result)).toBe(4);
  });

  it("is flaky at the base: the candidate is not credited with fixing it", async () => {
    // Run 1 is the base, run 2 the candidate; the base's rerun comes after the candidate's runs.
    const probe = await counted(1);
    const fix = requirement("R1", "half(n) settles", "fix", ["half settles"]);
    const result = await probe.verify([fix]);
    const tests = result.checks[0]?.tests;
    expect(tests?.fixed).toEqual([]);
    expect(tests?.flaky).toEqual([id]);
    expect(tests?.reruns).toEqual([{ id, snapshot: "base", results: ["fail", "pass"] }]);
    expect(result.regression).toMatchObject({ status: "unresolved", flaky: [id] });
    expect(result.requirements[0]).toMatchObject({ status: "unverified" });
    expect(result.requirements[0]?.limitation).toMatch(
      /flaky: test\/half\.test\.mjs::half settles/,
    );
    expect(result.state).toBe("incomplete");
  });
});

describe("a base rerun where the candidate installs its own dependencies", () => {
  it("installs the base's again and still finds the test flaky there", async () => {
    const manifest = (version: string) =>
      `{"name":"fixture","version":"${version}","type":"module","private":true}\n`;
    const lock = (version: string) =>
      `{"name":"fixture","version":"${version}","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture","version":"${version}"}}}\n`;
    const probe = await counted(1, {
      "package.json": manifest("1.0.0"),
      "package-lock.json": lock("1.0.0"),
    });
    await probe.put("package.json", manifest("1.0.1"));
    await probe.put("package-lock.json", lock("1.0.1"));
    const result = await probe.verify([], { dependencies: "prepare" });
    expect(result.execution.dependencies.mode).toBe("prepared");
    expect(result.checks[0]?.tests?.reruns).toEqual([
      { id, snapshot: "base", results: ["fail", "pass"] },
    ]);
    expect(result.execution).toMatchObject({ policyMet: true, problems: [] });
    expect(result.regression).toMatchObject({ status: "unresolved", flaky: [id] });
  });
});

describe("checking a flaky result offline", () => {
  it("refuses a signed complete state over a check that records a flaky test", async () => {
    const probe = await counted(2);
    const result = await probe.verify();
    const directory = result.evidence.directory;
    const statement = JSON.parse(await readFile(join(directory, "statement.json"), "utf8"));
    // Signed as though the flaky check had passed: only the recorded flaky test contradicts it.
    statement.predicate.state = "complete";
    statement.predicate.regression.status = "none";
    statement.predicate.checks[0].result = "pass";
    statement.predicate.unmeasured = [];
    const forged = join(directory, "..", "forged");
    const patch = await readFile(join(directory, "change.patch"));
    const written = await writeAttestation(statement, patch, forged, {
      sigstore: false,
      resolveKey: () => resolveSigningKey(),
    });
    const checker = join(import.meta.dirname, "..", "..", "verify.mjs");
    const ran = spawnSync(
      process.execPath,
      [checker, written.bundle, "--key", written.publicKey ?? ""],
      { encoding: "utf8" },
    );
    expect(ran.stdout).toContain("FAILED state");
    expect(ran.status).toBe(6);
  });
});

describe("a test that fails on every run", () => {
  it("stays a new failure after its reruns, which are recorded", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", "export const half = n => n * 2;\n");
    const result = await probe.verify();
    const failing = "test/half.test.mjs::half positive";
    expect(result.regression).toMatchObject({ status: "found", newFailures: [failing], flaky: [] });
    expect(result.checks[0]?.tests?.reruns).toEqual([
      { id: failing, snapshot: "candidate", results: ["fail", "fail", "fail", "fail"] },
    ]);
    expect(exitCodeOf(result)).toBe(1);
  });

  it("is rerun as many times as the request asks", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", "export const half = n => n * 2;\n");
    const result = await probe.verify([], { reruns: 1 });
    expect(result.policy).toEqual({ behaviorChange: "none", reruns: 1 });
    expect(result.checks[0]?.tests?.reruns?.[0]?.results).toEqual(["fail", "fail"]);
  });
});
