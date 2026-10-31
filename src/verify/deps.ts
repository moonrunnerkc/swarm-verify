import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { lockfileDigests } from "./checks.ts";

/** The directories a prepared dependency tree lives in. */
const installed = ["node_modules", ".venv"];

/**
 * One digest over every file of the installed dependency trees: `<kind> <sha256> <path>` per
 * entry, sorted, with symlinks hashed by target. Null where no tree exists. Bytecode caches that
 * a run itself writes are left out so that running the checks does not change the identity.
 */
export async function dependencyTreeDigest(dir: string): Promise<string | null> {
  const lines: string[] = [];
  for (const top of installed) {
    const root = join(dir, top);
    const stats = await lstat(root).catch(() => null);
    if (stats === null || !stats.isDirectory()) continue;
    for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = join(entry.parentPath, entry.name);
      if (path.split(sep).includes("__pycache__")) continue;
      const name = relative(dir, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = createHash("sha256")
          .update(await readlink(path))
          .digest("hex");
        lines.push(`link ${target} ${name}`);
      } else if (entry.isFile()) {
        const content = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        lines.push(`file ${content} ${name}`);
      }
    }
  }
  if (lines.length === 0) return null;
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface DependencyIdentity {
  readonly mode: "prepared" | "setup" | "linked" | "none";
  readonly lockfiles: Readonly<Record<string, string>>;
  /** Digest of the installed tree, only where it was installed into the checkout. */
  readonly treeSha256: string | null;
  /** Whether a later run with the same lockfiles reproduces this tree, so a baseline may be reused. */
  readonly reproducible: boolean;
}

/**
 * What the checks' dependencies were. Linked trees are the caller's own, mutable between runs
 * and outside any digest; a declared setup command's result is not pinned by a lockfile. Only a
 * tree installed from the lockfile, or no tree at all, identifies its environment.
 */
export async function dependencyIdentity(
  dir: string,
  mode: DependencyIdentity["mode"],
): Promise<DependencyIdentity> {
  const lockfiles = await lockfileDigests(dir);
  if (mode === "linked" || mode === "setup")
    return { mode, lockfiles, treeSha256: null, reproducible: false };
  if (mode === "none") return { mode, lockfiles, treeSha256: null, reproducible: true };
  const treeSha256 = await dependencyTreeDigest(dir);
  return { mode, lockfiles, treeSha256, reproducible: treeSha256 !== null };
}
