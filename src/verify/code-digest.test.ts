import { describe, expect, it } from "vitest";
import { baselineKey, codeSha256 } from "./code-digest.ts";

describe("what a cached base run is keyed by", () => {
  const key = {
    baseCommit: "a".repeat(40),
    environmentSha256: "b".repeat(64),
    sealedSha256: null,
    codeSha256: "c".repeat(64),
    policySha256: "f".repeat(64),
  };

  it("changes with the verifier's own code, so a base read by other code is run again", () => {
    expect(baselineKey(key)).not.toBe(baselineKey({ ...key, codeSha256: "d".repeat(64) }));
    expect(baselineKey(key)).not.toBe(baselineKey({ ...key, baseCommit: "e".repeat(40) }));
    expect(baselineKey(key)).toBe(baselineKey({ ...key }));
  });

  it("changes with the execution policy, setup and timeout the base ran under", () => {
    expect(baselineKey(key)).not.toBe(baselineKey({ ...key, policySha256: "0".repeat(64) }));
    expect(baselineKey(key)).not.toBe(baselineKey({ ...key, sealedSha256: "1".repeat(64) }));
    expect(baselineKey(key)).not.toBe(baselineKey({ ...key, environmentSha256: "2".repeat(64) }));
  });

  it("digests this build's code once, as a sha256", () => {
    expect(codeSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
