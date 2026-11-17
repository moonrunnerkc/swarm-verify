import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Reading and writing a relative path under a root the verifier owns, when the tree below the
 * root may be the candidate's. Every component is checked with lstat, a symbolic link anywhere is
 * refused rather than followed, and the last component is opened with O_NOFOLLOW and checked to be
 * the same file lstat saw. A lexical prefix check is not enough: `tests` made a link to the
 * operator's home passes it.
 */
export type ContainmentReason =
  | "absolute"
  | "traversal"
  | "empty"
  | "symlink"
  | "not-a-directory"
  | "not-a-file"
  | "replaced";

export class ContainmentError extends Error {
  readonly path: string;
  readonly reason: ContainmentReason;
  constructor(path: string, reason: ContainmentReason, detail: string) {
    super(`${path} ${detail}`);
    this.name = "ContainmentError";
    this.path = path;
    this.reason = reason;
  }
}

/** The components of a repository-relative path, or a ContainmentError saying why it is not one. */
export function relativeComponents(path: string): readonly string[] {
  if (path.length === 0 || path.includes("\0"))
    throw new ContainmentError(path, "empty", "is not a usable path");
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("\\"))
    throw new ContainmentError(path, "absolute", "is absolute, not relative to the repository");
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) throw new ContainmentError(path, "empty", "names no file");
  if (parts.includes(".."))
    throw new ContainmentError(path, "traversal", "leaves the repository through ..");
  return parts;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * What is at a path under the root, without following any link: absent (the path or a directory
 * on it does not exist), a regular file, a directory, a symbolic link or another kind of file.
 * Anything but ENOENT is thrown, so a permission failure is never read as absence.
 */
export type Entry =
  | { readonly kind: "absent" }
  | { readonly kind: "file" | "directory" | "symlink" | "special"; readonly at: string };

export async function entryAt(root: string, path: string): Promise<Entry> {
  const parts = relativeComponents(path);
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(at);
    } catch (error) {
      if (missing(error)) return { kind: "absent" };
      throw error;
    }
    const last = index === parts.length - 1;
    if (stats.isSymbolicLink()) return { kind: "symlink", at };
    if (last)
      return { kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "special", at };
    if (!stats.isDirectory()) return { kind: "special", at };
  }
  return { kind: "absent" };
}

/** The bytes of a regular file under the root, or null where the path is absent. */
export async function readContained(root: string, path: string): Promise<Buffer | null> {
  const entry = await entryAt(root, path);
  if (entry.kind === "absent") return null;
  if (entry.kind === "symlink")
    throw new ContainmentError(path, "symlink", "goes through a symbolic link, which is not read");
  if (entry.kind !== "file")
    throw new ContainmentError(path, "not-a-file", `is a ${entry.kind}, not a regular file`);
  const before = await lstat(entry.at);
  const handle = await open(entry.at, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile())
      throw new ContainmentError(path, "replaced", "was replaced while it was read");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Writes a regular file under the root, creating directories as needed. A symbolic link, or a
 * file where a directory belongs, on the way is refused. An existing last component that is a
 * regular file or a link is unlinked (unlink never follows) and the file created fresh with
 * O_EXCL, so the bytes cannot land anywhere the root does not hold.
 */
export async function writeContained(
  root: string,
  path: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const parts = relativeComponents(path);
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const stats = await lstat(at).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (stats === null) await mkdir(at, { mode: 0o700 });
    else if (stats.isSymbolicLink())
      throw new ContainmentError(path, "symlink", `goes through the symbolic link ${part}`);
    else if (!stats.isDirectory())
      throw new ContainmentError(path, "not-a-directory", `goes through ${part}, not a directory`);
  }
  const target = join(at, parts.at(-1) ?? "");
  const existing = await lstat(target).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (existing?.isDirectory())
    throw new ContainmentError(path, "not-a-file", "is a directory, not a file");
  if (existing !== null) await unlink(target);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(target, flags, mode);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
