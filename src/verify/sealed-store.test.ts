import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeSealed, sealedSchema } from "./sealed-store.ts";

const set = (path: string) => ({
  glob: path,
  checks: [{ name: "held", command: "node --test", kind: "test" as const }],
  files: [{ path, sha256: "0".repeat(64) }],
});

describe("a sealed set read from a bundle", () => {
  it("refuses paths that leave the repository", () => {
    for (const path of ["../outside.mjs", "a/../../outside.mjs", "/etc/outside.mjs"])
      expect(sealedSchema.safeParse(set(path)).success).toBe(false);
    expect(sealedSchema.safeParse(set("acceptance/held.mjs")).success).toBe(true);
  });

  it("places nothing outside the home it is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "place-sealed-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const home = join(root, "home");
      const forged = { ...set("x.mjs"), files: [{ path: "../../../escape.mjs", sha256: "" }] };
      await expect(
        placeSealed(root, home, forged as never, new Map([["../../../escape.mjs", "marker"]])),
      ).rejects.toThrow(/leaves the repository/);
      expect(await readdir(root)).not.toContain("escape.mjs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
