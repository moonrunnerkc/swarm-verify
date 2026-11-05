import { lstat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CheckContext, type CheckRun, runCheck } from "./checks.ts";
import {
  exportLocalPackages,
  type LocalPackage,
  LocalPackageError,
  localInstalls,
} from "./local-packages.ts";

const linkable = ["node_modules", ".venv"];

/**
 * The install command a lockfile in `dir` asks for, or null where there is none. In a container
 * (`isolated`), a Python project without uv.lock is resolved with `uv lock` first, and the
 * generated lock is what the identity records; `relock` resolves again over a lock the base's
 * preparation generated, for a candidate whose manifest changed.
 */
export async function lockfileInstall(
  dir: string,
  isolated = false,
  relock = false,
): Promise<string | null> {
  const has = (name: string) =>
    lstat(join(dir, name)).then(
      () => true,
      () => false,
    );
  // Install scripts one at a time: npm runs them in parallel, and concurrent native builds race.
  const npm = "npm ci --no-audit --no-fund --foreground-scripts";
  if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json"))) return npm;
  const manager = isolated ? "corepack " : "";
  if (await has("pnpm-lock.yaml")) return `${manager}pnpm install --frozen-lockfile`;
  if (await has("yarn.lock"))
    return (await has(".yarnrc.yml"))
      ? `${manager}yarn install --immutable`
      : `${manager}yarn install --frozen-lockfile`;
  if ((await has("bun.lock")) || (await has("bun.lockb"))) return "bun install --frozen-lockfile";
  const resolve = "uv lock && uv sync --frozen --all-extras";
  if (relock && isolated && (await has("pyproject.toml"))) return resolve;
  if (await has("uv.lock")) return isolated ? "uv sync --frozen --all-extras" : "uv sync --frozen";
  if (isolated && (await has("pyproject.toml"))) return resolve;
  return null;
}

export interface Preparation {
  /** refused: preparation was asked for and could not start; `refused` says why. */
  readonly mode: "prepared" | "setup" | "linked" | "none" | "refused";
  readonly failure: CheckRun | null;
  /** Packages the lockfile installs from outside the repository, exported beside the checkout. */
  readonly localPackages: readonly LocalPackage[];
  /** Why the dependencies could not be prepared at all, where nothing was run; otherwise null. */
  readonly refused: string | null;
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
  relock = false,
): Promise<Preparation> {
  if (mode === "none") return { mode: "none", failure: null, localPackages: [], refused: null };
  if (mode === "prepare") {
    const isolated = (context.sandbox ?? null) !== null;
    const install = setup ?? (await lockfileInstall(context.dir, isolated, relock));
    if (install === null) return { mode: "none", failure: null, localPackages: [], refused: null };
    let localPackages: LocalPackage[] = [];
    try {
      if (setup === null)
        localPackages = await exportLocalPackages(workspace, context.dir, dirname(context.dir));
    } catch (error) {
      if (!(error instanceof LocalPackageError)) throw error;
      return { mode: "refused", failure: null, localPackages: [], refused: error.message };
    }
    const command = [...localInstalls(localPackages), install].join(" && ");
    const ran = await runCheck({ name: "setup", command, kind: "other" }, context, {}, "prepare");
    return {
      mode: setup === null ? "prepared" : "setup",
      failure: ran.result.result === "pass" ? null : ran,
      localPackages,
      refused: null,
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
  return { mode: linked ? "linked" : "none", failure: null, localPackages: [], refused: null };
}

/** Why a run whose base did not install is blocked, and what to do, by where it ran. */
export function baseSetupFailed(mode: "isolated" | "host"): string {
  return mode === "isolated"
    ? "the base's dependencies did not install from its lockfile in a clean container: fix the dependency the setup output names, or verify on the host with the workspace's installed dependencies, reported as not isolated and not reproducible"
    : "the base's dependencies did not install from its lockfile: fix the dependency the setup output names, or use the workspace's installed dependencies (dependencies: linked), reported as not reproducible";
}
