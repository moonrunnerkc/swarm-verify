/**
 * The public API of swarm-verify. Everything a caller needs to verify a candidate and read the
 * result is exported here; modules under src/verify are internal and may change in any release.
 */
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
  snapshotWorkingTree,
  verify,
} from "./api/verify.ts";
export { buildVersion as verifierVersion } from "./build-version.ts";
export { declaredChecks } from "./config/declared.ts";
export type { DeclaredCheck } from "./config/swarm-toml.ts";
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
export { parseReport } from "./verify/test-report.ts";
