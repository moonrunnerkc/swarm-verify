#!/usr/bin/env node
/**
 * Combines corpus run records (scripts/corpus.mjs --out) into one coverage report for a required
 * scope: every planned patch once, with what it was expected and observed to read. Execution and
 * agreement are reported apart: an observed-only patch ran and judged nothing.
 *
 *   node scripts/corpus-coverage.mjs --require all|public [--out report.json] <record.json>...
 *
 * Exit 0 only when every required patch reached a verdict exactly once and the records name no
 * patch the manifest does not plan; 1 otherwise, 2 for a command line it cannot read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { coverage, loadPlan, runRecordVersion } from "./corpus-plan.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { require: { type: "string" }, out: { type: "string" } },
});
if (values.require !== "all" && values.require !== "public") {
  process.stderr.write("corpus-coverage: --require all or --require public\n");
  process.exit(2);
}
const records = positionals.map((path) => {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.version !== runRecordVersion) {
    process.stderr.write(`corpus-coverage: ${path} is not a ${runRecordVersion} record\n`);
    process.exit(2);
  }
  return record;
});
const { plan, problems } = loadPlan(join(import.meta.dirname, "..", "corpus"));
const report = coverage(plan, records, values.require);
const verifiers = [
  ...new Set(records.map((one) => `${one.verifier.commit}${one.verifier.dirty ? " (dirty)" : ""}`)),
];
const output = {
  ...report,
  problems: [...problems, ...records.flatMap((one) => one.problems)],
  verifiers,
  runtimes: [...new Set(records.map((one) => `${one.runtime.node} ${one.runtime.platform}`))],
  records: records.length,
};
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
for (const row of report.rows)
  process.stdout.write(
    `${row.outcome.padEnd(11)} ${row.specification.padEnd(13)} ${row.key}${row.differences.length > 0 ? ` (${row.differences.join("; ")})` : ""}\n`,
  );
process.stdout.write(
  `coverage ${values.require}: ${JSON.stringify(report.counts)}; verifier ${verifiers.join(", ")}\n`,
);
for (const key of report.duplicates) process.stdout.write(`duplicate: ${key}\n`);
for (const key of report.unplanned) process.stdout.write(`unplanned: ${key}\n`);
for (const problem of output.problems) process.stdout.write(`problem: ${problem}\n`);
const ok = report.complete && output.problems.length === 0 && verifiers.length === 1;
process.stdout.write(
  ok ? "complete: every required patch reached a verdict once\n" : "INCOMPLETE\n",
);
process.exit(ok ? 0 : 1);
