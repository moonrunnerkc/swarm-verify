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
export { predicateType } from "./verify/predicate.ts";
export { exitCodeOf, renderMarkdown, renderText } from "./verify/report.ts";
