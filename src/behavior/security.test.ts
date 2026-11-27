import { afterEach, describe, expect, it } from "vitest";
import { correct, type Defenses, fixtureApp } from "./fixture-app.ts";
import { runScenario } from "./scenario.ts";
import {
  type SecurityBindingInput,
  securityCases,
  securityChecks,
  securityFileSchema,
  securityRequirement,
} from "./security.ts";
import { behaviorCheckSchema } from "./spec.ts";
import { scenarioOf } from "./target.ts";

const ownership: SecurityBindingInput = {
  class: "ownership",
  resource: { path: "/invoices/1" },
  owner: { "x-user": "ada" },
  other: { "x-user": "grace" },
  ownerSees: ["INV-0001-ADA"],
};
const token: SecurityBindingInput = {
  class: "single-use-token",
  issue: { method: "POST", path: "/tokens" },
  tokenAt: "token",
  redeem: { method: "POST", path: "/redeem/{{token}}" },
  expiresAfterMs: 700,
};
const payment: SecurityBindingInput = {
  class: "duplicate-operation",
  operation: { method: "POST", path: "/payments", headers: { "idempotency-key": "key-{{run}}" } },
  observe: { path: "/balance" },
  valueAt: "balance",
  by: -10,
};

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** The names of the cases an application with these defenses fails. */
async function failing(binding: SecurityBindingInput, defenses: Partial<Defenses>) {
  const app = await fixtureApp({ ...correct, ...defenses });
  closing.push(() => app.server.close());
  const check = behaviorCheckSchema.parse({
    name: "security",
    class: binding.class,
    authority: "independently-generated",
    requirements: ["R2"],
    target: { start: "node server.mjs", port: 3000 },
    cases: securityCases(binding),
  });
  const result = await runScenario(scenarioOf(check), app.base);
  expect(result.ready).toBe(true);
  return result.cases.filter((one) => one.status === "fail").map((one) => one.name);
}

describe("the ownership cases", () => {
  it("pass an application that serves owners and refuses everyone else", async () => {
    expect(await failing(ownership, {})).toEqual([]);
  });

  it("fail an application that serves another user's resource, and say what it answered", async () => {
    const app = await fixtureApp({ ...correct, ownerCheck: false });
    closing.push(() => app.server.close());
    const check = behaviorCheckSchema.parse({
      name: "security",
      authority: "user-acceptance",
      requirements: ["R2"],
      target: { start: "node server.mjs", port: 3000 },
      cases: securityCases(ownership),
    });
    const result = await runScenario(scenarioOf(check), app.base);
    expect(result.cases.find((one) => one.status === "fail")).toMatchObject({
      name: "another user is refused",
      detail: expect.stringMatching(
        /step 1 \(GET \/invoices\/1\): expected status 403 or 404, got 200/,
      ),
    });
  });

  // Asked in the other order, the owner's own delete would leave the stranger a 404 either way.
  it("fail an application that lets another user delete the resource, asked before the owner does", async () => {
    const removal = {
      ...ownership,
      resource: { method: "DELETE" as const, path: "/invoices/1" },
      success: [204],
      ownerSees: [],
    };
    expect(await failing(removal, {})).toEqual([]);
    expect(await failing(removal, { ownerCheck: false })).toEqual([
      "another user is refused",
      "the owner is served",
    ]);
  });

  it("fail an application that refuses everyone, the owner included", async () => {
    expect(await failing(ownership, { serveOwners: false })).toEqual(["the owner is served"]);
  });
});

describe("a binding that could not show what it claims", () => {
  // An application that answers a stranger and an unknown name alike: without the signed-in case,
  // a credential that names nobody is "refused" exactly as another real user should be.
  it("fails on a user the server does not know, where it names a request signed-in users can make", async () => {
    const invented = { ...ownership, other: { "x-user": "nobody" } };
    expect(await failing(invented, {})).toEqual([]);
    expect(await failing({ ...invented, signedIn: { path: "/me" } }, {})).toEqual([
      "each named user is signed in, and a request without credentials is not",
    ]);
    expect(await failing({ ...ownership, signedIn: { path: "/me" } }, {})).toEqual([]);
  });

  it("fails where the signed-in request is open to everyone, so it shows nothing", async () => {
    expect(await failing({ ...ownership, signedIn: { path: "/balance" } }, {})).toEqual([
      "each named user is signed in, and a request without credentials is not",
    ]);
  });

  it("is refused where the other user is the owner, the token is never used, or the number cannot move", () => {
    const refusal = (binding: SecurityBindingInput) => {
      try {
        securityCases(binding);
        return null;
      } catch (error) {
        return (error as { issues: { path: string[]; message: string }[] }).issues[0]?.message;
      }
    };
    expect(refusal({ ...ownership, other: { "x-user": "ada" } })).toMatch(
      /owner's own credentials/,
    );
    expect(refusal({ ...ownership, owner: {} })).toMatch(/holds no header/);
    expect(refusal({ ...ownership, signedIn: { path: "/invoices/1" } })).toMatch(
      /is the resource itself/,
    );
    expect(refusal({ ...token, redeem: { method: "POST", path: "/redeem/fixed" } })).toMatch(
      /never uses \{\{token\}\}/,
    );
    expect(refusal({ ...payment, by: 0 })).toMatch(/is 0/);
    expect(refusal({ ...payment, observe: payment.operation })).toMatch(/is the operation itself/);
  });
});

describe("the single-use token cases", () => {
  it("pass an application that redeems a token once and only while it lives", async () => {
    expect(await failing(token, {})).toEqual([]);
  });

  it("fail an application that redeems a token twice", async () => {
    expect(await failing(token, { singleUse: false })).toEqual([
      "a redeemed token is refused",
      "a token redeemed several times at once is honored once",
    ]);
  });

  it("fail an application whose redemption is not atomic, on concurrent redemption alone", async () => {
    expect(await failing(token, { atomicRedeem: false })).toEqual([
      "a token redeemed several times at once is honored once",
    ]);
  });

  it("fail an application that honors an expired token", async () => {
    expect(await failing(token, { expiry: false })).toEqual(["an expired token is refused"]);
  });
});

describe("the duplicate operation cases", () => {
  it("pass an application that answers a retry with the first result and applies it once", async () => {
    expect(await failing(payment, {})).toEqual([]);
  });

  it("fail an application that applies a replayed operation again", async () => {
    expect(await failing(payment, { idempotent: false })).toEqual([
      "a replayed operation is applied once",
      "an operation sent several times at once is applied once",
    ]);
  });

  it("fail an application whose duplicate check is not atomic, on concurrent requests alone", async () => {
    expect(await failing(payment, { atomicPayment: false })).toEqual([
      "an operation sent several times at once is applied once",
    ]);
  });
});

describe("a behavior check", () => {
  const base = {
    name: "custom",
    authority: "user-acceptance",
    requirements: ["R1"],
    target: { start: "node server.mjs", port: 3000 },
  };
  const one = (role: string) => ({
    name: role,
    role,
    steps: [{ request: { path: "/" }, expect: { status: [200] } }],
  });

  it("is refused when no case is a legitimate use, since refusing everything would pass it", () => {
    const parsed = behaviorCheckSchema.safeParse({
      ...base,
      cases: [one("refused"), one("effect")],
    });
    expect(parsed.error?.issues[0]?.message).toMatch(/refuses everything would pass/);
  });

  it("is refused when every case is a legitimate use, since allowing everything would pass it", () => {
    const parsed = behaviorCheckSchema.safeParse({
      ...base,
      cases: [one("allowed"), { ...one("allowed"), name: "again" }],
    });
    expect(parsed.error?.issues[0]?.message).toMatch(/allows everything would pass/);
  });

  it("reports a target that never answers as not ready, with no case judged", async () => {
    const check = behaviorCheckSchema.parse({
      ...base,
      target: { ...base.target, ready: { timeoutMs: 1000 } },
      cases: [one("allowed"), one("refused")],
    });
    expect(await runScenario(scenarioOf(check), "http://127.0.0.1:9")).toEqual({
      ready: false,
      cases: [],
    });
  });
});

describe("a project's binding file", () => {
  const file = securityFileSchema.parse({
    target: { start: "node server.mjs", port: 3000 },
    checks: [ownership, payment],
  });

  it("makes one check per binding, bound to the requirement of its class", () => {
    const made = securityChecks(file, "user-acceptance", new Map([["ownership", "R2"]]));
    expect(made.map((one) => [one.name, one.class, one.requirements])).toEqual([
      ["security-ownership-1", "ownership", ["R2"]],
    ]);
    expect(behaviorCheckSchema.safeParse(made[0]).success).toBe(true);
  });

  it("words the obligation as a requirement that names the request and none of the credentials", () => {
    const made = securityRequirement("R2", "ownership", file.checks[0] ?? null);
    expect(made).toMatchObject({ id: "R2", source: "security", kind: "other", required: true });
    expect(made.text).toContain("its check sends GET /invoices/1");
    expect(made.text).not.toContain("ada");
  });
});
