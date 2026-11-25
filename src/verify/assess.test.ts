import { describe, expect, it } from "vitest";
import { regressionOf } from "./assess.ts";

describe("the regression across checks", () => {
  // tracemantle (session 20261101T125501-97efc9): the change did not apply, no check ran, and
  // the run printed "regression none" for a candidate nothing had measured.
  it("is unresolved, never none, when no check ran against the candidate", () => {
    expect(regressionOf([]).status).toBe("unresolved");
  });

  // depose (2026-11-06): typecheck fails at both commits with the same diagnostics.
  it("names a check without tests whose failure is all inherited, and is none", () => {
    const typecheck = {
      name: "typecheck",
      command: "pnpm run typecheck",
      kind: "other" as const,
      authority: "pre-existing" as const,
      result: "inherited-failures" as const,
      collected: null,
      exitCode: 2,
      durationMs: 1,
      outputSha256: "0".repeat(64),
    };
    expect(regressionOf([typecheck])).toMatchObject({
      status: "none",
      inherited: ["check typecheck"],
    });
  });
});
