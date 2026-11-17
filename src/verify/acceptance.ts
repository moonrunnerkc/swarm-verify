// The acceptance rule, one source for the live verifier and verify.mjs, which carries this file's
// code without its types (scripts/sync-offline.mjs). It imports nothing, reads only the recorded
// predicate and never trusts a recorded status it can re-derive.

/** The acceptance semantics a statement is judged under; a statement naming another is refused. */
export const acceptancePolicy = "swarm-verify.acceptance/v1";

/** Outcomes that show behavior: a test or check failing before and passing after. */
export const witnessingOutcomes = ["fixed", "witness", "superseded"];
/** Outcomes that hold: witnessing ones and those showing nothing broke or a fact was observed. */
export const holdingOutcomes = [
  ...witnessingOutcomes,
  "preserved",
  "pass",
  "observed",
  "passes before and after",
  "passes but for inherited failures",
];

interface RecordedRef {
  readonly kind?: string | undefined;
  readonly outcome?: string | undefined;
  readonly authority?: string | undefined;
}

interface RecordedRequirement {
  readonly id?: string | undefined;
  readonly kind?: string | undefined;
  readonly required?: boolean | undefined;
  readonly status?: string | undefined;
  readonly testsAsked?: boolean | undefined;
  readonly behaviorAsked?: boolean | undefined;
  readonly evidence?: readonly RecordedRef[] | undefined;
}

interface RecordedCheck {
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
  readonly result?: string | undefined;
  readonly collected?: number | null | undefined;
  readonly tests?: { readonly flaky?: readonly unknown[] } | null | undefined;
}

export interface RecordedPredicate {
  readonly state?: string | undefined;
  readonly change?: { readonly applied?: boolean } | undefined;
  readonly requirements?: readonly RecordedRequirement[] | undefined;
  readonly checks?: readonly RecordedCheck[] | undefined;
  readonly baseline?: { readonly status?: string } | undefined;
  readonly heldOut?:
    | { readonly status?: string | undefined; readonly heldOutPassRate?: number }
    | undefined;
  readonly regression?: { readonly status?: string } | undefined;
  readonly execution?: {
    readonly policyMet?: boolean | undefined;
    readonly dependencies?: { readonly mode?: string } | undefined;
  };
  readonly policy?: { readonly acceptance?: string } | undefined;
}

const witnesses = (ref: RecordedRef) => witnessingOutcomes.includes(ref.outcome ?? "");

/**
 * Whether a requirement's recorded evidence supports `satisfied`: every piece holds, at least one
 * decisive witness was not chosen by the implementation's author (a fix or feature: a test failing
 * before and passing after; a refactor: structure or such a test; an upgrade: a resolved package,
 * or a witnessing test where the task asked for code to change), asked-for tests are among this
 * requirement's own evidence, a refactor or upgrade regressed nothing and an upgrade was installed
 * fresh from its lockfile.
 */
export function requirementSupported(
  one: RecordedRequirement,
  predicate: RecordedPredicate,
): boolean {
  const evidence = one.evidence ?? [];
  if (evidence.length === 0) return false;
  if (!evidence.every((ref) => holdingOutcomes.includes(ref.outcome ?? ""))) return false;
  const quiet = predicate.regression?.status === "none";
  const decisive =
    one.kind === "fix" || one.kind === "feature"
      ? witnesses
      : one.kind === "refactor"
        ? (ref: RecordedRef) => ref.kind === "structure" || witnesses(ref)
        : one.kind === "upgrade"
          ? one.behaviorAsked === true
            ? witnesses
            : (ref: RecordedRef) => ref.kind === "package"
          : () => true;
  const shown = evidence.filter(decisive);
  if (!shown.some((ref) => ref.authority !== "implementation-authored")) return false;
  const own = (ref: RecordedRef) => ref.authority === "implementation-authored" && witnesses(ref);
  const asks = one.testsAsked === true && (one.kind === "fix" || one.kind === "feature");
  if (asks && !evidence.some(own)) return false;
  if (one.kind === "refactor") return quiet;
  if (one.kind === "upgrade") {
    const fresh = predicate.execution?.dependencies?.mode === "prepared";
    return quiet && fresh && evidence.some((ref) => ref.kind === "package");
  }
  return true;
}

/**
 * Why the record cannot be judged as it stands, independent of its state: an acceptance policy
 * this rule is not, duplicate requirement IDs or check names. Empty where it can be judged.
 */
export function recordProblems(predicate: RecordedPredicate): string[] {
  const problems: string[] = [];
  const policy = predicate.policy?.acceptance;
  if (policy !== undefined && policy !== acceptancePolicy)
    problems.push(`it is judged under ${policy}, which this verifier does not implement`);
  const duplicates = (names: readonly (string | undefined)[]) =>
    names.filter((name, at) => names.indexOf(name) !== at);
  const ids = duplicates((predicate.requirements ?? []).map((one) => one.id));
  if (ids.length > 0) problems.push(`requirement ID ${ids.join(", ")} appears more than once`);
  const names = duplicates((predicate.checks ?? []).map((check) => check.name));
  if (names.length > 0) problems.push(`check ${names.join(", ")} appears more than once`);
  return problems;
}

/**
 * The state the recorded evidence supports, short of `blocked`, which is the run's own finding:
 * complete only when the change applied, at least one check ran against a measured base and every
 * check held with no flaky test, every required requirement is supported, nothing regressed or
 * stayed unresolved, the held-out checks passed and the execution policy was met.
 */
export function acceptedState(predicate: RecordedPredicate): "complete" | "incomplete" {
  const checks = predicate.checks ?? [];
  const checksHold =
    checks.length > 0 &&
    checks.every(
      (check) =>
        (check.result === "pass" || check.result === "inherited-failures") &&
        !(check.kind === "test" && check.collected === 0) &&
        (check.tests?.flaky ?? []).length === 0,
    );
  const heldOut = predicate.heldOut;
  const heldOutHolds = heldOut?.status !== "measured" || heldOut.heldOutPassRate === 1;
  const required = (predicate.requirements ?? []).filter((one) => one.required === true);
  return predicate.change?.applied === true &&
    recordProblems(predicate).length === 0 &&
    predicate.baseline?.status === "measured" &&
    checksHold &&
    required.every((one) => one.status === "satisfied" && requirementSupported(one, predicate)) &&
    predicate.regression?.status === "none" &&
    predicate.execution?.policyMet === true &&
    heldOutHolds
    ? "complete"
    : "incomplete";
}
