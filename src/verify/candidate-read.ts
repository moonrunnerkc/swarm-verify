import { join } from "node:path";
import { ContainmentError, entryAt, readContained, relativeComponents } from "../fs/contained.ts";

/**
 * What a claim's path holds in the candidate tree, read without following a link and without
 * leaving the tree. Only `absent` is absence: a directory, a link (broken or not), a special file
 * or a read error is something there that was not read, and says which.
 */
export type CandidateText =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly text: string }
  | {
      readonly kind: "refused" | "directory" | "link" | "unreadable";
      readonly detail: string;
    };

const refusedReasons = new Set(["absolute", "traversal", "empty"]);

function failed(path: string, error: unknown): CandidateText {
  if (error instanceof ContainmentError)
    return {
      kind: refusedReasons.has(error.reason)
        ? "refused"
        : error.reason === "symlink"
          ? "link"
          : "unreadable",
      detail: `${error.message}, so it is not read`,
    };
  const code = (error as NodeJS.ErrnoException).code ?? "an unknown error";
  return { kind: "unreadable", detail: `${path} could not be read (${code})` };
}

/** The text of a regular file at `path` under `dir`, or what is there instead. */
export async function readCandidateText(dir: string, path: string): Promise<CandidateText> {
  let full: string;
  let entry: Awaited<ReturnType<typeof entryAt>>;
  try {
    full = join(dir, ...relativeComponents(path));
    entry = await entryAt(dir, path);
  } catch (error) {
    return failed(path, error);
  }
  switch (entry.kind) {
    case "absent":
      return { kind: "absent" };
    case "directory":
      return { kind: "directory", detail: `${path} is a directory, not a file` };
    case "symlink":
      return {
        kind: "link",
        detail:
          entry.at === full
            ? `${path} is a symbolic link, which is not followed`
            : `${path} goes through a symbolic link, which is not followed`,
      };
    case "special":
      return {
        kind: "unreadable",
        detail:
          entry.at === full
            ? `${path} is not a regular file`
            : `${path} goes through a file where a directory belongs`,
      };
  }
  try {
    const bytes = await readContained(dir, path);
    return bytes === null ? { kind: "absent" } : { kind: "file", text: bytes.toString("utf8") };
  } catch (error) {
    return failed(path, error);
  }
}

/** Why a module's names were not read: it is gone, it is there and was not read, or no module. */
export interface SymbolProblem {
  readonly problem: string;
  readonly state: "absent" | "unreadable" | "invalid";
}

/** The module a symbol claim names, read from the tree, or what kept it from being read. */
export async function moduleText(dir: string, path: string): Promise<string | SymbolProblem> {
  const read = await readCandidateText(dir, path);
  switch (read.kind) {
    case "file":
      return read.text;
    case "absent":
      return { problem: `no file at ${path}`, state: "absent" };
    case "refused":
      return { problem: read.detail, state: "invalid" };
    default:
      return { problem: read.detail, state: "unreadable" };
  }
}
