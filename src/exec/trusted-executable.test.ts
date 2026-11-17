import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustedExecutable } from "./trusted-executable.ts";

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("trustedExecutable", () => {
  it("skips relative and empty PATH entries", async () => {
    dir = await mkdtemp(join(tmpdir(), "trusted-exe-"));
    await writeFile(join(dir, "tool"), "#!/bin/sh\n");
    await chmod(join(dir, "tool"), 0o755);
    expect(await trustedExecutable("tool", `.:bin::${dir}`)).toBe(join(dir, "tool"));
    expect(await trustedExecutable("tool", ".:bin:")).toBeNull();
  });

  it("skips a file that is not executable", async () => {
    dir = await mkdtemp(join(tmpdir(), "trusted-exe-"));
    await writeFile(join(dir, "tool"), "#!/bin/sh\n");
    expect(await trustedExecutable("tool", dir)).toBeNull();
  });
});
