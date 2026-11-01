import { createHash } from "node:crypto";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** A package the lockfile installs from a directory outside the repository. */
export interface LocalPackage {
  /** As the lockfile names it, relative to the repository: `../sibling/packages/core`. */
  readonly path: string;
  /** Its digest as exported, without its node_modules. */
  readonly sha256: string;
  /** Whether it brings a lockfile of its own, whose production dependencies are installed. */
  readonly ownLockfile: boolean;
}

export class LocalPackageError extends Error {
  constructor(path: string, detail: string) {
    super(`the lockfile's local package ${path} cannot be exported: ${detail}`);
    this.name = "LocalPackageError";
  }
}

async function directoryDigest(root: string): Promise<string> {
  const lines: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || relative(root, path).split(sep).includes("node_modules")) continue;
    const content = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    lines.push(`${content} ${relative(root, path).split(sep).join("/")}`);
  }
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

/**
 * Exports every package an npm lockfile installs from outside the repository (a `file:` path
 * such as `../sibling/packages/core`) from where it sits beside `workspace` into the same place
 * beside the checkout, so the install resolves it inside the verification's scratch directory.
 * Its own node_modules stay behind: they were built for the host. A path that would leave the
 * scratch directory is refused.
 */
export async function exportLocalPackages(
  workspace: string,
  checkout: string,
  scratch: string,
): Promise<LocalPackage[]> {
  const text = await readFile(join(checkout, "package-lock.json"), "utf8").catch(() => null);
  if (text === null) return [];
  const lock = JSON.parse(text) as { packages?: Record<string, unknown> };
  const exported: LocalPackage[] = [];
  for (const path of Object.keys(lock.packages ?? {}).filter((key) => key.startsWith("../"))) {
    const source = resolve(workspace, path);
    const target = resolve(checkout, path);
    if (!target.startsWith(`${scratch}${sep}`))
      throw new LocalPackageError(
        path,
        "it would sit outside the verification's scratch directory",
      );
    await rm(target, { recursive: true, force: true });
    await cp(source, target, {
      recursive: true,
      filter: (from) => !relative(source, from).split(sep).includes("node_modules"),
    }).catch((error: unknown) => {
      throw new LocalPackageError(
        path,
        `${source} is not there to copy (${error instanceof Error ? error.message : String(error)})`,
      );
    });
    const ownLockfile = await readFile(join(target, "package-lock.json")).then(
      () => true,
      () => false,
    );
    exported.push({ path, sha256: await directoryDigest(target), ownLockfile });
  }
  return exported;
}

/** The commands that install each exported package's production dependencies, before the repository's own. */
export function localInstalls(packages: readonly LocalPackage[]): string[] {
  return packages
    .filter((one) => one.ownLockfile)
    .map(
      (one) =>
        `(cd '${one.path.replaceAll("'", "'\\''")}' && npm ci --omit=dev --no-audit --no-fund)`,
    );
}
