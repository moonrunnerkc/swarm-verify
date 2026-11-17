import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureSigner, probeFixture } from "../probes/fixture.ts";
import { divergencesOf } from "./divergences.ts";
import { replay } from "./replay.ts";

let markers = "";
afterEach(async () => {
  if (markers !== "") await rm(markers, { recursive: true, force: true });
});

/** 150 tests of half(n), each failing on the base; t140 passes regardless where the marker is. */
function suite(marker: string): string {
  const lines = [
    "import {test} from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import {existsSync} from 'node:fs';",
    "import {half} from '../half.mjs';",
  ];
  for (let at = 0; at < 150; at += 1) {
    const name = `t${String(at).padStart(3, "0")}`;
    const body =
      at === 140
        ? `if (!existsSync(${JSON.stringify(marker)})) assert.equal(half(${(at + 1) * 2}), ${at + 1})`
        : `assert.equal(half(${(at + 1) * 2}), ${at + 1})`;
    lines.push(`test('${name}', () => { ${body}; });`);
  }
  return `${lines.join("\n")}\n`;
}

// F8 (2026-11-17 review): replay compared test lists capped at 100 ids, so a test whose outcome
// changed beyond the first 100 was never seen to diverge.
describe("replaying a suite of more than 100 tests", () => {
  it("compares every observation and finds a change beyond the first 100", async () => {
    markers = await mkdtemp(join(tmpdir(), "replay-observations-"));
    const marker = join(markers, "t140-passes");
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": suite(marker),
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const result = await probe.verify([], { mode: "host", dependencies: "none" });
    expect(result.state).toBe("complete");
    expect(result.checks[0]?.tests?.counts.fixed).toBe(150);
    expect(result.checks[0]?.tests?.fixed).toHaveLength(100);

    await writeFile(marker, "");
    const replayed = await replay(dirname(result.evidence.bundle ?? ""), {
      repository: probe.repo,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
      signer: fixtureSigner(),
      allowHost: true,
    });
    expect(replayed.comparedBy).toBe("observations");
    expect(replayed.replayed.state).toBe("complete");
    expect(replayed.divergences.join("\n")).toMatch(
      /test\/half\.test\.mjs::t140 was fixed .* and is preserved/,
    );
    expect(replayed.environmentDrift).toEqual([]);
    // The capped summaries alone, as replay compared before, do not see it.
    expect(divergencesOf(replayed.recorded, replayed.replayed, null).join("\n")).not.toMatch(
      /t140/,
    );
  });
});
