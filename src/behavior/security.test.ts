import { afterEach, describe, expect, it } from "vitest";
import { correct, type Defenses, fixtureApp } from "./fixture-app.ts";
import { runScenario } from "./scenario.ts";
import { type SecurityBindingInput, securityCases } from "./security.ts";
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

  it("fail an application that refuses everyone, the owner included", async () => {
    expect(await failing(ownership, { serveOwners: false })).toEqual(["the owner is served"]);
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
