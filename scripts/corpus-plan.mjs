/**
 * The corpus as a plan and its runs as records, kept apart from running anything: which patches
 * exist, how fully each one's expectation is specified, what a selection covers, and whether a
 * set of run records covers a required scope exactly once. scripts/corpus.mjs runs patches and
 * writes records; scripts/corpus-coverage.mjs combines them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const runRecordVersion = "swarm-verify.corpus-run/v1";

/** A patch's identity across runs. */
export const keyOf = (one) => `${one.id}/${one.patch}`;

/**
 * How much of a verdict the record fixes. full: the state, every requirement and (where the entry
 * seals held-out checks) the held-out result. observed-only: none of them, so agreement means
 * nothing. partial: some.
 */
export function specification(expected, entry) {
  if (expected === null || expected === undefined) return "observed-only";
  const fixed = [
    expected.state !== null && expected.state !== undefined,
    ...Object.values(expected.requirements ?? {}).map((status) => status !== null),
  ];
  const heldOut = expected.heldOut !== null && expected.heldOut !== undefined;
  if (entry.heldOut !== null) fixed.push(heldOut);
  if (fixed.every(Boolean) && fixed.length > 0) return "full";
  return fixed.some(Boolean) || heldOut ? "partial" : "observed-only";
}

/** Every patch in the manifest, in order, with its entry's facts and its file's digest. */
export function loadPlan(corpus) {
  const plan = [];
  const problems = [];
  for (const id of JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"))) {
    const path = join(corpus, id, "entry.json");
    if (!existsSync(path)) {
      problems.push(`${id}: the manifest names it and it has no entry.json`);
      continue;
    }
    const entry = JSON.parse(readFileSync(path, "utf8"));
    for (const patch of entry.patches) {
      const file = join(corpus, id, patch.file);
      const sha256 = existsSync(file)
        ? createHash("sha256").update(readFileSync(file)).digest("hex")
        : null;
      if (sha256 === null) problems.push(`${id}/${patch.name}: ${patch.file} is missing`);
      else if (sha256 !== patch.sha256)
        problems.push(
          `${id}/${patch.name}: ${patch.file} is ${sha256}, the entry records ${patch.sha256}`,
        );
      plan.push({
        id,
        patch: patch.name,
        file,
        sha256,
        local: entry.local === true,
        expected: patch.expected ?? null,
        specification: specification(patch.expected ?? null, entry),
      });
    }
  }
  return { plan, problems };
}

/**
 * The patches a run's filters select, and every filter name that selects nothing: a typo never
 * narrows a run silently.
 */
export function select(plan, filters) {
  const only = filters.only ?? null;
  const patches = filters.patches ?? null;
  const ids = new Set(plan.map((one) => one.id));
  const unmatched = [
    ...(only ?? []).filter((id) => !ids.has(id)).map((id) => `--only ${id}`),
    ...(patches ?? [])
      .filter(
        (name) =>
          !plan.some((one) => (only === null || only.includes(one.id)) && one.patch === name),
      )
      .map((name) => `--patches ${name}`),
  ];
  const selected = plan.filter(
    (one) =>
      (only === null || only.includes(one.id)) && (patches === null || patches.includes(one.patch)),
  );
  return { selected, unmatched };
}

/** Every expected status that is set and differs from what was observed. */
export function differences(expected, seen) {
  if (expected === null) return [];
  const found = [];
  if (expected.state !== null && expected.state !== seen.state)
    found.push(`state ${seen.state}, expected ${expected.state}`);
  for (const [id, status] of Object.entries(expected.requirements ?? {}))
    if (status !== null && seen.requirements[id] !== status)
      found.push(`${id} ${seen.requirements[id] ?? "absent"}, expected ${status}`);
  if (expected.heldOut != null && expected.heldOut !== seen.heldOut)
    found.push(`held-out ${seen.heldOut ?? "not measured"}, expected ${expected.heldOut}`);
  return found;
}

/** A verdict's outcome against its expectation: agrees, differs, or observed where nothing is fixed. */
export function judged(planned, seen) {
  const found = differences(planned.expected, seen);
  const outcome =
    found.length > 0
      ? "differs"
      : planned.specification === "observed-only"
        ? "observed"
        : "agrees";
  return { outcome, differences: found };
}

const executed = (one) =>
  one.outcome === "agrees" || one.outcome === "differs" || one.outcome === "observed";

/**
 * What a set of run records covers of a required scope ("all" or "public"): every required patch
 * once, its outcome, and what is missing, duplicated or unplanned. Execution and agreement are
 * counted apart; complete means every required patch ran to a verdict exactly once.
 */
export function coverage(plan, records, scope) {
  const required = plan.filter((one) => scope === "all" || !one.local);
  const seen = new Map();
  const unplanned = [];
  for (const record of records)
    for (const result of record.results) {
      const key = keyOf(result);
      if (!plan.some((one) => keyOf(one) === key)) unplanned.push(key);
      seen.set(key, [...(seen.get(key) ?? []), result]);
    }
  const duplicates = [...seen]
    .filter(([, all]) => all.filter(executed).length > 1)
    .map(([key]) => key);
  const rows = required.map((one) => {
    const all = seen.get(keyOf(one)) ?? [];
    const result = all.find(executed) ?? all[0] ?? null;
    return {
      key: keyOf(one),
      specification: one.specification,
      expected: one.expected,
      outcome: result?.outcome ?? "missing",
      observed: result?.observed ?? null,
      differences: result?.differences ?? [],
    };
  });
  const count = (test) => rows.filter(test).length;
  const counts = {
    planned: required.length,
    executed: count((row) => executed(row)),
    agrees: count((row) => row.outcome === "agrees"),
    agreesFull: count((row) => row.outcome === "agrees" && row.specification === "full"),
    agreesPartial: count((row) => row.outcome === "agrees" && row.specification === "partial"),
    differs: count((row) => row.outcome === "differs"),
    observedOnly: count((row) => row.outcome === "observed"),
    setupFailed: count((row) => row.outcome === "not set up"),
    noVerdict: count((row) => row.outcome === "no verdict"),
    notRun: count((row) => row.outcome === "not run"),
    missing: count((row) => row.outcome === "missing"),
    duplicates: duplicates.length,
    unplanned: unplanned.length,
  };
  const complete =
    counts.executed === counts.planned && counts.duplicates === 0 && counts.unplanned === 0;
  return { scope, complete, counts, rows, duplicates, unplanned };
}
