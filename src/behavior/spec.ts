import { z } from "zod";

const status = z.int().min(100).max(599);

const requestSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  path: z.string().startsWith("/"),
  headers: z.record(z.string(), z.string()).default({}),
  /** A string sent as written, or a value sent as JSON. `{{name}}` is a captured variable. */
  body: z.unknown().optional(),
});

const stepSchema = z.strictObject({
  request: requestSchema,
  /** How many copies of the request are sent at once. */
  times: z.int().min(1).max(50).default(1),
  /** A wait before sending, for an expiry to pass. */
  waitMs: z.int().min(0).max(60_000).default(0),
  expect: z.strictObject({
    /** The statuses that count; with no `count`, every response must carry one. */
    status: z.array(status).min(1),
    /** With `times`: how many of the responses may carry one of `status`. */
    count: z.strictObject({ min: z.int().min(0), max: z.int().min(0) }).optional(),
    /** With `count`: the statuses the remaining responses must carry; any, where empty. */
    otherwise: z.array(status).default([]),
    /** Values in the JSON response: equal to a value, or changed by an amount from a capture. */
    json: z
      .array(
        z.strictObject({
          path: z.string().min(1),
          equals: z.unknown().optional(),
          delta: z.strictObject({ of: z.string().min(1), by: z.number() }).optional(),
        }),
      )
      .default([]),
    bodyIncludes: z.array(z.string().min(1)).default([]),
    bodyExcludes: z.array(z.string().min(1)).default([]),
  }),
  /** Variables for later steps of the case, each read from a path of the JSON response. */
  capture: z.record(z.string().regex(/^\w+$/), z.string().min(1)).default({}),
});
export type BehaviorStep = z.output<typeof stepSchema>;
export type BehaviorStepInput = z.input<typeof stepSchema>;

/**
 * allowed: a legitimate use that must succeed. refused: a use that must be denied. effect: a
 * side effect that must happen no more often than permitted.
 */
export const caseRoles = ["allowed", "refused", "effect"] as const;

const caseSchema = z
  .strictObject({
    name: z.string().min(1),
    role: z.enum(caseRoles),
    steps: z.array(stepSchema).default([]),
    /**
     * Why the case could not be made from what the check was given, and what would make it. Such
     * a case is never sent and never passes: the requirements it would witness stay unverified.
     */
    unobserved: z.string().min(1).optional(),
  })
  .refine((one) => (one.unobserved === undefined) === one.steps.length > 0, {
    path: ["steps"],
    message: "a case holds the steps it sends, or says why it is unobserved, and never both",
  });
export type BehaviorCase = z.output<typeof caseSchema>;
export type BehaviorCaseInput = z.input<typeof caseSchema>;

export const behaviorClasses = [
  "ownership",
  "single-use-token",
  "duplicate-operation",
  "custom",
] as const;
export type BehaviorClass = (typeof behaviorClasses)[number];

export const targetSchema = z.strictObject({
  /** The command that starts the application in the checkout; it must keep running. */
  start: z.string().min(1),
  /** The port it listens on; also given to it as PORT. */
  port: z.int().min(1).max(65_535),
  env: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.string()).default({}),
  ready: z
    .strictObject({
      path: z.string().startsWith("/").default("/"),
      timeoutMs: z.int().min(1000).max(300_000).default(30_000),
    })
    .default({ path: "/", timeoutMs: 30_000 }),
});
export type BehaviorTarget = z.output<typeof targetSchema>;

/**
 * A check of what a running application does, made from outside it: the verifier starts the
 * candidate as a target and a separate driver sends it the requests. It comes with the request,
 * so the candidate never holds it. A check with no legitimate use in it would pass an
 * application that refuses everything, and one with nothing else would pass one that allows
 * everything; both are refused here.
 */
export const behaviorCheckSchema = z
  .strictObject({
    name: z.string().regex(/^[\w.-]+$/),
    class: z.enum(behaviorClasses).default("custom"),
    authority: z.enum(["user-acceptance", "independently-generated"]),
    /** The requirements its cases witness. */
    requirements: z.array(z.string().regex(/^R\d+$/)).min(1),
    target: targetSchema,
    cases: z.array(caseSchema).min(2),
  })
  .superRefine((check, context) => {
    const names = check.cases.map((one) => one.name);
    const sent = check.cases.filter((one) => one.unobserved === undefined);
    const twice = names.find((name, index) => names.indexOf(name) !== index);
    if (twice !== undefined)
      context.addIssue({ code: "custom", path: ["cases"], message: `case ${twice} appears twice` });
    if (!sent.some((one) => one.role === "allowed"))
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message:
          "no case is a legitimate use that must succeed, so an application that refuses everything would pass; add one with role allowed",
      });
    if (!sent.some((one) => one.role !== "allowed"))
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message:
          "every case is a use that must succeed, so an application that allows everything would pass; add one with role refused or effect",
      });
  });
export type BehaviorCheck = z.output<typeof behaviorCheckSchema>;
export type BehaviorCheckInput = z.input<typeof behaviorCheckSchema>;

/** A case's id among the tests of a verification. */
export const caseId = (check: string, name: string) => `behavior ${check}::${name}`;
