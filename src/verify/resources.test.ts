import { describe, expect, it } from "vitest";
import { parseRequest } from "../api/verify.ts";
import {
  defaultResources,
  describeResources,
  effectiveResources,
  resourceArgs,
} from "./resources.ts";

const asked = { memoryMiB: 512, cpus: 1.5 };
const mib512 = String(512 * 1024 * 1024);

describe("resource limits", () => {
  it("passes memory, an equal swap total and CPUs to docker", () => {
    expect(resourceArgs(asked)).toEqual(["--memory=512m", "--memory-swap=512m", "--cpus=1.5"]);
  });

  it("reads cgroup v2 limits back and records them", () => {
    const read = effectiveResources(
      asked,
      `memory.max=${mib512}\nmemory.swap.max=0\ncpu.max=150000 100000\n`,
    );
    expect(read).toEqual({
      record: {
        requested: asked,
        effective: { memoryBytes: 512 * 1024 * 1024, swapBytes: 0, cpus: 1.5, cgroup: "v2" },
        scope: "per-container",
      },
    });
  });

  it("reads cgroup v1 limits, swap as the total less memory", () => {
    const read = effectiveResources(
      asked,
      `memory/memory.limit_in_bytes=${mib512}\nmemory/memory.memsw.limit_in_bytes=${mib512}\ncpu/cpu.cfs_quota_us=150000\ncpu/cpu.cfs_period_us=100000\n`,
    );
    expect("record" in read && read.record.effective).toMatchObject({ swapBytes: 0, cgroup: "v1" });
  });

  it.each([
    ["no memory limit", `memory.max=max\nmemory.swap.max=0\ncpu.max=150000 100000`, /memory limit/],
    [
      "a different memory limit",
      `memory.max=1024\nmemory.swap.max=0\ncpu.max=150000 100000`,
      /memory limit/,
    ],
    ["no swap accounting", `memory.max=${mib512}\ncpu.max=150000 100000`, /swap/],
    [
      "swap granted",
      `memory.max=${mib512}\nmemory.swap.max=${mib512}\ncpu.max=150000 100000`,
      /swap/,
    ],
    ["no CPU quota", `memory.max=${mib512}\nmemory.swap.max=0\ncpu.max=max 100000`, /CPU limit/],
    ["nothing readable", "", /memory limit/],
  ])("refuses a container with %s", (_, printed, problem) => {
    const read = effectiveResources(asked, printed);
    expect("problem" in read && read.problem).toMatch(problem);
  });

  it("describes the bounds as per-container", () => {
    expect(describeResources(defaultResources)).toBe(
      "memory 4096 MiB with no swap and 2 CPUs, per container",
    );
  });
});

describe("the request's resource policy", () => {
  const request = (execution: Record<string, unknown>) => ({
    version: "swarm-verify.request/v1" as const,
    repository: "/r",
    base: { commit: "a".repeat(40) },
    candidate: { kind: "commit" as const, commit: "b".repeat(40) },
    policy: { execution },
    artifacts: { directory: "/out" },
  });

  it("bounds an isolated run by the defaults where none are given", () => {
    const parsed = parseRequest(request({ mode: "isolated" }) as never);
    expect(parsed.policy.execution.resources).toEqual(defaultResources);
  });

  it("keeps the caller's bounds", () => {
    const parsed = parseRequest(request({ mode: "isolated", resources: asked }) as never);
    expect(parsed.policy.execution.resources).toEqual(asked);
  });

  it("leaves a host run unbounded and refuses bounds it could not enforce", () => {
    expect(parseRequest(request({ mode: "host" }) as never).policy.execution.resources).toBe(
      undefined,
    );
    expect(() => parseRequest(request({ mode: "host", resources: asked }) as never)).toThrow(
      /enforced only by the container/,
    );
  });

  it.each([
    [{ memoryMiB: 10, cpus: 1 }],
    [{ memoryMiB: 512.5, cpus: 1 }],
    [{ memoryMiB: 512, cpus: 0 }],
    [{ memoryMiB: 512, cpus: Number.POSITIVE_INFINITY }],
    [{ memoryMiB: 512 }],
    [{ memoryMiB: 512, cpus: 1, swapMiB: 512 }],
  ])("refuses an invalid setting %j", (resources) => {
    expect(() => parseRequest(request({ mode: "isolated", resources }) as never)).toThrow();
  });
});
