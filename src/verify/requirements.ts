import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceRef, RequirementOutcome } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import type { CheckResult } from "./predicate.ts";

export interface RequirementInputs {
  readonly checks: readonly CheckResult[];
  /** The candidate tree, for structural claims. */
  readonly dir: string;
  /** Whether the candidate changed anything at all. */
  readonly changed: boolean;
}

const matches = (id: string, name: string, file: string | undefined) =>
  id.endsWith(`::${name}`) && (file === undefined || id.startsWith(`${file}::`));

async function structureEvidence(
  dir: string,
  claim: Requirement["evidence"]["structure"][number],
): Promise<EvidenceRef> {
  const text = await readFile(join(dir, claim.path), "utf8").catch(() => null);
  const holds =
    claim.absent === true
      ? text === null
      : text !== null && (claim.contains === undefined || text.includes(claim.contains));
  const what =
    claim.absent === true ? "absent" : claim.contains === undefined ? "exists" : "contains";
  return {
    kind: "structure",
    ref:
      claim.contains === undefined
        ? claim.path
        : `${claim.path} contains ${JSON.stringify(claim.contains)}`,
    authority: "pre-existing",
    outcome: holds ? "observed" : "not observed",
    detail: `expected ${what}`,
  };
}

function testEvidence(
  checks: readonly CheckResult[],
  selector: Requirement["evidence"]["tests"][number],
): EvidenceRef {
  const label = selector.file === undefined ? selector.name : `${selector.file}::${selector.name}`;
  for (const check of checks) {
    const tests = check.tests;
    if (tests === undefined) continue;
    const found = (ids: readonly string[]) =>
      ids.find((id) => matches(id, selector.name, selector.file));
    const fixed = found(tests.fixed);
    if (fixed !== undefined)
      return { kind: "test", ref: fixed, authority: "pre-existing", outcome: "fixed" };
    const broke = found([...tests.regressed, ...tests.newlyFailing]);
    if (broke !== undefined)
      return { kind: "test", ref: broke, authority: "pre-existing", outcome: "failing" };
  }
  return {
    kind: "test",
    ref: label,
    authority: "pre-existing",
    outcome: "not observed",
    detail: "no executed test with this name failed before and passed after the change",
  };
}

function checkEvidence(checks: readonly CheckResult[], name: string): EvidenceRef {
  const check = checks.find((one) => one.name === name);
  if (check === undefined) {
    return { kind: "check", ref: name, authority: "pre-existing", outcome: "not run" };
  }
  return { kind: "check", ref: name, authority: check.authority, outcome: check.result };
}

/**
 * Each requirement's status from executed evidence only: every piece of evidence it names
 * must be observed as passing, and one that fails makes it failed. A requirement that names
 * no evidence is unverified, whatever the candidate did.
 */
export async function assessRequirements(
  requirements: readonly Requirement[],
  inputs: RequirementInputs,
): Promise<RequirementOutcome[]> {
  const outcomes: RequirementOutcome[] = [];
  for (const requirement of requirements) {
    const { tests, checks, structure } = requirement.evidence;
    const evidence: EvidenceRef[] = [
      ...tests.map((selector) => testEvidence(inputs.checks, selector)),
      ...checks.map((name) => checkEvidence(inputs.checks, name)),
      ...(await Promise.all(structure.map((claim) => structureEvidence(inputs.dir, claim)))),
    ];
    const failing = evidence.filter((one) => one.outcome === "failing" || one.outcome === "fail");
    const passing = (one: EvidenceRef) =>
      one.outcome === "fixed" || one.outcome === "pass" || one.outcome === "observed";
    const status =
      failing.length > 0
        ? "failed"
        : evidence.length > 0 && evidence.every(passing)
          ? "satisfied"
          : "unverified";
    const limitation =
      status === "satisfied"
        ? null
        : !inputs.changed
          ? "no change observed"
          : evidence.length === 0
            ? "no executed evidence is mapped to this requirement"
            : status === "failed"
              ? `failing: ${failing.map((one) => one.ref).join(", ")}`
              : `not observed: ${evidence
                  .filter((one) => !passing(one))
                  .map((one) => one.ref)
                  .join(", ")}`;
    outcomes.push({
      id: requirement.id,
      text: requirement.text,
      source: requirement.source,
      kind: requirement.kind,
      required: requirement.required,
      assumptions: [...requirement.assumptions],
      status,
      evidence,
      limitation,
      nextAction:
        status === "satisfied"
          ? null
          : status === "failed"
            ? "repair the failing evidence"
            : "add a check that fails before the change and passes after it",
    });
  }
  return outcomes;
}
