import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executableOnPath } from "./executable.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "executable-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function program(dir: string, mode = 0o755): Promise<string> {
  await mkdir(dir, { recursive: true });
  const full = join(dir, "tool");
  await writeFile(full, "#!/bin/sh\n");
  await chmod(full, mode);
  return full;
}

describe("executableOnPath", () => {
  it("finds the first executable in an absolute entry", async () => {
    const second = await program(join(root, "b"));
    await program(join(root, "a"), 0o644);
    expect(await executableOnPath("tool", [join(root, "a"), join(root, "b")].join(delimiter))).toBe(
      second,
    );
  });

  it("skips empty and relative entries, which resolve against the working directory", async () => {
    await program(join(root, "rel"));
    const relativeEntry = relative(process.cwd(), join(root, "rel"));
    expect(await executableOnPath("tool", ["", ".", relativeEntry].join(delimiter))).toBeNull();
  });

  it("finds nothing without a PATH", async () => {
    expect(await executableOnPath("tool", undefined)).toBeNull();
  });
});
