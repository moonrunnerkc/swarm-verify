import { describe, expect, it } from "vitest";
import { divergencesOf } from "./replay.ts";

type Recorded = Parameters<typeof divergencesOf>[0];
type Replayed = Parameters<typeof divergencesOf>[1];

const result = (inherited: readonly string[]) => ({
  state: "incomplete",
  regression: { status: "none" },
  execution: { dependencies: { lockfiles: [] } },
  checks: [{ name: "test", result: "inherited-failures", tests: { inherited } }],
  requirements: [],
});

describe("comparing a replay with what was recorded", () => {
  // depose (session 20261101T155037-25f560): the same 17 inherited failures in another order.
  it("compares test ids as sets, so the runner's order is no divergence", () => {
    const recorded = result(["b::two", "a::one"]) as unknown as Recorded;
    expect(divergencesOf(recorded, result(["a::one", "b::two"]) as unknown as Replayed)).toEqual(
      [],
    );
    expect(divergencesOf(recorded, result(["a::one"]) as unknown as Replayed)).toHaveLength(1);
  });
});
