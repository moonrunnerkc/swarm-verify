import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TrustedCheck } from "../api/request.ts";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { redactText } from "../evidence/redact.ts";
import { childEnvironment } from "../exec/child-environment.ts";
import { type ProcessRunResult, runProcessGroup } from "../exec/run-process.ts";
import { gitText } from "./change.ts";
import { readDiagnostics } from "./diagnostics.ts";
import { type CheckResult, checkResultSchema, type Predicate } from "./predicate.ts";
import { runInSandbox, type Sandbox } from "./sandbox.ts";
import { collectedFromOutput, testEvidenceSchema } from "./test-report.ts";

export interface CheckRun {
  readonly result: CheckResult;
  /** Everything the check printed, capped at 4 MiB; written to the evidence as a log. */
  readonly output: string;
  /** The end of what the check printed, for the person or agent reading a failure. */
  readonly outputTail: string;
  /** Why the command could not run (it timed out, was cancelled or never started), or null. */
  readonly notRun: string | null;
  /**
   * The compiler diagnostics a failing run printed, without line and column; null where it
   * passed, never ran, printed none or its output was cut at the cap.
   */
  readonly diagnostics: readonly string[] | null;
}

/**
 * Where project-controlled commands may run, decided once by the caller. Host is a caller's
 * explicit choice; a container that could not be made never becomes host, it stops the run.
 */
export type ExecutionCapability =
  | { readonly kind: "host" }
  | { readonly kind: "isolated"; readonly sandbox: Sandbox };

export const hostExecution: ExecutionCapability = { kind: "host" };

export interface CheckContext {
  readonly dir: string;
  /** A private HOME for the checks; never the operator's. */
  readonly home: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly execution: ExecutionCapability;
  /** Whether checks may reach the network inside the container. */
  readonly checkNetwork?: "closed" | "open" | undefined;
}

const maxOutputBytes = 4 * 1024 * 1024;
const tailBytes = 4000;

/** Runs one check through the shell in the checkout, under an environment built here. */
export async function runCheck(
  check: DeclaredCheck,
  context: CheckContext,
  extraEnv: Readonly<Record<string, string>> = {},
  stage: "prepare" | "check" = "check",
): Promise<CheckRun> {
  const started = Date.now();
  // The base run, the change and the mutant rewrite the same files within seconds, often at the
  // same size; a .pyc written by one run would be trusted by the next.
  const env = { PYTHONDONTWRITEBYTECODE: "1", ...extraEnv };
  const execution = context.execution;
  const ran: ProcessRunResult & { readonly exhausted?: string | null } =
    execution.kind === "host"
      ? await runProcessGroup("/bin/sh", ["-c", check.command], {
          cwd: context.dir,
          env: { ...childEnvironment(process.env, { homeDir: context.home }).variables, ...env },
          timeoutMs: context.timeoutMs,
          maxOutputBytes,
          signal: context.signal,
        })
      : await runInSandbox(
          execution.sandbox,
          check.command,
          { ...context, maxOutputBytes },
          env,
          stage,
        );
  // Semantics come from what the check printed; only redacted text is hashed, kept or shown.
  // Each stream apart, since the cap cuts each from its head.
  const printed = `${ran.stdout}${ran.stderr}`;
  const output = `${redactText(ran.stdout).text}${redactText(ran.stderr).text}`;
  // A confirmed memory kill is resource exhaustion, not a failed assertion: never measured.
  const exhausted = ran.exhausted ?? null;
  const notRun = ran.timedOut
    ? "it timed out"
    : ran.cancelled
      ? "it was cancelled"
      : exhausted !== null
        ? exhausted
        : ran.startFailure === null
          ? null
          : `it never started (${redactText(ran.startFailure).text})`;
  const failedToRun = notRun !== null;
  const note = ran.timedOut
    ? "\n[timed out]"
    : exhausted !== null
      ? `\n[${exhausted}]`
      : ran.startFailure === null
        ? ""
        : `\n[${redactText(ran.startFailure).text}]`;
  return {
    notRun,
    result: {
      name: check.name,
      command: check.command,
      kind: check.kind,
      authority: check.authority ?? "pre-existing",
      result: failedToRun ? "error" : ran.exitCode === 0 ? "pass" : "fail",
      exitCode: failedToRun ? null : ran.exitCode,
      collected: check.kind === "test" ? collectedFromOutput(printed) : null,
      durationMs: Date.now() - started,
      outputSha256: createHash("sha256").update(output).digest("hex"),
    },
    output,
    outputTail: `${output.slice(-tailBytes)}${note}`,
    diagnostics: failedToRun || ran.exitCode === 0 ? null : readDiagnostics(output, ran.truncated),
  };
}

export async function privateHome(scratch: string): Promise<string> {
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** The share of measured checks that hold; a check that measured nothing is left out. */
export function passRate(runs: readonly CheckResult[]): number {
  const measured = runs.filter((run) => run.result !== "unresolved" && run.result !== "no-tests");
  const holds = (run: CheckResult) => run.result === "pass" || run.result === "inherited-failures";
  return measured.length === 0 ? 0 : measured.filter(holds).length / measured.length;
}

export const lockfileNames = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
];

/** The sha256 of each lockfile in `dir`, by name. */
export async function lockfileDigests(dir: string): Promise<Record<string, string>> {
  const locks: Record<string, string> = {};
  for (const name of lockfileNames) {
    const content = await readFile(join(dir, name)).catch(() => null);
    if (content !== null) locks[name] = createHash("sha256").update(content).digest("hex");
  }
  return locks;
}

/**
 * What the checks ran on, and one digest over it: toolchain, platform, the check commands and
 * the lockfiles in the checkout. Two runs with the same digest ran the same declared commands
 * against the same pinned dependencies on the same toolchain.
 */
export async function environmentOf(
  dir: string,
  checks: readonly DeclaredCheck[],
  dependencies: {
    readonly mode: Predicate["environment"]["dependencies"];
    readonly lockfiles: Readonly<Record<string, string>>;
    readonly treeSha256: string | null;
    readonly reproducible: boolean;
  },
  isolation: { readonly image: string; readonly imageId: string } | null = null,
): Promise<Predicate["environment"]> {
  const git = (await gitText(dir, ["--version"])).replace(/^git version /, "");
  const [imageId = "", architecture = ""] = isolation?.imageId.split(" ") ?? [];
  const described = {
    // In a container the runtime is the image's; its content digest names it exactly.
    node: isolation === null ? process.version : `in ${isolation.image} (${imageId})`,
    platform: isolation === null ? `${process.platform}-${process.arch}` : `linux-${architecture}`,
    git,
    dependencies: dependencies.mode,
    checks: checks.map(({ name, command }) => ({ name, command })),
    lockfiles: dependencies.lockfiles,
    dependencyTree: dependencies.treeSha256,
  };
  return {
    sha256: createHash("sha256").update(JSON.stringify(described)).digest("hex"),
    node: described.node,
    platform: described.platform,
    git,
    dependencies: dependencies.mode,
    dependencyTreeSha256: dependencies.treeSha256,
    reproducible: dependencies.reproducible,
  };
}

const storedBaseSchema = z.object({
  checks: z.array(checkResultSchema),
  /** Each declared check's runner report at base, in the same order as `checks`. */
  tests: z.array(testEvidenceSchema),
  /**
   * Each declared check's diagnostics at base, in the same order as `checks`: a check with no
   * report that fails at both commits is compared by them, and the base's output is not kept.
   */
  diagnostics: z.array(z.array(z.string()).nullable()).default([]),
  heldOut: z.array(checkResultSchema),
  /** Each sealed check's runner report at base, in the same order as `heldOut`. */
  heldOutTests: z.array(testEvidenceSchema).default([]),
});
export type StoredBase = z.input<typeof storedBaseSchema>;
type ReadBase = z.output<typeof storedBaseSchema>;

/**
 * Base results kept under SWARM_HOME, owner-only, one file per key. A file that does not parse
 * is ignored and the base is run again; nothing here is trusted past its schema.
 */
export const baseCache = {
  file: (home: string, key: string) => join(home, "baselines", `${key}.json`),
  async read(file: string): Promise<ReadBase | null> {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    try {
      return storedBaseSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  },
  /** Written whole or not at all: a reader never sees half an entry, and a racing writer's entry stands. */
  async write(file: string, value: StoredBase): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    const partial = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.partial`;
    await writeFile(partial, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(partial, file);
  },
};

export class CheckNameCollisionError extends Error {
  constructor(name: string, other?: string) {
    super(
      other === undefined
        ? `the request's check ${name} has the name of a check the base declares; rename it`
        : `the checks ${other} and ${name} would write the same log file; rename one`,
    );
    this.name = "CheckNameCollisionError";
  }
}

/** A check's name as its log file is named. */
export const logName = (name: string) => name.replace(/[^\w.-]/g, "_");

/** The base's declared checks, then the request's own, each labeled with its authority. */
export function allChecks(
  declared: readonly DeclaredCheck[],
  trusted: readonly TrustedCheck[],
): readonly DeclaredCheck[] {
  const names = new Set(declared.map((check) => check.name));
  for (const check of trusted)
    if (names.has(check.name)) throw new CheckNameCollisionError(check.name);
  const all = [...declared, ...trusted];
  const files = new Map<string, string>();
  for (const check of all) {
    const other = files.get(logName(check.name));
    if (other !== undefined) throw new CheckNameCollisionError(check.name, other);
    files.set(logName(check.name), check.name);
  }
  return all;
}
