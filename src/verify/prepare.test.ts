import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installScripts, lockfileInstall } from "./prepare.ts";

describe("installing from a lockfile", () => {
  it("runs npm's install scripts one at a time, so native builds do not race", async () => {
    // Parallel node-gyp builds of three tree-sitter grammars failed six times in seven in the
    // pinned node:24 image, and never with --foreground-scripts (ruleprobe, 2026-11-01).
    for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const dir = await mkdtemp(join(tmpdir(), "lockfile-"));
      await writeFile(join(dir, lockfile), "{}\n");
      expect(await lockfileInstall(dir, true)).toBe(
        "npm ci --no-audit --no-fund --foreground-scripts",
      );
    }
  });

  it("names the step that runs install scripts afterwards, for the managers that have one", () => {
    expect(installScripts("npm ci --no-audit --no-fund --foreground-scripts")).toBe(
      "npm rebuild --foreground-scripts",
    );
    expect(installScripts("corepack pnpm install --frozen-lockfile")).toBe("corepack pnpm rebuild");
    expect(installScripts("corepack yarn install --frozen-lockfile")).toBe(
      "npm rebuild --foreground-scripts",
    );
    expect(installScripts("corepack yarn install --immutable")).toBeNull();
    expect(installScripts("uv sync --frozen --all-extras")).toBeNull();
  });
});
