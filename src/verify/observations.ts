import { z } from "zod";
import type { TestOutcome } from "./compare.ts";
import type { CheckResult } from "./predicate.ts";

/**
 * Every test a run observed, normalized and in full: the authoritative record a statement binds
 * by digest as the log `observations.json`. The predicate's test lists are summaries capped for
 * display; nothing compares or judges by them where this record exists. Timing and paths are left
 * out, so two runs that observed the same thing write the same record.
 */
export const observationsVersion = "swarm-verify.observations/v1";
export const observationsLogName = "observations.json";
/** More observations than this and the record is not written whole: the run says so. */
export const maxObservations = 200_000;

export interface TestObservation {
  readonly id: string;
  readonly classification: string;
  readonly base: string | null;
  readonly after: string | null;
  readonly before: string | null;
  readonly origin: string;
  readonly authority: string | null;
  readonly movedTo: string | null;
  readonly requirements: readonly string[];
  readonly reruns: readonly string[];
}

export interface Observations {
  readonly version: typeof observationsVersion;
  readonly checks: readonly {
    readonly name: string;
    readonly result: string;
    readonly collected: number | null;
    readonly tests: readonly TestObservation[];
  }[];
  readonly sealed: readonly TestObservation[];
}

const normalized = (one: TestOutcome): TestObservation => ({
  id: one.id,
  classification: one.classification,
  base: one.base,
  after: one.after,
  before: one.before,
  origin: one.origin,
  authority: one.authority ?? null,
  movedTo: one.movedTo,
  requirements: [...(one.requirements ?? [])].sort(),
  reruns: one.rerun === undefined ? [] : [`${one.rerun.snapshot}:${one.rerun.results.join(",")}`],
});

const byId = (a: TestObservation, b: TestObservation) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : a.classification < b.classification ? -1 : 1;

/** The run's observations, or why they are too many to record whole. */
export function observationsOf(
  checks: readonly { readonly result: CheckResult; readonly outcomes: readonly TestOutcome[] }[],
  sealed: readonly TestOutcome[],
): { readonly record: Observations } | { readonly overflow: string } {
  const total = checks.reduce((sum, one) => sum + one.outcomes.length, sealed.length);
  if (total > maxObservations)
    return {
      overflow: `the run observed ${total} tests, more than the ${maxObservations} its evidence records whole, so its observations are incomplete`,
    };
  return {
    record: {
      version: observationsVersion,
      checks: checks.map(({ result, outcomes }) => ({
        name: result.name,
        result: result.result,
        collected: result.collected,
        tests: outcomes.map(normalized).sort(byId),
      })),
      sealed: sealed.map(normalized).sort(byId),
    },
  };
}

/**
 * Every difference between two observation records, in both directions: a test either side has
 * that the other does not, and a test both have whose observation differs. One line each.
 */
export function observationDifferences(recorded: Observations, replayed: Observations): string[] {
  const found: string[] = [];
  const compare = (
    where: string,
    before: readonly TestObservation[],
    after: readonly TestObservation[],
  ) => {
    const was = new Map(before.map((one) => [one.id, one]));
    const now = new Map(after.map((one) => [one.id, one]));
    for (const [id, one] of was) {
      const again = now.get(id);
      if (again === undefined)
        found.push(`${where}: ${id} was observed in the recording and not in the replay`);
      else if (JSON.stringify({ ...one, reruns: [] }) !== JSON.stringify({ ...again, reruns: [] }))
        found.push(`${where}: ${id} was ${describe(one)} and is ${describe(again)}`);
    }
    for (const id of now.keys())
      if (!was.has(id))
        found.push(`${where}: ${id} is observed in the replay and was not in the recording`);
  };
  const names = new Set([...recorded.checks, ...replayed.checks].map((one) => one.name));
  for (const name of [...names].sort()) {
    const before = recorded.checks.find((one) => one.name === name);
    const after = replayed.checks.find((one) => one.name === name);
    if (before === undefined || after === undefined) {
      found.push(
        `check ${name} is ${before === undefined ? "only in the replay" : "only in the recording"}`,
      );
      continue;
    }
    if (before.collected !== after.collected)
      found.push(`check ${name}: collected ${before.collected} tests, replayed ${after.collected}`);
    compare(`check ${name}`, before.tests, after.tests);
  }
  compare("held-out", recorded.sealed, replayed.sealed);
  return found;
}

const describe = (one: TestObservation) =>
  `${one.classification} (base ${one.base ?? "none"}, after ${one.after ?? "none"}, before ${one.before ?? "none"})`;

const observationSchema = z.strictObject({
  id: z.string(),
  classification: z.string(),
  base: z.string().nullable(),
  after: z.string().nullable(),
  before: z.string().nullable(),
  origin: z.string(),
  authority: z.string().nullable(),
  movedTo: z.string().nullable(),
  requirements: z.array(z.string()),
  reruns: z.array(z.string()),
});
const observationsSchema = z.strictObject({
  version: z.literal(observationsVersion),
  checks: z.array(
    z.strictObject({
      name: z.string(),
      result: z.string(),
      collected: z.number().int().nonnegative().nullable(),
      tests: z.array(observationSchema),
    }),
  ),
  sealed: z.array(observationSchema),
});

/** An observation record read back, or null where it is not one this version wrote. */
export function parseObservations(bytes: Buffer): Observations | null {
  try {
    return observationsSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}
