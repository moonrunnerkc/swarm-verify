import { z } from "zod";

/**
 * Per-container bounds on project-controlled code. They come from the caller (request, command
 * line, Action input), never from the candidate's tree, and bound each container separately:
 * concurrent runs on one host can together use more.
 */
export const resourcesSchema = z.strictObject({
  /** Memory in MiB. Swap is never granted: --memory-swap equals --memory. */
  memoryMiB: z.int().min(64).max(1_048_576),
  /** CPUs, a CFS quota over docker's 100 ms period. */
  cpus: z.number().min(0.1).max(1024),
});
export type Resources = z.output<typeof resourcesSchema>;

/**
 * 4 GiB and 2 CPUs: the full corpus (npm, pnpm and uv projects, vitest, jest, pytest suites)
 * prepares and runs within them, and a GitHub-hosted runner (4 CPUs, 16 GB) holds them.
 */
export const defaultResources: Resources = { memoryMiB: 4096, cpus: 2 };

/** The docker run flags that impose `limits`, swap included. */
export function resourceArgs(limits: Resources): string[] {
  return [
    `--memory=${limits.memoryMiB}m`,
    `--memory-swap=${limits.memoryMiB}m`,
    `--cpus=${limits.cpus}`,
  ];
}

/** What the kernel applied to a container, read from its own cgroup. */
export const resourceRecordSchema = z.strictObject({
  requested: resourcesSchema,
  effective: z.strictObject({
    memoryBytes: z.int().positive(),
    swapBytes: z.int().nonnegative(),
    cpus: z.number().positive(),
    cgroup: z.enum(["v1", "v2"]),
  }),
  scope: z.literal("per-container"),
});
export type ResourceRecord = z.output<typeof resourceRecordSchema>;

/** Prints each cgroup limit file a container can see, v2 first, as `name=value` lines. */
export const limitsProbe =
  'for f in memory.max memory.swap.max cpu.max memory/memory.limit_in_bytes memory/memory.memsw.limit_in_bytes cpu/cpu.cfs_quota_us cpu/cpu.cfs_period_us; do v=$(cat "/sys/fs/cgroup/$f" 2>/dev/null) && echo "$f=$v"; done; exit 0';

const whole = (value: string | undefined): number | null =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : null;

/**
 * The bounds a probe container read, checked against what was asked. Any limit the kernel did
 * not apply (a missing controller, `max`, a different value) is a problem: the run that needed it
 * is blocked rather than run unbounded.
 */
export function effectiveResources(
  requested: Resources,
  printed: string,
): { readonly record: ResourceRecord } | { readonly problem: string } {
  const read = new Map(
    printed
      .split("\n")
      .map((line) => line.trim().split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const v2 = read.has("memory.max");
  const memoryBytes = whole(read.get(v2 ? "memory.max" : "memory/memory.limit_in_bytes"));
  const total = whole(read.get("memory/memory.memsw.limit_in_bytes"));
  const swapBytes = v2
    ? whole(read.get("memory.swap.max"))
    : total === null || memoryBytes === null
      ? null
      : total - memoryBytes;
  const [quota, period] = v2
    ? (read.get("cpu.max") ?? "").split(" ").map(whole)
    : [whole(read.get("cpu/cpu.cfs_quota_us")), whole(read.get("cpu/cpu.cfs_period_us"))];
  const cpus = quota === null || quota === undefined || !period ? null : quota / period;
  const wanted = requested.memoryMiB * 1024 * 1024;
  if (memoryBytes !== wanted)
    return {
      problem: `docker did not apply the ${requested.memoryMiB} MiB memory limit (the container's cgroup reads ${memoryBytes ?? "no limit"})`,
    };
  if (swapBytes !== 0)
    return {
      problem: `docker could not deny the container swap (the cgroup reads ${swapBytes ?? "no swap limit"}); enable swap accounting on the docker host`,
    };
  if (cpus === null || Math.abs(cpus - requested.cpus) > 0.01)
    return {
      problem: `docker did not apply the ${requested.cpus} CPU limit (the container's cgroup reads ${cpus ?? "no quota"})`,
    };
  return {
    record: {
      requested,
      effective: { memoryBytes, swapBytes, cpus, cgroup: v2 ? "v2" : "v1" },
      scope: "per-container",
    },
  };
}

/** The bounds in a sentence, for the execution statement and preflight. */
export function describeResources(limits: Resources): string {
  return `memory ${limits.memoryMiB} MiB with no swap and ${limits.cpus} CPU${limits.cpus === 1 ? "" : "s"}, per container`;
}
