import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChange } from "./change.ts";
import { applyChange, cloneBase } from "./checkout.ts";

async function repository(): Promise<{ repo: string; git: (...args: string[]) => string }> {
  const repo = await mkdtemp(join(tmpdir(), "checkout-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  await writeFile(join(repo, "pyproject.toml"), "[project]\nname = 'x'\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return { repo, git };
}

describe("applying the change to the base checkout", () => {
  // tracemantle (session 20261101T125501-97efc9): `uv lock` in the base's preparation wrote an
  // untracked uv.lock, the candidate added its own, and the change did not apply at all.
  it("lets a file the change adds replace an untracked one the base's run left behind", async () => {
    const { repo, git } = await repository();
    await writeFile(join(repo, "uv.lock"), "candidate lock\n");
    const change = await resolveChange(repo, { kind: "working-tree", base: "HEAD" });
    const checkout = await cloneBase(repo, git("rev-parse", "HEAD").trim());
    try {
      await writeFile(join(checkout.dir, "uv.lock"), "base preparation lock\n");
      const applied = await applyChange(checkout, change.patch);
      expect(applied.applied).toBe(true);
      expect(await readFile(join(checkout.dir, "uv.lock"), "utf8")).toBe("candidate lock\n");
    } finally {
      await checkout.remove();
    }
  });

  it("still refuses a change that does not apply to a tracked file", async () => {
    const { repo, git } = await repository();
    await writeFile(join(repo, "pyproject.toml"), "[project]\nname = 'y'\n");
    const change = await resolveChange(repo, { kind: "working-tree", base: "HEAD" });
    const checkout = await cloneBase(repo, git("rev-parse", "HEAD").trim());
    try {
      await writeFile(join(checkout.dir, "pyproject.toml"), "something else\n");
      git("-C", checkout.dir, "add", "pyproject.toml");
      const applied = await applyChange(checkout, change.patch);
      expect(applied.applied).toBe(false);
    } finally {
      await checkout.remove();
    }
  });
});
