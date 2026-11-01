import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The verifier as a user installs it: this checkout packed, the tarball installed into a fresh
 * prefix, then a change verified through the installed `swarm-verify` and its attestation checked
 * by the installed, dependency-free verify.mjs. Nothing here imports the source tree.
 */
const root = join(import.meta.dirname, "..");
const signingKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

let scratch = "";

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "packed-install-")));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("the packed verifier", () => {
  it("installs from its tarball, verifies a change and checks its own attestation", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const packs = join(scratch, "packs");
    await mkdir(packs);
    // prepack builds first and prints its line before npm's JSON.
    const printed = execFileSync("npm", ["pack", "--json", "--pack-destination", packs], {
      cwd: root,
      encoding: "utf8",
    });
    const packed = JSON.parse(printed.slice(printed.indexOf("[")));
    const tarball = join(packs, packed[0].filename);
    const prefix = join(scratch, "prefix");
    await mkdir(prefix);
    execFileSync(
      "npm",
      ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--prefer-offline", tarball],
      { encoding: "utf8" },
    );
    const installed = join(prefix, "node_modules", "swarm-verify");
    const bin = join(prefix, "node_modules", ".bin", "swarm-verify");
    expect(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()).toContain(
      manifest.version,
    );

    const repo = join(scratch, "repo");
    await mkdir(join(repo, "test"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    await writeFile(join(repo, "swarm.toml"), '[checks]\ntest = "node --test"\n');
    await writeFile(join(repo, "half.mjs"), "export const half = (n) => n;\n");
    await writeFile(
      join(repo, "test", "half.test.mjs"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../half.mjs";\ntest("half", () => assert.equal(half(4), 2));\n',
    );
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "fix");
    await writeFile(join(repo, "half.mjs"), "export const half = (n) => n / 2;\n");
    git("commit", "-qam", "fix");

    const env = {
      ...process.env,
      SWARM_SIGNING_KEY: signingKey,
      SWARM_HOME: join(scratch, "home"),
    };
    const out = join(scratch, "out");
    const verified = spawnSync(
      bin,
      ["verify", "--isolation", "host", "--range", "main..fix", "--out", out],
      { cwd: repo, encoding: "utf8", env },
    );
    expect(verified.stdout).toMatch(/^state\s+complete/m);
    expect(verified.status).toBe(0);

    const checked = spawnSync(
      process.execPath,
      [
        join(installed, "verify.mjs"),
        join(out, "attestation.sigstore.json"),
        "--key",
        join(out, "attestation.pub.pem"),
        "--patch",
        join(out, "change.patch"),
      ],
      { cwd: repo, encoding: "utf8" },
    );
    expect(checked.stdout).toContain("ok     signature");
    expect(checked.status).toBe(0);
  });
});
