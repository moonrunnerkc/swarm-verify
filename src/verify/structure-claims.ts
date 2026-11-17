import type { EvidenceRef } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import { readCandidateText } from "./candidate-read.ts";
import { symbolsOf } from "./symbols.ts";

type StructureClaim = Requirement["evidence"]["structure"][number];

/**
 * The outcome of a claim the read could not decide: a name a parser cannot establish, or a path
 * that holds something that was not read. Never holding and never failing, so the requirement is
 * unverified with the reason named.
 */
export const unresolvedClaim = "unresolved";

/**
 * A structural claim against the candidate tree. With `symbol`, read by the language's own parser:
 * the module defines the name, no longer defines it (`absent`), or provides it to an importer
 * (`provides`: defined, imported or re-exported). Without, the older text form: a file exists,
 * holds a text, no longer holds it, or is gone. Nothing is read through a link or outside the tree.
 */
export async function structureEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  return claim.symbol === undefined
    ? textEvidence(dir, claim)
    : symbolEvidence(dir, claim, claim.symbol);
}

const somePaths =
  "only on some paths through it (inside a top-level if, try, with or loop, or annotated without a value)";

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
  const result = (outcome: string, detail: string): EvidenceRef => ({
    kind: "structure",
    ref,
    authority,
    outcome,
    detail,
  });
  if ("problem" in read) {
    // A module that is gone defines nothing: what a move leaves where it moved from.
    if (read.state === "absent")
      return claim.absent === true
        ? result("observed", "the module is gone")
        : result("not observed", read.problem);
    return result(read.state === "unreadable" ? unresolvedClaim : "not observed", read.problem);
  }
  const establish = `a test that imports ${symbol} from ${claim.path} and passes would establish it`;
  if (claim.provides === true) {
    const named = read.provided.has(symbol);
    if (named && !read.conditional.has(symbol) && !read.typeOnly.has(symbol))
      return result(
        "observed",
        read.defined.has(symbol) ? "defined there" : "imported or re-exported there",
      );
    if (read.typeOnly.has(symbol))
      return result(
        unresolvedClaim,
        "exported there only as a type (export type, an interface, a declare or an import type passed on), which compiles away, so an importer gets no value by that name; a test that uses it as a value would establish it",
      );
    if (named)
      return result(
        unresolvedClaim,
        `the module binds it ${somePaths}, so a parser cannot establish an importer gets it; ${establish}`,
      );
    if (read.dynamic)
      return result(
        unresolvedClaim,
        `not named there; the module's __getattr__ looks names up dynamically, which no parser can resolve; ${establish}`,
      );
    if (read.unread.length > 0)
      return result(
        unresolvedClaim,
        `not named there, and these star imports were not read, so what they pass on is unknown: ${read.unread.join("; ")}; ${establish}`,
      );
    return result(
      "not observed",
      "an importer of the module does not get it: it is neither defined, imported nor re-exported there",
    );
  }
  const declared = read.defined.has(symbol);
  if (claim.absent === true)
    return declared
      ? result("not observed", "the module still defines it")
      : result(
          "observed",
          read.provided.has(symbol)
            ? "defined elsewhere, and still importable from here"
            : "not defined there",
        );
  if (declared && read.conditional.has(symbol))
    return result(
      unresolvedClaim,
      `the module defines it ${somePaths}, so a parser cannot establish it is defined when the module runs; ${establish}`,
    );
  return declared
    ? result("observed", "defined there")
    : result(
        "not observed",
        read.provided.has(symbol) ? "imported there, not defined" : "the module does not define it",
      );
}

/**
 * A structural claim read from the candidate tree: a file exists, holds a text, or is gone. With
 * both `contains` and `absent`, the file no longer holds the text, or is gone: what a move leaves
 * in the file it moved from. Only a path that is not there is gone: a directory, a link or a file
 * that could not be read is something there, and never satisfies the claim.
 */
async function textEvidence(dir: string, claim: StructureClaim): Promise<EvidenceRef> {
  const read = await readCandidateText(dir, claim.path);
  const lacks = claim.absent === true && claim.contains !== undefined;
  const result = (outcome: string, detail: string): EvidenceRef => ({
    kind: "structure",
    ref:
      claim.contains === undefined
        ? claim.path
        : `${claim.path} ${lacks ? "lacks" : "contains"} ${JSON.stringify(claim.contains)}`,
    authority: claim.authority ?? "user-acceptance",
    outcome,
    detail,
  });
  if (read.kind === "refused") return result("not observed", read.detail);
  if (read.kind === "directory")
    return result(
      "not observed",
      claim.absent === true
        ? `${claim.path} is a directory, so the path is still there`
        : read.detail,
    );
  if (read.kind === "link" || read.kind === "unreadable")
    return result(unresolvedClaim, read.detail);
  const text = read.kind === "file" ? read.text : null;
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
      : text === null
        ? `no file at ${claim.path}`
        : "the file does not contain it";
  return result(holds ? "observed" : "not observed", holds ? `expected ${what}` : why);
}
