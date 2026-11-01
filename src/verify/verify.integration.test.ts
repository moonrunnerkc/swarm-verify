import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChange } from "./change.ts";
import { seal } from "./held-out.ts";
import { exitCodeOf } from "./report.ts";
import { verifyChange } from "./verify.ts";

const hostPolicy = { mode: "host", network: "open", dependencies: "linked" } as const;

let root = "";
let repo = "";
let home = "";

const run = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

async function put(path: string, text: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

const correct =
  "export function clamp(value, low, high) {\n  return Math.min(high, Math.max(low, value));\n}\n";
const visibleTest = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { clamp } from "../src/clamp.mjs";',
  'test("clamps above", () => assert.equal(clamp(9, 0, 5), 5));',
  "",
].join("\n");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "verify-it-"));
  repo = join(root, "repo");
  home = join(root, "swarm-home");
  await mkdir(repo);
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  await put("swarm.toml", '[checks]\ntest = "node --test"\n');
  await put("src/clamp.mjs", "export function clamp(value, low, high) {\n  return value;\n}\n");
  await put("test/clamp.test.mjs", visibleTest);
  run(["add", "-A"]);
  run(["commit", "-qm", "base"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const verify = async () =>
  verifyChange({
    workspace: repo,
    change: await resolveChange(repo, { kind: "working-tree", base: "HEAD" }),
    policy: hostPolicy,
    swarmHome: home,
    version: "test",
  });

describe("verifying a change in a clean checkout", () => {
  it("passes a correct change, with changed-line coverage and a killed mutant", async () => {
    await put("src/clamp.mjs", correct);
    const { statement } = await verify();
    const predicate = statement.predicate;
    expect(predicate.state).toBe("complete");
    expect(predicate.checks.map((check) => check.result)).toEqual(["pass"]);
    expect(predicate.coverage).toMatchObject({ status: "measured", tool: "v8" });
    expect(predicate.mutation.status).toBe("killed");
    expect(statement.subject.map((subject) => subject.name)).toEqual(["tree", "change.patch"]);
  });

  it("leaves unresolved a change whose only test fails at base and still fails, and hands back its output", async () => {
    await put("src/clamp.mjs", "export function clamp(value) {\n  return value + 1;\n}\n");
    const outcome = await verify();
    const predicate = outcome.statement.predicate;
    expect(exitCodeOf(predicate)).toBe(4);
    expect(predicate.checks[0]).toMatchObject({ result: "unresolved" });
    expect(predicate.checks[0]?.tests?.inherited).toEqual(["test/clamp.test.mjs::clamps above"]);
    expect(outcome.failureText).toContain("node --test");
  });

  it("judges a rewritten test by its original version, and refuses the rewrite that rescues it", async () => {
    await put("test/clamp.test.mjs", visibleTest.replace("clamp(9, 0, 5), 5", "clamp(9, 0, 5), 9"));
    const predicate = (await verify()).statement.predicate;
    expect(exitCodeOf(predicate)).toBe(1);
    expect(predicate.testFiles.modified).toEqual(["test/clamp.test.mjs"]);
    expect(predicate.checks[0]?.tests?.expectationChanges).toEqual([
      "test/clamp.test.mjs::clamps above",
    ]);
  });

  it("accepts a source fix that rewrites its test alongside, judged by the original test", async () => {
    await put("src/clamp.mjs", correct);
    await put(
      "test/clamp.test.mjs",
      `${visibleTest}test("clamps below", () => assert.equal(clamp(-1, 0, 5), 0));\n`,
    );
    const predicate = (await verify()).statement.predicate;
    expect(predicate.state).toBe("complete");
    expect(predicate.checks[0]?.tests).toMatchObject({
      fixed: ["test/clamp.test.mjs::clamps above"],
      added: ["test/clamp.test.mjs::clamps below"],
    });
  });

  it("judges by the base's checks even where the change rewrites swarm.toml", async () => {
    await put("swarm.toml", '[checks]\ntest = "true"\n');
    const predicate = (await verify()).statement.predicate;
    expect(predicate.checks[0]?.command).toBe("node --test");
    expect(predicate.state).not.toBe("complete");
  });

  it("measures the held-out gap for a change that only satisfies the visible test", async () => {
    await put(
      "test/hidden/clamp.test.mjs",
      visibleTest.replace("../src", "../../src").replace("clamp(9, 0, 5), 5", "clamp(-3, 0, 5), 0"),
    );
    await seal(
      repo,
      "test/hidden/**",
      [{ name: "test", command: "node --test", kind: "test" }],
      home,
    );
    await put(
      "src/clamp.mjs",
      "export function clamp(value, low, high) {\n  return Math.min(high, value);\n}\n",
    );
    const predicate = (await verify()).statement.predicate;
    expect(predicate.heldOut).toMatchObject({
      status: "measured",
      visiblePassRate: 1,
      heldOutPassRate: 0,
      gap: 1,
    });
    expect(exitCodeOf(predicate)).toBe(1);
  });

  it("reports a change that does not apply as a failed verdict", async () => {
    const patch = join(root, "bad.patch");
    await writeFile(
      patch,
      "diff --git a/missing b/missing\n--- a/missing\n+++ b/missing\n@@ -1 +1 @@\n-a\n+b\n",
    );
    const outcome = await verifyChange({
      workspace: repo,
      change: await resolveChange(repo, { kind: "patch", path: patch, base: "HEAD" }),
      policy: hostPolicy,
      swarmHome: home,
      version: "test",
    });
    expect(exitCodeOf(outcome.statement.predicate)).toBe(1);
    expect(outcome.statement.predicate.change.applied).toBe(false);
  });

  it("is blocked where nothing declares a check", async () => {
    await rm(join(repo, "swarm.toml"));
    run(["commit", "-qam", "no checks"]);
    await put("src/clamp.mjs", correct);
    const predicate = (await verify()).statement.predicate;
    expect(predicate.state).toBe("blocked");
    expect(exitCodeOf(predicate)).toBe(5);
  });
});

describe("measuring every check at the base commit first", () => {
  beforeEach(async () => {
    await put(
      "swarm.toml",
      '[checks]\ntest = "node --test test/clamp.test.mjs"\nred = "node --test test/red.test.mjs"\nsyntax = "node --check src/clamp.mjs"\n',
    );
    await put(
      "test/red.test.mjs",
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("red", () => assert.fail("red at base"));\n',
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "one red test at base"]);
  });

  it("separates a check the change fixed, one that was red before it, and the base run", async () => {
    await put("src/clamp.mjs", correct);
    const predicate = (await verify()).statement.predicate;
    expect(predicate.checks.map((check) => [check.name, check.result])).toEqual([
      ["test", "pass"],
      ["red", "unresolved"],
      ["syntax", "pass"],
    ]);
    expect(predicate.baseline).toMatchObject({ status: "measured", cached: false });
    if (predicate.baseline.status !== "measured") throw new Error("no baseline");
    expect(predicate.baseline.checks.map((check) => check.result)).toEqual([
      "fail",
      "fail",
      "pass",
    ]);
    expect(predicate.unmeasured).toContain(
      "check red: no test in its report passes against the candidate (1 collected)",
    );
    // A check that cannot tell the candidate from no change never lets the result complete.
    expect(exitCodeOf(predicate)).toBe(4);
  });

  it("fails a check that passes at base and fails with the change, as a regression", async () => {
    await put("src/clamp.mjs", "export function clamp(value, low, high) {\n  return (;\n}\n");
    const predicate = (await verify()).statement.predicate;
    expect(predicate.checks[2]).toMatchObject({ name: "syntax", result: "fail" });
    expect(predicate.reasons).toContain(
      "check syntax regressed: it passes at the base commit and fails with the candidate",
    );
    expect(exitCodeOf(predicate)).toBe(1);
  });

  // depose (session 20261101T154330-6eee82): the base's build check wrote ignored build output,
  // the candidate's tests loaded it, and an unchanged tree read as 14 new failures.
  it("runs the candidate on what the base commit holds, not on what the base's checks wrote", async () => {
    await put(".gitignore", "out/\n");
    await put("swarm.toml", '[checks]\ntest = "node --test"\nbuild = "node build.mjs"\n');
    await put(
      "build.mjs",
      'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/flag", "built");\n',
    );
    await put(
      "test/fresh.test.mjs",
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { existsSync } from "node:fs";\ntest("starts from a fresh tree", () => assert.ok(!existsSync("out/flag")));\n',
    );
    run(["add", "-A"]);
    run(["commit", "-qm", "build output"]);
    await put("README.md", "notes\n");
    const predicate = (await verify()).statement.predicate;
    expect(predicate.regression.newFailures).toEqual([]);
  });

  it("reuses the base run for the same base commit and environment", async () => {
    await put("src/clamp.mjs", correct);
    await verify();
    const again = (await verify()).statement.predicate;
    expect(again.baseline).toMatchObject({ status: "measured", cached: true });
  });
});

describe("judging held-out checks the code under test cannot disable", () => {
  const sealHidden = async (path: string, text: string, command: string) => {
    await put(path, text);
    await seal(repo, path, [{ name: "test", command, kind: "test" }], home);
  };

  it("fails a held-out check whose node:assert the source replaced at import", async () => {
    await sealHidden(
      "test/hidden/clamp.test.mjs",
      visibleTest.replace("../src", "../../src").replace("clamp(9, 0, 5), 5", "clamp(-3, 0, 5), 0"),
      "node --test",
    );
    await put(
      "src/clamp.mjs",
      'import assert from "node:assert/strict";\nassert.equal = () => {};\nexport function clamp(value, low, high) {\n  return Math.min(high, value);\n}\n',
    );
    const predicate = (await verify()).statement.predicate;
    expect(predicate.reasons).toContain(
      "held-out check test: the code under test changed assert.strict.equal",
    );
    expect(exitCodeOf(predicate)).toBe(1);
  });

  it("does the same for Python, where the source patches unittest, and passes an honest fix", async () => {
    await put("swarm.toml", '[checks]\ntest = "python3 -m unittest discover -s tests -t ."\n');
    await put("half.py", "def half(n):\n    return n\n");
    await put("tests/__init__.py", "");
    const visible =
      "import unittest\nfrom half import half\n\nclass T(unittest.TestCase):\n    def test_four(self):\n        self.assertEqual(half(4), 2)\n";
    await put("tests/test_half.py", visible);
    run(["add", "-A"]);
    run(["commit", "-qm", "python"]);
    await sealHidden(
      "tests/test_hidden.py",
      visible.replace("half(4), 2", "half(10), 5"),
      "python3 -m unittest discover -s tests -t .",
    );
    await put(
      "half.py",
      "import unittest\nunittest.TestCase.assertEqual = lambda *args, **kwargs: None\n\ndef half(n):\n    return n\n",
    );
    const cheat = (await verify()).statement.predicate;
    expect(cheat.reasons).toContain(
      "held-out check test: the code under test changed unittest.TestCase.assertEqual",
    );
    expect(exitCodeOf(cheat)).toBe(1);
    await put("half.py", "def half(n):\n    return n / 2\n");
    const honest = (await verify()).statement.predicate;
    expect(honest.state).toBe("complete");
    expect(honest.heldOut).toMatchObject({ status: "measured", heldOutPassRate: 1 });
  });
});
