/**
 * The public API of swarm-verify. Everything a caller needs to verify a candidate and read the
 * result is exported here; modules under src/verify are internal and may change in any release.
 */

export type { Authenticated, SignerPolicy } from "./api/bundle-auth.ts";
export { authenticatedStatement, UnauthenticatedBundleError } from "./api/bundle-auth.ts";
export type {
  EvidenceFiles,
  EvidenceRef,
  Execution,
  Integrity,
  OverallState,
  Regression,
  RequirementOutcome,
  RequirementStatus,
} from "./api/outcome.ts";
export { overallStates, requirementStatuses } from "./api/outcome.ts";
export type { Delivery, DeliveryStatus } from "./api/publish.ts";
export { manifestVersion } from "./api/publish.ts";
export type { Replay } from "./api/replay.ts";
export { replay, UnreplayableBundleError } from "./api/replay.ts";
export type {
  CheckAuthority,
  ExecutionPolicy,
  Producer,
  Requirement,
  TrustedCheck,
  VerifyRequest,
  VerifyRequestInput,
  VersionConstraint,
} from "./api/request.ts";
export {
  checkAuthorities,
  requestVersion,
  requirementKinds,
  requirementSchema,
  requirementSources,
  structureClaimSchema,
  verifyRequestSchema,
  versionConstraintSchema,
} from "./api/request.ts";
export type { VerifyResult } from "./api/result.ts";
export { resultVersion, verifyResultSchema } from "./api/result.ts";
export type { VerifyCallOptions } from "./api/verify.ts";
export {
  CandidateChangedError,
  InvalidRequestError,
  parseRequest,
  RunCancelledError,
  snapshotWorkingTree,
  verify,
} from "./api/verify.ts";
export { unreadValue } from "./behavior/binding.ts";
export type { BehaviorRecord } from "./behavior/evidence.ts";
export { tryBinding } from "./behavior/probe.ts";
export type {
  SecurityBinding,
  SecurityBindingInput,
  SecurityClass,
  SecurityFile,
} from "./behavior/security.ts";
export {
  securityBindingSchema,
  securityCases,
  securityChecks,
  securityClasses,
  securityFileSchema,
  securityRequirement,
} from "./behavior/security.ts";
export type { BehaviorCheck, BehaviorCheckInput, BehaviorClass } from "./behavior/spec.ts";
export {
  behaviorCheckSchema,
  behaviorClasses,
  caseId,
  targetSchema as behaviorTargetSchema,
} from "./behavior/spec.ts";
export { httpSurface } from "./behavior/surface.ts";
export { buildVersion as verifierVersion } from "./build-version.ts";
export { declaredChecks } from "./config/declared.ts";
export type { DeclaredCheck } from "./config/swarm-toml.ts";
export { MalformedSwarmTomlError, readSwarmToml } from "./config/swarm-toml.ts";
export { conventionEvidence } from "./conventions/evidence.ts";
export type { SourceText, Tally, Violation } from "./conventions/measure.ts";
export {
  conventionSources,
  conventionViolations,
  measureConventions,
} from "./conventions/measure.ts";
export type { ConventionProposal } from "./conventions/propose.ts";
export { conventionProposal } from "./conventions/propose.ts";
export type { ConventionRule, ConventionSet } from "./conventions/rules.ts";
export {
  conventionRules,
  conventionSetSchema,
  conventionText,
  conventionValues,
} from "./conventions/rules.ts";
export type { UnsafeFinding, UnsafeKind } from "./conventions/unsafe.ts";
export { unsafePatterns } from "./conventions/unsafe.ts";
export { acceptancePolicy } from "./verify/acceptance.ts";
export { reportPlans } from "./verify/per-test.ts";
export { predicateType } from "./verify/predicate.ts";
export { exitCodeOf, renderMarkdown, renderText } from "./verify/report.ts";
export type { ReportPlan } from "./verify/report-plan.ts";
/**
 * The verifier's readings, for a producer that measures its own working tree between
 * verifications the same way: claims and constraints against a tree, the checks a base declares,
 * and runners' reports, normalized test by test. None of them decides a status.
 */
export { constraintEvidence, structureEvidence } from "./verify/requirement-evidence.ts";
export type { SealedFile, SealedSet } from "./verify/sealed-store.ts";
export { readSealed, SealError, sealedDirectory, sealFiles } from "./verify/sealed-store.ts";
export type { TestReport } from "./verify/test-report.ts";
export { livesIn, parseReport } from "./verify/test-report.ts";
