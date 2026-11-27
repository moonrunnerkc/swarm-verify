import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { halfTest, probeFixture } from "./fixture.ts";

// Needs a docker daemon; the fixtures live under the user's home, which a docker VM shares.
const parent = join(homedir(), ".swarm", "test-work", `scripts-${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const manifest =
  '{"name":"fixture","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n';

describe("a dependency's install script", () => {
  it("does not run while the network is open, and runs after with the network closed", async () => {
    const probe = await probeFixture(
      {
        "half.mjs": "export const half = n => n;\n",
        "test/half.test.mjs": halfTest,
        // What the install script saw of the network, read by a test of the base's own.
        "test/reached.test.mjs":
          "import {test} from 'node:test';\nimport assert from 'node:assert';\nimport {readFileSync} from 'node:fs';\ntest('the install script ran offline', () => assert.equal(readFileSync('node_modules/scripted-lib/reached', 'utf8'), 'closed'));\n",
        "package.json": manifest,
      },
      "node --test",
      parent,
    );
    const sibling = join(probe.repo, "..", "scripted", "lib");
    await mkdir(sibling, { recursive: true });
    const script =
      "node -e \"fetch('https://registry.npmjs.org').then(()=>'open',()=>'closed').then((seen)=>require('fs').writeFileSync('reached',seen))\"";
    await writeFile(
      join(sibling, "package.json"),
      `${JSON.stringify({ name: "scripted-lib", version: "1.0.0", main: "index.js", scripts: { install: script } })}\n`,
    );
    await writeFile(join(sibling, "index.js"), "module.exports = 1;\n");
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--ignore-scripts", "../scripted/lib"],
      { cwd: probe.repo, stdio: "ignore" },
    );
    await rm(join(probe.repo, "node_modules"), { recursive: true, force: true });
    probe.git("add", "-A");
    probe.git("commit", "-qm", "depend on a package with an install script");
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    // The base fails on half alone: the script's marker is there, and says the network was closed.
    expect(result.baseline.status === "measured" && result.baseline.checks[0]?.exitCode).toBe(1);
    expect(result.state).toBe("complete");
  });
});
