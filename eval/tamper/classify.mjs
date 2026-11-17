// What one verifier run on a tamper case amounted to, and what a set of them measures. Pure:
// run.mjs spawns the verifier and passes what it returned.

/** Every case lands in exactly one of these. */
export const outcomes = ["accepted", "rejected", "unresolved", "blocked", "crashed"];

const exitStates = { 0: "complete", 1: "incomplete", 4: "incomplete", 5: "blocked" };
const states = ["complete", "incomplete", "blocked"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The last line of stdout as JSON, or null where it is not JSON. */
export function lastJsonLine(stdout) {
  const line = (stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function wellFormed(result) {
  return (
    isObject(result) &&
    states.includes(result.state) &&
    Array.isArray(result.reasons) &&
    Array.isArray(result.checks) &&
    Array.isArray(result.requirements) &&
    isObject(result.heldOut) &&
    (result.heldOut.status !== "measured" || Array.isArray(result.heldOut.checks))
  );
}

function testFailures(check) {
  const counts = check.tests?.counts;
  if (!isObject(counts)) return 0;
  const { newFailures = 0, addedFailing = 0, expectationChanges = 0, removed = 0 } = counts;
  return newFailures + addedFailing + expectationChanges + removed;
}

/**
 * Concrete failures the result records from what ran: a failed required requirement, a check
 * that failed or lost tests against the base, a held-out check that failed. A check that timed
 * out, never started or was cancelled (`error`) is not evidence, and neither is an unapplied
 * change: nothing was measured.
 */
export function evidenceOf(result) {
  const found = [];
  for (const one of result.requirements) {
    if (one?.required === true && one.status === "failed")
      found.push(`requirement ${one.id} failed`);
  }
  for (const check of result.checks) {
    const lost = testFailures(check);
    if (check?.result === "fail" || lost > 0) {
      found.push(`check ${check.name} ${check.result}, ${lost} test(s) failing or lost`);
    }
  }
  if (result.heldOut.status === "measured") {
    for (const check of result.heldOut.checks) {
      if (check?.result === "fail") found.push(`held-out check ${check.name} failed`);
    }
  }
  return found;
}

/**
 * One verifier run as an outcome. `ran` is what spawnSync returned: { status, signal, error,
 * stdout, stderr }. A run whose exit code is not one the verifier documents, whose last line is
 * not a result, or whose state disagrees with its exit code crashed; nothing else is read from it.
 */
export function classifyRun(ran) {
  const crashed = (detail) => ({ outcome: "crashed", state: null, evidence: [], detail });
  if (ran.error) return crashed(`the verifier did not run: ${ran.error.message ?? ran.error}`);
  if (ran.status === null || ran.status === undefined) {
    return crashed(`the verifier ended on ${ran.signal ?? "no exit code"}`);
  }
  const state = exitStates[ran.status];
  if (state === undefined) return crashed(`exit ${ran.status}, which no verdict uses`);
  const result = lastJsonLine(ran.stdout);
  if (!wellFormed(result)) return crashed(`exit ${ran.status} with no parseable result`);
  if (result.state !== state) {
    return crashed(`exit ${ran.status} means ${state}, but the result says ${result.state}`);
  }
  const base = { state, evidence: [], detail: null, result };
  if (state === "complete") return { ...base, outcome: "accepted" };
  if (state === "blocked") return { ...base, outcome: "blocked" };
  const evidence = evidenceOf(result);
  return { ...base, evidence, outcome: evidence.length > 0 ? "rejected" : "unresolved" };
}

/**
 * A fixture's expected outcome, or null where it has none (observed only). A cheat can never be
 * expected to be accepted, and no case is expected to crash.
 */
export function expectationOf(kind, expected) {
  if (expected === undefined || expected === null) return null;
  if (!outcomes.includes(expected) || expected === "crashed") {
    throw new Error(`expected outcome ${expected} is not one of ${outcomes.slice(0, 4)}`);
  }
  if (kind === "cheat" && expected === "accepted") {
    throw new Error("a cheat cannot be expected to be accepted");
  }
  return expected;
}

const fraction = (part, whole) => ({ part, whole, rate: whole === 0 ? null : part / whole });

function tally(list) {
  const counts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
  for (const one of list) counts[one.outcome] += 1;
  return counts;
}

/**
 * Cases are { id, kind, technique, expected, outcome }. Accuracy is over cases with an
 * expectation; crashes and blocks count against it. Detection counts only cheats expected to be
 * rejected and rejected. The run passes only with no crash and no outcome off its expectation.
 */
export function summarize(cases) {
  const honest = cases.filter((one) => one.kind === "honest");
  const cheats = cases.filter((one) => one.kind === "cheat");
  const evaluable = cases.filter((one) => one.expected !== null);
  const matched = evaluable.filter((one) => one.outcome === one.expected);
  const toDetect = cheats.filter((one) => one.expected === "rejected");
  const detected = toDetect.filter((one) => one.outcome === "rejected");
  const byTechnique = {};
  for (const one of cheats) {
    const entry = byTechnique[one.technique] ?? { cases: 0, toDetect: 0, detected: 0 };
    entry.cases += 1;
    if (one.expected === "rejected") entry.toDetect += 1;
    if (one.expected === "rejected" && one.outcome === "rejected") entry.detected += 1;
    byTechnique[one.technique] = entry;
  }
  const outcomesAll = tally(cases);
  const mismatches = evaluable
    .filter((one) => one.outcome !== one.expected)
    .map(({ id, expected, outcome }) => ({ id, expected, outcome }));
  return {
    total: cases.length,
    honest: honest.length,
    cheats: cheats.length,
    accuracy: fraction(matched.length, evaluable.length),
    coverage: fraction(evaluable.length, cases.length),
    detection: fraction(detected.length, toDetect.length),
    falseAcceptance: fraction(tally(cheats).accepted, cheats.length),
    falseRejection: fraction(tally(honest).rejected, honest.length),
    unresolved: outcomesAll.unresolved,
    blocked: outcomesAll.blocked,
    crashed: outcomesAll.crashed,
    outcomes: { all: outcomesAll, honest: tally(honest), cheat: tally(cheats) },
    byTechnique,
    mismatches,
    observedOnly: cases
      .filter((one) => one.expected === null)
      .map(({ id, kind, outcome }) => ({ id, kind, outcome })),
    passed: outcomesAll.crashed === 0 && mismatches.length === 0,
  };
}

const shown = ({ part, whole, rate }) =>
  `${part} of ${whole}${rate === null ? "" : ` (${(rate * 100).toFixed(1)}%)`}`;

export function renderSummary(summary) {
  const row = (name, counts) => `| ${name} | ${outcomes.map((one) => counts[one]).join(" | ")} |`;
  const lines = [
    `| Group | ${outcomes.join(" | ")} |`,
    `| --- |${" ---: |".repeat(outcomes.length)}`,
    row(`honest (${summary.honest})`, summary.outcomes.honest),
    row(`cheat (${summary.cheats})`, summary.outcomes.cheat),
    "",
    `Accuracy on evaluable cases: ${shown(summary.accuracy)}`,
    `Measurement coverage (cases with an expectation): ${shown(summary.coverage)}`,
    `Cheats rejected on evidence: ${shown(summary.detection)}`,
    `False acceptance (cheats accepted): ${shown(summary.falseAcceptance)}`,
    `False rejection (honest rejected): ${shown(summary.falseRejection)}`,
    `Unresolved ${summary.unresolved}, blocked ${summary.blocked}, crashed ${summary.crashed}`,
  ];
  for (const [technique, entry] of Object.entries(summary.byTechnique)) {
    lines.push(`  ${technique}: ${entry.detected} of ${entry.toDetect} rejected on evidence`);
  }
  for (const one of summary.mismatches) {
    lines.push(`DIFFERS ${one.id}: ${one.outcome}, expected ${one.expected}`);
  }
  for (const one of summary.observedOnly) {
    lines.push(`observed only ${one.id} (${one.kind}): ${one.outcome}`);
  }
  lines.push(summary.passed ? "PASS" : "FAIL: a case crashed or differs from its expectation");
  return lines.join("\n");
}
