import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeFixture } from "../probes/fixture.ts";
import { sealFiles } from "../verify/sealed-store.ts";
import { replay } from "./replay.ts";

const authored = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {half} from '../half.mjs';
test('half(6) is 3',()=>assert.equal(half(6),3));
`;

// swarm-orchestrator 17.0.0-rc.13 (2026-11-05): the orchestrator seals its authored checks for the
// clone it works in; a replay against the user's checkout found no sealed set there, and every
// run whose authored test failed replayed R1 as unverified.
describe("replaying against another checkout than the one sealed for", () => {
  it("judges with the sealed set the recording used, and agrees", async () => {
    const probe = await probeFixture({ "half.mjs": "export const half = n => n;\n" });
    await sealFiles({
      workspace: probe.repo,
      home: probe.home,
      authority: "independently-generated",
      files: [{ path: "test/half.authored.test.mjs", content: authored }],
      checks: [
        {
          name: "authored",
          command: "node --test test/half.authored.test.mjs",
          kind: "test",
          requirements: ["R1"],
        },
      ],
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fix = {
      id: "R1",
      text: "half(n) returns n / 2",
      source: "user" as const,
      kind: "fix" as const,
      required: true,
      testsAsked: false,
      behaviorAsked: false,
      assumptions: [],
      evidence: { tests: [], checks: [], structure: [], packages: [] },
      versions: [],
    };
    const result = await probe.verify([fix], { mode: "host", dependencies: "prepare" });
    expect(result.requirements[0]).toMatchObject({ status: "satisfied", witness: "independent" });

    const other = join(dirname(probe.repo), "other");
    execFileSync("git", ["clone", "-q", probe.repo, other]);
    const replayed = await replay(dirname(result.evidence.bundle ?? ""), {
      repository: other,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
    });
    expect(replayed.replayed.requirements[0]).toMatchObject({ status: "satisfied" });
    expect(replayed.divergences).toEqual([]);
  });
});
