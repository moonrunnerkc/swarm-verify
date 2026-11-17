import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeFixture } from "../probes/fixture.ts";

let markers = "";
const savedDockerHost = process.env.DOCKER_HOST;
beforeEach(async () => {
  markers = await mkdtemp(join(tmpdir(), "isolation-markers-"));
});
afterEach(async () => {
  await rm(markers, { recursive: true, force: true });
  if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedDockerHost;
});

/** A project whose setup and check each leave a harmless marker file where they ran. */
async function markingProject() {
  const setup = `touch ${JSON.stringify(join(markers, "setup-ran"))}`;
  const check = `touch ${JSON.stringify(join(markers, "check-ran"))} && node --test`;
  const probe = await probeFixture(
    {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs":
        "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {half} from '../half.mjs';\ntest('half', () => assert.equal(half(2), 2));\n",
      "package-lock.json": '{"name":"p","lockfileVersion":3,"packages":{}}\n',
    },
    check,
  );
  await probe.put(
    "swarm.toml",
    `[checks]\ntest = ${JSON.stringify(check)}\n\n[verify]\nsetup = ${JSON.stringify(setup)}\n`,
  );
  probe.git("add", "-A");
  probe.git("commit", "-qm", "declare a marking setup");
  await probe.put("package.json", '{"name":"p","version":"1.0.1"}\n');
  await probe.put("half.mjs", "export const half = n => n / 2;\n");
  return probe;
}

// F1 (2026-11-17 review): an isolated run whose container could not be made recorded the
// failure, then prepared dependencies and could run checks on the host anyway.
describe("isolation that is requested and not available", () => {
  it("runs no setup and no check when the docker daemon does not answer", async () => {
    process.env.DOCKER_HOST = "unix:///nonexistent/swarm-verify-test/docker.sock";
    const probe = await markingProject();
    const result = await probe.verify([], { mode: "isolated", dependencies: "prepare" });
    expect(result.state).toBe("blocked");
    expect(result.reasons[0]).toMatch(/docker daemon does not answer/);
    expect(await readdir(markers)).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.environment.dependencies).toBe("none");
  });

  it("runs nothing when the image cannot be made ready", async () => {
    const probe = await markingProject();
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "prepare",
      image: "swarm-verify-test.invalid/no-such-image:0",
    });
    expect(result.state).toBe("blocked");
    expect(await readdir(markers)).toEqual([]);
  });

  it("runs nothing when the policy itself is refused (linked dependencies in isolation)", async () => {
    const probe = await markingProject();
    const result = await probe.verify([], { mode: "isolated", dependencies: "linked" });
    expect(result.state).toBe("blocked");
    expect(result.reasons[0]).toMatch(/linked dependencies cannot be used in isolation/);
    expect(await readdir(markers)).toEqual([]);
  });

  it("runs setup and checks on the host only when the caller names the host", async () => {
    const probe = await markingProject();
    const result = await probe.verify([], { mode: "host", dependencies: "prepare" });
    expect((await readdir(markers)).sort()).toEqual(["check-ran", "setup-ran"]);
    expect(result.execution.statement).toBe("host, not isolated");
  });
});
