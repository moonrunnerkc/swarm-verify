import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayCommand } from "./cli-replay.ts";
import { halfTest, probeFixture } from "./probes/fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replay on the command line", () => {
  it("exits 5 and says why for a recording it cannot reproduce", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    // An installed tree to link: the workspace's, as it stands now.
    await mkdir(join(probe.repo, "node_modules"));
    const result = await probe.verify([], { dependencies: "linked" });
    expect(result.execution.dependencies.mode).toBe("linked");
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    const code = await replayCommand([
      dirname(result.evidence.bundle ?? ""),
      "--workspace",
      probe.repo,
    ]);
    expect(code).toBe(5);
    expect(written.join("")).toMatch(
      /cannot be replayed: it was verified with linked dependencies/,
    );
  });
});
