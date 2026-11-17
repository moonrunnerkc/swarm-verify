/**
 * Writes the acceptance rule into verify.mjs from its one source, src/verify/acceptance.ts, with
 * the types removed, so the dependency-free checker and the verifier judge by the same code.
 *
 *   node scripts/sync-offline.mjs           rewrite verify.mjs
 *   node scripts/sync-offline.mjs --check   fail when verify.mjs is stale
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const begin = "// BEGIN acceptance rule, generated from src/verify/acceptance.ts; do not edit\n";
const end = "// END acceptance rule\n";

/** The acceptance rule as plain JavaScript, exactly as verify.mjs must carry it. */
export function generatedRule(source) {
  const code = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false });
  return `${begin}${code.trimEnd()}\n${end}`;
}

/** verify.mjs with its acceptance region replaced by the generated rule, formatted as the repository formats it. */
export function synced(checker, source) {
  const from = checker.indexOf(begin);
  const to = checker.indexOf(end);
  if (from < 0 || to < from) throw new Error("verify.mjs has no acceptance region to replace");
  const text = `${checker.slice(0, from)}${generatedRule(source)}${checker.slice(to + end.length)}`;
  return execFileSync(
    join(root, "node_modules", ".bin", "biome"),
    ["format", "--stdin-file-path=verify.mjs"],
    { cwd: root, input: text, encoding: "utf8" },
  );
}

if (import.meta.filename === process.argv[1]) {
  const checkerPath = join(root, "verify.mjs");
  const checker = readFileSync(checkerPath, "utf8");
  const source = readFileSync(join(root, "src", "verify", "acceptance.ts"), "utf8");
  const next = synced(checker, source);
  if (process.argv.includes("--check")) {
    if (next !== checker) {
      process.stderr.write("verify.mjs is stale: run node scripts/sync-offline.mjs\n");
      process.exitCode = 1;
    }
  } else writeFileSync(checkerPath, next);
}
