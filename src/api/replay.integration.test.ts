import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { halfTest, probeFixture, requirement } from "../probes/fixture.ts";
import { replay } from "./replay.ts";

// ruleprobe (docs/acceptance/2026-10-31/t3-ruleprobe in swarm-orchestrator): verified on the host
// on darwin-arm64 and replayed in a Linux container, where it could never agree.
describe("replaying a verification recorded on the host", () => {
  it("runs on the host again, with dependencies prepared fresh, and agrees", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n;\n",
      "test/half.test.mjs": halfTest,
    });
    await probe.put("half.mjs", "export const half = n => n / 2;\n");
    const fix = requirement("R1", "half(n) returns n / 2", "fix", ["half positive"]);
    const result = await probe.verify([fix], { mode: "host", dependencies: "prepare" });
    expect(result.execution.mode).toBe("host");
    expect(result.state).toBe("complete");
    const replayed = await replay(dirname(result.evidence.bundle ?? ""), {
      repository: probe.repo,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
    });
    expect(replayed.replayed.execution).toMatchObject({
      mode: "host",
      statement: "host, not isolated",
    });
    expect(replayed.replayed.environment.platform).toBe(result.environment.platform);
    expect(replayed.divergences).toEqual([]);
  });
});
