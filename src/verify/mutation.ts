import { lstat } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessGroup } from "../exec/run-process.ts";
import { trustedExecutable, trustedPythonArgs } from "../exec/trusted-executable.ts";
import { ContainmentError, readContained, writeContained } from "../fs/contained.ts";
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

/** Whether a verifier-owned parser accepts `text` on stdin, started in a directory the candidate does not own. */
async function accepts(file: string, args: readonly string[], text: string): Promise<boolean> {
  const ran = await runProcessGroup(file, args, {
    stdin: text,
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024,
  });
  return ran.startFailure === null && !ran.timedOut && ran.exitCode === 0;
}

/**
 * Whether a mutated file still parses: Node's own TypeScript transform for TypeScript, `node
 * --check` for JavaScript and Python's `ast.parse` for Python, each reading the text from stdin
 * so nothing in the candidate's tree is loaded. Python is the host's, resolved from absolute PATH
 * entries and started isolated outside the checkout: a candidate's ast.py, json.py or
 * sitecustomize.py is never imported. A host Python older than the project's may refuse newer
 * syntax; the mutant is then refused, never counted as killed.
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
    const python = await trustedExecutable("python3");
    if (python === null) return false;
    const script = "import ast,sys; ast.parse(sys.stdin.read())";
    return accepts(python, [...trustedPythonArgs, "-c", script], text);
  }
  const type = path.endsWith(".mjs")
    ? "module"
    : path.endsWith(".cjs")
      ? "commonjs"
      : await packageType(dir, path);
  const check = (as: string) =>
    accepts(process.execPath, [`--input-type=${as}`, "--check", "-"], text);
  // With no declared type, Node reads a .js file as CommonJS and falls back to a module.
  if (type === null) return (await check("commonjs")) || check("module");
  return check(type);
}

/** The module system the nearest package.json declares for a .js file, read without following links. */
async function packageType(dir: string, path: string): Promise<"module" | "commonjs" | null> {
  const parts = path.split("/").slice(0, -1);
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const manifest = [...parts.slice(0, depth), "package.json"].join("/");
    const bytes = await readContained(dir, manifest).catch(() => null);
    if (bytes === null) continue;
    try {
      const declared = (JSON.parse(bytes.toString("utf8")) as { type?: unknown }).type;
      return declared === "module" || declared === "commonjs" ? declared : null;
    } catch {
      return null;
    }
  }
  return null;
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
    // A changed file the candidate made a link is not followed: the mutant would land outside.
    const original = await readContained(context.dir, candidate.path).then(
      (bytes) => bytes?.toString("utf8") ?? null,
      (error: unknown) => {
        if (error instanceof ContainmentError) return null;
        throw error;
      },
    );
    if (original === null) continue;
    const mode = (await lstat(join(context.dir, candidate.path))).mode & 0o777;
    const lines = original.split("\n");
    const python = candidate.path.endsWith(".py");
    const visible = codeLines(original, python)[candidate.line - 1] ?? "";
    const mutant = mutateLine(lines[candidate.line - 1] ?? "", python, visible);
    if (mutant === null) continue;
    lines[candidate.line - 1] = mutant.text;
    const text = lines.join("\n");
    if (!(await parses(candidate.path, text, context.dir))) {
      rejected += 1;
      continue;
    }
    await writeContained(context.dir, candidate.path, text, mode);
    try {
      const status = await outcome();
      return { status, ...candidate, operator: mutant.operator, syntax: "valid", rejected };
    } finally {
      await writeContained(context.dir, candidate.path, original, mode);
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
