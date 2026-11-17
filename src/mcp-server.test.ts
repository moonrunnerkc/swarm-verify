import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = resolve(import.meta.dirname, "..", "mcp.mjs");
const cli = resolve(import.meta.dirname, "swarm-verify.ts");
let root = "";
let repo = "";
let slow = "";

async function project(dir: string, check: string) {
  await mkdir(join(dir, "test"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(dir, "swarm.toml"), `[checks]\ntest = ${JSON.stringify(check)}\n`);
  await writeFile(join(dir, "half.mjs"), "export const half = (n) => n;\n");
  await writeFile(
    join(dir, "test", "half.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../half.mjs";\ntest("half", () => assert.equal(half(4), 2));\n',
  );
  git("add", "-A");
  git("commit", "-qm", "base");
  await writeFile(join(dir, "half.mjs"), "export const half = (n) => n / 2;\n");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-"));
  repo = join(root, "repo");
  slow = join(root, "slow");
  await project(repo, "node --test");
  await project(slow, `echo started > ${join(root, "slow-started")}; sleep 300`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The server, started on a CLI that verifies on the host, and a way to call it. */
function started(): {
  child: ChildProcess;
  call: (message: object) => Promise<any>;
  notify: (message: object) => void;
} {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      SWARM_VERIFY_MCP_CLI: cli,
      SWARM_HOME: join(root, "home"),
      SWARM_SIGNING_KEY: generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<unknown, (value: unknown) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let next = 0;
  return {
    child,
    call: (message) =>
      new Promise((settle) => {
        next += 1;
        pending.set(next, settle);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, ...message })}\n`);
      }),
    notify: (message) => child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
  };
}

describe("the MCP server", () => {
  it("answers a protocol revision it speaks with that revision, and another with its newest", async () => {
    const { child, call } = started();
    const known = await call({ method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(known.result.protocolVersion).toBe("2025-03-26");
    const unknown = await call({ method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
    const bad = await call({
      method: "tools/call",
      params: { name: "verify", arguments: { bogus: "x" } },
    });
    expect(bad.error.code).toBe(-32602);
    child.kill();
  });

  it("gives two simultaneous calls their own evidence", async () => {
    const { child, call } = started();
    const args = { name: "verify", arguments: { workspace: repo, isolation: "host" } };
    const [one, two] = await Promise.all([
      call({ method: "tools/call", params: args }),
      call({ method: "tools/call", params: args }),
    ]);
    const runs = [one, two].map((answer) => answer.result.structuredContent?.evidence?.runId);
    expect(runs[0]).toBeDefined();
    expect(runs[0]).not.toBe(runs[1]);
    child.kill();
  });

  it("stops a verification the client cancels", async () => {
    const { child, call, notify } = started();
    const answer = call({
      method: "tools/call",
      params: { name: "verify", arguments: { workspace: slow, isolation: "host" } },
    });
    for (let tries = 0; tries < 600; tries += 1) {
      if ((await readFile(join(root, "slow-started"), "utf8").catch(() => "")) !== "") break;
      await new Promise((settle) => setTimeout(settle, 100));
    }
    notify({ method: "notifications/cancelled", params: { requestId: 1 } });
    const result = await answer;
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/cancelled; no evidence was published/);
    expect(
      await readFile(join(slow, ".swarm", "verify"), "utf8").catch((error) => error.code),
    ).toMatch(/ENOENT|EISDIR/);
    child.kill();
  });
});
