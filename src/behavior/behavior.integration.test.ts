import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replay } from "../api/replay.ts";
import type { Requirement } from "../api/request.ts";
import { checksOffline, fixtureSigner, probeFixture } from "../probes/fixture.ts";
import { securityCases } from "./security.ts";
import type { BehaviorCheckInput } from "./spec.ts";

/**
 * Behavior checks through a whole verification: a small invoice API whose base serves nothing,
 * and candidates that are correct, insecure, or try to pass by forging and tampering. Synthetic
 * users only. The isolated cases need a docker daemon.
 */
const parent = join(homedir(), ".swarm", "test-work", `behavior-${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const server = (extra = "") => `import { createServer } from "node:http";
import { invoiceFor } from "./invoices.mjs";
${extra}
createServer((request, response) => {
  const match = /^\\/invoices\\/(\\w+)$/.exec(request.url ?? "");
  if (match === null) return response.writeHead(200).end("ok");
  const found = invoiceFor(match[1], request.headers["x-user"]);
  response.writeHead(found.status, { "content-type": "application/json" });
  response.end(JSON.stringify(found.body));
}).listen(Number(process.env.PORT));
`;
const store = `const invoices = { 1: { owner: "ada", number: "INV-0001-ADA" } };\n`;
const absent = `export const invoiceFor = () => ({ status: 404, body: { error: "not found" } });\n`;
const insecure = `${store}export function invoiceFor(id, user) {
  if (user === undefined) return { status: 401, body: { error: "sign in" } };
  const invoice = invoices[id];
  return invoice === undefined ? { status: 404, body: {} } : { status: 200, body: invoice };
}
`;
const secure = insecure.replace(
  "return invoice === undefined ?",
  "return invoice === undefined || invoice.owner !== user ?",
);
const files = {
  "server.mjs": server(),
  "invoices.mjs": absent,
  "test/invoices.test.mjs":
    "import { test } from 'node:test';\nimport '../invoices.mjs';\ntest('the module loads', () => {});\n",
  "package.json":
    '{"name":"invoices","version":"1.0.0","type":"module","private":true,"scripts":{"test":"node --test"}}\n',
};

const derived: Requirement = {
  id: "R2",
  text: "Only an invoice's owner can download it",
  source: "security",
  kind: "other",
  required: true,
  testsAsked: false,
  behaviorAsked: false,
  assumptions: [],
  evidence: { tests: [], checks: [], structure: [], packages: [] },
  versions: [],
};

let port = 21_000 + (process.pid % 20_000);
const ownership = (): BehaviorCheckInput => ({
  name: "ownership",
  class: "ownership",
  authority: "independently-generated",
  requirements: ["R2"],
  target: { start: "node server.mjs", port: ++port, ready: { timeoutMs: 20_000 } },
  cases: securityCases({
    class: "ownership",
    resource: { path: "/invoices/1" },
    owner: { "x-user": "ada" },
    other: { "x-user": "grace" },
    ownerSees: ["INV-0001-ADA"],
  }),
});

describe("a behavior check in a verification, on the host", () => {
  it("fails the derived requirement of a candidate that serves another user's invoice", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("invoices.mjs", insecure);
    const result = await probe.verify([derived], { behavior: [ownership()] });
    expect(result.requirements[0]).toMatchObject({ status: "failed", source: "security" });
    expect(result.state).toBe("incomplete");
    expect(result.failureOutput).toMatch(
      /behavior ownership::another user is refused failed: step 1 \(GET \/invoices\/1\): expected status 403 or 404, got 200/,
    );
    expect(result.behavior[0]).toMatchObject({ assurance: "external driver, host target" });
    expect(result.behavior[0]?.cases.map((one) => [one.name, one.base, one.candidate])).toEqual([
      ["the owner is served", "fail", "pass"],
      ["another user is refused", "pass", "fail"],
      ["an unauthenticated request is refused", "fail", "pass"],
    ]);
  });

  it("completes a candidate that serves the owner and refuses everyone else", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("invoices.mjs", secure);
    const result = await probe.verify([derived], { behavior: [ownership()] });
    expect(result.requirements[0]).toMatchObject({ status: "satisfied", witness: "independent" });
    expect(result.state).toBe("complete");
    checksOffline(result);
  });

  it("is not moved by a candidate that prints a passing report of its own", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    const forged = JSON.stringify({
      ready: true,
      cases: ownership().cases.map((one) => ({ name: one.name, status: "pass", detail: "" })),
    });
    await probe.put("invoices.mjs", insecure);
    await probe.put("server.mjs", server(`console.log(${JSON.stringify(forged)});`));
    const result = await probe.verify([derived], { behavior: [ownership()] });
    expect(result.requirements[0]?.status).toBe("failed");
  });

  it("leaves the requirement unverified when the target never answers, whatever it prints", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("invoices.mjs", secure);
    await probe.put("server.mjs", 'console.log("all cases pass");\nsetInterval(() => {}, 1000);\n');
    const check = ownership();
    const result = await probe.verify([derived], {
      behavior: [{ ...check, target: { ...check.target, ready: { timeoutMs: 2000 } } }],
    });
    expect(result.requirements[0]?.status).toBe("unverified");
    expect(result.state).toBe("incomplete");
    expect(result.reasons.join("\n")).toMatch(
      /behavior check ownership was not measured: its target did not answer on port \d+ within 2 s/,
    );
  });
});

describe("a behavior check in a verification, in containers", () => {
  const isolated = { mode: "isolated", dependencies: "prepare", network: "closed" } as const;

  it("judges the candidate from a driver in a container of its own", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("invoices.mjs", secure);
    const result = await probe.verify([derived], { ...isolated, behavior: [ownership()] });
    expect(result.behavior[0]).toMatchObject({
      assurance: "external driver, isolated target",
      notRun: null,
    });
    expect(result.requirements[0]?.status).toBe("satisfied");
    expect(result.state).toBe("complete");
    // The signed record holds the check itself, so a replay drives the same cases again.
    const replayed = await replay(dirname(result.evidence.bundle ?? ""), {
      repository: probe.repo,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
      signer: fixtureSigner(),
    });
    expect(replayed.divergences).toEqual([]);
    expect(replayed.replayed.behavior[0]?.cases.map((one) => one.candidate)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("is not moved by a candidate that tries to rewrite the driver and its scenario", async () => {
    const probe = await probeFixture(files, "node --test", parent);
    const tamper = `import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const dir = join(dirname(process.cwd()), "behavior");
for (const name of readdirSync(dir)) {
  try {
    writeFileSync(join(dir, name), name.endsWith(".json") ? '{"ready":{"path":"/","timeoutMs":1000},"cases":[]}' : 'console.log(JSON.stringify({ready:true,cases:[]}))');
    console.log("rewrote " + name);
  } catch (error) {
    console.log("could not write " + name + ": " + error.code);
  }
}`;
    await probe.put("invoices.mjs", insecure);
    await probe.put("server.mjs", server(tamper));
    const result = await probe.verify([derived], { ...isolated, behavior: [ownership()] });
    expect(result.requirements[0]?.status).toBe("failed");
    expect(result.behavior[0]?.cases.find((one) => one.candidate === "fail")?.name).toBe(
      "another user is refused",
    );
  });
});
