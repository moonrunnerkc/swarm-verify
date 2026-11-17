import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtureSigner, halfTest, probeFixture, requirement } from "../probes/fixture.ts";
import { bundleOf, signStatement } from "../verify/dsse.ts";
import { keyFromText } from "../verify/signing.ts";
import { UnauthenticatedBundleError } from "./bundle-auth.ts";
import { replay, UnreplayableBundleError } from "./replay.ts";
import type { VerifyResult } from "./result.ts";

let markers = "";
let recorded: { readonly result: VerifyResult; readonly repo: string; readonly home: string };
const savedPath = process.env.PATH;

beforeAll(async () => {
  const probe = await probeFixture({
    "half.mjs": "export const half = n => n;\n",
    "test/half.test.mjs": halfTest,
  });
  await probe.put("half.mjs", "export const half = n => n / 2;\n");
  const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
  const result = await probe.verify([fix], { mode: "host", dependencies: "prepare" });
  expect(result.state).toBe("complete");
  recorded = { result, repo: probe.repo, home: probe.home };
});
beforeEach(async () => {
  markers = await mkdtemp(join(tmpdir(), "replay-auth-markers-"));
});
afterEach(async () => {
  await rm(markers, { recursive: true, force: true });
  process.env.PATH = savedPath;
});

const bundleDir = () => dirname(recorded.result.evidence.bundle ?? "");

/** A copy of the recorded evidence directory with its bundle replaced. */
async function withBundle(document: unknown, publicKey?: string): Promise<string> {
  const copy = await mkdtemp(join(tmpdir(), "replay-auth-bundle-"));
  await writeFile(join(copy, "change.patch"), await readFile(join(bundleDir(), "change.patch")));
  await writeFile(join(copy, "attestation.sigstore.json"), JSON.stringify(document));
  if (publicKey !== undefined) await writeFile(join(copy, "attestation.pub.pem"), publicKey);
  return copy;
}

/** The recorded statement with a user-acceptance check that leaves a marker when it runs. */
async function injected(): Promise<{
  readonly document: Record<string, unknown>;
  readonly statement: unknown;
}> {
  const document = JSON.parse(await readFile(recorded.result.evidence.bundle ?? "", "utf8"));
  const envelope = document.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  const first = statement.predicate.checks[0];
  statement.predicate.checks.push({
    ...first,
    name: "injected",
    kind: "other",
    authority: "user-acceptance",
    command: `touch ${JSON.stringify(join(markers, "injected-ran"))}`,
  });
  return { document, statement };
}

const options = (signer = fixtureSigner(), allowHost = true) => ({
  repository: recorded.repo,
  out: join(recorded.home, `replay-${Date.now()}-${Math.random()}`),
  verifierVersion: "probe",
  swarmHome: recorded.home,
  signer,
  allowHost,
});

// F3 (2026-11-17 review): replay decoded the statement without authenticating its envelope, and a
// command added to it ran although the original signature no longer covered it.
describe("replaying a bundle that is not authenticated", () => {
  it("refuses a changed payload under the original signature and runs nothing", async () => {
    const { document, statement } = await injected();
    const envelope = document.dsseEnvelope as { payload: string };
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    const copy = await withBundle(document);
    const outcome = await replay(copy, options()).then(
      () => "replayed",
      (error: unknown) => error,
    );
    expect(await readdir(markers)).toEqual([]);
    expect(outcome).toBeInstanceOf(UnauthenticatedBundleError);
  });

  it("refuses a bundle signed by a key the caller does not trust, with that key beside it", async () => {
    const { statement } = await injected();
    const pem = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const attacker = keyFromText(pem, "per-run");
    const copy = await withBundle(
      bundleOf(signStatement(statement, attacker), attacker),
      attacker.publicKeyPem,
    );
    const outcome = await replay(copy, options()).then(
      () => "replayed",
      (error: unknown) => error,
    );
    expect(await readdir(markers)).toEqual([]);
    expect(String(outcome)).toMatch(/no signature verifies/);
  });

  it("refuses a trusted key that is not a public key", async () => {
    const signer = { kind: "key" as const, publicKeys: ["not a key"] };
    await expect(replay(bundleDir(), options(signer))).rejects.toThrow(/not a valid PEM/);
  });

  it("refuses a keyless policy when cosign is unavailable or does not verify", async () => {
    const keyless = {
      kind: "keyless" as const,
      identity: "https://github.com/someone/else/.github/workflows/x.yml@refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
    };
    process.env.PATH = markers;
    await expect(replay(bundleDir(), options(keyless))).rejects.toThrow(/cosign is not on PATH/);
    const failing = join(markers, "bin");
    await mkdir(failing);
    await writeFile(
      join(failing, "cosign"),
      "#!/bin/sh\necho 'none of the expected identities matched' >&2\nexit 1\n",
    );
    await chmod(join(failing, "cosign"), 0o755);
    process.env.PATH = `${failing}:${savedPath ?? ""}`;
    await expect(replay(bundleDir(), options(keyless))).rejects.toThrow(
      /cosign did not verify it for https:\/\/github.com\/someone\/else/,
    );
  });

  it("does not run a host recording unless the caller allows the host", async () => {
    await expect(replay(bundleDir(), options(fixtureSigner(), false))).rejects.toBeInstanceOf(
      UnreplayableBundleError,
    );
    await expect(replay(bundleDir(), options(fixtureSigner(), false))).rejects.toThrow(
      /authorize that explicitly/,
    );
  });
});
