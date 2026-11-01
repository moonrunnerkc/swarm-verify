import type { Predicate } from "./predicate.ts";

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

/** Whether anything in the result failed outright, as opposed to staying unverified. */
export function somethingFailed(predicate: Predicate): boolean {
  return (
    !predicate.change.applied ||
    predicate.regression.status === "found" ||
    predicate.checks.some((check) => check.result === "fail" || check.result === "error") ||
    (predicate.heldOut.status === "measured" && predicate.heldOut.heldOutPassRate < 1) ||
    predicate.requirements.some((one) => one.required && one.status === "failed")
  );
}

/**
 * 0 complete; 1 incomplete because something failed; 4 incomplete because something stayed
 * unverified or unresolved; 5 blocked. 2 (unreadable command line) and 3 (cancelled) come
 * from the command line itself.
 */
export function exitCodeOf(predicate: Predicate): number {
  if (predicate.state === "complete") return 0;
  if (predicate.state === "blocked") return 5;
  return somethingFailed(predicate) ? 1 : 4;
}

function lines(predicate: Predicate): readonly (readonly [string, string])[] {
  const rows: [string, string][] = [
    [
      "state",
      predicate.scope === "regression-only"
        ? `${predicate.state} (regression only: no requirements were declared)`
        : predicate.state,
    ],
  ];
  for (const reason of predicate.reasons) rows.push(["reason", reason]);
  for (const requirement of predicate.requirements) {
    const why = requirement.limitation === null ? "" : `: ${requirement.limitation}`;
    rows.push([
      "requirement",
      `${requirement.id} ${requirement.status}${why} (${requirement.text})`,
    ]);
  }
  const regression = predicate.regression;
  rows.push([
    "regression",
    `${regression.status}${regression.newFailures.length > 0 ? `: new failures ${regression.newFailures.slice(0, 5).join(", ")}` : ""}${regression.inherited.length > 0 ? `; ${regression.inherited.length} inherited` : ""}${regression.unresolved.length > 0 ? `; unresolved ${regression.unresolved.join(", ")}` : ""}${regression.flaky.length > 0 ? `; flaky ${regression.flaky.slice(0, 5).join(", ")}` : ""}`,
  ]);
  rows.push(["base", predicate.base.commit]);
  rows.push([
    "change",
    `${predicate.change.files.length} file(s) from the ${predicate.change.source}`,
  ]);
  for (const check of predicate.checks) {
    rows.push(["check", `${check.name}: ${check.result} (${check.command}, ${check.authority})`]);
  }
  const baseline = predicate.baseline;
  const atBase = baseline.status === "measured" ? baseline.checks : [];
  rows.push([
    "baseline",
    baseline.status === "measured"
      ? `${atBase.filter((check) => check.result === "pass").length} of ${atBase.length} check(s) pass at the base commit${baseline.cached ? " (reused)" : ""}`
      : `unmeasured: ${baseline.reason}`,
  ]);
  const heldOut = predicate.heldOut;
  rows.push([
    "held-out",
    heldOut.status === "measured"
      ? `visible ${percent(heldOut.visiblePassRate)}, held-out ${percent(heldOut.heldOutPassRate)}, gap ${percent(heldOut.gap)}, judged in ${heldOut.judge.processes} process(es)`
      : `unmeasured: ${heldOut.reason}`,
  ]);
  const files = predicate.testFiles;
  const touched = [
    files.added.length > 0 ? `${files.added.length} added` : "",
    files.modified.length > 0 ? `${files.modified.length} modified` : "",
    files.deleted.length > 0 ? `${files.deleted.length} deleted` : "",
    files.moved.length > 0 ? `${files.moved.length} moved` : "",
    files.relocated.length > 0 ? `${files.relocated.length} with only imports changed` : "",
  ].filter(Boolean);
  if (touched.length > 0) rows.push(["test files", touched.join(", ")]);
  const coverage = predicate.coverage;
  rows.push([
    "coverage",
    coverage.status === "measured"
      ? `${coverage.coveredLines} of ${coverage.changedLines} changed line(s) covered (${coverage.tool})`
      : `unmeasured: ${coverage.reason}`,
  ]);
  const mutation = predicate.mutation;
  rows.push([
    "mutation",
    mutation.status === "unmeasured"
      ? `unmeasured: ${mutation.reason}`
      : mutation.status === "invalid-mutant"
        ? `invalid-mutant: ${mutation.reason}`
        : `${mutation.status}: ${mutation.operator} at ${mutation.path}:${mutation.line}${mutation.rejected > 0 ? ` (${mutation.rejected} unparsable mutant(s) refused first)` : ""}`,
  ]);
  const execution = predicate.execution;
  rows.push([
    "execution",
    `${execution.statement}; dependencies ${execution.dependencies.note}${execution.problems.length > 0 ? `; ${execution.problems.join("; ")}` : ""}`,
  ]);
  rows.push(["environment", `sha256:${predicate.environment.sha256}`]);
  return rows;
}

export function renderText(predicate: Predicate): string {
  return lines(predicate)
    .map(([label, value]) => `${label.padEnd(12)} ${value}`)
    .join("\n");
}

export function renderMarkdown(predicate: Predicate): string {
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `### swarm-verify: ${predicate.state}`,
    "",
    "| | |",
    "| --- | --- |",
    ...lines(predicate).map(([label, value]) => `| ${label} | ${cell(value)} |`),
    "",
  ].join("\n");
}
