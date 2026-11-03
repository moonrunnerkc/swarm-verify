import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareJudge, readJudge } from "./judge.ts";

let scratch = "";
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A Node process with the judge loaded, running `program` beside `files` in its directory. */
async function judged(program: string, files: Readonly<Record<string, string>> = {}) {
  scratch = await mkdtemp(join(tmpdir(), "judge-"));
  const judge = await prepareJudge(scratch, "probe", scratch);
  for (const [name, text] of Object.entries(files)) await writeFile(join(scratch, name), text);
  const child = spawn(process.execPath, ["-e", program], {
    cwd: scratch,
    env: { ...process.env, ...judge.env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let printed = "";
  child.stdout?.on("data", (chunk) => {
    printed += String(chunk);
  });
  // The judge writes its start line before the program runs; the program prints when ready.
  while (!printed.includes("ready")) await new Promise((done) => setTimeout(done, 20));
  return { child, report: judge.report, printed: () => printed };
}

const ended = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );

// vitest ends its pool's worker processes with SIGTERM, which runs no exit handler: a held-out
// vitest check reported 29 of depose's 32 processes as never checked, and failed whatever its
// tests did (orchestrator patch run, depose 09b01c1).
describe("the judge in a process a signal ends", () => {
  it("checks a process ended by SIGTERM, which still ends by that signal", async () => {
    const { child, report } = await judged("setInterval(() => {}, 1000); console.log('ready');");
    const exit = ended(child);
    child.kill("SIGTERM");
    expect(await exit).toEqual({ code: null, signal: "SIGTERM" });
    expect(await readJudge(report)).toMatchObject({ processes: 1, problem: null });
  });

  it("leaves a process's own SIGTERM handler to decide how it ends", async () => {
    const { child, report, printed } = await judged(
      "process.on('SIGTERM', () => { console.log('graceful'); setTimeout(() => process.exit(3), 50); }); setInterval(() => {}, 1000); console.log('ready');",
    );
    const exit = ended(child);
    child.kill("SIGTERM");
    expect(await exit).toEqual({ code: 3, signal: null });
    expect(printed()).toContain("graceful");
    expect(await readJudge(report)).toMatchObject({ processes: 1, problem: null });
  });

  it("still reports a process killed outright, which nothing can check", async () => {
    const { child, report } = await judged("setInterval(() => {}, 1000); console.log('ready');");
    const exit = ended(child);
    child.kill("SIGKILL");
    expect(await exit).toEqual({ code: null, signal: "SIGKILL" });
    expect((await readJudge(report)).problem).toBe(
      "1 process(es) exited before the judge could check them",
    );
    expect(await readFile(report, "utf8")).toMatch(/^start [0-9a-f]{64}\n$/);
  });
});

// vitest 1's default pool runs tests in worker threads and ends them with terminate(), which runs
// nothing in the thread: claimcheck's held-out check reported 28 starts with no end, and failed
// whatever its tests did (orchestrator patch run, claimcheck d2f136c).
describe("the judge in a worker thread", () => {
  it("counts a thread its runner terminated as unchecked, not as a change", async () => {
    const { child, report } = await judged(
      "console.log('ready'); const w = new (require('node:worker_threads').Worker)(require('node:path').resolve('worker.cjs')); w.once('online', () => setTimeout(() => w.terminate().then(() => process.exit(0)), 100));",
      { "worker.cjs": "setInterval(() => {}, 1000);\n" },
    );
    expect(await ended(child)).toEqual({ code: 0, signal: null });
    expect(await readJudge(report)).toMatchObject({
      processes: 1,
      uncheckedThreads: 1,
      problem: null,
    });
  });

  it("still reports a thread that changed an assertion", async () => {
    const { child, report } = await judged(
      "console.log('ready'); new (require('node:worker_threads').Worker)(require('node:path').resolve('worker.cjs'));",
      { "worker.cjs": "require('node:assert').equal = () => {};\n" },
    );
    expect(await ended(child)).toEqual({ code: 0, signal: null });
    expect(await readJudge(report)).toMatchObject({
      uncheckedThreads: 0,
      problem: "the code under test changed assert.equal",
    });
  });
});
