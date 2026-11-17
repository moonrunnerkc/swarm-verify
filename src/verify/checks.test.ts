import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allChecks,
  baseCache,
  CheckNameCollisionError,
  hostExecution,
  runCheck,
} from "./checks.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "checks-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("running a check", () => {
  it("runs the source on disk after a same-size rewrite within the same second", async () => {
    // Python trusts a cached .pyc whose source has the same size and whole-second mtime, which is
    // what a mutant restored inside one second looks like.
    const source = join(dir, "half.py");
    const stamp = new Date("2026-01-01T00:00:00Z");
    const check = {
      name: "test",
      command: 'python3 -c "from half import half; assert half(10) == 5"',
      kind: "test" as const,
    };
    const context = { dir, home: dir, timeoutMs: 30_000, execution: hostExecution };
    await writeFile(source, "def half(n):\n    return n / 3\n");
    await utimes(source, stamp, stamp);
    expect((await runCheck(check, context)).result.result).toBe("fail");
    await writeFile(source, "def half(n):\n    return n / 2\n");
    await utimes(source, stamp, stamp);
    expect((await runCheck(check, context)).result.result).toBe("pass");
  });
});

describe("the checks of one run", () => {
  it("refuses two checks whose logs would be written to the same file", () => {
    const declared = [
      { name: "unit tests", command: "npm test", kind: "test" as const },
      { name: "unit_tests", command: "npm run t", kind: "test" as const },
    ];
    expect(() => allChecks(declared, [])).toThrow(CheckNameCollisionError);
    expect(() => allChecks(declared.slice(0, 1), [])).not.toThrow();
  });
});

describe("the base cache", () => {
  it("writes an entry whole under concurrent writers and reads back a valid one", async () => {
    const home = await mkdtemp(join(tmpdir(), "base-cache-"));
    try {
      const file = baseCache.file(home, "k");
      const entry = (n: number) => ({ checks: [], tests: [], heldOut: [], heldOutTests: [], n });
      await Promise.all(Array.from({ length: 8 }, (_, n) => baseCache.write(file, entry(n))));
      expect(await baseCache.read(file)).not.toBeNull();
      expect(
        (await readdir(join(home, "baselines"))).filter((name) => name.endsWith(".partial")),
      ).toEqual([]);
      await writeFile(file, '{"checks": [');
      expect(await baseCache.read(file)).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
