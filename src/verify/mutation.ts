import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import type { ChangedFile } from "./checkout.ts";
import type { CheckContext } from "./checks.ts";
import type { MutantOutcome } from "./per-test.ts";
import type { Coverage, Mutation } from "./predicate.ts";

type Replacement = string | ((matched: string, python: boolean) => string);

/** Operators in the order they are tried; the first that applies to a line is used. */
const operators: readonly (readonly [string, RegExp, Replacement])[] = [
  ["=== to !==", /===/, "!=="],
  ["!== to ===", /!==/, "==="],
  ["== to !=", /(?<![=!<>])==(?!=)/, "!="],
  ["!= to ==", /!=(?!=)/, "=="],
  ["<= to >", /<=/, ">"],
  [">= to <", />=/, "<"],
  ["&& to ||", /&&/, "||"],
  ["|| to &&", /\|\|/, "&&"],
  [" and to or", /\band\b/, "or"],
  [" or to and", /\bor\b/, "and"],
  ["true to false", /\btrue\b/, "false"],
  ["false to true", /\bfalse\b/, "true"],
  ["True to False", /\bTrue\b/, "False"],
  ["False to True", /\bFalse\b/, "True"],
  ["< to >=", /(?<![<=-])<(?![<=])/, ">="],
  ["> to <=", /(?<![>=-])>(?![>=])/, "<="],
  ["+ to -", /(?<![+])\+(?![+=])/, "-"],
  ["- to +", /(?<![-])-(?![-=>])/, "+"],
  ["min to max", /\bmin\b/, "max"],
  ["max to min", /\bmax\b/, "min"],
  ["number plus one", /(?<![\w.])\d+(?![\w.])/, (matched) => String(Number(matched) + 1)],
  // Last resort: the value a changed return produced is thrown away. The expression stops at
  // the statement's end, so a closing brace on the same line stays.
  [
    "return value dropped",
    /\breturn\s+[^;}\s][^;}]*/,
    (_matched, python) => (python ? "return None" : "return undefined"),
  ],
];

// Languages whose mutants can be syntax-checked before they run; JSX has no parser here.
const code = /\.(?:[cm]?js|[cm]?ts|py)$/;

const run = (file: string, args: readonly string[], cwd: string) =>
  new Promise<boolean>((settle) => {
    execFile(file, args, { cwd, timeout: 60_000, env: { PATH: process.env.PATH ?? "" } }, (error) =>
      settle(error === null),
    );
  });

/**
 * Whether a mutated file still parses: `node --check` for JavaScript, Node's own TypeScript
 * transform for TypeScript, and Python's `ast.parse` with the host's interpreter. Nothing is
 * executed and nothing is written.
 */
export async function parses(path: string, text: string, dir: string): Promise<boolean> {
  if (/\.[cm]?ts$/.test(path)) {
    try {
      stripTypeScriptTypes(text, { mode: "transform" });
      return true;
    } catch {
      return false;
    }
  }
  if (path.endsWith(".py")) {
    // The host's interpreter: a checkout's .venv may hold a container's binaries.
    const script = "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())";
    return run("python3", ["-c", script, join(dir, path)], dir);
  }
  return run(process.execPath, ["--check", join(dir, path)], dir);
}

/** The line with string literals and trailing comments blanked, so operators in them are skipped. */
function codeOf(line: string): string {
  const blanked = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (literal) =>
    " ".repeat(literal.length),
  );
  const comment = /\/\/|#/.exec(blanked);
  return comment === null ? blanked : blanked.slice(0, comment.index);
}

/** Where the literal or comment starting at `at` with `opener` ends, past its closer. */
function endOf(text: string, at: number, opener: string): number {
  if (opener === "#" || opener === "//") {
    const newline = text.indexOf("\n", at);
    return newline < 0 ? text.length : newline;
  }
  if (opener === "/*") {
    const closer = text.indexOf("*/", at + 2);
    return closer < 0 ? text.length : closer + 2;
  }
  // A quoted string ends at its quote or, unterminated, at the line's end; a template literal and
  // a triple-quoted string may span lines.
  const spans = opener.length === 3 || opener === "`";
  for (let index = at + opener.length; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text.startsWith(opener, index)) return index + opener.length;
    else if (text[index] === "\n" && !spans) return index;
  }
  return text.length;
}

/**
 * The file's lines with string literals and comments blanked, columns kept. Read a line at a
 * time, the inside of a docstring, a template literal or a block comment looked like code, and
 * the one mutant could change prose no test can see.
 */
export function codeLines(text: string, python: boolean): string[] {
  const openers = python ? ['"""', "'''", '"', "'", "#"] : ["/*", "//", "`", '"', "'"];
  let visible = "";
  for (let at = 0; at < text.length; ) {
    const opener = openers.find((one) => text.startsWith(one, at));
    if (opener === undefined) {
      visible += text[at];
      at += 1;
      continue;
    }
    const end = endOf(text, at, opener);
    visible += text.slice(at, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return visible.split("\n");
}

export function mutateLine(
  line: string,
  python = false,
  visible = codeOf(line),
): { readonly text: string; readonly operator: string } | null {
  if (/^\s*(?:import|export\s+\{|from\s)/.test(visible)) return null;
  for (const [operator, pattern, replacement] of operators) {
    const match = pattern.exec(visible);
    if (match === null) continue;
    const replaced = typeof replacement === "string" ? replacement : replacement(match[0], python);
    const text = `${line.slice(0, match.index)}${replaced}${line.slice(match.index + match[0].length)}`;
    return { text, operator };
  }
  return null;
}

/**
 * One mutant on a changed source line, preferring lines the tests covered. A mutant that does
 * not parse is refused and the next one tried, so a parser's rejection is never read as a test
 * catching wrong behavior; `outcome` runs the test checks against the one that parses.
 */
export async function mutationWitness(
  source: readonly ChangedFile[],
  coverage: Coverage,
  outcome: (() => Promise<MutantOutcome>) | null,
  context: CheckContext,
): Promise<Mutation> {
  if (outcome === null) return { status: "unmeasured", reason: "no test check is declared" };
  const covered = (path: string, line: number) =>
    coverage.status === "measured" &&
    coverage.files.some((file) => file.path === path && file.covered.includes(line));
  const candidates = source
    .filter((file) => code.test(file.path))
    .flatMap((file) => file.addedLines.map((line) => ({ path: file.path, line })))
    .sort((a, b) => Number(covered(b.path, b.line)) - Number(covered(a.path, a.line)));
  let rejected = 0;
  for (const candidate of candidates) {
    const absolute = join(context.dir, candidate.path);
    const original = await readFile(absolute, "utf8");
    const lines = original.split("\n");
    const python = candidate.path.endsWith(".py");
    const visible = codeLines(original, python)[candidate.line - 1] ?? "";
    const mutant = mutateLine(lines[candidate.line - 1] ?? "", python, visible);
    if (mutant === null) continue;
    lines[candidate.line - 1] = mutant.text;
    const text = lines.join("\n");
    await writeFile(absolute, text);
    try {
      if (!(await parses(candidate.path, text, context.dir))) {
        rejected += 1;
        continue;
      }
      const status = await outcome();
      return { status, ...candidate, operator: mutant.operator, syntax: "valid", rejected };
    } finally {
      await writeFile(absolute, original);
    }
  }
  if (rejected > 0) {
    return {
      status: "invalid-mutant",
      rejected,
      reason: `every mutant of a changed line failed to parse (${rejected} refused), so none was run`,
    };
  }
  return { status: "unmeasured", reason: "no changed source line has an operator to mutate" };
}
