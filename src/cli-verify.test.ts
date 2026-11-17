import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "swarm-verify.ts");
const verifier = resolve(import.meta.dirname, "..", "verify.mjs");
const signingKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

let root = "";
let repo = "";
let out = "";

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const node = (args: string[], cwd = repo) =>
  spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SWARM_SIGNING_KEY: signingKey, SWARM_HOME: join(root, "home") },
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-verify-"));
  repo = join(root, "repo");
  out = join(root, "out");
  await mkdir(join(repo, "test"), { recursive: true });
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
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("swarm verify and verify.mjs", () => {
  it("verifies a ref range, signs it, and the dependency-free script agrees", async () => {
    const ran = node([cli, "verify", "--isolation", "host", "--range", "main..fix", "--out", out]);
    expect(ran.stdout).toMatch(/^state\s+complete/m);
    expect(ran.status).toBe(0);

    const tree = join(root, "tree");
    await mkdir(tree);
    execFileSync("sh", ["-c", `git archive fix | tar -x -C ${tree}`], { cwd: repo });
    const checked = node([
      verifier,
      join(out, "attestation.sigstore.json"),
      "--key",
      join(out, "attestation.pub.pem"),
      "--patch",
      join(out, "change.patch"),
      "--tree",
      tree,
    ]);
    expect(checked.stdout).toContain("ok     signature");
    expect(checked.stdout).toContain("ok     tree");
    expect(checked.status).toBe(0);
  });

  it("fails verify.mjs after one byte of the attestation changes", async () => {
    const path = join(out, "attestation.sigstore.json");
    const bytes = await readFile(path);
    const at = bytes.indexOf('"payload": "') + 30;
    bytes[at] = bytes[at] === 0x41 ? 0x42 : 0x41;
    await writeFile(join(root, "tampered.json"), bytes);
    const checked = node([
      verifier,
      join(root, "tampered.json"),
      "--key",
      join(out, "attestation.pub.pem"),
    ]);
    expect(checked.stdout).toContain("FAILED signature");
    // Integrity failing is its own exit code, apart from a task that was not accepted.
    expect(checked.status).toBe(6);
  });

  it("exits 1 for a failing change and 2 for a command line it cannot read", () => {
    expect(
      node([
        cli,
        "verify",
        "--isolation",
        "host",
        "--range",
        "fix..main",
        "--out",
        join(root, "out-2"),
      ]).status,
    ).toBe(1);
    const unread = node([cli, "verify", "--patch", "a", "--range", "b..c"]);
    expect(unread.status).toBe(2);
    expect(unread.stderr).toContain("not both");
  });

  it("lists exactly the commands it has", () => {
    const help = node([cli, "--help"]).stdout;
    const listed = [...help.matchAll(/^ {2}swarm-verify (\S+)/gm)].map((match) => match[1]);
    expect(listed).toEqual(["verify", "init", "replay", "ci"]);
  });
});

// F7 (2026-11-17 review): a keyless signature that failed still exited 0 for a complete run, and
// left an earlier run's bundle at the expected output path.
describe("evidence that is not delivered as required", () => {
  const failingCosign = async () => {
    const bin = join(root, "failing-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cosign"), "#!/bin/sh\necho 'no identity token' >&2\nexit 1\n");
    execFileSync("chmod", ["755", join(bin, "cosign")]);
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  };
  const withEnv = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, SWARM_SIGNING_KEY: signingKey, SWARM_HOME: join(root, "home") },
    });

  it("exits 7 when a required signature fails, and never presents an older run as this one", async () => {
    const target = join(root, "out-signed-then-failed");
    const first = node([
      cli,
      "verify",
      "--isolation",
      "host",
      "--range",
      "main..fix",
      "--out",
      target,
    ]);
    expect(first.status).toBe(0);
    const before = await readFile(join(target, "attestation.sigstore.json"), "utf8");

    const env = await failingCosign();
    const again = withEnv(
      [cli, "verify", "--isolation", "host", "--range", "main..fix", "--out", target, "--sigstore"],
      env,
    );
    expect(again.status).toBe(7);
    expect(await readFile(join(target, "attestation.sigstore.json"), "utf8")).toBe(before);

    const fresh = join(root, "out-sigstore-failed");
    const failed = withEnv(
      [cli, "verify", "--isolation", "host", "--range", "main..fix", "--out", fresh, "--sigstore"],
      env,
    );
    expect(failed.status).toBe(7);
    expect(failed.stdout).toMatch(/^delivery\s+failed/m);
    const manifest = JSON.parse(await readFile(join(fresh, "manifest.json"), "utf8"));
    expect(manifest.delivery).toBe("failed");
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain(
      "attestation.sigstore.json",
    );
  });

  it("exits with the task's code when unsigned evidence was asked for by name", async () => {
    const env = await failingCosign();
    const unsigned = withEnv(
      [
        cli,
        "verify",
        "--isolation",
        "host",
        "--range",
        "main..fix",
        "--out",
        join(root, "out-unsigned"),
        "--sigstore",
        "--allow-unsigned",
      ],
      env,
    );
    expect(unsigned.stdout).toMatch(/^delivery\s+unsigned/m);
    expect(unsigned.status).toBe(0);
  });
});
