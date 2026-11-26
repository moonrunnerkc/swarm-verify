import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConventionRule } from "./rules.ts";

/** A rule the repository's own lint configuration already decides, and the value it enforces. */
export interface Configured {
  readonly rule: ConventionRule;
  readonly value: string;
  readonly by: string;
}

const lintFiles = [
  "biome.json",
  "biome.jsonc",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
];
const formatFiles = [
  ...lintFiles.slice(0, 2),
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  ".editorconfig",
];

/** A lint rule's name, the convention it settles and the value it holds code to. */
const known: readonly (readonly [RegExp, ConventionRule, string])[] = [
  [/noDefaultExport|no-default-export/, "exports", "named"],
  [/prefer-default-export/, "exports", "default"],
  [/noExplicitAny|no-explicit-any/, "explicit-any", "forbidden"],
  [
    /explicit-function-return-type|explicit-module-boundary-types/,
    "exported-return-types",
    "explicit",
  ],
  [/noEmptyBlockStatements|["']no-empty["']/, "empty-catch", "forbidden"],
  [/no-throw-literal|only-throw-error|useThrowOnlyError/, "thrown-values", "error-objects"],
  [/["']camelcase["']/, "function-names", "camelCase"],
  [/["']camelcase["']/, "variable-names", "camelCase"],
  [/jsdoc\/require-jsdoc|["']require-jsdoc["']/, "exported-docs", "documented"],
];

/** A rule switched off in the configuration, in either tool's spelling. */
const off = (text: string, name: RegExp) =>
  new RegExp(`(?:${name.source})["']?\\s*:\\s*(?:["']off["']|0|\\[\\s*["']off["'])`).test(text);

/**
 * What the repository's lint and format configuration already settles, read as text: a rule
 * named there and not switched off decides its convention, and samples are not asked. Formatting
 * (quotes, semicolons, indentation) is never proposed at all; `formatter` names who owns it.
 */
export async function configuredConventions(
  repository: string,
): Promise<{ readonly rules: Configured[]; readonly formatter: string | null }> {
  const read = (name: string) => readFile(join(repository, name), "utf8").catch(() => null);
  const rules: Configured[] = [];
  for (const name of lintFiles) {
    const text = await read(name);
    if (text === null) continue;
    for (const [pattern, rule, value] of known)
      if (pattern.test(text) && !off(text, pattern) && !rules.some((one) => one.rule === rule))
        rules.push({ rule, value, by: name });
  }
  let formatter: string | null = null;
  for (const name of formatFiles)
    if (formatter === null && (await read(name)) !== null) formatter = name;
  return { rules, formatter };
}
