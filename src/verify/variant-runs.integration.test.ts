import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChange } from "./change.ts";
import { verifyChange } from "./verify.ts";

let root = "";
let repo = "";

const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

async function put(path: string, text: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

const halfTest = (cases: string) =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../src/half.mjs";\n${cases}`;

// fix-depose-09b01c1 (Arm C, 2026-11-07), cut down: the test check runs before the build check,
// and a test file imports what the build writes to an ignored directory, so at the base it fails
// to load. The candidate's build left that output in the checkout, the base's tests ran again
// against the candidate's source after it, loaded, and 13 files that failed at the base were
// reported as passing there and failing against the candidate.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "variant-it-"));
  repo = join(root, "repo");
  await mkdir(repo);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  await put(".gitignore", "dist/\n");
  await put(
    "swarm.toml",
    '[checks]\ntest = { command = "node --test", kind = "test" }\nbuild = "node build.mjs"\n',
  );
  await put(
    "build.mjs",
    'import { cpSync, mkdirSync } from "node:fs";\nmkdirSync("dist", { recursive: true });\ncpSync("src/half.mjs", "dist/half.mjs");\n',
  );
  await put("src/half.mjs", "export const half = (n) => n * 2;\n");
  await put("test/half.test.mjs", halfTest('test("half of 4", () => assert.equal(half(4), 2));\n'));
  await put(
    "test/built.test.mjs",
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../dist/half.mjs";\ntest("built", () => assert.equal(typeof half, "function"));\n',
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("each run of a candidate starts from what the base's run started from", () => {
  it("does not hand the base's tests the build output the candidate's checks wrote", async () => {
    await put("src/half.mjs", "export const half = (n) => n / 2;\n");
    await put(
      "test/half.test.mjs",
      halfTest(
        'test("half of 4", () => assert.equal(half(4), 2));\ntest("half of 6", () => assert.equal(half(6), 3));\n',
      ),
    );
    const { statement } = await verifyChange({
      workspace: repo,
      change: await resolveChange(repo, { kind: "working-tree", base: "HEAD" }),
      policy: { mode: "host", network: "open", dependencies: "linked" },
      swarmHome: join(root, "home"),
      version: "test",
    });
    const tests = statement.predicate.checks[0]?.tests;
    expect(tests?.newFailures).toEqual([]);
    expect(tests?.fixed).toEqual(["test/half.test.mjs::half of 4"]);
    expect(statement.predicate.regression.status).not.toBe("found");
  });
});
