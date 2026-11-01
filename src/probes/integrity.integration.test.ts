import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { VerifyResult } from "../api/result.ts";
import { seal, sealedDirectory } from "../verify/held-out.ts";
import { halfTest, probeFixture } from "./fixture.ts";

/**
 * The evidence and execution boundary under attack: each case either fails the check or takes
 * the result's assurance away. None of them may leave a complete, intact-looking result.
 */
const checker = join(import.meta.dirname, "..", "..", "verify.mjs");
// Apart for each test process: afterAll removes it, and other checkouts may run at once.
const parent = join(homedir(), ".swarm", "test-work-integrity", `${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const check = (result: VerifyResult, ...extra: string[]) =>
  spawnSync(
    process.execPath,
    [checker, result.evidence.bundle ?? "", "--key", result.evidence.publicKey ?? "", ...extra],
    { encoding: "utf8" },
  );
const fixed = async (producer = {}) => {
  const probe = await probeFixture({
    "half.mjs": "export const half = n => n;\n",
    "test/half.test.mjs": halfTest,
  });
  await probe.put("half.mjs", "export const half = n => n / 2;\n");
  return { probe, result: await probe.verify([], {}, producer) };
};

describe("tampering with the oracle and the evidence", () => {
  it("blocks on a sealed held-out file altered after sealing", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("test/hidden/edge.test.mjs", halfTest.replace("half positive", "hidden"));
    await seal(
      probe.repo,
      "test/hidden/**",
      [{ name: "test", command: "node --test", kind: "test" }],
      probe.home,
    );
    const store = join(
      await sealedDirectory(probe.repo, probe.home),
      "files",
      "test",
      "hidden",
      "edge.test.mjs",
    );
    await writeFile(store, "import {test} from 'node:test';\ntest('hidden', () => {});\n");
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify();
    expect(result.state).toBe("blocked");
    expect(result.reasons[0]).toMatch(
      /sealed held-out files changed after they were sealed: test\/hidden\/edge\.test\.mjs/,
    );
  });

  it("refuses a report that states other than what was signed", async () => {
    const { result } = await fixed();
    const report = join(result.evidence.directory, "report.json");
    const honest = {
      snapshot: { patchSha256: result.snapshot.patchSha256 },
      state: result.state,
      requirements: [],
    };
    await writeFile(report, JSON.stringify(honest));
    expect(check(result, "--report", report).status).toBe(0);
    await writeFile(
      report,
      JSON.stringify({ ...honest, state: result.state === "complete" ? "incomplete" : "complete" }),
    );
    const forged = check(result, "--report", report);
    expect(forged.stdout).toContain("FAILED report");
    expect(forged.status).toBe(6);
  });

  it("refuses an attestation of an earlier patch for the delivered one", async () => {
    const { probe, result: earlier } = await fixed();
    await probe.put("half.mjs", "export const half = n => n * 0.5;\n");
    const later = await probe.verify();
    const stale = check(earlier, "--patch", later.evidence.patch ?? "");
    expect(stale.stdout).toContain("FAILED patch");
    expect(stale.status).toBe(6);
  });

  it("refuses a ledger truncated below the records the statement bound", async () => {
    const lines = ["one", "two", "three", "four"].map((word) => JSON.stringify({ record: word }));
    const bound = lines
      .slice(0, 3)
      .map((line) => `${line}\n`)
      .join("");
    const { result } = await fixed({ ledgerSha256: sha256(bound), ledgerRecords: 3 });
    const ledger = join(result.evidence.directory, "ledger.jsonl");
    await writeFile(ledger, lines.map((line) => `${line}\n`).join(""));
    expect(check(result, "--ledger", ledger).status).toBe(0);
    await writeFile(
      ledger,
      lines
        .slice(0, 2)
        .map((line) => `${line}\n`)
        .join(""),
    );
    const truncated = check(result, "--ledger", ledger);
    expect(truncated.stdout).toContain("FAILED ledger");
    expect(truncated.status).toBe(6);
  });

  it("refuses evidence logs changed after signing", async () => {
    const { result } = await fixed();
    expect(check(result, "--evidence", result.evidence.directory).status).toBe(0);
    const logs = await readdir(join(result.evidence.directory, "logs"));
    await writeFile(join(result.evidence.directory, "logs", logs[0] ?? ""), "all tests passed\n");
    expect(check(result, "--evidence", result.evidence.directory).status).toBe(6);
  });

  it("refuses a signature under any key but the signer's", async () => {
    const { result } = await fixed();
    const other = join(result.evidence.directory, "other.pub.pem");
    await writeFile(
      other,
      generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const ran = spawnSync(
      process.execPath,
      [checker, result.evidence.bundle ?? "", "--key", other],
      { encoding: "utf8" },
    );
    expect(ran.stdout).toContain("FAILED signature");
    expect(ran.status).toBe(6);
  });

  it("refuses linked, mutable dependencies in isolation rather than running on them", async () => {
    const probe = await probeFixture(
      { "half.mjs": "export const half = n => n;\n", "test/half.test.mjs": halfTest },
      "node --test",
      parent,
    );
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "linked",
      network: "closed",
    });
    expect(result.state).toBe("blocked");
    expect(result.reasons[0]).toMatch(/linked dependencies cannot be used in isolation/);
  });
});

describe("candidate code against the verifier's own paths, in a container", () => {
  it("cannot write the judge, cannot see the verifier's home, and loses assurance by rewriting itself", async () => {
    const attack = `import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
const judge = /file:\\/\\/([^"\\s]+judge\\.mjs)/.exec(process.env.NODE_OPTIONS ?? '')?.[1];
const attempt = (what, path) => { try { writeFileSync(path, 'export {};'); console.log(what + ': written'); } catch (error) { console.log(what + ': ' + error.code); } };
test('attacks', () => {
  attempt('judge', judge);
  attempt('verifier home', '${join(homedir(), ".swarm", "baselines", "planted.json")}');
  attempt('own source', new URL('../half.mjs', import.meta.url).pathname);
});
`;
    const manifest = '{"name":"fixture","version":"1.0.0","type":"module","private":true}\n';
    const files = {
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
      "package.json": manifest,
    };
    const probe = await probeFixture(files, "node --test", parent);
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    await probe.put("test/attack.test.mjs", attack);
    const result = await probe.verify([], {
      mode: "isolated",
      dependencies: "prepare",
      network: "closed",
    });
    const log = await readFile(join(result.evidence.directory, "logs", "test.txt"), "utf8");
    expect(log).toContain("judge: EROFS");
    expect(log).toContain("verifier home: ENOENT");
    expect(log).toContain("own source: written");
    expect(result.execution.policyMet).toBe(false);
    expect(result.execution.problems.join("\n")).toMatch(
      /check test rewrote tracked files during the candidate run/,
    );
    expect(result.state).not.toBe("complete");
  });
});
