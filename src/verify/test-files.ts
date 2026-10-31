import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./change.ts";
import type { ChangedFile } from "./checkout.ts";
import type { TestFileChanges } from "./compare.ts";
import { categoryOf } from "./paths.ts";

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

/**
 * What the candidate did to test files. A modified file whose only differences are its imports
 * was relocated; a deleted file and an added one that differ only in imports were one move. Both
 * are refactors of where code lives, judged by the tests' names rather than as rewrites.
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
  for (const [from, to] of moved) {
    deleted.delete(from);
    added.delete(to);
  }
  return { added, modified, deleted, moved, relocated };
}
