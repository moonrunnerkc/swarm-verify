import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedLocks, keptLockName } from "./generated-lock.ts";
import { lockfileInstall } from "./prepare.ts";

/** A base checkout: a Python project with or without a uv.lock of its own. */
async function checkout(tracked: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "generated-lock-"));
  await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "fixture"\nversion = "1.0.0"\n');
  if (tracked) await writeFile(join(dir, "uv.lock"), "version = 1\n# tracked\n");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "base",
  ]);
  return dir;
}

/** What `uv lock` leaves behind, standing in for the preparation that ran it. */
const resolve = (dir: string, text: string) => writeFile(join(dir, "uv.lock"), text);

describe("a uv.lock the verifier generates", () => {
  // tracemantle c4dc276c4 (orchestrator session 20261104T051054-41553d): the base tracks no
  // uv.lock, the isolated preparation resolved one, the statement called it reproducible, and the
  // replay resolved again and diverged on its digest.
  it("is kept as evidence for the base, and for a candidate that has to resolve again", async () => {
    const dir = await checkout(false);
    const locks = await generatedLocks(dir);
    expect(await locks.before("base")).toEqual({ relock: false });
    await resolve(dir, "version = 1\n# base\n");
    await locks.after("base");
    expect(await locks.before("candidate")).toEqual({ relock: true });
    expect(await lockfileInstall(dir, true, true)).toBe("uv lock && uv sync --frozen --all-extras");
    await resolve(dir, "version = 1\n# candidate\n");
    await locks.after("candidate");
    expect(locks.kept()).toEqual([
      { name: keptLockName("base"), text: "version = 1\n# base\n" },
      { name: keptLockName("candidate"), text: "version = 1\n# candidate\n" },
    ]);
    await locks.restoreBase();
    expect(await readFile(join(dir, "uv.lock"), "utf8")).toBe("version = 1\n# base\n");
  });

  it("is installed from the recorded lock on a replay, frozen, instead of resolved again", async () => {
    const dir = await checkout(false);
    const locks = await generatedLocks(dir, { base: "version = 1\n# recorded\n" });
    expect(await locks.before("base")).toEqual({ relock: false });
    expect(await readFile(join(dir, "uv.lock"), "utf8")).toBe("version = 1\n# recorded\n");
    expect(await lockfileInstall(dir, true)).toBe("uv sync --frozen --all-extras");
    await locks.after("base");
    expect(locks.kept()).toEqual([
      { name: keptLockName("base"), text: "version = 1\n# recorded\n" },
    ]);
  });

  it("is not made or kept where the base tracks its own, or a candidate brings its own", async () => {
    const tracked = await checkout(true);
    const locks = await generatedLocks(tracked);
    await locks.before("base");
    await locks.after("base");
    expect(await locks.before("candidate")).toEqual({ relock: false });
    expect(locks.kept()).toEqual([]);

    const own = await checkout(false);
    const candidate = await generatedLocks(own);
    await resolve(own, "version = 1\n# base\n");
    await candidate.after("base");
    await rm(join(own, "uv.lock"));
    await writeFile(join(own, "uv.lock"), "version = 1\n# the candidate's own\n");
    expect(await candidate.before("candidate")).toEqual({ relock: false });
    await candidate.after("candidate");
    expect(candidate.kept().map((one) => one.name)).toEqual([keptLockName("base")]);
  });
});
