import type { EvidenceRef, Regression, RequirementOutcome } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import type { TestOutcome } from "./compare.ts";
import type { LatestTarget } from "./latest-version.ts";
import { targetKey } from "./latest-version.ts";
import type { CheckResult } from "./predicate.ts";
import {
  constraintEvidence,
  failing,
  holding,
  packageEvidence,
  structureEvidence,
  testRef,
  witnessing,
} from "./requirement-evidence.ts";
import { splitTestName, titleSelects } from "./test-names.ts";
import { livesIn } from "./test-report.ts";
import { noSuchCheck, noSuchTest, unobservedAction, witnessTitles } from "./unobserved-action.ts";

export interface RequirementInputs {
  readonly checks: readonly CheckResult[];
  /** Every test of every check, classified against the base. */
  readonly outcomes: readonly TestOutcome[];
  /** The candidate tree, and a reader of the base's files, for structural and dependency claims. */
  readonly dir: string;
  readonly readBase: (path: string) => Promise<string | null>;
  readonly changed: boolean;
  readonly regression: Regression;
  /** Whether the candidate's dependencies were installed fresh from its own lockfile. */
  readonly freshDependencies: boolean;
  /** The registry's latest within each constraint that asks for it, by `targetKey`. */
  readonly latest: ReadonlyMap<string, LatestTarget>;
}

function testRefs(
  selector: Requirement["evidence"]["tests"][number],
  inputs: RequirementInputs,
): EvidenceRef[] {
  // A name selects the test of that name, every test in the suite of that name, or a path of both,
  // in the file it names, if it names one. The id the verifier itself prints selects its test
  // whatever the runner made of the file: pytest's dotted classname is no path.
  const named = splitTestName(selector.name);
  const found = inputs.outcomes.filter(
    (one) =>
      (selector.file === undefined || livesIn(one.file, selector.file)) &&
      (one.id === selector.name ||
        ((named.title === "" || titleSelects(one.title, named.title)) &&
          (named.file === null || livesIn(one.file, named.file)))),
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
  // A changed file shows only that something changed; what a refactor leaves is named and read.
  if (requirement.kind === "refactor" && !evidence.some((one) => one.kind === "structure")) {
    return {
      status: "unverified",
      limitation: "no structure claim shows what the refactor leaves",
      nextAction:
        'name what the refactor leaves in "structure": each file it creates or moves to, with a text it holds ({"path": "file", "contains": "text"}), each text it takes out of a file ({"path": "file", "contains": "text", "absent": true}), and each path it removes ({"path": "file", "absent": true})',
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
  const flaky = evidence.filter((one) => one.outcome === "flaky");
  if (flaky.length > 0) {
    return {
      status: "unverified",
      limitation: `flaky: ${flaky.map((one) => `${one.ref} (${one.detail ?? ""})`).join(", ")}`,
      nextAction:
        "make the test deterministic, or map one that is: it failed and then passed on the same snapshot",
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
      ...(await Promise.all(
        requirement.versions.map((constraint) =>
          constraintEvidence(inputs.dir, constraint, inputs.latest.get(targetKey(constraint))),
        ),
      )),
    ];
    outcomes.push({
      id: requirement.id,
      text: requirement.text,
      source: requirement.source,
      kind: requirement.kind,
      required: requirement.required,
      assumptions: [...requirement.assumptions],
      expected: requirement.evidence,
      versions: requirement.versions,
      evidence,
      ...judged(requirement, evidence, inputs),
    });
  }
  return outcomes;
}
