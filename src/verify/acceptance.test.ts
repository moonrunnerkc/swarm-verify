import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptancePolicy,
  acceptedState,
  recordProblems,
  requirementSupported,
} from "./acceptance.ts";
import { judgedPredicate } from "./assess.ts";
import { bundleOf, signStatement } from "./dsse.ts";
import type { Predicate } from "./predicate.ts";
import { predicateType } from "./predicate.ts";
import { keyFromText } from "./signing.ts";

interface Case {
  readonly name: string;
  readonly predicate: Record<string, unknown>;
  readonly expected: {
    readonly state: string;
    readonly unsupported: readonly string[];
    readonly problems: boolean;
  };
}
const fixtures = JSON.parse(
  await readFile(join(import.meta.dirname, "fixtures", "acceptance", "cases.json"), "utf8"),
) as { readonly template: Record<string, unknown>; readonly cases: readonly Case[] };
const recorded = (one: Case): Record<string, unknown> => ({
  ...fixtures.template,
  ...one.predicate,
});

const checker = resolve(import.meta.dirname, "..", "..", "verify.mjs");
const key = keyFromText(
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "environment",
);
let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "acceptance-"));
  await writeFile(join(dir, "key.pem"), key.publicKeyPem);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each(fixtures.cases)("acceptance of $name", (one) => {
  it("is judged as specified by the shared rule", () => {
    const predicate = recorded(one) as {
      state: string;
      requirements: { id: string; status: string }[];
    };
    const state = predicate.state === "blocked" ? "blocked" : acceptedState(predicate);
    expect(state).toBe(one.expected.state);
    const unsupported = predicate.requirements
      .filter((req) => req.status === "satisfied" && !requirementSupported(req, predicate))
      .map((req) => req.id);
    expect(unsupported).toEqual(one.expected.unsupported);
    expect(recordProblems(predicate).length > 0).toBe(one.expected.problems);
  });

  it("is judged as specified by the live verifier", () => {
    const draft = { reasons: [], ...recorded(one) } as unknown as Predicate;
    const judged = judgedPredicate(draft, draft.state === "blocked");
    // The live verifier judges under its own policy and records that; a foreign policy is a
    // question only for a record being read.
    expect(judged.policy.acceptance).toBe(acceptancePolicy);
    if (draft.policy.acceptance !== acceptancePolicy) return;
    expect(judged.state).toBe(one.expected.state);
    const downgraded = judged.requirements
      .filter(
        (req, at) => draft.requirements[at]?.status === "satisfied" && req.status !== "satisfied",
      )
      .map((req) => req.id);
    expect(downgraded).toEqual(one.expected.unsupported);
  });

  it("is judged as specified by verify.mjs over a signed statement", async () => {
    const predicate = recorded(one) as { state: string };
    const patch = Buffer.from("patch\n");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "change.patch",
          digest: { sha256: createHash("sha256").update(patch).digest("hex") },
        },
      ],
      predicateType,
      predicate,
    };
    const bundle = join(dir, `${one.name.replace(/\W+/g, "-")}.json`);
    await writeFile(bundle, JSON.stringify(bundleOf(signStatement(statement, key), key)));
    const ran = spawnSync(process.execPath, [checker, bundle, "--key", join(dir, "key.pem")], {
      encoding: "utf8",
    });
    const consistent =
      one.expected.state === predicate.state &&
      one.expected.unsupported.length === 0 &&
      !one.expected.problems;
    expect(ran.stdout).toMatch(consistent ? /^ok\s+state/m : /^FAILED/m);
    expect(ran.status).toBe(!consistent ? 6 : predicate.state === "complete" ? 0 : 1);
  });
});
