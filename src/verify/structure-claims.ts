import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import { symbolsOf } from "./symbols.ts";

type StructureClaim = Requirement["evidence"]["structure"][number];

/**
 * A structural claim against the candidate tree. With `symbol`, read by the language's own parser:
 * the module defines the name, no longer defines it (`absent`), or provides it to an importer
 * (`provides`: defined, imported, re-exported, or behind a Python `__getattr__`). Without, the
 * older text form: a file exists, holds a text, no longer holds it, or is gone.
 */
export async function structureEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  return claim.symbol === undefined
    ? textEvidence(dir, claim)
    : symbolEvidence(dir, claim, claim.symbol);
}

async function symbolEvidence(
  dir: string,
  claim: StructureClaim,
  symbol: string,
): Promise<EvidenceRef> {
  const form =
    claim.provides === true ? "provides" : claim.absent === true ? "no longer defines" : "defines";
  const ref = `${claim.path} ${form} ${symbol}`;
  const authority = claim.authority ?? "user-acceptance";
  const read = await symbolsOf(dir, claim.path);
  const result = (holds: boolean, detail: string): EvidenceRef => ({
    kind: "structure",
    ref,
    authority,
    outcome: holds ? "observed" : "not observed",
    detail,
  });
  if ("problem" in read) {
    // A module that is gone defines nothing: what a move leaves where it moved from.
    if (claim.absent === true && read.problem.startsWith("no file at"))
      return result(true, "the module is gone");
    return result(false, read.problem);
  }
  if (claim.provides === true) {
    if (read.provided.has(symbol))
      return result(
        true,
        read.defined.has(symbol) ? "defined there" : "imported or re-exported there",
      );
    if (read.dynamic)
      return result(
        true,
        "not named there; the module's __getattr__ may provide it, which no parser can resolve",
      );
    return result(
      false,
      "an importer of the module does not get it: it is neither defined, imported nor re-exported there",
    );
  }
  const defines = read.defined.has(symbol);
  if (claim.absent === true)
    return result(
      !defines,
      defines
        ? "the module still defines it"
        : read.provided.has(symbol)
          ? "defined elsewhere, and still importable from here"
          : "not defined there",
    );
  return result(
    defines,
    defines
      ? "defined there"
      : read.provided.has(symbol)
        ? "imported there, not defined"
        : "the module does not define it",
  );
}

/**
 * A structural claim read from the candidate tree: a file exists, holds a text, or is gone. With
 * both `contains` and `absent`, the file no longer holds the text, or is gone: what a move leaves
 * in the file it moved from.
 */
async function textEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  const read = await readFile(join(dir, claim.path), "utf8").then(
    (text) => ({ text, problem: null }),
    (error: NodeJS.ErrnoException) => ({ text: null, problem: error.code ?? "unreadable" }),
  );
  const text = read.text;
  const lacks = claim.absent === true && claim.contains !== undefined;
  const holds = lacks
    ? text === null || !text.includes(claim.contains ?? "")
    : claim.absent === true
      ? text === null
      : text !== null && (claim.contains === undefined || text.includes(claim.contains));
  const what = lacks
    ? "the text gone"
    : claim.absent === true
      ? "absent"
      : claim.contains === undefined
        ? "exists"
        : "contains";
  // Where it does not hold, why: what a producer needs to fix the claim or the change.
  const why = lacks
    ? "the file still contains it"
    : claim.absent === true
      ? "the path is still there"
      : read.problem === "EISDIR"
        ? `${claim.path} is a directory, not a file`
        : text === null
          ? `no file at ${claim.path}`
          : "the file does not contain it";
  return {
    kind: "structure",
    ref:
      claim.contains === undefined
        ? claim.path
        : `${claim.path} ${lacks ? "lacks" : "contains"} ${JSON.stringify(claim.contains)}`,
    authority: claim.authority ?? "user-acceptance",
    outcome: holds ? "observed" : "not observed",
    detail: holds ? `expected ${what}` : why,
  };
}
