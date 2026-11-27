/**
 * The errors a compiler or type checker printed, one string each: the file, the code where the
 * tool gives one, and the message, without the line and column, so an error the candidate only
 * moved reads as the same error. Compared as a multiset, they tell a check that fails at both
 * commits for the base's reasons from one the candidate made fail for a new one.
 */
const forms: readonly RegExp[] = [
  // tsc: src/a.ts(3,7): error TS2322: message
  /^(?<file>[^\s(][^(]*)\(\d+,\d+\): error (?<code>TS\d+): (?<message>.+)$/,
  // tsc --pretty: src/a.ts:3:7 - error TS2322: message
  /^(?<file>[^\s:][^:]*):\d+:\d+ - error (?<code>TS\d+): (?<message>.+)$/,
  // tsc with no file: error TS5083: message
  /^error (?<code>TS\d+): (?<message>.+)$/,
  // mypy, gcc, clang, go vet and others: path:line[:col]: error: message
  /^(?<file>[^\s:][^:]*):\d+(?::\d+)?: error: (?<message>.+)$/,
];

/** Terminal color codes: ESC, then `[`, numbers and `m`. */
const colors = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Each diagnostic in a check's output, or null where it printed none or its output was cut at
 * the cap (`truncated`): a comparison over part of a run would miss what the rest held.
 */
export function readDiagnostics(output: string, truncated = false): string[] | null {
  if (truncated) return null;
  const read: string[] = [];
  for (const line of output.replace(colors, "").split("\n")) {
    for (const form of forms) {
      const groups = line.trimEnd().match(form)?.groups;
      if (groups === undefined) continue;
      read.push(
        [groups.file, groups.code, groups.message].filter((part) => part !== undefined).join(": "),
      );
      break;
    }
  }
  return read.length === 0 ? null : read;
}

/** The candidate's diagnostics beyond the base's, a repeat counted as one more. */
export function addedDiagnostics(base: readonly string[], head: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const one of base) left.set(one, (left.get(one) ?? 0) + 1);
  const added: string[] = [];
  for (const one of head) {
    const count = left.get(one) ?? 0;
    if (count > 0) left.set(one, count - 1);
    else added.push(one);
  }
  return added;
}
