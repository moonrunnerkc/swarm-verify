import { z } from "zod";
import { parseVersionRange } from "../verify/version-range.ts";

/** The request a caller hands the verifier. A new incompatible shape gets a new version. */
export const requestVersion = "swarm-verify.request/v1";

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex sha256");
export const commitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "a full lowercase commit id");

export const requirementSources = ["user", "repository-instruction", "inferred"] as const;
export const requirementKinds = ["fix", "feature", "refactor", "upgrade", "other"] as const;
/**
 * Who stands behind a check. Pre-existing checks are the base commit's own; user acceptance
 * checks and independently generated checks come from the request, outside the candidate;
 * implementation-authored tests are the candidate's own and count only as labeled evidence.
 */
export const checkAuthorities = [
  "pre-existing",
  "user-acceptance",
  "independently-generated",
  "implementation-authored",
] as const;
export type CheckAuthority = (typeof checkAuthorities)[number];

/** A test named the way its runner reports it: the name, and the file where the runner says. */
const testSelectorSchema = z.strictObject({
  name: z.string().min(1),
  file: z.string().min(1).optional(),
});

/**
 * Who chose a claim. A claim the caller writes is the caller's acceptance; a producer passing on
 * claims its coding model proposed marks them implementation-authored, and they then witness
 * nothing on their own.
 */
const claimAuthority = z.enum([
  "user-acceptance",
  "independently-generated",
  "implementation-authored",
]);

/**
 * A structural fact about the candidate tree, for refactors: a file exists, holds a text, no longer
 * holds it (`contains` with `absent`), or is gone.
 */
const structureClaimSchema = z
  .strictObject({
    path: z.string().min(1),
    contains: z.string().min(1).optional(),
    /** A name the module defines, read by its language's parser; with `absent`, it no longer does. */
    symbol: z
      .string()
      .regex(/^[A-Za-z_$][\w$]*$/)
      .optional(),
    /** With `symbol`: an importer of the module gets the name, defined there or not. */
    provides: z.boolean().optional(),
    absent: z.boolean().optional(),
    authority: claimAuthority.optional(),
  })
  .refine((claim) => claim.symbol === undefined || claim.contains === undefined, {
    message: "a claim names a symbol or a text, not both",
  })
  .refine(
    (claim) => claim.provides !== true || (claim.symbol !== undefined && claim.absent !== true),
    {
      message: "provides names a symbol a module still gives an importer",
    },
  );

/** A dependency an upgrade must resolve to, read from the candidate's lockfile. */
const packageClaimSchema = z.strictObject({
  name: z.string().min(1),
  ecosystem: z.enum(["npm", "pypi"]),
  version: z.string().min(1).optional(),
  authority: claimAuthority.optional(),
});

/**
 * A version the user's own wording constrains a dependency to ("the latest 9.x", "^9", "pin to
 * 4.1.2"). The producer's code reads it from the wording, never a model, and the verifier judges
 * the candidate's lockfile against it: within the range, and the registry's latest within it when
 * the wording asks for the latest.
 */
export const versionConstraintSchema = z.strictObject({
  name: z.string().min(1),
  ecosystem: z.enum(["npm", "pypi"]),
  range: z.string().refine((range) => parseVersionRange(range) !== null, {
    message: "a version range: 1.2.3, 9, 9.x, 9.6.x, ^9.6.1 or ~9.6",
  }),
  latest: z.boolean().default(false),
  /** The words it was read from, shown beside the result. */
  wording: z.string().min(1),
});
export type VersionConstraint = z.output<typeof versionConstraintSchema>;

export const requirementSchema = z.strictObject({
  id: z.string().regex(/^R\d+$/, "R followed by a number"),
  text: z.string().min(1),
  source: z.enum(requirementSources),
  kind: z.enum(requirementKinds),
  required: z.boolean().default(true),
  assumptions: z.array(z.string().min(1)).default([]),
  /** Where the evidence for this requirement is expected. A proposal; statuses come from results. */
  evidence: z
    .strictObject({
      tests: z.array(testSelectorSchema).default([]),
      checks: z.array(z.string().min(1)).default([]),
      structure: z.array(structureClaimSchema).default([]),
      packages: z.array(packageClaimSchema).default([]),
    })
    .default({ tests: [], checks: [], structure: [], packages: [] }),
  versions: z.array(versionConstraintSchema).default([]),
  /**
   * The user's wording asks for tests ("with a test", "Add tests"), as the producer's code reads
   * it: a fix or feature then also needs a test the change itself adds that fails before it and
   * passes after it, beside its independent witness.
   */
  testsAsked: z.boolean().default(false),
});
export type Requirement = z.output<typeof requirementSchema>;

/** A check the request supplies: it runs on the candidate but its command is not the candidate's. */
export const trustedCheckSchema = z.strictObject({
  name: z.string().regex(/^[\w.-]+$/),
  command: z.string().min(1),
  kind: z.enum(["test", "other"]),
  authority: z.enum(["user-acceptance", "independently-generated"]),
});
export type TrustedCheck = z.output<typeof trustedCheckSchema>;

/**
 * How the checks run. Isolated runs them in a container with the network closed after a
 * recorded dependency stage; host runs them as the caller's user and is reported as not
 * isolated. Dependencies are prepared from the lockfile (or the base's declared setup command),
 * linked from the caller's installed tree (never reproducible), or not prepared at all.
 */
export const executionPolicySchema = z.strictObject({
  mode: z.enum(["isolated", "host"]),
  network: z.enum(["closed", "open"]).default("closed"),
  dependencies: z.enum(["prepare", "linked", "none"]).default("prepare"),
  image: z.string().min(1).optional(),
});
export type ExecutionPolicy = z.output<typeof executionPolicySchema>;

/** What produced the candidate, bound into the signed statement. Never used to judge it. */
export const producerSchema = z.strictObject({
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  promptSha256: sha256Schema.optional(),
  /** The producer's command ledger: the digest of its first `ledgerRecords` lines, as written. */
  ledgerSha256: sha256Schema.optional(),
  ledgerRecords: z.number().int().nonnegative().optional(),
  reportSha256: sha256Schema.optional(),
  instructions: z
    .array(z.strictObject({ path: z.string().min(1), sha256: sha256Schema }))
    .default([]),
});
export type Producer = z.output<typeof producerSchema>;

export const verifyRequestSchema = z.strictObject({
  version: z.literal(requestVersion),
  /** A git repository holding the base commit (and the candidate commit, when one is named). */
  repository: z.string().min(1),
  base: z.strictObject({ commit: commitSchema }),
  /** The candidate, by an identity that cannot change under the verifier. */
  candidate: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("patch"), path: z.string().min(1), sha256: sha256Schema }),
    z.strictObject({ kind: z.literal("commit"), commit: commitSchema }),
  ]),
  requirements: z.array(requirementSchema).default([]),
  checks: z.array(trustedCheckSchema).default([]),
  policy: z.strictObject({
    /** Whether the task authorizes changing what existing tests expect. */
    behaviorChange: z.enum(["none", "authorized"]).default("none"),
    /**
     * Reruns of a check on the same snapshot when a test's failure there decides the verdict. A
     * test that passes on one is flaky: uncertain, never a regression and never a fix.
     */
    reruns: z.number().int().min(0).max(10).default(3),
    execution: executionPolicySchema,
  }),
  /** Where the statement, bundle, patch and logs are written. Outside the candidate's tree. */
  artifacts: z.strictObject({ directory: z.string().min(1) }),
  producer: producerSchema.default({ instructions: [] }),
});
export type VerifyRequestInput = z.input<typeof verifyRequestSchema>;
export type VerifyRequest = z.output<typeof verifyRequestSchema>;
