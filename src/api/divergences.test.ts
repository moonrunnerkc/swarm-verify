import { describe, expect, it } from "vitest";
import type { TestJudgment, TestRuns } from "../verify/predicate.ts";
import { divergencesOf } from "./divergences.ts";

type Recorded = Parameters<typeof divergencesOf>[0];
type Replayed = Parameters<typeof divergencesOf>[1];

const tests = (lists: Partial<TestJudgment>) => ({
  fixed: [],
  newFailures: [],
  inherited: [],
  removed: [],
  expectationChanges: [],
  witnesses: [],
  flaky: [],
  reruns: [],
  ...lists,
});

const result = (lists: Partial<TestJudgment>, reruns?: number) => ({
  state: "incomplete",
  regression: { status: "none" },
  execution: { dependencies: { lockfiles: [] } },
  checks: [{ name: "test", result: "inherited-failures", tests: tests(lists) }],
  requirements: [],
  policy: { behaviorChange: "none", ...(reruns === undefined ? {} : { reruns }) },
});

describe("comparing a replay with what was recorded", () => {
  // depose (session 20261101T155037-25f560): the same 17 inherited failures in another order.
  it("compares test ids as sets, so the runner's order is no divergence", () => {
    const recorded = result({ inherited: ["b::two", "a::one"] }) as unknown as Recorded;
    const again = (inherited: string[]) => result({ inherited }) as unknown as Replayed;
    expect(divergencesOf(recorded, again(["a::one", "b::two"]))).toEqual([]);
    expect(divergencesOf(recorded, again(["a::one"]))).toHaveLength(1);
  });
});

// tracemantle (session 20261101T150922-f837ff): recorded without reruns, `[bundle_sha256]` failed
// and `[configuration_sha256]` passed; the replay saw both fail.
describe("comparing a replay whose tests are flaky", () => {
  const gate = "tests.test_build_plan_acceptance::test_malformed_history_blocks_final_gate";
  const bundle = `${gate}[bundle_sha256]`;
  const configuration = `${gate}[configuration_sha256]`;
  const runs = (id: string, ...results: TestRuns["results"]): TestRuns => ({
    id,
    snapshot: "candidate",
    results,
  });
  const recorded = result({ newFailures: [bundle] }) as unknown as Recorded;

  it("names a test the replay found flaky and the recording let one run decide", () => {
    const replayed = result({
      newFailures: [bundle],
      flaky: [configuration],
      reruns: [runs(bundle, "fail", "fail", "fail", "fail"), runs(configuration, "fail", "pass")],
    }) as unknown as Replayed;
    expect(divergencesOf(recorded, replayed)).toEqual([
      `check test: ${configuration} (candidate: fail, pass) is flaky in the replay and listed nowhere (preserved, added or skipped) in the recording, which reran no test`,
    ]);
  });

  it("reports a recorded failure the replay found flaky once, not again in every list", () => {
    const replayed = result({
      flaky: [bundle],
      reruns: [runs(bundle, "fail", "fail", "pass")],
    }) as unknown as Replayed;
    expect(divergencesOf(recorded, replayed)).toEqual([
      `check test: ${bundle} (candidate: fail, fail, pass) is flaky in the replay and among newFailures in the recording, which reran no test`,
    ]);
  });

  it("agrees where both runs found the same test flaky", () => {
    const flaky = (results: TestRuns["results"]) =>
      result({ flaky: [bundle], reruns: [runs(bundle, ...results)] }, 3);
    expect(
      divergencesOf(
        flaky(["fail", "pass"]) as unknown as Recorded,
        flaky(["fail", "fail", "pass"]) as unknown as Replayed,
      ),
    ).toEqual([]);
  });

  it("keeps a test that failed on every run of the replay a plain divergence", () => {
    const replayed = result({ newFailures: [bundle, configuration] }) as unknown as Replayed;
    expect(divergencesOf(recorded, replayed)).toEqual([
      `check test newFailures: recorded ${JSON.stringify([bundle])}, replayed ${JSON.stringify([bundle, configuration])}`,
    ]);
  });
});
