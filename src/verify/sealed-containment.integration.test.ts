import { lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeFixture, requirement } from "../probes/fixture.ts";
import { sealFiles } from "./sealed-store.ts";

const sealedTest = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {half} from '../../half.mjs';
test('half(6) is 3',()=>assert.equal(half(6),3));
`;

let outside = "";
afterEach(async () => {
  if (outside !== "") await rm(outside, { recursive: true, force: true });
});

// F4 (2026-11-17 review): the overlay wrote trusted sealed files through a directory the candidate
// had replaced with a symbolic link, so trusted bytes landed outside the checkout.
describe("laying sealed checks into a candidate tree", () => {
  it("refuses a candidate link on the sealed path and writes nothing outside the checkout", async () => {
    outside = await mkdtemp(join(tmpdir(), "sealed-outside-"));
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/smoke.test.mjs": "import {test} from 'node:test';\ntest('loads', () => {});\n",
    });
    await sealFiles({
      workspace: probe.repo,
      home: probe.home,
      authority: "user-acceptance",
      files: [{ path: "acceptance/held/half.check.mjs", content: sealedTest }],
      checks: [
        {
          name: "held",
          command: "node --test acceptance/held/half.check.mjs",
          kind: "test",
          requirements: ["R1"],
        },
      ],
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    await probe.put("acceptance/keep.txt", "kept\n");
    await symlink(outside, join(probe.repo, "acceptance", "held"), "dir");

    const result = await probe.verify([requirement("R1", "half(n) is n / 2", "fix", [])], {
      dependencies: "none",
    });

    expect(await readdir(outside)).toEqual([]);
    expect(result.state).not.toBe("complete");
    expect(result.heldOut.status).toBe("unmeasured");
    expect(result.execution.policyMet).toBe(false);
    expect(result.execution.problems.join("\n")).toMatch(/held-out checks could not be laid/);
    expect((await lstat(join(probe.repo, "acceptance", "held"))).isSymbolicLink()).toBe(true);
  });
});
