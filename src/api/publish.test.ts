import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFromText } from "../verify/signing.ts";
import { publishEvidence } from "./publish.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "publish-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const key = keyFromText(
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  "environment",
);
const input = (directory: string, marker: string) => ({
  directory,
  statement: { _type: "https://in-toto.io/Statement/v1", subject: [], marker },
  patch: Buffer.from(`patch ${marker}\n`),
  logs: [{ name: "logs/test.txt", text: `log ${marker}\n` }],
  sigstore: false,
  signing: "required" as const,
  resolveKey: async () => ({ key, notice: null }),
});

describe("publishing a run's evidence", () => {
  it("binds every file of the run in its manifest", async () => {
    const delivered = await publishEvidence(input(join(root, "run"), "a"));
    expect(delivered.status).toBe("signed");
    const manifest = JSON.parse(await readFile(delivered.manifest ?? "", "utf8"));
    expect(manifest.runId).toBe(delivered.runId);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      "attestation.pub.pem",
      "attestation.sigstore.json",
      "change.patch",
      "logs/test.txt",
      "statement.json",
    ]);
  });

  it("lets exactly one of two concurrent runs publish to one directory", async () => {
    const target = join(root, "shared");
    const both = await Promise.all([
      publishEvidence(input(target, "a")),
      publishEvidence(input(target, "b")),
    ]);
    const kept = both.filter((one) => one.status === "signed");
    expect(kept).toHaveLength(1);
    expect(both.filter((one) => one.status === "failed")).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.runId).toBe(kept[0]?.runId);
    expect((await readdir(root)).filter((name) => name.includes("staging"))).toEqual([]);
  });

  it("leaves nothing at the target, and no staging, when a run fails while it is written", async () => {
    const target = join(root, "interrupted");
    const broken = { ...input(target, "a"), logs: [{ name: "../outside.txt", text: "x" }] };
    await expect(publishEvidence(broken)).rejects.toThrow(/leaves the repository/);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a directory that already holds a run and leaves it as it was", async () => {
    const target = join(root, "held");
    const first = await publishEvidence(input(target, "a"));
    const second = await publishEvidence(input(target, "b"));
    expect(second.status).toBe("failed");
    expect(second.problems[0]).toMatch(/already holds evidence/);
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.runId).toBe(first.runId);
  });
});
