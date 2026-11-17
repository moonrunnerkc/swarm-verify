import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "swarm-verify.ts");
let root = "";
let repo = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-cancel-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "test"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  // The check starts a long-lived descendant, records its pid, and waits on it.
  const pidFile = join(root, "descendant.pid");
  await writeFile(
    join(repo, "swarm.toml"),
    `[checks]\ntest = ${JSON.stringify(`sleep 300 & echo $! > ${pidFile}; wait`)}\n`,
  );
  await writeFile(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  await writeFile(join(repo, "a.txt"), "b\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a run cancelled by a signal", () => {
  it("exits 3, stops the checks' descendants, and leaves no complete evidence", async () => {
    const out = join(root, "out");
    const child = spawn(process.execPath, [cli, "verify", "--isolation", "host", "--out", out], {
      cwd: repo,
      env: {
        ...process.env,
        SWARM_HOME: join(root, "home"),
        SWARM_SIGNING_KEY: generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "pem" })
          .toString(),
      },
      stdio: "ignore",
    });
    const pidFile = join(root, "descendant.pid");
    let pid = Number.NaN;
    for (let tries = 0; tries < 600 && Number.isNaN(pid); tries += 1) {
      await new Promise((settle) => setTimeout(settle, 100));
      pid = Number.parseInt((await readFile(pidFile, "utf8").catch(() => "")).trim(), 10);
    }
    expect(alive(pid)).toBe(true);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((settle) => child.on("close", settle));
    expect(code).toBe(3);
    await new Promise((settle) => setTimeout(settle, 500));
    expect(alive(pid)).toBe(false);
    const published = await readdir(out).catch(() => [] as string[]);
    if (published.includes("statement.json")) {
      const statement = JSON.parse(await readFile(join(out, "statement.json"), "utf8"));
      expect(statement.predicate.state).not.toBe("complete");
    }
  });
});
