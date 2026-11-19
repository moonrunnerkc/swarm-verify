import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replay } from "../api/replay.ts";
import { privateHome } from "../verify/checks.ts";
import { isolate } from "../verify/isolate.ts";
import { docker, runInSandbox } from "../verify/sandbox.ts";
import { fixtureSigner, halfTest, probeFixture, requirement } from "./fixture.ts";

/**
 * Memory and CPU bounds on a real docker daemon, with small fixtures: a 256 MiB container and an
 * allocation of 384 MiB, never anything that could exhaust the host.
 */
const parent = join(homedir(), ".swarm", "test-work", `resources-${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const manifest =
  '{"name":"fixture","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n';
const isolated = { mode: "isolated", dependencies: "none", network: "closed" } as const;
const small = { memoryMiB: 256, cpus: 1 };
const gone = async (name: string) =>
  (await docker(["inspect", "--format", "{{.Name}}", name], 30_000)).code !== 0;

describe("bounded containers", () => {
  it("bounds the check's own container and records what its cgroup applied", async () => {
    const read =
      "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/cpu.max";
    const probe = await probeFixture({ "package.json": manifest }, read, parent);
    await probe.put("note.txt", "x\n");
    const result = await probe.verify([], { ...isolated, resources: small });
    const log = await readFile(join(result.evidence.directory, "logs", "test.txt"), "utf8");
    expect(log.split("\n").slice(0, 3)).toEqual([String(256 * 1024 * 1024), "0", "100000 100000"]);
    expect(result.execution.resources).toEqual({
      requested: small,
      effective: { memoryBytes: 256 * 1024 * 1024, swapBytes: 0, cpus: 1, cgroup: "v2" },
      scope: "per-container",
    });
    expect(result.execution.statement).toMatch(
      /memory 256 MiB with no swap and 1 CPU, per container$/,
    );
    expect(result.execution.policyMet).toBe(true);
  });

  it("verifies an ordinary change within the default bounds", async () => {
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json": manifest,
    };
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([fix], isolated);
    expect(result.execution.resources?.requested).toEqual({ memoryMiB: 4096, cpus: 2 });
    expect(result.state).toBe("complete");
  });

  it("never verifies a change whose test is killed at the memory limit", async () => {
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json": manifest,
    };
    const probe = await probeFixture(files, "node --test", parent);
    // Touches every page of 384 MiB inside a 256 MiB container with no swap, then answers right.
    await probe.put(
      "half.mjs",
      "const held = Buffer.alloc(384 * 1024 * 1024, 1);\nexport const half = n => (held.length > 0 ? n / 2 : n);\n",
    );
    const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([fix], { ...isolated, resources: small });
    expect(result.checks[0]?.result).toBe("unresolved");
    expect(result.reasons.join("\n")).toMatch(
      /256 MiB memory limit and a process in it was killed/,
    );
    expect(result.requirements[0]?.status).not.toBe("satisfied");
    expect(result.state).not.toBe("complete");
  });

  it("reads a SIGKILL from elsewhere as the exit it is, not as the memory limit", async () => {
    const probe = await probeFixture({ "package.json": manifest }, "kill -9 $$", parent);
    await probe.put("note.txt", "x\n");
    const result = await probe.verify([], { ...isolated, resources: small });
    expect(result.baseline.status === "measured" && result.baseline.checks[0]?.exitCode).toBe(137);
    expect(result.reasons.join("\n")).not.toMatch(/memory limit/);
  });

  it("blocks a run whose CPU bound docker cannot give, and runs nothing", async () => {
    const marker = join(parent, "cpus-marker");
    const probe = await probeFixture({ "package.json": manifest }, `touch ${marker}`, parent);
    await probe.put("note.txt", "x\n");
    const result = await probe.verify([], {
      ...isolated,
      resources: { memoryMiB: 512, cpus: 1000 },
    });
    expect(result.state).toBe("blocked");
    expect(result.reasons.join("\n")).toMatch(/docker refused the resource limits/);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("removes the container after it exits, times out or is cancelled", async () => {
    const probe = await probeFixture({ "package.json": manifest }, "true", parent);
    const scratch = dirname(probe.repo);
    const made = await isolate({ ...isolated, resources: small }, probe.repo, scratch, probe.home, [
      "node",
    ]);
    if ("unavailable" in made) throw new Error(made.unavailable);
    const home = await privateHome(scratch);
    const context = { dir: probe.repo, home, maxOutputBytes: 1024 };
    const done = await runInSandbox(
      made.sandbox,
      "true",
      { ...context, timeoutMs: 60_000 },
      {},
      "check",
    );
    expect(done.exitCode).toBe(0);
    expect(await gone(done.container)).toBe(true);
    const slow = await runInSandbox(
      made.sandbox,
      "sleep 60",
      { ...context, timeoutMs: 3_000 },
      {},
      "check",
    );
    expect(slow.timedOut).toBe(true);
    expect(await gone(slow.container)).toBe(true);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3_000);
    const signal = controller.signal;
    const stopped = await runInSandbox(
      made.sandbox,
      "sleep 60",
      { ...context, timeoutMs: 60_000, signal },
      {},
      "check",
    );
    expect(stopped.cancelled).toBe(true);
    expect(await gone(stopped.container)).toBe(true);
  });

  it("keys the base cache on the bounds and replays under the recorded ones", async () => {
    const pinned = {
      version: "7.0.0",
      resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      integrity:
        "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
    };
    const packages = {
      "": { name: "fixture", version: "1.0.0", dependencies: { "is-number": "7.0.0" } },
      "node_modules/is-number": pinned,
    };
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json":
        '{"name":"fixture","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"},"dependencies":{"is-number":"7.0.0"}}\n',
      "package-lock.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages })}\n`,
    };
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const policy = { mode: "isolated", dependencies: "prepare", network: "closed" } as const;
    const first = await probe.verify([], { ...policy, resources: small });
    expect(first.baseline).toMatchObject({ status: "measured", cached: false });
    const same = await probe.verify([], { ...policy, resources: small });
    expect(same.baseline).toMatchObject({ status: "measured", cached: true });
    const larger = await probe.verify([], { ...policy, resources: { memoryMiB: 512, cpus: 1 } });
    expect(larger.baseline).toMatchObject({ status: "measured", cached: false });
    const again = await replay(first.evidence.directory, {
      repository: probe.repo,
      out: join(dirname(first.evidence.directory), "replay"),
      verifierVersion: "probe",
      signer: fixtureSigner(),
      swarmHome: probe.home,
    });
    expect(again.replayed.execution.resources?.requested).toEqual(small);
    expect(again.environmentDrift.filter((line) => line.startsWith("resources"))).toEqual([]);
    expect(again.divergences).toEqual([]);
  });
});
