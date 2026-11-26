import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { redactText } from "../evidence/redact.ts";
import { childEnvironment } from "../exec/child-environment.ts";
import type { CheckContext } from "../verify/checks.ts";
import { resourceArgs } from "../verify/resources.ts";
import {
  containerLimits,
  containerRun,
  docker,
  removeContainer,
  type Sandbox,
  settleWait,
  sharedFilesystemSettleMs,
} from "../verify/sandbox.ts";
import {
  type CaseResult,
  driverName,
  runScenario,
  type Scenario,
  type ScenarioResult,
} from "./scenario.ts";
import type { BehaviorCheck } from "./spec.ts";

export interface BehaviorRun {
  readonly check: string;
  /** Why no case was measured (the target never answered, the driver did not report), or null. */
  readonly notRun: string | null;
  readonly cases: readonly CaseResult[];
  /** What the target printed and what the driver reported, redacted, for the evidence. */
  readonly log: string;
}

const resultSchema = z.strictObject({
  ready: z.boolean(),
  cases: z.array(
    z.strictObject({ name: z.string(), status: z.enum(["pass", "fail"]), detail: z.string() }),
  ),
});

/** What the driver is handed of a check: where to wait for the target, and the cases. */
export const scenarioOf = (check: BehaviorCheck): Scenario => ({
  ready: check.target.ready,
  cases: check.cases.map(({ name, steps }) => ({ name, steps })),
});

/** Longest a driver may take: readiness, every wait, and time for each request to answer. */
function budgetMs(check: BehaviorCheck): number {
  const steps = check.cases.flatMap((one) => one.steps);
  const waits = steps.reduce((sum, step) => sum + step.waitMs, 0);
  return check.target.ready.timeoutMs + waits + steps.length * 20_000 + 30_000;
}

const targetEnv = (check: BehaviorCheck) => ({
  PORT: String(check.target.port),
  NODE_ENV: "test",
  ...check.target.env,
});

function settled(
  check: BehaviorCheck,
  reported: ScenarioResult | null,
  target: string,
  why: string,
): BehaviorRun {
  const log = redactText(
    `# target: ${check.target.start}\n${target}\n# driver\n${JSON.stringify(reported)}\n`,
  ).text;
  if (reported === null) return { check: check.name, notRun: why, cases: [], log };
  if (!reported.ready)
    return {
      check: check.name,
      notRun: `its target did not answer on port ${check.target.port} within ${check.target.ready.timeoutMs / 1000} s of \`${check.target.start}\`${why === "" ? "" : ` (${why})`}`,
      cases: [],
      log,
    };
  return { check: check.name, notRun: null, cases: reported.cases, log };
}

function read(stdout: string): z.infer<typeof resultSchema> | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return resultSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * In containers: the target runs the candidate with no network but its own loopback, and the
 * driver runs in a second container that shares only that loopback. The driver's files are
 * mounted read-only where the target can see them at all, and its report is read from its own
 * output, which the target has no way to write.
 */
async function isolated(
  check: BehaviorCheck,
  context: CheckContext,
  sandbox: Sandbox,
  side: string,
): Promise<BehaviorRun> {
  const dir = join(sandbox.scratch, "behavior");
  const own = fileURLToPath(new URL(import.meta.url));
  const typed = own.endsWith(".ts");
  const source = join(own, "..", typed ? "scenario.ts" : "scenario.js");
  const driver = join(dir, `${driverName}.${typed ? "mts" : "mjs"}`);
  const scenario = join(dir, `${check.name}-${side}.json`);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await copyFile(source, driver);
  await writeFile(scenario, JSON.stringify(scenarioOf(check)), { mode: 0o644 });
  const waited = settleWait(sandbox.clock.lastEnded, Date.now(), sharedFilesystemSettleMs);
  if (waited > 0) await new Promise((settle) => setTimeout(settle, waited));
  const target = containerRun(sandbox, {
    command: check.target.start,
    cwd: context.dir,
    env: { CI: "true", HOME: context.home, TMPDIR: "/tmp", ...targetEnv(check) },
    stage: "check",
    detached: true,
  });
  try {
    const started = await docker(target.args, 120_000);
    if (started.code !== 0)
      return settled(
        check,
        null,
        "",
        `its target could not start: ${started.stderr.trim().slice(-300)}`,
      );
    const drove = await docker(
      [
        "run",
        "--rm",
        "--network",
        `container:${target.name}`,
        "--user",
        sandbox.user,
        ...containerLimits,
        ...resourceArgs(sandbox.limits),
        "--mount",
        `type=bind,src=${dir},dst=${dir},readonly`,
        sandbox.image,
        "node",
        driver,
        scenario,
        `http://127.0.0.1:${check.target.port}`,
      ],
      budgetMs(check),
    );
    const logs = await docker(["logs", "--tail", "400", target.name], 60_000);
    const state = await docker(
      ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", target.name],
      60_000,
    );
    const [running = "", code = ""] = state.stdout.trim().split(" ");
    const exited = running === "false" ? `the target exited with code ${code}` : "";
    return settled(
      check,
      read(drove.stdout),
      `${logs.stdout}${logs.stderr}`,
      exited ||
        `its driver did not report (${drove.stderr.trim().slice(-300) || `exit ${drove.code}`})`,
    );
  } finally {
    await removeContainer(target.name);
    sandbox.clock.lastEnded = Date.now();
  }
}

/** On the host, as the caller's user: the target is a process group, the driver this process. */
async function onHost(check: BehaviorCheck, context: CheckContext): Promise<BehaviorRun> {
  const child = spawn("/bin/sh", ["-c", check.target.start], {
    cwd: context.dir,
    env: {
      ...childEnvironment(process.env, { homeDir: context.home }).variables,
      ...targetEnv(check),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  let exited: string | null = null;
  const keep = (chunk: Buffer) => {
    if (printed.length < 256 * 1024) printed += chunk.toString("utf8");
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("error", (error) => {
    exited = `the target could not start: ${error.message}`;
  });
  child.on("exit", (code) => {
    exited ??= `the target exited with code ${code}`;
  });
  try {
    const reported = await runScenario(scenarioOf(check), `http://127.0.0.1:${check.target.port}`);
    return settled(check, reported, printed, exited ?? "");
  } finally {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group ended between the check and the signal.
      }
    }
  }
}

/** One behavior check against the checkout as it stands, where the context says checks run. */
export async function runBehavior(
  check: BehaviorCheck,
  context: CheckContext,
  side: "base" | "candidate",
): Promise<BehaviorRun> {
  if (context.signal?.aborted)
    return { check: check.name, notRun: "it was cancelled", cases: [], log: "" };
  return context.execution.kind === "isolated"
    ? isolated(check, context, context.execution.sandbox, side)
    : onHost(check, context);
}
