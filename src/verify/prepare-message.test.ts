import { describe, expect, it } from "vitest";
import { baseSetupFailed } from "./prepare.ts";

describe("a base whose dependencies did not install", () => {
  it("is told to fix the dependency the setup names where the setup ran and failed", () => {
    expect(baseSetupFailed("isolated")).toMatch(
      /^the base's dependencies did not install from its lockfile/,
    );
  });

  // The orchestrator's release smoke (2026-11-05): docker could not mount a checkout colima's VM
  // does not share, and the message named a dependency.
  it("is told the setup never ran, and why, where it never started", () => {
    const why =
      "it never started (docker could not start the container: bind source path does not exist)";
    expect(baseSetupFailed("isolated", why)).toBe(
      `the base's dependencies were not installed: the setup ${why}; make the container runtime able to run it on this checkout (a running daemon, a VM that shares the checkout's directory), then verify again`,
    );
  });
});
