import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Requirement } from "../api/request.ts";
import { probeFixture } from "../probes/fixture.ts";
import { type SecurityBindingInput, securityCases, securityRequirement } from "./security.ts";
import type { BehaviorCheckInput } from "./spec.ts";

/**
 * A single-use token check through a whole verification. The base issues nothing; candidates
 * redeem once, refuse reuse and unknown tokens, and are atomic. One enforces the token's
 * lifetime and one, deliberately, does not. Synthetic tokens only.
 */
const parent = join(homedir(), ".swarm", "test-work", `token-${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const app = (expiry: boolean) => `import { createServer } from "node:http";
const life = Number(process.env.TOKEN_TTL_MS ?? 900000);
const tokens = new Map();
let serial = 0;
createServer((request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const [, area, id] = (request.url ?? "/").split("/");
  if (area === "tokens" && request.method === "POST") {
    const token = "synthetic-" + ++serial;
    tokens.set(token, { used: false, issued: Date.now() });
    return send(201, { token });
  }
  if (area === "redeem" && request.method === "POST") {
    const token = tokens.get(id);
    if (token === undefined) return send(404, { error: "unknown token" });
    ${expiry ? 'if (Date.now() - token.issued > life) return send(410, { error: "expired" });' : ""}
    if (token.used) return send(409, { error: "already used" });
    token.used = true;
    return send(200, { redeemed: true });
  }
  return send(200, { ok: true });
}).listen(Number(process.env.PORT));
`;
const files = {
  "server.mjs":
    'import { createServer } from "node:http";\ncreateServer((_, response) => response.writeHead(404).end("{}")).listen(Number(process.env.PORT));\n',
  "test/app.test.mjs": "import { test } from 'node:test';\ntest('the suite runs', () => {});\n",
  "package.json":
    '{"name":"tokens","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n',
};

const binding: SecurityBindingInput = {
  class: "single-use-token",
  issue: { method: "POST", path: "/tokens" },
  tokenAt: "token",
  redeem: { method: "POST", path: "/redeem/{{token}}" },
};
const derived: Requirement = securityRequirement("R2", "single-use-token", null);

let port = 23_000 + (process.pid % 20_000);
const check = (
  bound: SecurityBindingInput,
  env: Record<string, string> = {},
): BehaviorCheckInput => ({
  name: "token",
  class: "single-use-token",
  authority: "independently-generated",
  requirements: ["R2"],
  target: { start: "node server.mjs", port: ++port, env, ready: { timeoutMs: 20_000 } },
  cases: securityCases(bound),
});
const short = { TOKEN_TTL_MS: "150" };
const timed: SecurityBindingInput = { ...binding, expiresAfterMs: 400 };

async function verified(expiry: boolean, behavior: BehaviorCheckInput) {
  const probe = await probeFixture(files, "node --test", parent);
  await probe.put("server.mjs", app(expiry));
  return probe.verify([derived], { behavior: [behavior] });
}

describe("the expiry obligation of a single-use token check", () => {
  it("is not satisfied by a binding that gives no expiry to wait for", async () => {
    for (const expiry of [false, true]) {
      const result = await verified(expiry, check(binding));
      const [requirement] = result.requirements;
      expect(requirement?.status).toBe("unverified");
      expect(requirement?.limitation).toBe(
        "not observed: behavior token::an expired token is refused",
      );
      expect(requirement?.nextAction).toMatch(
        /give the check what it lacked \(behavior token::an expired token is refused: the binding gives no "expiresAfterMs"/,
      );
      expect(result.state).toBe("incomplete");
      expect(result.reasons.join("\n")).toMatch(/an expired token is refused was not exercised/);
      // The cases that were sent are still judged, and none of them is the candidate's failure.
      expect(result.behavior[0]?.cases.map((one) => one.candidate)).toEqual([
        "pass",
        "pass",
        "pass",
        null,
        "pass",
      ]);
      expect(result.failureOutput).not.toMatch(/expired/);
    }
  });

  it("fails an application that never expires a token, the other defenses in place", async () => {
    const result = await verified(false, check(timed, short));
    expect(result.requirements[0]?.status).toBe("failed");
    expect(result.failureOutput).toMatch(/an expired token is refused failed: step 2/);
    expect(result.behavior[0]?.cases.map((one) => [one.name, one.candidate])).toEqual([
      ["a valid token is redeemed", "pass"],
      ["a redeemed token is refused", "pass"],
      ["a token that was never issued is refused", "pass"],
      ["an expired token is refused", "fail"],
      ["a token redeemed several times at once is honored once", "pass"],
    ]);
  });

  it("is satisfied by an application that expires it, started with a short lifetime", async () => {
    const result = await verified(true, check(timed, short));
    expect(result.requirements[0]).toMatchObject({ status: "satisfied", witness: "independent" });
    expect(result.state).toBe("complete");
  });
});
