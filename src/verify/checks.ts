import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { TrustedCheck } from "../api/request.ts";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { childEnvironment } from "../exec/child-environment.ts";
import { runProcessGroup } from "../exec/run-process.ts";
import { gitText } from "./change.ts";
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
}

export interface CheckContext {
  readonly dir: string;
  /** A private HOME for the checks; never the operator's. */
  readonly home: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** The container every command runs in, or null to run on the host. */
  readonly sandbox?: Sandbox | null | undefined;
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
  const sandbox = context.sandbox ?? null;
  const ran =
    sandbox === null
      ? await runProcessGroup("/bin/sh", ["-c", check.command], {
          cwd: context.dir,
          env: { ...childEnvironment(process.env, { homeDir: context.home }).variables, ...env },
          timeoutMs: context.timeoutMs,
          maxOutputBytes,
          signal: context.signal,
        })
      : await runInSandbox(sandbox, check.command, { ...context, maxOutputBytes }, env, stage);
  const output = `${ran.stdout}${ran.stderr}`;
  const notRun = ran.timedOut
    ? "it timed out"
    : ran.cancelled
      ? "it was cancelled"
      : ran.startFailure === null
        ? null
        : `it never started (${ran.startFailure})`;
  const failedToRun = notRun !== null;
  const note = ran.timedOut
    ? "\n[timed out]"
    : ran.startFailure === null
      ? ""
      : `\n[${ran.startFailure}]`;
  return {
    notRun,
    result: {
      name: check.name,
      command: check.command,
      kind: check.kind,
      authority: check.authority ?? "pre-existing",
      result: failedToRun ? "error" : ran.exitCode === 0 ? "pass" : "fail",
      exitCode: failedToRun ? null : ran.exitCode,
      collected: check.kind === "test" ? collectedFromOutput(output) : null,
      durationMs: Date.now() - started,
      outputSha256: createHash("sha256").update(output).digest("hex"),
    },
    output,
    outputTail: `${output.slice(-tailBytes)}${note}`,
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
  heldOut: z.array(checkResultSchema),
});
export type StoredBase = z.infer<typeof storedBaseSchema>;

/**
 * Base results kept under SWARM_HOME, owner-only, one file per key. A file that does not parse
 * is ignored and the base is run again; nothing here is trusted past its schema.
 */
export const baseCache = {
  file: (home: string, key: string) => join(home, "baselines", `${key}.json`),
  async read(file: string): Promise<StoredBase | null> {
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    try {
      return storedBaseSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  },
  async write(file: string, value: StoredBase): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  },
};

export class CheckNameCollisionError extends Error {
  constructor(name: string) {
    super(`the request's check ${name} has the name of a check the base declares; rename it`);
    this.name = "CheckNameCollisionError";
  }
}

/** The base's declared checks, then the request's own, each labeled with its authority. */
export function allChecks(
  declared: readonly DeclaredCheck[],
  trusted: readonly TrustedCheck[],
): readonly DeclaredCheck[] {
  const names = new Set(declared.map((check) => check.name));
  for (const check of trusted)
    if (names.has(check.name)) throw new CheckNameCollisionError(check.name);
  return [...declared, ...trusted];
}
