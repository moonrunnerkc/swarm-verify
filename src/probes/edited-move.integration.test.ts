import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeFixture } from "./fixture.ts";

const fixtureTest = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {half} from '../half.mjs';
const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
test('half of every case',()=>{ for (const [n, h] of cases) assert.equal(half(n), h); });
test('half of zero',()=>assert.equal(half(0), 0));
test('half of an odd number',()=>assert.equal(half(10 - 1), 4.5));
test('half of a large number',()=>assert.equal(half(10 * 100), 500));
test('half of half',()=>assert.equal(half(half(10 * 2)), 5));
test('half is a number',()=>assert.equal(typeof half(10 * 3), 'number'));
`;

// Counts the suite's test files, as tracemantle's README test counts its collected tests.
const countTest = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
const files = readdirSync(new URL('.', import.meta.url), {recursive: true}).filter((f) => f.endsWith('.test.mjs'));
test('the suite has two test files',()=>assert.equal(files.length, 2));
`;

/**
 * A test file moved one directory down has to reach its fixture one directory further up, so
 * more than its imports change. tracemantle's history refactor did exactly that: the verifier
 * called 18 tests removed, and its base-tests run held the old file and the moved one at once,
 * so the suite's own count of its tests failed (orchestrator patch release, t6 comparison).
 */
describe("a test file moved and edited", () => {
  it("is judged by the base's version against the new code, once, rather than as removed", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": fixtureTest,
      "test/cases.json": "[[4, 2], [10, 5]]\n",
      "test/count.test.mjs": countTest,
    });
    await mkdir(join(probe.repo, "test", "unit"), { recursive: true });
    probe.git("mv", "test/half.test.mjs", "test/unit/half.test.mjs");
    await probe.put(
      "test/unit/half.test.mjs",
      fixtureTest.replace("'../half.mjs'", "'../../half.mjs'").replace("./cases", "../cases"),
    );
    const result = await probe.verify([]);
    expect(result.checks[0]?.tests?.removed).toEqual([]);
    expect(result.checks[0]?.tests?.newFailures).toEqual([]);
    expect(result.regression.status).toBe("none");
    expect(result.state).toBe("complete");
    expect(result.testFiles.movedAndEdited).toEqual([
      { from: "test/half.test.mjs", to: "test/unit/half.test.mjs" },
    ]);
    expect(result.testFiles.deleted).toEqual([]);
    expect(result.testFiles.added).toEqual([]);
  });

  it("still finds the new code failing the base's version of a moved and edited file", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": fixtureTest,
      "test/cases.json": "[[4, 2], [10, 5]]\n",
      "test/count.test.mjs": countTest,
    });
    await probe.put("half.mjs", "export const half = n => n === 10 ? 5 : 0;\n");
    await mkdir(join(probe.repo, "test", "unit"), { recursive: true });
    probe.git("mv", "test/half.test.mjs", "test/unit/half.test.mjs");
    // The moved copy skips the case the new code gets wrong.
    await probe.put(
      "test/unit/half.test.mjs",
      fixtureTest
        .replace("'../half.mjs'", "'../../half.mjs'")
        .replace("./cases", "../cases")
        .replace("of cases)", "of cases.slice(1))"),
    );
    const result = await probe.verify([]);
    expect(result.regression.status).toBe("found");
    expect(result.checks[0]?.tests?.expectationChanges).toEqual([
      "test/half.test.mjs::half of every case",
    ]);
    expect(result.state).toBe("incomplete");
  });
});
