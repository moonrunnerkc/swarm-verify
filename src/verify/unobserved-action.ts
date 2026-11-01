import type { EvidenceRef } from "../api/outcome.ts";
import { testRef, witnessing } from "./requirement-evidence.ts";
import type { RequirementInputs } from "./requirements.ts";

export const noSuchTest = "no executed test has this name";
export const noSuchCheck = "no such check ran";

/** Titles of tests the executed results show witnessing the change, not among `mapped`. */
export function witnessTitles(inputs: RequirementInputs, mapped: readonly EvidenceRef[]): string[] {
  const refs = new Set(mapped.map((one) => one.ref));
  return inputs.outcomes
    .filter((one) => witnessing.has(testRef(one).outcome) && !refs.has(testRef(one).ref))
    .map((one) => one.title)
    .slice(0, 8);
}

/** What to do about evidence that was not observed: fix what matched nothing, or run it. */
export function unobservedAction(
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
  const packages = unobserved
    .filter((one) => one.kind === "package" && one.authority !== "user-acceptance")
    .map((one) => `${one.ref}: ${one.detail}`)
    .join("; ");
  const steps = [
    ...(packages.length > 0
      ? [
          `a package claim holds where the candidate's lockfile resolves the package to a version the base did not: drop the claim for a package that did not change, or correct it (${packages})`,
        ]
      : []),
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
