import { createHash } from "node:crypto";
import { z } from "zod";
import { redactText } from "../evidence/redact.ts";
import type { Classification, TestOutcome } from "../verify/compare.ts";
import { type BehaviorCheck, behaviorCheckSchema, caseId } from "./spec.ts";
import type { BehaviorRun } from "./target.ts";

type Status = "pass" | "fail" | null;

/** What the predicate keeps of each behavior check: what was asked, of what, and what answered. */
export const behaviorRecordSchema = z.object({
  /** The check as the request gave it: a replay runs the same one. */
  check: behaviorCheckSchema,
  sha256: z.string(),
  /** A driver outside the target judged it; the target ran in a container or on the host. */
  assurance: z.enum(["external driver, isolated target", "external driver, host target"]),
  /** Why the candidate's cases were not measured, or null. */
  notRun: z.string().nullable(),
  cases: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      base: z.enum(["pass", "fail"]).nullable(),
      candidate: z.enum(["pass", "fail"]).nullable(),
      detail: z.string(),
    }),
  ),
});
export type BehaviorRecord = z.infer<typeof behaviorRecordSchema>;

export const behaviorLogName = (check: string, side: string) => `behavior/${check}.${side}.txt`;

function classify(base: Status, after: Status): Classification {
  if (after === "pass") return base === "pass" ? "preserved" : "fixed";
  return after === null ? "skipped" : "new-failure";
}

/**
 * Each case as an outcome against the base, with the check's authority and requirements, and
 * the record of the checks. A case the candidate's run did not measure is not observed: it
 * never counts as passing, and it is not the candidate's failure either.
 */
export function behaviorEvidence(
  checks: readonly BehaviorCheck[],
  base: readonly BehaviorRun[],
  candidate: readonly BehaviorRun[],
  isolated: boolean,
): {
  readonly outcomes: TestOutcome[];
  readonly records: BehaviorRecord[];
  readonly reasons: string[];
  readonly failures: string[];
} {
  const outcomes: TestOutcome[] = [];
  const records: BehaviorRecord[] = [];
  const reasons: string[] = [];
  const failures: string[] = [];
  for (const [at, check] of checks.entries()) {
    const after = candidate[at];
    const statusIn = (run: BehaviorRun | undefined, name: string): Status =>
      run?.cases.find((one) => one.name === name)?.status ?? null;
    const notRun = after === undefined ? "it was not run" : after.notRun;
    if (notRun !== null)
      reasons.push(
        `behavior check ${check.name} was not measured: ${notRun}; its log is ${behaviorLogName(check.name, "candidate")}`,
      );
    const cases = check.cases.map((one) => {
      const was = statusIn(base[at], one.name);
      const now = statusIn(after, one.name);
      // What the target answered is the candidate's text: redacted like any captured output.
      const said = after?.cases.find((found) => found.name === one.name)?.detail ?? "";
      const detail = redactText(said).text;
      const id = caseId(check.name, one.name);
      outcomes.push({
        id,
        title: one.name,
        file: null,
        origin: "pre-existing",
        classification: classify(was, now),
        base: was,
        after: now === null ? "skip" : now,
        before: was,
        movedTo: null,
        authority: check.authority,
        requirements: check.requirements,
      });
      if (now === "fail") failures.push(`${id} failed: ${detail}`);
      return { name: one.name, role: one.role, base: was, candidate: now, detail };
    });
    if (cases.some((one) => one.candidate === "fail"))
      reasons.push(`behavior check ${check.name} failed`);
    records.push({
      check,
      sha256: createHash("sha256").update(JSON.stringify(check)).digest("hex"),
      assurance: isolated ? "external driver, isolated target" : "external driver, host target",
      notRun,
      cases,
    });
  }
  return { outcomes, records, reasons, failures };
}
