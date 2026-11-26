import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openWorker, type Worker } from "./worker.ts";

/**
 * The container boundary a coding agent's commands run in, attacked from inside with synthetic
 * secrets. Needs a docker daemon; the fixtures live under the user's home, which a docker VM shares.
 */
const parent = join(homedir(), ".swarm", "test-work", `worker-${process.pid}`);
const workspace = join(parent, "workspace");
const home = join(parent, "home");
const secrets = join(parent, "trusted");
const secret = "synthetic-signing-key-7f3a";
let worker: Worker;

const run = (command: string, network: "closed" | "dependencies" = "closed") =>
  worker.run(command, { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, network });

beforeAll(async () => {
  for (const dir of [workspace, home, secrets]) await mkdir(dir, { recursive: true });
  await writeFile(join(secrets, "signing.pem"), secret);
  await writeFile(join(secrets, "acceptance.json"), '{"required":true}\n');
  await writeFile(join(workspace, "package.json"), '{"name":"w","private":true}\n');
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  process.env.SYNTHETIC_PROVIDER_KEY = secret;
  const opened = await openWorker({
    workspace,
    home,
    readOnly: [join(workspace, ".git")],
    cache: join(parent, "cache"),
    accounts: join(parent, "accounts"),
    resources: { memoryMiB: 256, cpus: 1 },
  });
  if ("unavailable" in opened) throw new Error(opened.unavailable);
  worker = opened;
}, 300_000);

afterAll(async () => {
  delete process.env.SYNTHETIC_PROVIDER_KEY;
  await rm(parent, { recursive: true, force: true });
});

describe("the worker boundary", () => {
  it("runs a command in the workspace, as a user the image knows, and keeps what it writes", async () => {
    const ran = await run(
      "node -e \"require('fs').writeFileSync('made.txt', process.cwd())\" && id -un",
    );
    expect(ran.exitCode).toBe(0);
    expect(await readFile(join(workspace, "made.txt"), "utf8")).toBe(workspace);
    expect(worker.resources.effective.memoryBytes).toBe(256 * 1024 * 1024);
  });

  it("gives the commands none of the caller's environment, home or docker socket", async () => {
    const ran = await run("printenv; echo HOME=$HOME; ls /var/run/docker.sock; ls /Users /home");
    expect(ran.stdout).not.toContain(secret);
    expect(ran.stdout).not.toContain("SYNTHETIC_PROVIDER_KEY");
    expect(ran.stdout).toContain(`HOME=${home}`);
    expect(ran.stdout).not.toContain("docker.sock\n");
    expect(ran.stdout).not.toContain(".ssh");
  });

  it("cannot read or write trusted files outside the workspace, directly, through an interpreter or a link", async () => {
    const key = join(secrets, "signing.pem");
    const policy = join(secrets, "acceptance.json");
    const attempts = [
      `cat ${key}`,
      `echo '{"required":false}' > ${policy}`,
      `node -e "require('fs').writeFileSync('${policy}', '{}')"`,
      `node -e "require('child_process').execSync('cat ${key}', {stdio: 'inherit'})"`,
      `ln -s ${secrets} leak && cat leak/signing.pem`,
      `ln -s ${policy} policy-link && echo forged > policy-link`,
    ];
    for (const attempt of attempts) {
      const ran = await run(attempt);
      expect(`${attempt}: ${ran.exitCode !== 0}`).toBe(`${attempt}: true`);
      expect(ran.stdout).not.toContain(secret);
    }
    expect(await readFile(policy, "utf8")).toBe('{"required":true}\n');
    expect(await readFile(key, "utf8")).toBe(secret);
  });

  it("cannot write the workspace's git directory, which the supervisor reads", async () => {
    const before = await readFile(join(workspace, ".git", "config"), "utf8");
    const direct = await run("printf '[core]\\n\\tfsmonitor = /bin/false\\n' >> .git/config");
    const indirect = await run(
      "node -e \"require('fs').writeFileSync('.git/hooks/pre-commit', '#!/bin/sh\\nexit 1\\n')\"",
    );
    expect(direct.exitCode).not.toBe(0);
    expect(indirect.exitCode).not.toBe(0);
    expect(await readFile(join(workspace, ".git", "config"), "utf8")).toBe(before);
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);
    expect((await run("git status --short")).exitCode).toBe(0);
  });

  it("has no network, in the command or a child of it, until the dependency stage is asked for", async () => {
    const reach =
      "node -e \"fetch('https://registry.npmjs.org/-/ping').then(()=>process.exit(0),()=>process.exit(7))\"";
    expect((await run(reach)).exitCode).toBe(7);
    expect((await run(`sh -c '${reach.replaceAll("'", "'\\''")}'`)).exitCode).toBe(7);
    expect((await run(reach, "dependencies")).exitCode).toBe(0);
  });

  it("reports a command that exhausts its memory bound as exhausted, not as a failure of the code", async () => {
    const ran = await run('node -e "const held=[];for(;;)held.push(Buffer.alloc(32*1024*1024,1))"');
    expect(ran.exhausted).toMatch(/256 MiB memory limit/);
  });

  it("stops a command at its time limit and leaves no container behind", async () => {
    const ran = await worker.run("sleep 300", { timeoutMs: 4000, maxOutputBytes: 1024 });
    expect(ran.timedOut).toBe(true);
    const left = execFileSync("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=${ran.container}`,
    ]);
    expect(left.toString().trim()).toBe("");
  });
});

describe("a worker that cannot be made", () => {
  it("says why and how to proceed, and runs nothing", async () => {
    const saved = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
    try {
      const opened = await openWorker({
        workspace,
        home,
        readOnly: [],
        cache: join(parent, "cache"),
        accounts: join(parent, "accounts"),
      });
      expect(opened).toMatchObject({
        unavailable: expect.stringMatching(/isolated execution is not available.*Start docker/),
      });
    } finally {
      if (saved === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = saved;
    }
  });
});
