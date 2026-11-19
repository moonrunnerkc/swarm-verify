import { describe, expect, it } from "vitest";
import { replayExecution, UnreplayableBundleError } from "./replay.ts";

type Recorded = Parameters<typeof replayExecution>[0];

const image = "node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413";
const recorded = (
  mode: "host" | "isolated",
  dependencies: "prepared" | "setup" | "linked" | "none",
  platform: string,
) =>
  ({
    execution: {
      mode,
      network: mode === "host" ? "open" : "closed",
      image: mode === "host" ? null : `${image} (sha256:e7add2a4 arm64)`,
      dependencies: { mode: dependencies },
    },
    environment: { platform },
  }) as unknown as Recorded;

describe("the execution a replay runs under", () => {
  // ruleprobe (docs/acceptance/2026-10-31/t3-ruleprobe in swarm-orchestrator) was verified with
  // --host on darwin-arm64, and its replay ran in a Linux container.
  it("is the host for a host recording, on the platform it was recorded on", () => {
    expect(
      replayExecution(recorded("host", "prepared", "darwin-arm64"), "darwin-arm64", true),
    ).toEqual({
      mode: "host",
      network: "open",
      dependencies: "prepare",
    });
  });

  it("refuses a host recording unless the caller allows the host", () => {
    const replaying = () =>
      replayExecution(recorded("host", "prepared", "darwin-arm64"), "darwin-arm64");
    expect(replaying).toThrow(/authorize that explicitly/);
  });

  it("stays isolated, in the recorded image, for an isolated recording", () => {
    expect(
      replayExecution(recorded("isolated", "prepared", "linux-arm64"), "darwin-arm64"),
    ).toEqual({ mode: "isolated", network: "closed", dependencies: "prepare", image });
  });

  it("prepares nothing where the recording prepared nothing", () => {
    const execution = replayExecution(recorded("isolated", "none", "linux-arm64"));
    expect(execution.dependencies).toBe("none");
  });

  it("refuses a host recording made on another platform, and names both", () => {
    const replaying = () =>
      replayExecution(recorded("host", "prepared", "darwin-arm64"), "linux-x64", true);
    expect(replaying).toThrow(UnreplayableBundleError);
    expect(replaying).toThrow(
      "it was verified on the host on darwin-arm64, and this host is linux-x64; replay it on darwin-arm64",
    );
  });

  it("refuses a recording on linked dependencies, which no replay can reproduce", () => {
    for (const mode of ["host", "isolated"] as const) {
      const replaying = () =>
        replayExecution(recorded(mode, "linked", "darwin-arm64"), "darwin-arm64", true);
      expect(replaying).toThrow(/verified with linked dependencies/);
    }
  });

  it("replays under the recorded bounds, and leaves a recording without any to today's defaults", () => {
    const bounds = { memoryMiB: 1024, cpus: 1 };
    const record = recorded("isolated", "prepared", "linux-arm64");
    const bounded = {
      ...record,
      execution: { ...record.execution, resources: { requested: bounds } },
    } as unknown as Recorded;
    expect(replayExecution(bounded).resources).toEqual(bounds);
    expect(replayExecution(record).resources).toBeUndefined();
  });
});
