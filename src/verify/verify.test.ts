import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleOf, envelopeOf, envelopeVerifies, pae, signStatement } from "./dsse.ts";
import { globPattern } from "./held-out.ts";
import { mutateLine, parses } from "./mutation.ts";
import { artifactsOf, categoryOf } from "./paths.ts";
import { keyFromText } from "./signing.ts";

describe("candidate artifact categories", () => {
  it.each([
    ["test/clamp.test.mjs", "tests"],
    ["src/clamp.spec.ts", "tests"],
    ["pkg/tests/helpers.py", "tests"],
    ["test_clamp.py", "tests"],
    ["conftest.py", "tests"],
    ["vitest.config.ts", "tests"],
    [".github/workflows/ci.yml", "ci"],
    ["package-lock.json", "lockfiles"],
    ["uv.lock", "lockfiles"],
    ["package.json", "manifests"],
    ["swarm.toml", "config"],
    [".swarm/verify/change.patch", "config"],
    // Startup hooks decide what loads before the judge of a held-out check.
    [".npmrc", "config"],
    ["sitecustomize.py", "config"],
    ["lib/site-packages/hook.pth", "config"],
  ])("puts %s in %s", (path, category) => {
    expect(categoryOf(path)).toBe(category);
  });

  it("treats ordinary source as source", () => {
    expect(categoryOf("src/clamp.mjs")).toBeNull();
    expect(categoryOf("lib/testing-utils-free.js")).toBeNull();
  });

  it("names every changed path's kind and refuses none of them", () => {
    expect(artifactsOf(["src/a.js", "test/a.test.js", "package-lock.json"])).toEqual([
      { path: "src/a.js", category: "source" },
      { path: "test/a.test.js", category: "tests" },
      { path: "package-lock.json", category: "lockfiles" },
    ]);
  });
});

describe("one mutant per line", () => {
  it("flips the first comparison it finds", () => {
    expect(mutateLine("  if (a === b) return 1;")).toEqual({
      text: "  if (a !== b) return 1;",
      operator: "=== to !==",
    });
  });

  it("leaves operators inside strings and comments alone", () => {
    expect(mutateLine('  const label = "a && b"; // x || y')).toBeNull();
  });

  it("swaps min and max, and bumps a literal", () => {
    expect(mutateLine("  return Math.min(high, value);")?.text).toBe(
      "  return Math.max(high, value);",
    );
    expect(mutateLine("  const size = 8;")?.text).toBe("  const size = 9;");
  });

  it("drops a returned value as a last resort, in the file's language", () => {
    expect(mutateLine("  return value")?.text).toBe("  return undefined");
    expect(mutateLine("    return value", true)?.text).toBe("    return None");
  });

  it("keeps the statement's end, so a one-line function still parses", () => {
    // The review's probe: dropping through the closing brace made this unparsable.
    expect(mutateLine("export function half(n) { return divide(n); }")?.text).toBe(
      "export function half(n) { return undefined; }",
    );
  });

  it("does not mutate imports or lines without an operator", () => {
    expect(mutateLine('import { a } from "./a.js";')).toBeNull();
    expect(mutateLine("  doThing(value);")).toBeNull();
  });
});

const pem = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const key = keyFromText(pem, "environment");
const statement = { _type: "https://in-toto.io/Statement/v1", subject: [], predicate: {} };

describe("whether a mutant parses", () => {
  it("checks JavaScript, TypeScript and Python without running them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "parses-"));
    const written = async (path: string, text: string) => {
      await writeFile(join(dir, path), text);
      return parses(path, text, dir);
    };
    expect(await written("a.mjs", "export const half = (n) => n / 2;\n")).toBe(true);
    expect(await written("b.mjs", "export function half(n) { return undefined;\n")).toBe(false);
    expect(await written("c.py", "def half(n):\n    return n / 2\n")).toBe(true);
    expect(await written("d.py", "def half(n):\n    return (n / 2\n")).toBe(false);
    expect(await parses("a.ts", "export function half(n: number) { return undefined;\n", dir)).toBe(
      false,
    );
    expect(
      await parses("a.ts", "export function half(n: number): number { return n / 2; }\n", dir),
    ).toBe(true);
  });
});

describe("DSSE envelopes", () => {
  it("encodes the pre-authentication string as the specification spells it", () => {
    expect(pae("t", Buffer.from("ab")).toString()).toBe("DSSEv1 1 t 2 ab");
  });

  it("verifies a signed statement against the signer's public key", () => {
    const envelope = signStatement(statement, key);
    expect(envelopeVerifies(envelope, key.publicKeyPem)).toBe(true);
    expect(JSON.parse(Buffer.from(envelope.payload, "base64").toString())).toEqual(statement);
  });

  it("refuses the envelope after one byte of its payload changes", () => {
    const envelope = signStatement(statement, key);
    const bytes = Buffer.from(envelope.payload, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(
      envelopeVerifies({ ...envelope, payload: bytes.toString("base64") }, key.publicKeyPem),
    ).toBe(false);
  });

  it("refuses it under another key", () => {
    const other = keyFromText(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "environment",
    );
    expect(envelopeVerifies(signStatement(statement, key), other.publicKeyPem)).toBe(false);
  });

  it("reads the envelope out of a bundle or on its own", () => {
    const envelope = signStatement(statement, key);
    expect(envelopeOf(bundleOf(envelope, key))).toEqual(envelope);
    expect(envelopeOf(envelope)).toEqual(envelope);
    expect(envelopeOf({ payload: "x" })).toBeNull();
  });
});

describe("sealing globs", () => {
  it("lets ** cross directories and * stay inside one", () => {
    expect(globPattern("tests/hidden/**").test("tests/hidden/a/b.py")).toBe(true);
    expect(globPattern("**/*.hidden.js").test("a/b/c.hidden.js")).toBe(true);
    expect(globPattern("**/*.hidden.js").test("c.hidden.js")).toBe(true);
    expect(globPattern("tests/*.py").test("tests/a/b.py")).toBe(false);
  });

  it("matches dots literally", () => {
    expect(globPattern("a.py").test("abpy")).toBe(false);
  });
});
