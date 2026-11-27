import { afterEach, describe, expect, it } from "vitest";
import { unreadValue } from "./binding.ts";
import { correct, type Defenses, fixtureApp } from "./fixture-app.ts";
import { runScenario } from "./scenario.ts";
import {
  type SecurityBindingInput,
  securityCases,
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
};
const untimed: SecurityBindingInput = {
  class: "single-use-token",
  issue: { method: "POST", path: "/tokens" },
  tokenAt: "token",
  redeem: { method: "POST", path: "/redeem/{{token}}" },
};
const target = { start: "node server.mjs", port: 3000 };
const made = () =>
  behaviorCheckSchema.parse({
    name: "security",
    class: "single-use-token",
    authority: "independently-generated",
    requirements: ["R2"],
    target,
    cases: securityCases(untimed),
  });

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** The names of the sent cases an application with these defenses fails. */
async function failing(defenses: Partial<Defenses>) {
  const app = await fixtureApp({ ...correct, ...defenses });
  closing.push(() => app.server.close());
  const result = await runScenario(scenarioOf(made()), app.base);
  return result.cases.filter((one) => one.status === "fail").map((one) => one.name);
}

describe("a token binding that gives no expiry to wait for", () => {
  it("keeps the expiry case, unobserved and saying what to supply, and sends the driver the rest", () => {
    const expired = made().cases.find((one) => one.name === "an expired token is refused");
    expect(expired).toMatchObject({ role: "refused", steps: [] });
    expect(expired?.unobserved).toMatch(/gives no "expiresAfterMs".*"target\.env"/);
    expect(scenarioOf(made()).cases.map((one) => one.name)).toEqual([
      "a valid token is redeemed",
      "a redeemed token is refused",
      "a token that was never issued is refused",
      "a token redeemed several times at once is honored once",
    ]);
  });

  it("still fails reuse, an unknown token and concurrent redemption, and cannot see expiry", async () => {
    expect(await failing({})).toEqual([]);
    expect(await failing({ singleUse: false })).toEqual([
      "a redeemed token is refused",
      "a token redeemed several times at once is honored once",
    ]);
    expect(await failing({ atomicRedeem: false })).toEqual([
      "a token redeemed several times at once is honored once",
    ]);
    expect(await failing({ expiry: false })).toEqual([]);
  });
});

const base = { name: "custom", authority: "user-acceptance", requirements: ["R1"], target };
const one = (role: string) => ({
  name: role,
  role,
  steps: [{ request: { path: "/" }, expect: { status: [200] } }],
});

describe("an unobserved case", () => {
  it("is refused where a case both sends steps and is unobserved, or does neither", () => {
    const both = { ...one("refused"), unobserved: "nothing to wait for" };
    const neither = { name: "neither", role: "refused" };
    for (const odd of [both, neither]) {
      const parsed = behaviorCheckSchema.safeParse({ ...base, cases: [one("allowed"), odd] });
      expect(parsed.error?.issues[0]?.message).toMatch(/or says why it is unobserved/);
    }
  });

  it("does not count an unobserved case as the use that must be refused", () => {
    const unsent = { name: "later", role: "refused", unobserved: "nothing to wait for" };
    const parsed = behaviorCheckSchema.safeParse({ ...base, cases: [one("allowed"), unsent] });
    expect(parsed.error?.issues[0]?.message).toMatch(/allows everything would pass/);
  });
});

describe("what a binding leaves untried", () => {
  it("claims the refusal of another role only where the binding names a user of one", () => {
    const text = (binding: SecurityBindingInput | null) =>
      securityRequirement(
        "R2",
        "ownership",
        binding === null
          ? null
          : (securityFileSchema.parse({ target: target, checks: [binding] }).checks[0] ?? null),
      ).text;
    expect(text(null)).toContain("another user, another role and an unauthenticated request");
    expect(text({ ...ownership, otherRole: { "x-user": "sam" } })).toContain("another role and");
    expect(text(ownership)).toContain("another user and an unauthenticated request are refused");
    expect(text(ownership)).toContain("names no user of another role, so none is tried");
  });

  it("holds a drafted binding to variables the repository reads, as to its credentials", () => {
    const timed = securityFileSchema.parse({
      target: { start: "node server.mjs", port: 3000, env: { TOKEN_TTL_MS: "500" } },
      checks: [{ ...untimed, expiresAfterMs: 700 }],
    });
    expect(unreadValue(timed, "const life = process.env.TOKEN_TTL_MS;")).toBeNull();
    expect(unreadValue(timed, "const life = 900_000;")).toBe("TOKEN_TTL_MS");
  });
});
