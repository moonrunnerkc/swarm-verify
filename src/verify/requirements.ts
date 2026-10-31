import type { EvidenceRef, Regression, RequirementOutcome } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { CheckResult } from "./predicate.ts";
import { packageEvidence, structureEvidence } from "./requirement-evidence.ts";
import { livesIn } from "./test-report.ts";

export interface RequirementInputs {
  readonly checks: readonly CheckResult[];
  /** Every test of every check, classified against the base. */
  readonly outcomes: readonly TestOutcome[];
  /** The candidate tree, and a reader of the base's files, for structural and dependency claims. */
  readonly dir: string;
  readonly readBase: (path: string) => Promise<string | null>;
  /** Paths of source files the candidate changed. */
  readonly sourceChanged: readonly string[];
  readonly changed: boolean;
  readonly regression: Regression;
  /** Whether the candidate's dependencies were installed fresh from its own lockfile. */
  readonly freshDependencies: boolean;
}

/** Outcomes that show behavior: a test or check failing before and passing after. */
const witnessing = new Set(["fixed", "witness", "superseded"]);
const holding = new Set([
  ...witnessing,
  "preserved",
  "pass",
  "observed",
  "passes before and after",
]);
const failing = new Set(["failing", "fail"]);

function testRef(outcome: TestOutcome): EvidenceRef {
  const authority = outcome.origin === "pre-existing" ? "pre-existing" : "implementation-authored";
  const ref = outcome.id;
  switch (outcome.classification) {
    case "fixed":
      return { kind: "test", ref, authority, outcome: "fixed" };
    case "superseded":
      return {
        kind: "test",
        ref,
        authority,
        outcome: "superseded",
        detail: "authorized behavior change",
      };
    case "preserved":
    case "renamed":
      return { kind: "test", ref: outcome.movedTo ?? ref, authority, outcome: "preserved" };
    case "added":
      return outcome.before !== null && outcome.before !== "pass"
        ? {
            kind: "test",
            ref,
            authority,
            outcome: "witness",
            detail: "fails against the base's source",
          }
        : {
            kind: "test",
            ref,
            authority,
            outcome: "passes before and after",
            detail:
              outcome.before === null
                ? "no run against the base's source"
                : "passes against the base's source too",
          };
    case "skipped":
      return { kind: "test", ref, authority, outcome: "not observed", detail: "skipped" };
    default:
      return { kind: "test", ref, authority, outcome: "failing", detail: outcome.classification };
  }
}

function testRefs(
  selector: Requirement["evidence"]["tests"][number],
  inputs: RequirementInputs,
): EvidenceRef[] {
  const found = inputs.outcomes.filter(
    (one) =>
      (one.title === selector.name || one.title.endsWith(` > ${selector.name}`)) &&
      (selector.file === undefined || livesIn(one.file, selector.file)),
  );
  if (found.length > 0) return found.map(testRef);
  const label = selector.file === undefined ? selector.name : `${selector.file}::${selector.name}`;
  return [
    {
      kind: "test",
      ref: label,
      authority: "pre-existing",
      outcome: "not observed",
      detail: "no executed test has this name",
    },
  ];
}

function checkRef(name: string, inputs: RequirementInputs): EvidenceRef {
  const check = inputs.checks.find((one) => one.name === name);
  if (check === undefined)
    return {
      kind: "check",
      ref: name,
      authority: "pre-existing",
      outcome: "not observed",
      detail: "no such check ran",
    };
  const outcome =
    check.result === "pass"
      ? "pass"
      : check.result === "fail" || check.result === "error"
        ? "fail"
        : "not observed";
  return { kind: "check", ref: name, authority: check.authority, outcome, detail: check.result };
}

/** Status, limitation and next action from a requirement's evidence, by its kind. */
function judged(
  requirement: Requirement,
  evidence: readonly EvidenceRef[],
  inputs: RequirementInputs,
): Pick<RequirementOutcome, "status" | "limitation" | "nextAction"> {
  if (!inputs.changed && evidence.every((one) => !witnessing.has(one.outcome))) {
    return {
      status: "unverified",
      limitation: "no change observed",
      nextAction: "make the change the requirement asks for",
    };
  }
  const broken = evidence.filter((one) => failing.has(one.outcome));
  if (broken.length > 0) {
    return {
      status: "failed",
      limitation: `failing: ${broken.map((one) => one.ref).join(", ")}`,
      nextAction: "repair the failing evidence",
    };
  }
  if (evidence.length === 0) {
    return {
      status: "unverified",
      limitation: "no executed evidence is mapped to this requirement",
      nextAction: "map a test or check that exercises it",
    };
  }
  const unobserved = evidence.filter((one) => !holding.has(one.outcome));
  if (unobserved.length > 0) {
    return {
      status: "unverified",
      limitation: `not observed: ${unobserved.map((one) => one.ref).join(", ")}`,
      nextAction: "run a check that exercises it",
    };
  }
  if (requirement.kind === "fix" || requirement.kind === "feature") {
    if (!evidence.some((one) => witnessing.has(one.outcome))) {
      return {
        status: "unverified",
        limitation: "no mapped test fails before the change and passes after it",
        nextAction: "add a test that fails against the base and passes with the change",
      };
    }
  }
  if (requirement.kind === "refactor" && inputs.regression.status !== "none") {
    return {
      status: "unverified",
      limitation: `behavior is not shown preserved: regression ${inputs.regression.status}`,
      nextAction: "keep every base test passing",
    };
  }
  if (requirement.kind === "upgrade") {
    if (!evidence.some((one) => one.kind === "package")) {
      return {
        status: "unverified",
        limitation: "no resolved package version is mapped",
        nextAction: "name the upgraded package",
      };
    }
    if (!inputs.freshDependencies) {
      return {
        status: "unverified",
        limitation: "the candidate's dependencies were not installed fresh from its lockfile",
        nextAction: "verify with dependencies prepared from the lockfile",
      };
    }
    if (inputs.regression.status !== "none") {
      return {
        status: "unverified",
        limitation: `compatibility is not shown: regression ${inputs.regression.status}`,
        nextAction: "keep every base test passing",
      };
    }
  }
  return { status: "satisfied", limitation: null, nextAction: null };
}

/**
 * Each requirement's status from executed and observed evidence only. A fix or feature needs a
 * test that fails before and passes after; a refactor needs preserved behavior and structural
 * evidence, never a failing baseline; an upgrade needs resolved versions, a fresh install and
 * compatible checks. A requirement that names no evidence is unverified, whatever changed.
 */
export async function assessRequirements(
  requirements: readonly Requirement[],
  inputs: RequirementInputs,
): Promise<RequirementOutcome[]> {
  const outcomes: RequirementOutcome[] = [];
  for (const requirement of requirements) {
    const { tests, checks, structure, packages } = requirement.evidence;
    const evidence: EvidenceRef[] = [
      ...tests.flatMap((selector) => testRefs(selector, inputs)),
      ...checks.map((name) => checkRef(name, inputs)),
      ...(await Promise.all(structure.map((claim) => structureEvidence(inputs.dir, claim)))),
      ...(await Promise.all(
        packages.map((claim) => packageEvidence(inputs.readBase, inputs.dir, claim)),
      )),
    ];
    if (
      requirement.kind === "refactor" &&
      structure.length === 0 &&
      inputs.sourceChanged.length > 0
    ) {
      evidence.push({
        kind: "change",
        ref: inputs.sourceChanged.slice(0, 5).join(", "),
        authority: "pre-existing",
        outcome: "observed",
        detail: `${inputs.sourceChanged.length} source file(s) changed`,
      });
    }
    outcomes.push({
      id: requirement.id,
      text: requirement.text,
      source: requirement.source,
      kind: requirement.kind,
      required: requirement.required,
      assumptions: [...requirement.assumptions],
      expected: requirement.evidence,
      evidence,
      ...judged(requirement, evidence, inputs),
    });
  }
  return outcomes;
}
