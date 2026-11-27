import { z } from "zod";
import { targetSchema } from "./spec.ts";

const headers = z.record(z.string(), z.string());
export const callSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  path: z.string().startsWith("/"),
  headers: headers.default({}),
  body: z.unknown().optional(),
});
export type Call = z.output<typeof callSchema>;

/**
 * What a project must say about itself for one of the supported security checks to be made for
 * it: which request, as whom. The cases are the same for every project; only these differ.
 */
const bindingSchema = z.discriminatedUnion("class", [
  z.strictObject({
    class: z.literal("ownership"),
    /** A request for one resource, without credentials. */
    resource: callSchema,
    /** Headers that authenticate the resource's owner, another user, and a user of another role. */
    owner: headers,
    other: headers,
    otherRole: headers.optional(),
    /**
     * A request the base already answers for any signed-in user and refuses without credentials.
     * With it, each named user is shown to be one the server knows, before and after the change:
     * a credential that names nobody is refused like a stranger's, which reads as a restriction.
     */
    signedIn: callSchema.optional(),
    success: z.array(z.int()).min(1).default([200]),
    /** Text only the owner's response holds; another user's response must not hold it. */
    ownerSees: z.array(z.string().min(1)).default([]),
  }),
  z.strictObject({
    class: z.literal("single-use-token"),
    /** The request that issues a token, and where the token is in its JSON response. */
    issue: callSchema,
    tokenAt: z.string().min(1),
    /** The request that redeems it; `{{token}}` stands for the token. */
    redeem: callSchema,
    success: z.array(z.int()).min(1).default([200]),
    /** How long after issue a token must be refused, where the target is started with a short life. */
    expiresAfterMs: z.int().min(1).max(30_000).optional(),
    concurrent: z.int().min(2).max(20).default(5),
  }),
  z.strictObject({
    class: z.literal("duplicate-operation"),
    /** The operation; `{{run}}` differs between cases, for an idempotency key or a fresh resource. */
    operation: callSchema,
    /** A request that reads a number the operation changes, and where it is in the JSON response. */
    observe: callSchema,
    valueAt: z.string().min(1),
    /** How much one application of the operation changes that number. */
    by: z.number(),
    success: z.array(z.int()).min(1).default([200, 201]),
    concurrent: z.int().min(2).max(20).default(5),
  }),
]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A binding whose parts cannot show what its class claims is refused before it is used. */
export const securityBindingSchema = bindingSchema.superRefine((binding, context) => {
  const refuse = (path: string, message: string) =>
    context.addIssue({ code: "custom", path: [path], message });
  if (binding.class === "ownership") {
    if (Object.keys(binding.owner).length === 0)
      refuse("owner", "holds no header, so the owner's request is an unauthenticated one");
    if (same(binding.owner, binding.other))
      refuse("other", "is the owner's own credentials; name a different user");
    const { resource, signedIn } = binding;
    if (signedIn?.method === resource.method && signedIn.path === resource.path)
      refuse(
        "signedIn",
        "is the resource itself: a request every signed-in user can make is not one only an owner can",
      );
    if (binding.otherRole !== undefined && same(binding.owner, binding.otherRole))
      refuse("otherRole", "is the owner's own credentials; name a user of another role");
  } else if (binding.class === "single-use-token") {
    if (!JSON.stringify(binding.redeem).includes("{{token}}"))
      refuse("redeem", "never uses {{token}}, so it redeems nothing the issue step returned");
  } else if (binding.by === 0) {
    refuse("by", "is 0, so the observed number shows nothing of whether the operation applied");
  } else if (same(binding.operation, binding.observe)) {
    refuse("observe", "is the operation itself; name a request that only reads the number");
  }
});
export type SecurityBinding = z.output<typeof securityBindingSchema>;
export type SecurityBindingInput = z.input<typeof securityBindingSchema>;

/** The security checks this version can make, for JavaScript and TypeScript Node web APIs. */
export const securityClasses = ["ownership", "single-use-token", "duplicate-operation"] as const;
export type SecurityClass = (typeof securityClasses)[number];

/** How a project binds the checks to itself: how its server starts, and one binding per check. */
export const securityFileSchema = z.strictObject({
  target: targetSchema,
  checks: z.array(securityBindingSchema).min(1),
});
export type SecurityFile = z.output<typeof securityFileSchema>;

const credential = /authorization|cookie|key|token|user|session|auth/i;

/**
 * A value of a binding that a text does not hold: a credential in a header, or text only the
 * owner should see. A binding drafted from a repository is held to what its author was shown; a
 * check built on an invented value fails every change, or passes for the wrong reason.
 */
export function unreadValue(file: SecurityFile, shown: string): string | null {
  const values: string[] = [];
  const held = (headers: Readonly<Record<string, string>> | undefined) => {
    for (const [name, value] of Object.entries(headers ?? {}))
      if (credential.test(name)) values.push(value.replace(/^(?:Bearer|Basic|Token)\s+/i, ""));
  };
  for (const check of file.checks) {
    if (check.class === "ownership") {
      for (const one of [check.owner, check.other, check.otherRole, check.resource.headers])
        held(one);
      held(check.signedIn?.headers);
      values.push(...check.ownerSees);
    } else if (check.class === "single-use-token") {
      held(check.issue.headers);
      held(check.redeem.headers);
    } else {
      held(check.operation.headers);
      held(check.observe.headers);
    }
  }
  return values.find((one) => !one.includes("{{") && !shown.includes(one)) ?? null;
}
