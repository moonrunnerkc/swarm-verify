import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageEvidence } from "./requirement-evidence.ts";

const lock = (version: string) =>
  JSON.stringify({ packages: { "node_modules/@stryker-mutator/core": { version } } });

async function claimed(version: string | undefined, resolved: string) {
  const dir = await mkdtemp(join(tmpdir(), "package-claim-"));
  await writeFile(join(dir, "package-lock.json"), lock(resolved));
  const base = async (path: string) => (path === "package-lock.json" ? lock("9.6.1") : null);
  return packageEvidence(base, dir, {
    name: "@stryker-mutator/core",
    ecosystem: "npm",
    ...(version === undefined ? {} : { version }),
  });
}

describe("a requirement's package claim", () => {
  it("holds a version range written with x, as a task states it", async () => {
    // claimcheck: the task allowed "the latest 9.x"; the candidate resolved 10.1.1.
    expect(await claimed("9.x", "9.7.0")).toMatchObject({ outcome: "observed" });
    expect(await claimed("9", "9.7.0")).toMatchObject({ outcome: "observed" });
    expect(await claimed("9.7.x", "9.7.2")).toMatchObject({ outcome: "observed" });
    expect(await claimed("10.1.1", "10.1.1")).toMatchObject({ outcome: "observed" });
  });

  // A comparison's upgrade run claimed "^5" and "^10", resolved 5.1.0 and 10.1.1, and read
  // "outside ^5": the claim knew only x forms. It then spent about 40 turns chasing that failure.
  it("holds a caret or tilde range, as the version constraints read it", async () => {
    expect(await claimed("^10", "10.1.1")).toMatchObject({ outcome: "observed" });
    expect(await claimed("^10.1.0", "10.1.1")).toMatchObject({ outcome: "observed" });
    expect(await claimed("~10.1", "10.1.1")).toMatchObject({ outcome: "observed" });
    expect(await claimed("^9", "10.1.1")).toMatchObject({ outcome: "fail" });
    expect(await claimed("~10.0", "10.1.1")).toMatchObject({ outcome: "fail" });
  });

  it("fails where the candidate resolves a version outside the claim", async () => {
    expect(await claimed("9.x", "10.1.1")).toEqual({
      kind: "package",
      ref: "npm:@stryker-mutator/core",
      authority: "pre-existing",
      outcome: "fail",
      detail: "resolved 9.6.1 at the base and 10.1.1 in the candidate, outside 9.x",
    });
  });

  it("is not observed where the version did not move", async () => {
    expect(await claimed(undefined, "9.6.1")).toMatchObject({ outcome: "not observed" });
  });
});
