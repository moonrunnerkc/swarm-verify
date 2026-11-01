import { describe, expect, it } from "vitest";
import { regressionOf } from "./assess.ts";

describe("the regression across checks", () => {
  // tracemantle (session 20261101T125501-97efc9): the change did not apply, no check ran, and
  // the run printed "regression none" for a candidate nothing had measured.
  it("is unresolved, never none, when no check ran against the candidate", () => {
    expect(regressionOf([]).status).toBe("unresolved");
  });
});
