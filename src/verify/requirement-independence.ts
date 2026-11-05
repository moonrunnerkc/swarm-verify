import type { EvidenceRef, RequirementOutcome } from "../api/outcome.ts";
import type { Requirement } from "../api/request.ts";
import { holding, witnessing } from "./requirement-evidence.ts";

/** The evidence that shows a requirement met, by its kind, as opposed to evidence that it broke nothing. */
export function decisive(
  requirement: Requirement,
  evidence: readonly EvidenceRef[],
): EvidenceRef[] {
  const holds = evidence.filter((one) => holding.has(one.outcome));
  switch (requirement.kind) {
    case "fix":
    case "feature":
      return holds.filter((one) => witnessing.has(one.outcome));
    case "refactor":
      return holds.filter((one) => one.kind === "structure" || witnessing.has(one.outcome));
    case "upgrade":
      // Where the wording asks for a code change too, what shows it met is a test of that change.
      return requirement.behaviorAsked
        ? holds.filter((one) => witnessing.has(one.outcome))
        : holds.filter((one) => one.kind === "package");
    default:
      return holds;
  }
}

export type Judged = Pick<RequirementOutcome, "status" | "limitation" | "nextAction">;

/**
 * Satisfied only on independent evidence: at least one decisive witness the change's own author
 * did not choose. Where every one is the implementation's own (its tests, or claims it proposed),
 * the requirement is self-attested, which is not satisfied.
 */
export function attested(
  requirement: Requirement,
  evidence: readonly EvidenceRef[],
  judgedAs: Judged,
): Judged & Pick<RequirementOutcome, "witness"> {
  const shown = decisive(requirement, evidence);
  const independent = shown.filter((one) => one.authority !== "implementation-authored");
  const witness =
    independent.length > 0 ? "independent" : shown.length > 0 ? "self-attested" : "none";
  if (judgedAs.status !== "satisfied" || witness === "independent") return { ...judgedAs, witness };
  return {
    status: "unverified",
    witness,
    limitation: `self-attested: every witness is the implementation's own (${shown.map((one) => one.ref).join(", ")})`,
    nextAction:
      "independent evidence is missing: a check the implementation's author did not write (sealed, user-supplied or pre-existing) must witness this requirement",
  };
}
