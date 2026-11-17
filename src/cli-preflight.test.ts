import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "swarm-verify.ts");
let root = "";
let repo = "";
let markers = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-preflight-"));
  repo = join(root, "repo");
  markers = join(root, "markers");
  await mkdir(markers);
  await mkdir(join(repo, "test"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const check = `touch ${join(markers, "check")} && node --test`;
  const setup = `touch ${join(markers, "setup")}`;
  await writeFile(
    join(repo, "swarm.toml"),
    `[checks]\ntest = ${JSON.stringify(check)}\n\n[verify]\nsetup = ${JSON.stringify(setup)}\n`,
  );
  await writeFile(join(repo, "half.mjs"), "export const half = (n) => n;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  await writeFile(join(repo, "half.mjs"), "export const half = (n) => n / 2;\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const preflight = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, "verify", "--preflight", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, SWARM_HOME: join(root, "home"), ...env },
  });

describe("verify --preflight", () => {
  it("says what a host run would do, and runs nothing of the project's", async () => {
    const ran = preflight(["--isolation", "host", "--dependencies", "prepare"]);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toMatch(/^check\s+test: touch .* \(pre-existing; /m);
    expect(ran.stdout).toMatch(/^setup\s+touch /m);
    expect(ran.stdout).toMatch(/^execution\s+host, not isolated/m);
    expect(ran.stdout).toMatch(/^acceptance\s+swarm-verify\.acceptance\/v1/m);
    expect(await readdir(markers)).toEqual([]);
    expect(await readdir(join(repo, ".swarm")).catch(() => [])).toEqual([]);
  });

  it("names a missing container runtime and exits 5, still running nothing", async () => {
    const ran = preflight(["--json"], { DOCKER_HOST: "unix:///nonexistent/preflight/docker.sock" });
    expect(ran.status).toBe(5);
    const plan = JSON.parse(ran.stdout);
    expect(plan.missing.join("\n")).toMatch(/docker daemon that answers/);
    expect(await readdir(markers)).toEqual([]);
  });
});
