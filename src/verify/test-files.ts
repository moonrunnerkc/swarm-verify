import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./change.ts";
import type { ChangedFile } from "./checkout.ts";
import type { TestFileChanges } from "./compare.ts";
import { categoryOf } from "./paths.ts";
import type { Predicate } from "./predicate.ts";

const importStatements = [
  // import x from "y"; import {\n a,\n b\n} from "y"; export * from "y"
  /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*["'][^"']+["'];?[ \t]*$/gms,
  /^[ \t]*import\s*["'][^"']+["'];?[ \t]*$/gm,
  /^[ \t]*(?:const|let|var)\s+[^=\n]+=\s*require\(\s*["'][^"']+["']\s*\);?[ \t]*$/gm,
  // from x import (a,\n b) and import x
  /^[ \t]*from\s+[\w.]+\s+import\s+(?:\([^)]*\)|[^\n]*)$/gm,
  /^[ \t]*import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*[ \t]*$/gm,
];

/** The file's text with import statements and blank lines removed. */
export function withoutImports(text: string): string {
  let body = text;
  for (const pattern of importStatements) body = body.replace(pattern, "");
  return body
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Test code, as opposed to a runner's configuration, which is a test-category file too. */
const testCode = /\.(?:[cm]?[jt]sx?|py)$/;

/** Base path to candidate path for each rename git finds among the staged changes. */
async function renames(dir: string, baseCommit: string): Promise<ReadonlyMap<string, string>> {
  const listing = await runGit(dir, ["diff", "--cached", "--name-status", "-z", "-M", baseCommit]);
  const fields = listing.code === 0 ? listing.stdout.toString("utf8").split("\0") : [];
  const pairs = new Map<string, string>();
  for (let at = 0; at < fields.length; ) {
    // A rename names two paths; with -M and no -C, every other status names one.
    if ((fields[at] ?? "").startsWith("R")) {
      pairs.set(fields[at + 1] ?? "", fields[at + 2] ?? "");
      at += 3;
    } else {
      at += 2;
    }
  }
  return pairs;
}

/**
 * What the candidate did to test files. A modified file whose only differences are its imports
 * was relocated; a deleted file and an added one that differ only in imports were one move. Both
 * are refactors of where code lives, judged by the tests' names rather than as rewrites. A deleted
 * file and an added one that git pairs as a rename, with more than imports changed, were moved and
 * edited: judged like a file rewritten in place, by the base's version against the new code.
 */
export async function testFileChanges(
  dir: string,
  baseCommit: string,
  changed: readonly ChangedFile[],
): Promise<TestFileChanges> {
  const tests = changed.filter(
    (file) => categoryOf(file.path) === "tests" && testCode.test(file.path),
  );
  const atBase = async (path: string) => {
    const shown = await runGit(dir, ["show", `${baseCommit}:${path}`]);
    return shown.code === 0 ? shown.stdout.toString("utf8") : "";
  };
  const now = (path: string) => readFile(join(dir, path), "utf8").catch(() => "");
  const added = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const relocated = new Set<string>();
  const moved = new Map<string, string>();
  const addedBodies = new Map<string, string>();
  for (const file of tests) {
    if (file.status === "added") {
      added.add(file.path);
      addedBodies.set(file.path, withoutImports(await now(file.path)));
    } else if (file.status === "deleted") {
      deleted.add(file.path);
    } else if (withoutImports(await atBase(file.path)) === withoutImports(await now(file.path))) {
      relocated.add(file.path);
    } else {
      modified.add(file.path);
    }
  }
  for (const path of deleted) {
    const body = withoutImports(await atBase(path));
    const target = [...addedBodies].find(([, text]) => text === body && text.length > 0)?.[0];
    if (target === undefined) continue;
    moved.set(path, target);
    addedBodies.delete(target);
  }
  const movedAndEdited = new Map<string, string>();
  for (const [from, to] of await renames(dir, baseCommit)) {
    if (deleted.has(from) && !moved.has(from) && addedBodies.has(to)) movedAndEdited.set(from, to);
  }
  for (const [from, to] of [...moved, ...movedAndEdited]) {
    deleted.delete(from);
    added.delete(to);
  }
  return { added, modified, deleted, moved, movedAndEdited, relocated };
}

export const noTestFiles: TestFileChanges = {
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
  moved: new Map(),
  movedAndEdited: new Map(),
  relocated: new Set(),
};

const pairs = (paths: ReadonlyMap<string, string>) =>
  [...paths].map(([from, to]) => ({ from, to }));

/** The changes as the statement records them. */
export function testFilesRecord(changes: TestFileChanges): Predicate["testFiles"] {
  return {
    added: [...changes.added],
    modified: [...changes.modified],
    deleted: [...changes.deleted],
    moved: pairs(changes.moved),
    movedAndEdited: pairs(changes.movedAndEdited),
    relocated: [...changes.relocated],
  };
}
