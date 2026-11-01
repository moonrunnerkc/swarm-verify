import type { EvidenceRef, Regression, RequirementOutcome } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { CheckResult } from "./predicate.ts";
import {
  failing,
  holding,
  packageEvidence,
  structureEvidence,
  testRef,
  witnessing,
} from "./requirement-evidence.ts";
import { splitTestName, titleSelects } from "./test-names.ts";
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

const noSuchTest = "no executed test has this name";
const noSuchCheck = "no such check ran";

function testRefs(
  selector: Requirement["evidence"]["tests"][number],
  inputs: RequirementInputs,
): EvidenceRef[] {
  // A name selects the test of that name, every test in the suite of that name, or a path of both,
  // in the file it names, if it names one.
  const named = splitTestName(selector.name);
  const found = inputs.outcomes.filter(
    (one) =>
      (named.title === "" || titleSelects(one.title, named.title)) &&
      (selector.file === undefined || livesIn(one.file, selector.file)) &&
      (named.file === null || livesIn(one.file, named.file)),
  );
  if (found.length > 0) return found.map(testRef);
  const label = selector.file === undefined ? selector.name : `${selector.file}::${selector.name}`;
  return [
    {
      kind: "test",
      ref: label,
      authority: "pre-existing",
      outcome: "not observed",
      detail: noSuchTest,
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
      detail: noSuchCheck,
    };
  // Inherited failures fail at the base and still fail with nothing new failing: the check shows
  // the change broke nothing it measures, which is what naming it claims.
  const outcome =
    check.result === "pass"
      ? "pass"
      : check.result === "inherited-failures"
        ? "passes but for inherited failures"
        : check.result === "fail" || check.result === "error"
          ? "fail"
          : "not observed";
  return { kind: "check", ref: name, authority: check.authority, outcome, detail: check.result };
}

/** Titles of tests the executed results show witnessing the change, not among `mapped`. */
function witnessTitles(inputs: RequirementInputs, mapped: readonly EvidenceRef[]): string[] {
  const refs = new Set(mapped.map((one) => one.ref));
  return inputs.outcomes
    .filter((one) => witnessing.has(testRef(one).outcome) && !refs.has(testRef(one).ref))
    .map((one) => one.title)
    .slice(0, 8);
}

/** What to do about evidence that was not observed: fix what matched nothing, or run it. */
function unobservedAction(
  unobserved: readonly EvidenceRef[],
  inputs: RequirementInputs,
  evidence: readonly EvidenceRef[],
): string {
  const refs = (detail: string) =>
    unobserved
      .filter((one) => one.detail === detail)
      .map((one) => one.ref)
      .join(", ");
  const checks = refs(noSuchCheck);
  const tests = refs(noSuchTest);
  const ran = inputs.checks.map((one) => one.name).join(", ") || "none ran";
  const witnesses = witnessTitles(inputs, evidence);
  const example =
    witnesses.find((title) => title.includes(" > ")) ??
    inputs.outcomes.find((one) => one.title.includes(" > "))?.title ??
    "suite > test title";
  const structure = unobserved
    .filter((one) => one.kind === "structure")
    .map((one) => `${one.ref}: ${one.detail}`)
    .join("; ");
  const steps = [
    ...(checks.length > 0 ? [`name only checks that ran (${ran}) in place of ${checks}`] : []),
    ...(tests.length > 0
      ? [
          `name tests as they ran (a title, a suite, or a path such as ${example}) in place of ${tests}`,
        ]
      : []),
    ...(structure.length > 0
      ? [`fix or drop the structure claims that do not hold (${structure})`]
      : []),
    ...(witnesses.length > 0
      ? [
          `these tests fail before the change and pass after it, and this requirement does not map them: ${witnesses.join(", ")}`,
        ]
      : []),
  ];
  return steps.length > 0 ? steps.join("; ") : "run a check that exercises it";
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
    // Executed results already show which tests witness the change; naming them is not mapping
    // them, which stays the producer's to propose.
    const witnesses = witnessTitles(inputs, evidence);
    return {
      status: "unverified",
      limitation: "no executed evidence is mapped to this requirement",
      nextAction:
        witnesses.length === 0
          ? "map a test or check that exercises it"
          : `map the tests that exercise it; these fail before the change and pass after it: ${witnesses.join(", ")}`,
    };
  }
  const unobserved = evidence.filter((one) => !holding.has(one.outcome));
  if (unobserved.length > 0) {
    return {
      status: "unverified",
      limitation: `not observed: ${unobserved.map((one) => one.ref).join(", ")}`,
      nextAction: unobservedAction(unobserved, inputs, evidence),
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
        nextAction:
          "name the upgraded package with the version it resolves to; where no package version changes, the requirement is not an upgrade: record it as kind other, with the structure and checks that show it",
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
