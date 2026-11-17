import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The first executable regular file named `name` in an absolute PATH entry. A relative or empty
 * entry (`.`, `bin`, `::`) resolves against whatever directory the child starts in, which for a
 * verifier is often a candidate's tree, so it is never searched.
 */
export async function trustedExecutable(
  name: string,
  path: string | undefined = process.env.PATH,
): Promise<string | null> {
  for (const entry of (path ?? "").split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    const found = await stat(candidate).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!found) continue;
    const runnable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (runnable) return candidate;
  }
  return null;
}

/**
 * Flags for a verifier-owned Python child that reads candidate files: isolated mode (no
 * PYTHON* variables, no script or working directory on sys.path, no user site), no site module
 * at all (so no sitecustomize or .pth file runs), and no bytecode written.
 */
export const trustedPythonArgs = ["-I", "-S", "-B"] as const;

const resolved = new Map<string, Promise<string | null>>();

/** trustedExecutable for the verifier's own PATH, resolved once per name and PATH. */
export function trustedCommand(name: string): Promise<string | null> {
  const key = `${name}\0${process.env.PATH ?? ""}`;
  let found = resolved.get(key);
  if (found === undefined) {
    found = trustedExecutable(name);
    resolved.set(key, found);
  }
  return found;
}

export class MissingExecutableError extends Error {
  constructor(name: string) {
    super(
      `${name} is not in any absolute directory on PATH; install it or put its directory on PATH`,
    );
    this.name = "MissingExecutableError";
  }
}
