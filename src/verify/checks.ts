import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { TrustedCheck } from "../api/request.ts";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { childEnvironment } from "../exec/child-environment.ts";
import { runProcessGroup } from "../exec/run-process.ts";
import { gitText } from "./change.ts";
import { type CheckResult, checkResultSchema, type Predicate } from "./predicate.ts";
import { testEvidenceSchema } from "./test-report.ts";

export interface CheckRun {
  readonly result: CheckResult;
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
}

const maxOutputBytes = 4 * 1024 * 1024;
const tailBytes = 4000;

/** Runs one check through the shell in the checkout, under an environment built here. */
export async function runCheck(
  check: DeclaredCheck,
  context: CheckContext,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<CheckRun> {
  const { variables } = childEnvironment(process.env, { homeDir: context.home });
  const started = Date.now();
  const ran = await runProcessGroup("/bin/sh", ["-c", check.command], {
    cwd: context.dir,
    // The base run, the change and the mutant rewrite the same files within seconds, often at the
    // same size; a .pyc written by one run would be trusted by the next.
    env: { ...variables, PYTHONDONTWRITEBYTECODE: "1", ...extraEnv },
    timeoutMs: context.timeoutMs,
    maxOutputBytes,
    signal: context.signal,
  });
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
      durationMs: Date.now() - started,
      outputSha256: createHash("sha256").update(output).digest("hex"),
    },
    outputTail: `${output.slice(-tailBytes)}${note}`,
  };
}

const linkable = ["node_modules", ".venv"];

/** The install command a lockfile in `dir` asks for, or null where there is none. */
export async function lockfileInstall(dir: string): Promise<string | null> {
  const has = (name: string) =>
    lstat(join(dir, name)).then(
      () => true,
      () => false,
    );
  if (await has("package-lock.json")) return "npm ci --no-audit --no-fund";
  if (await has("npm-shrinkwrap.json")) return "npm ci --no-audit --no-fund";
  if (await has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (await has("yarn.lock"))
    return (await has(".yarnrc.yml"))
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return "bun install --frozen-lockfile";
  if (await has("uv.lock")) return "uv sync --frozen";
  return null;
}

export interface Preparation {
  readonly mode: "prepared" | "setup" | "linked" | "none";
  readonly failure: CheckRun | null;
}

/**
 * Gives the clean checkout its dependencies the way the policy asks. prepare: the base's
 * declared setup command, or else the install its lockfile asks for, run in the checkout.
 * linked: the workspace's own node_modules and .venv linked in, which no later run can
 * reproduce. none: nothing.
 */
export async function prepareDependencies(
  workspace: string,
  setup: string | null,
  mode: "prepare" | "linked" | "none",
  context: CheckContext,
): Promise<Preparation> {
  if (mode === "none") return { mode: "none", failure: null };
  if (mode === "prepare") {
    const command = setup ?? (await lockfileInstall(context.dir));
    if (command === null) return { mode: "none", failure: null };
    const ran = await runCheck({ name: "setup", command, kind: "other" }, context);
    return {
      mode: setup === null ? "prepared" : "setup",
      failure: ran.result.result === "pass" ? null : ran,
    };
  }
  let linked = false;
  for (const name of linkable) {
    const source = join(workspace, name);
    const isDirectory = await lstat(source).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    const taken = await lstat(join(context.dir, name)).then(
      () => true,
      () => false,
    );
    if (!isDirectory || taken) continue;
    await symlink(source, join(context.dir, name), "dir");
    linked = true;
  }
  return { mode: linked ? "linked" : "none", failure: null };
}

export async function privateHome(scratch: string): Promise<string> {
  const home = join(scratch, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

/** The share of measured checks that passed; a pre-existing failure is not measured. */
export function passRate(runs: readonly CheckResult[]): number {
  const measured = runs.filter(
    (run) => run.result !== "pre-existing-failure" && run.result !== "unmeasured",
  );
  return measured.length === 0
    ? 0
    : measured.filter((run) => run.result === "pass").length / measured.length;
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
  dependencies: Predicate["environment"]["dependencies"],
): Promise<Predicate["environment"]> {
  const git = (await gitText(dir, ["--version"])).replace(/^git version /, "");
  const locks = await lockfileDigests(dir);
  const described = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    git,
    dependencies,
    checks: checks.map(({ name, command }) => ({ name, command })),
    lockfiles: locks,
  };
  return {
    sha256: createHash("sha256").update(JSON.stringify(described)).digest("hex"),
    node: described.node,
    platform: described.platform,
    git,
    dependencies,
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

/**
 * A check judged against its base run: one that failed at base and still fails measures
 * nothing about the change; one that failed at base and passes now was fixed by it.
 */
export function againstBase(run: CheckRun, base: CheckResult | undefined): CheckRun {
  if (base === undefined || base.result === "pass" || run.result.result === "pass") return run;
  return {
    ...run,
    result: { ...run.result, result: "pre-existing-failure", baseOutputSha256: base.outputSha256 },
  };
}

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
