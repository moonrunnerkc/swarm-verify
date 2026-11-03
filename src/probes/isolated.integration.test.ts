import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replay } from "../api/replay.ts";
import { seal } from "../verify/held-out.ts";
import { halfTest, probeFixture, requirement } from "./fixture.ts";

/**
 * The isolated backend end to end: needs a docker daemon, as isolated verification does. The
 * fixtures live under the user's home, which a docker VM shares, as the verifier's own home does.
 */
// Apart for each test process: afterAll removes it, and other checkouts may run at once.
const parent = join(homedir(), ".swarm", "test-work", `${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const manifest =
  '{"name":"fixture","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n';

describe("verifying in a container", () => {
  it("runs the checks in a pinned image with the network closed and says so", async () => {
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json": manifest,
    };
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([fix], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    expect(result.execution).toMatchObject({
      mode: "isolated",
      network: "closed",
      policyMet: true,
    });
    expect(result.execution.statement).toMatch(/^isolated: docker node:24@sha256:/);
    expect(result.environment.platform).toMatch(/^linux-/);
    expect(result.requirements[0]?.status).toBe("satisfied");
    expect(result.state).toBe("complete");
  });

  // A judging clone verified with SWARM_HOME=../home was blocked: docker resolved the relative
  // cache mount from the scratch directory it ran in, a path that did not exist.
  it("runs a sealed held-out check with SWARM_HOME given relative to where it started", async () => {
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "test/hidden/edge.test.mjs": halfTest
        .replace("half positive", "hidden")
        .replace("../half.mjs", "../../half.mjs"),
      "package.json": manifest,
      // A lockfile, so dependencies are prepared in a container with the cache mounted.
      "package-lock.json": `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture", version: "1.0.0" } } })}\n`,
    };
    const probe = await probeFixture(files, "node --test", parent);
    await seal(
      probe.repo,
      "test/hidden/**",
      [{ name: "test", command: "node --test", kind: "test" }],
      probe.home,
    );
    probe.git("commit", "-qam", "seal");
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([fix], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
      swarmHome: relative(process.cwd(), probe.home),
    });
    expect(result.heldOut).toMatchObject({ status: "measured", heldOutPassRate: 1 });
    expect(result.state).toBe("complete");
  });

  it("cannot reach the network from a check", async () => {
    const reach =
      "node -e \"fetch('https://registry.npmjs.org').then(()=>process.exit(0),()=>process.exit(1))\"";
    const probe = await probeFixture({ "package.json": manifest }, reach, parent);
    await probe.put("note.txt", "x\n");
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "none",
      network: "closed",
    });
    expect(result.baseline.status === "measured" && result.baseline.checks[0]?.exitCode).toBe(1);
    expect(result.checks[0]?.result).toBe("unresolved");
  });
});

describe("a lockfile that installs a package from beside the repository", () => {
  it("exports it next to the checkout, installs it in the container, and records its digest", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const lib = "export const divide = (a, b) => a / b;\n";
    const files = {
      "half.mjs": "import { divide } from 'sibling-lib';\nexport const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json": manifest,
    };
    const probe = await probeFixture(files, "node --test", parent);
    const sibling = join(probe.repo, "..", "sibling", "lib");
    await mkdir(sibling, { recursive: true });
    await writeFile(
      join(sibling, "package.json"),
      '{"name":"sibling-lib","version":"1.0.0","type":"module","main":"index.js"}\n',
    );
    await writeFile(join(sibling, "index.js"), lib);
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "../sibling/lib"], {
      cwd: probe.repo,
      stdio: "ignore",
    });
    await rm(join(probe.repo, "node_modules"), { recursive: true, force: true });
    probe.git("add", "-A");
    probe.git("commit", "-qm", "depend on the sibling");
    await probe.put(
      "half.mjs",
      "import { divide } from 'sibling-lib';\nexport const half = n => divide(n, 2);\n",
    );
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    expect(Object.keys(result.execution.dependencies.lockfiles)).toContain("local:../sibling/lib");
    expect(result.state).toBe("complete");
  });
});

describe("replaying an authorized behavior change", () => {
  it("reruns under the recorded policy and agrees", async () => {
    const expects = (value: string) =>
      `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {half} from '../half.mjs';\ntest('half', () => assert.equal(half(5), ${value}));\n`;
    const probe = await probeFixture(
      {
        "half.mjs": "export const half = n => n / 2;\n",
        "test/half.test.mjs": expects("2.5"),
        "package.json": manifest,
      },
      "node --test",
      parent,
    );
    await probe.put("half.mjs", "export const half = n => Math.floor(n / 2);\n");
    await probe.put("test/half.test.mjs", expects("2"));
    const result = await probe.verify([requirement("R1", "half(n) rounds down", "fix", ["half"])], {
      behaviorChange: "authorized",
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    expect(result.state).toBe("complete");
    const replayed = await replay(dirname(result.evidence.bundle ?? ""), {
      repository: probe.repo,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
    });
    expect(replayed.replayed.policy).toEqual({ behaviorChange: "authorized", reruns: 3 });
    expect(replayed.replayed.execution).toMatchObject({ mode: "isolated", network: "closed" });
    // A replay measures the base again rather than reading the run it is checking.
    expect(replayed.replayed.baseline).toMatchObject({ status: "measured", cached: false });
    expect(replayed.divergences).toEqual([]);
  });
});

describe("a pnpm project in a container", () => {
  it("runs its declared pnpm scripts, which the image has no pnpm for of its own", async () => {
    const probe = await probeFixture(
      {
        "half.mjs": "export const half = n => n;\n",
        "test/half.test.mjs": halfTest,
        "package.json":
          '{"name":"fixture","version":"1.0.0","type":"module","private":true,"packageManager":"pnpm@9.15.0","scripts":{"test":"node --test"}}\n',
        "pnpm-lock.yaml":
          "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
        // The declared check, as `swarm init` writes it for a pnpm project.
        "swarm.toml": '[checks]\ntest = "pnpm run test"\n',
      },
      "pnpm run test",
      parent,
    );
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify([requirement("R1", "half", "fix", ["half positive"])], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    expect(result.checks[0]).toMatchObject({ command: "pnpm run test", result: "pass" });
    expect(result.requirements[0]?.status).toBe("satisfied");
  });
});
