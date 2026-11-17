import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContainmentError, entryAt, readContained, writeContained } from "./contained.ts";

let root = "";
let outside = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "contained-root-"));
  outside = await mkdtemp(join(tmpdir(), "contained-outside-"));
  await writeFile(join(outside, "secret.txt"), "harmless outside marker");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const reason = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ContainmentError) return error.reason;
    throw error;
  }
  return "none";
};

describe("writeContained", () => {
  it("writes a nested regular file under the root", async () => {
    await writeContained(root, "tests/held/a.test.ts", "ok");
    expect(await readFile(join(root, "tests/held/a.test.ts"), "utf8")).toBe("ok");
  });

  it("refuses a parent directory that is a symbolic link out of the root", async () => {
    await symlink(outside, join(root, "tests"), "dir");
    expect(await reason(writeContained(root, "tests/secret.txt", "overwritten"))).toBe("symlink");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("harmless outside marker");
  });

  it("replaces a leaf symbolic link instead of writing through it", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
    await writeContained(root, "leaf.txt", "placed");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("harmless outside marker");
    expect((await lstat(join(root, "leaf.txt"))).isFile()).toBe(true);
  });

  it("replaces a broken leaf link without creating its target", async () => {
    await symlink(join(outside, "made-by-link.txt"), join(root, "broken.txt"));
    await writeContained(root, "broken.txt", "placed");
    expect(await lstat(join(outside, "made-by-link.txt")).catch(() => null)).toBeNull();
  });

  it("refuses traversal, absolute paths and empty paths", async () => {
    expect(await reason(writeContained(root, "../escape.txt", "x"))).toBe("traversal");
    expect(await reason(writeContained(root, "a/../../escape.txt", "x"))).toBe("traversal");
    expect(await reason(writeContained(root, join(outside, "x.txt"), "x"))).toBe("absolute");
    expect(await reason(writeContained(root, "", "x"))).toBe("empty");
  });

  it("refuses a file where a directory belongs", async () => {
    await writeFile(join(root, "tests"), "a file");
    expect(await reason(writeContained(root, "tests/a.txt", "x"))).toBe("not-a-directory");
  });
});

describe("readContained and entryAt", () => {
  it("reads a regular file and reports a missing one as absent", async () => {
    await writeContained(root, "src/a.py", "x = 1\n");
    expect((await readContained(root, "src/a.py"))?.toString()).toBe("x = 1\n");
    expect(await readContained(root, "src/b.py")).toBeNull();
    expect(await entryAt(root, "missing/dir/b.py")).toEqual({ kind: "absent" });
  });

  it("does not follow a leaf or parent link to a file outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leaf.txt"));
    await symlink(outside, join(root, "parent"), "dir");
    expect(await reason(readContained(root, "leaf.txt"))).toBe("symlink");
    expect(await reason(readContained(root, "parent/secret.txt"))).toBe("symlink");
  });

  it("reports a directory, not absence, and a broken link as a link", async () => {
    await mkdir(join(root, "pkg"));
    await symlink(join(outside, "nothing"), join(root, "broken"));
    expect((await entryAt(root, "pkg")).kind).toBe("directory");
    expect((await entryAt(root, "broken")).kind).toBe("symlink");
    expect(await reason(readContained(root, "pkg"))).toBe("not-a-file");
  });

  it.skipIf(process.getuid?.() === 0)(
    "throws a permission failure instead of reading it as absence",
    async () => {
      await mkdir(join(root, "locked"), { mode: 0o000 });
      try {
        await expect(entryAt(root, "locked/a.txt")).rejects.toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(join(root, "locked"), 0o700);
      }
    },
  );
});
