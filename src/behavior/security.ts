import { z } from "zod";
import { type Requirement, requirementSchema } from "../api/request.ts";
import {
  type Call,
  callSchema,
  type SecurityBinding,
  type SecurityBindingInput,
  type SecurityClass,
  type SecurityFile,
  securityBindingSchema,
} from "./binding.ts";
import type { BehaviorCaseInput, BehaviorCheckInput, BehaviorStepInput } from "./spec.ts";

export {
  type SecurityBinding,
  type SecurityBindingInput,
  type SecurityClass,
  type SecurityFile,
  securityBindingSchema,
  securityClasses,
  securityFileSchema,
} from "./binding.ts";

/** Statuses that say no without saying the server broke. */
const refusals = [400, 401, 403, 404, 409, 410, 422];

const step = (
  request: Call,
  expect: BehaviorStepInput["expect"],
  more: Partial<BehaviorStepInput> = {},
): BehaviorStepInput => ({ request, expect, ...more });

const withHeaders = (request: Call, extra: Readonly<Record<string, string>>): Call => ({
  ...request,
  headers: { ...request.headers, ...extra },
});

/** `{{name}}` replaced through a request, where the value is known before the case runs. */
function bound(request: Call, name: string, value: string): Call {
  const put = (text: string) => text.replaceAll(`{{${name}}}`, value);
  return z.parse(callSchema, JSON.parse(put(JSON.stringify(request))));
}

/** The case that shows each user an ownership binding names is one the server knows. */
export const signedInCase =
  "each named user is signed in, and a request without credentials is not";

/**
 * The cases of one supported security check for a project's binding. Every set holds a
 * legitimate use that must succeed beside the uses that must be refused, so neither refusing
 * everything nor allowing everything passes. Each request goes straight to the server: a
 * restriction that lives only in a user interface is not there.
 */
export function securityCases(input: SecurityBindingInput): BehaviorCaseInput[] {
  const binding = securityBindingSchema.parse(input);
  if (binding.class === "ownership") {
    const { resource, success, ownerSees } = binding;
    const refused = (name: string, as: Readonly<Record<string, string>>, status: number[]) => ({
      name,
      role: "refused" as const,
      steps: [step(withHeaders(resource, as), { status, bodyExcludes: ownerSees })],
    });
    const users = [binding.owner, binding.other, ...(binding.otherRole ? [binding.otherRole] : [])];
    const { signedIn } = binding;
    return [
      ...(signedIn === undefined
        ? []
        : [
            {
              name: signedInCase,
              role: "allowed" as const,
              steps: [
                ...users.map((as) => step(withHeaders(signedIn, as), { status: [200] })),
                step(signedIn, { status: [401, 403] }),
              ],
            },
          ]),
      {
        name: "the owner is served",
        role: "allowed",
        steps: [
          step(withHeaders(resource, binding.owner), { status: success, bodyIncludes: ownerSees }),
        ],
      },
      refused("another user is refused", binding.other, [403, 404]),
      refused("an unauthenticated request is refused", {}, [401, 403]),
      ...(binding.otherRole === undefined
        ? []
        : [refused("a user of another role is refused", binding.otherRole, [403, 404])]),
    ];
  }
  if (binding.class === "single-use-token") {
    const { issue, redeem, success, concurrent } = binding;
    const issued = step(issue, { status: [200, 201] }, { capture: { token: binding.tokenAt } });
    return [
      {
        name: "a valid token is redeemed",
        role: "allowed",
        steps: [issued, step(redeem, { status: success })],
      },
      {
        name: "a redeemed token is refused",
        role: "refused",
        steps: [issued, step(redeem, { status: success }), step(redeem, { status: refusals })],
      },
      {
        name: "a token that was never issued is refused",
        role: "refused",
        steps: [step(bound(redeem, "token", "never-issued-0000"), { status: refusals })],
      },
      ...(binding.expiresAfterMs === undefined
        ? []
        : [
            {
              name: "an expired token is refused",
              role: "refused" as const,
              steps: [
                issued,
                step(redeem, { status: refusals }, { waitMs: binding.expiresAfterMs }),
              ],
            },
          ]),
      {
        name: "a token redeemed several times at once is honored once",
        role: "effect",
        steps: [
          issued,
          step(
            redeem,
            { status: success, count: { min: 1, max: 1 }, otherwise: refusals },
            { times: concurrent },
          ),
        ],
      },
    ];
  }
  const { operation, observe, valueAt, by, success, concurrent } = binding;
  const before = step(observe, { status: [200] }, { capture: { before: valueAt } });
  const after = step(observe, {
    status: [200],
    json: [{ path: valueAt, delta: { of: "before", by } }],
  });
  // A repeat may be answered with the first result or refused; what counts is the effect.
  const repeated = { status: [...success, ...refusals] };
  const of = (run: string) => bound(operation, "run", run);
  return [
    {
      name: "the operation is applied",
      role: "allowed",
      steps: [before, step(of("first"), { status: success }), after],
    },
    {
      name: "a replayed operation is applied once",
      role: "effect",
      steps: [before, step(of("replay"), { status: success }), step(of("replay"), repeated), after],
    },
    {
      name: "an operation sent several times at once is applied once",
      role: "effect",
      steps: [before, step(of("burst"), repeated, { times: concurrent }), after],
    },
  ];
}

const obligations: Readonly<Record<SecurityClass, string>> = {
  ownership:
    "Only its owner can reach the resource the task serves: another user, another role and an unauthenticated request are refused by the server, and the owner is still served",
  "single-use-token":
    "A token the task issues is honored once and only while it is valid: an expired, unknown or already used one is refused, and of several redemptions at once exactly one succeeds",
  "duplicate-operation":
    "The operation the task adds takes effect once: a replayed or concurrent duplicate request does not apply it again, and a legitimate first request still succeeds",
};

const requested = (binding: SecurityBinding): string => {
  const call =
    binding.class === "ownership"
      ? binding.resource
      : binding.class === "single-use-token"
        ? binding.redeem
        : binding.operation;
  return `${call.method} ${call.path}`;
};

/**
 * A security obligation as a requirement of its own, for a producer to fix before its first
 * edit. It names the request its check sends, so a change can serve that path, and none of the
 * check's credentials.
 */
export function securityRequirement(
  id: string,
  name: SecurityClass,
  binding: SecurityBinding | null,
): Requirement {
  return requirementSchema.parse({
    id,
    text: `${obligations[name]}${binding === null ? "" : ` (its check sends ${requested(binding)} and requests like it straight to the server)`}`,
    source: "security",
    kind: "other",
  });
}

/** The behavior checks a binding file makes, each bound to the requirement of its class. */
export function securityChecks(
  file: SecurityFile,
  authority: BehaviorCheckInput["authority"],
  ids: ReadonlyMap<SecurityClass, string>,
): BehaviorCheckInput[] {
  return file.checks.flatMap((binding, at) => {
    const id = ids.get(binding.class);
    if (id === undefined) return [];
    return [
      {
        name: `security-${binding.class}-${at + 1}`,
        class: binding.class,
        authority,
        requirements: [id],
        target: file.target,
        cases: securityCases(binding),
      },
    ];
  });
}
