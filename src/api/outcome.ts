import { z } from "zod";
import { checkAuthorities, requirementKinds, requirementSources, sha256Schema } from "./request.ts";

export const requirementStatuses = ["satisfied", "failed", "unverified", "blocked"] as const;
export type RequirementStatus = (typeof requirementStatuses)[number];

/**
 * complete: every required obligation satisfied, no unresolved regression, the evidence is of
 * the delivered snapshot and the execution policy was met. blocked: the environment, the
 * dependencies or a prerequisite kept the verifier from measuring. Anything else is incomplete.
 */
export const overallStates = ["complete", "incomplete", "blocked"] as const;
export type OverallState = (typeof overallStates)[number];

/** One piece of executed or observed evidence, by reference. Never model prose. */
export const evidenceRefSchema = z.strictObject({
  kind: z.enum(["test", "check", "structure", "package", "change"]),
  ref: z.string().min(1),
  authority: z.enum(checkAuthorities),
  outcome: z.string().min(1),
  detail: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const requirementOutcomeSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(requirementSources),
  kind: z.enum(requirementKinds),
  required: z.boolean(),
  assumptions: z.array(z.string()),
  status: z.enum(requirementStatuses),
  evidence: z.array(evidenceRefSchema),
  limitation: z.string().nullable(),
  nextAction: z.string().nullable(),
});
export type RequirementOutcome = z.infer<typeof requirementOutcomeSchema>;

const ids = z.array(z.string());

/**
 * The candidate against the base, test by test where a runner's report was read. found: a test
 * or check that passed at base no longer does. unresolved: some comparison could not be made
 * (an unparsed report, a check failing at both commits judged only by exit code), so no claim
 * of inheritance is made for it.
 */
export const regressionSchema = z.strictObject({
  status: z.enum(["none", "found", "unresolved"]),
  newFailures: ids,
  inherited: ids,
  removed: ids,
  unresolved: ids,
});
export type Regression = z.infer<typeof regressionSchema>;

/**
 * How the checks were contained, apart from whether the record is intact. A host run says
 * `host, not isolated`; a full evidence claim never degrades to it silently.
 */
export const executionSchema = z.strictObject({
  mode: z.enum(["isolated", "host"]),
  statement: z.string().min(1),
  network: z.enum(["closed", "open"]),
  image: z.string().nullable(),
  dependencies: z.strictObject({
    mode: z.enum(["prepared", "setup", "linked", "none"]),
    reproducible: z.boolean(),
    lockfiles: z.record(z.string(), sha256Schema),
    treeSha256: sha256Schema.nullable(),
    note: z.string(),
  }),
  policyMet: z.boolean(),
  problems: z.array(z.string()),
});
export type Execution = z.infer<typeof executionSchema>;

/** Whether the evidence record is intact and who signed it. Says nothing about the work. */
export const integritySchema = z.strictObject({
  signed: z.boolean(),
  signer: z
    .strictObject({ kind: z.enum(["key", "sigstore"]), fingerprint: z.string().nullable() })
    .nullable(),
  statementSha256: sha256Schema.nullable(),
  problems: z.array(z.string()),
});
export type Integrity = z.infer<typeof integritySchema>;

/** Where the written evidence is. Paths, so the result itself stays small. */
export const evidenceFilesSchema = z.strictObject({
  directory: z.string().min(1),
  bundle: z.string().nullable(),
  statement: z.string().nullable(),
  patch: z.string().nullable(),
  publicKey: z.string().nullable(),
});
export type EvidenceFiles = z.infer<typeof evidenceFilesSchema>;
