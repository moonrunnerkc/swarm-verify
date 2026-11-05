import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateHeldOut } from "./held-out-validation.ts";

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "held-out-"));
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(
    join(repo, "half.mjs"),
    "export const half = (n) => n;\nexport const spare = () => 1;\n",
  );
  await writeFile(
    join(repo, "test", "half.held-out.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../half.mjs";\ntest("half(4) is 2", () => assert.equal(half(4), 2));\n',
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "base");
  await writeFile(
    join(repo, "half.mjs"),
    "export const half = (n) => n / 2;\nexport const spare = () => 1;\n",
  );
  const patch = execFileSync("git", ["diff"], { cwd: repo });
  execFileSync("git", ["checkout", "-q", "half.mjs"], { cwd: repo });
  await writeFile(join(repo, "..", `${repo.split("/").at(-1)}.patch`), patch);
  return repo;
}

const check = (command: string) => ({ name: "held-out", command, kind: "test" as const });

describe("a held-out check, before it is sealed", () => {
  it("fails at the base and passes on the reference patch", async () => {
    const repo = await repository();
    const notes = await validateHeldOut({
      workspace: repo,
      checks: [check("node --test test/half.held-out.test.mjs")],
      reference: `${repo}.patch`,
    });
    expect(notes).toEqual([
      "held-out check held-out fails at the base and passes on the reference patch",
    ]);
  });

  // ironroot (2026-11-04): the held-out pytest ran under the project's --cov-fail-under=68, which
  // fails any run of a single file, so it failed on every tree. Node's coverage gate does the same.
  it("refuses one that fails at the base with every test passing, a gate around the tests", async () => {
    const repo = await repository();
    // Its one test passes; half's body is left uncovered, so the 100% line gate fails the run.
    await writeFile(
      join(repo, "half.mjs"),
      "export function half(n) {\n  return n;\n}\nexport const spare = () => 1;\n",
    );
    await writeFile(
      join(repo, "test", "spare.held-out.test.mjs"),
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { spare } from "../half.mjs";\ntest("spare() is 1", () => assert.equal(spare(), 1));\n',
    );
    const gated =
      "node --test --experimental-test-coverage --test-coverage-lines=100 test/spare.held-out.test.mjs";
    await expect(
      validateHeldOut({ workspace: repo, checks: [check(gated)], reference: null }),
    ).rejects.toThrow(/exits 1 at the base with every one of its 1 test\(s\) passing/);
  });

  it("refuses one the reference patch does not pass", async () => {
    const repo = await repository();
    await expect(
      validateHeldOut({
        workspace: repo,
        checks: [check("node --test test/half.held-out.test.mjs")],
        reference: `${repo}.missing.patch`,
      }),
    ).rejects.toThrow(/the reference patch does not apply/);
  });
});
