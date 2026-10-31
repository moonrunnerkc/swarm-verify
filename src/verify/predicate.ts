import { z } from "zod";
import {
  executionSchema,
  overallStates,
  regressionSchema,
  requirementOutcomeSchema,
} from "../api/outcome.ts";
import { checkAuthorities, producerSchema } from "../api/request.ts";
import { artifactCategories } from "../config/swarm-toml.ts";
import { statementType } from "./dsse.ts";
import { runners } from "./test-report.ts";

/** The signed result. Version 1 of the result model; the verdict/v1 predicate it replaces is retired. */
export const predicateType = "https://github.com/moonrunnerkc/swarm-verify/result/v1";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const rate = z.number().min(0).max(1);
const unmeasured = z.object({ status: z.literal("unmeasured"), reason: z.string().min(1) });

const testIds = z.array(z.string());

/**
 * A check judged test by test from its runner's reports at the base, against the candidate, and
 * for the candidate's own tests against the base's source. Each list holds at most its first
 * 100 ids; `counts` has the totals.
 */
export const testJudgmentSchema = z.object({
  runner: z.enum(runners),
  collected: z.object({
    base: z.number().int().nonnegative(),
    candidate: z.number().int().nonnegative(),
  }),
  counts: z.object({
    preserved: z.number().int().nonnegative(),
    renamed: z.number().int().nonnegative(),
    fixed: z.number().int().nonnegative(),
    newFailures: z.number().int().nonnegative(),
    inherited: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    expectationChanges: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    addedFailing: z.number().int().nonnegative(),
    witnesses: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  fixed: testIds,
  newFailures: testIds,
  inherited: testIds,
  removed: testIds,
  renamed: testIds,
  superseded: testIds,
  expectationChanges: testIds,
  added: testIds,
  addedFailing: testIds,
  /** Tests the candidate added or rewrote that fail against the base's source and pass now. */
  witnesses: testIds,
});
export type TestJudgment = z.infer<typeof testJudgmentSchema>;

export const checkResultSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  kind: z.enum(["test", "other"]),
  authority: z.enum(checkAuthorities),
  // inherited-failures: nothing new fails, and tests that failed at the base still fail.
  // no-tests: the run collected no test, which never counts as passing. unresolved: the base and
  // the candidate could not be compared (a report that did not parse, or a check judged only by
  // its exit code that fails at both), so nothing is claimed as inherited.
  result: z.enum(["pass", "fail", "error", "no-tests", "inherited-failures", "unresolved"]),
  /** Tests the run collected, from the runner's report or its printed summary; null where unknown. */
  collected: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  outputSha256: sha256,
  baseOutputSha256: sha256.optional(),
  tests: testJudgmentSchema.optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

const artifact = z.object({
  path: z.string().min(1),
  category: z.enum([...artifactCategories, "source"]),
});

export const coverageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("measured"),
    tool: z.enum(["v8", "coverage.py"]),
    changedLines: z.number().int().nonnegative(),
    coveredLines: z.number().int().nonnegative(),
    files: z.array(
      z.object({ path: z.string(), covered: z.array(z.number()), uncovered: z.array(z.number()) }),
    ),
  }),
  unmeasured,
]);
export type Coverage = z.infer<typeof coverageSchema>;

/**
 * One mutant of a changed line, syntax-checked before it runs. Only `killed` is detection: a
 * test that passed with the candidate failed under valid code. `invalid-mutant` means no
 * candidate line yielded a mutant that parses; `timeout` and `runner-crash` say the run ended
 * without telling a test failure apart.
 */
export const mutationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["killed", "survived", "timeout", "runner-crash"]),
    path: z.string(),
    line: z.number().int().positive(),
    operator: z.string(),
    syntax: z.literal("valid"),
    /** Mutants refused before this one because they did not parse. */
    rejected: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal("invalid-mutant"),
    rejected: z.number().int().positive(),
    reason: z.string().min(1),
  }),
  unmeasured,
]);
export type Mutation = z.infer<typeof mutationSchema>;

export const heldOutSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("measured"),
    checks: z.array(checkResultSchema),
    visiblePassRate: rate,
    heldOutPassRate: rate,
    gap: z.number().min(-1).max(1),
    /** Processes that loaded the judge, and the node:assert calls they made. */
    judge: z.object({
      processes: z.number().int().nonnegative(),
      assertionCalls: z.number().int().nonnegative(),
    }),
  }),
  unmeasured,
]);
export type HeldOut = z.infer<typeof heldOutSchema>;

/** Every declared and held-out check, run at the base commit before the change applied. */
export const baselineSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("measured"),
    /** Reused from an earlier run with the same base, environment, sealed set and judge. */
    cached: z.boolean(),
    environmentSha256: sha256,
    checks: z.array(checkResultSchema),
    heldOut: z.array(checkResultSchema),
  }),
  unmeasured,
]);
export type Baseline = z.infer<typeof baselineSchema>;

export const predicateSchema = z.object({
  state: z.enum(overallStates),
  /** requirements: the request named requirements; regression-only: it named none. */
  scope: z.enum(["requirements", "regression-only"]),
  reasons: z.array(z.string()),
  base: z.object({ commit: z.string().min(1) }),
  change: z.object({
    source: z.enum(["working-tree", "range", "patch", "commit"]),
    applied: z.boolean(),
    files: z.array(
      z.object({ path: z.string(), status: z.enum(["added", "modified", "deleted"]) }),
    ),
  }),
  requirements: z.array(requirementOutcomeSchema),
  regression: regressionSchema,
  checks: z.array(checkResultSchema),
  baseline: baselineSchema,
  heldOut: heldOutSchema,
  /** Every changed path and its kind; none is refused for its kind. */
  artifacts: z.array(artifact),
  testFiles: z.object({
    added: z.array(z.string()),
    modified: z.array(z.string()),
    deleted: z.array(z.string()),
    moved: z.array(z.object({ from: z.string(), to: z.string() })),
    relocated: z.array(z.string()),
  }),
  coverage: coverageSchema,
  mutation: mutationSchema,
  producer: producerSchema,
  environment: z.object({
    sha256,
    node: z.string(),
    platform: z.string(),
    git: z.string(),
    dependencies: z.enum(["prepared", "linked", "setup", "none"]),
    /** The installed dependency tree's digest, where it was installed from the lockfile. */
    dependencyTreeSha256: sha256.nullable(),
    /** Whether the same lockfiles reproduce this environment; linked trees never do. */
    reproducible: z.boolean(),
  }),
  execution: executionSchema,
  unmeasured: z.array(z.string()),
  /** The log files written beside the statement (each check's full output), by digest. */
  logs: z.array(z.object({ name: z.string().min(1), sha256 })),
  verifier: z.object({ name: z.literal("swarm-verify"), version: z.string() }),
});
export type Predicate = z.infer<typeof predicateSchema>;

export const statementSchema = z.object({
  _type: z.literal(statementType),
  subject: z.array(z.object({ name: z.string().min(1), digest: z.object({ sha256 }) })).min(1),
  predicateType: z.literal(predicateType),
  predicate: predicateSchema,
});
export type Statement = z.infer<typeof statementSchema>;

/** Subjects: the resulting tree, and the patch that produced it from the base. */
export function buildStatement(input: {
  readonly treeSha256: string;
  readonly patchSha256: string;
  readonly patchName: string;
  readonly predicate: Predicate;
}): Statement {
  return statementSchema.parse({
    _type: statementType,
    subject: [
      { name: "tree", digest: { sha256: input.treeSha256 } },
      { name: input.patchName, digest: { sha256: input.patchSha256 } },
    ],
    predicateType,
    predicate: input.predicate,
  });
}
