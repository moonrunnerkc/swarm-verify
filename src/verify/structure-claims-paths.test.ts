import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { structureEvidence } from "./structure-claims.ts";

const marker = "harmless outside marker 7f3a";
let dir = "";
let outside = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claim-paths-"));
  outside = await mkdtemp(join(tmpdir(), "claim-outside-"));
  await writeFile(join(outside, "secret.txt"), `${marker}\n`);
  await writeFile(join(outside, "secret.py"), `outside_name = "${marker}"\n`);
  await writeFile(join(outside, "secret.ts"), `export const outsideName = "${marker}";\n`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

type Claim = Parameters<typeof structureEvidence>[1];
const judge = (claim: Claim) => structureEvidence(dir, claim);
const notSatisfied = (ref: { outcome: string; detail?: string | undefined }) => {
  expect(ref.outcome).not.toBe("observed");
  expect(ref.detail ?? "").not.toContain(marker);
};

describe("a text claim reads only what the checkout itself holds", () => {
  it("does not take a directory for the absence an absent claim asks for", async () => {
    await mkdir(join(dir, "src", "old"), { recursive: true });
    const ref = await judge({ path: "src/old", absent: true });
    notSatisfied(ref);
    expect(ref.detail).toMatch(/src\/old is a directory/);
  });

  it("does not take a broken symbolic link for absence", async () => {
    await symlink(join(dir, "nowhere"), join(dir, "gone.py"));
    const ref = await judge({ path: "gone.py", absent: true });
    notSatisfied(ref);
    expect(ref.detail).toMatch(/gone\.py is a symbolic link/);
  });

  it("does not follow a symbolic link out of the checkout to show a file exists or holds a text", async () => {
    await symlink(join(outside, "secret.txt"), join(dir, "notes.txt"));
    for (const claim of [
      { path: "notes.txt" },
      { path: "notes.txt", contains: "harmless" },
      { path: "notes.txt", contains: "absent text", absent: true },
    ]) {
      const ref = await judge(claim);
      notSatisfied(ref);
      expect(ref.detail).toMatch(/symbolic link/);
    }
  });

  it("does not follow a linked directory on the way to the file", async () => {
    await symlink(outside, join(dir, "docs"), "dir");
    const ref = await judge({ path: "docs/secret.txt", contains: "harmless" });
    notSatisfied(ref);
    expect(ref.detail).toMatch(/docs\/secret\.txt goes through a symbolic link/);
    notSatisfied(await judge({ path: "docs/secret.txt", absent: true }));
  });

  it("refuses a path that leaves the checkout or is absolute, whatever the claim", async () => {
    for (const path of ["../x", "src/../../x", join(outside, "secret.txt")]) {
      for (const claim of [{ path }, { path, absent: true }, { path, contains: "marker" }]) {
        const ref = await judge(claim);
        notSatisfied(ref);
        expect(ref.detail).toMatch(/is absolute|leaves the repository/);
      }
    }
  });

  it("still reads real absence as absence", async () => {
    expect((await judge({ path: "src/never.py", absent: true })).outcome).toBe("observed");
    expect((await judge({ path: "src/never.py" })).outcome).toBe("not observed");
  });
});

describe("a symbol claim reads only what the checkout itself holds", () => {
  it("does not read a module linked out of the checkout, in either language", async () => {
    await symlink(join(outside, "secret.py"), join(dir, "mod.py"));
    await symlink(join(outside, "secret.ts"), join(dir, "mod.ts"));
    for (const claim of [
      { path: "mod.py", symbol: "outside_name" },
      { path: "mod.py", symbol: "outside_name", provides: true },
      { path: "mod.py", symbol: "other", absent: true },
      { path: "mod.ts", symbol: "outsideName", provides: true },
      { path: "mod.ts", symbol: "other", absent: true },
    ]) {
      const ref = await judge(claim);
      notSatisfied(ref);
      expect(ref.detail).toMatch(/symbolic link/);
    }
  });

  it("does not take a directory where the module was for the module being gone", async () => {
    await mkdir(join(dir, "mod.py"));
    notSatisfied(await judge({ path: "mod.py", symbol: "f", absent: true }));
  });

  it("does not follow an import * or export * through a link out of the checkout", async () => {
    await symlink(join(outside, "secret.py"), join(dir, "inner.py"));
    await writeFile(join(dir, "outer.py"), "from .inner import *\n");
    await symlink(join(outside, "secret.ts"), join(dir, "inner.ts"));
    await writeFile(join(dir, "outer.ts"), 'export * from "./inner.js";\n');
    for (const claim of [
      { path: "outer.py", symbol: "outside_name", provides: true },
      { path: "outer.ts", symbol: "outsideName", provides: true },
    ]) {
      const ref = await judge(claim);
      notSatisfied(ref);
      expect(ref.detail).toMatch(/inner/);
    }
  });

  it("refuses a module path that leaves the checkout or is absolute", async () => {
    for (const path of ["../m.py", join(outside, "secret.py"), "../m.ts"]) {
      const ref = await judge({ path, symbol: "f", absent: true });
      notSatisfied(ref);
      expect(ref.detail).toMatch(/is absolute|leaves the repository/);
    }
  });
});
