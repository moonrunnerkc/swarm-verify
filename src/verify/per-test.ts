import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import type { CheckContext, CheckRun } from "./checks.ts";
import { runCheck } from "./checks.ts";
import { prepareJudge, readJudge } from "./judge.ts";
import { type ReportPlan, reportPlan } from "./report-plan.ts";
import { parseReport, type TestEvidence } from "./test-report.ts";

export interface MeasuredRun {
  readonly run: CheckRun;
  readonly evidence: TestEvidence;
}

export type Wrap = (check: DeclaredCheck) => {
  readonly check: DeclaredCheck;
  readonly env: Readonly<Record<string, string>>;
};

/** Report plans for the declared checks, read against the base's package.json scripts. */
export async function reportPlans(
  dir: string,
  checks: readonly DeclaredCheck[],
): Promise<readonly (ReportPlan | null)[]> {
  let scripts: Record<string, unknown> = {};
  try {
    scripts = JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts ?? {};
  } catch {
    // No manifest, or one that does not parse: only commands that name a runner are recognized.
  }
  return checks.map((check) => reportPlan(check.command, scripts));
}

async function goModule(dir: string): Promise<string | null> {
  const text = await readFile(join(dir, "go.mod"), "utf8").catch(() => "");
  return /^module\s+(\S+)/m.exec(text)?.[1] ?? null;
}

/** Environments laid over each other, with NODE_OPTIONS joined rather than replaced. */
function mergeEnv(...layers: readonly Readonly<Record<string, string>>[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      merged[name] =
        name === "NODE_OPTIONS" && merged[name] !== undefined ? `${merged[name]} ${value}` : value;
    }
  }
  return merged;
}

/**
 * Runs a declared check with its runner's reporter attached and, for a test check, the judge
 * loaded. The recorded command stays the declared one; `collected` comes from the report where
 * there is one.
 */
export async function runMeasured(input: {
  readonly check: DeclaredCheck;
  readonly plan: ReportPlan | null;
  readonly context: CheckContext;
  readonly scratch: string;
  readonly label: string;
  readonly judge: boolean;
  readonly wrap?: Wrap | null | undefined;
}): Promise<MeasuredRun> {
  const { check, plan, context } = input;
  const directory = join(input.scratch, "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${input.label}-${check.name.replace(/[^\w.-]/g, "_")}.report`);
  await rm(file, { force: true });
  const reported = plan === null ? check : { ...check, command: plan.command(file) };
  const wrapped = input.wrap?.(reported) ?? { check: reported, env: {} };
  const judge =
    input.judge && check.kind === "test"
      ? await prepareJudge(input.scratch, `${input.label}-${check.name}`, context.dir)
      : null;
  const env = mergeEnv(judge?.env ?? {}, plan?.env(file) ?? {}, wrapped.env);
  const ran = await runCheck(wrapped.check, context, env);
  const run = { ...ran, result: { ...ran.result, command: check.command } };
  const judged = judge === null ? null : (await readJudge(judge.report)).problem;
  if (plan === null) {
    return { run, evidence: { runner: null, report: null, unreadable: null, judge: judged } };
  }
  const text = run.notRun === null ? await readFile(file, "utf8").catch(() => null) : null;
  const report =
    text === null ? null : parseReport(plan.runner, text, context.dir, await goModule(context.dir));
  const unreadable =
    run.notRun !== null
      ? `the command could not run: ${run.notRun}`
      : text === null
        ? `the ${plan.runner} report could not be parsed: the command wrote none`
        : report === null
          ? `the ${plan.runner} report could not be parsed`
          : null;
  const collected = report === null ? run.result.collected : Object.keys(report).length;
  return {
    run: { ...run, result: { ...run.result, collected } },
    evidence: { runner: plan.runner, report, unreadable, judge: judged },
  };
}

export type MutantOutcome = "killed" | "survived" | "timeout" | "runner-crash";

/**
 * What a mutant did to a test check that passed with the candidate. Killed only when a test
 * that passed now fails in the mutant's report; a run that timed out, or that wrote no report
 * (a loader or syntax failure, not an assertion), is told apart. Without a report, a check that
 * printed failing tests counts, and any other non-zero exit is a crash.
 */
export function mutantOutcome(head: MeasuredRun, mutant: MeasuredRun): MutantOutcome {
  if (mutant.run.notRun === "it timed out") return "timeout";
  const before = head.evidence.report;
  if (before !== null) {
    const after = mutant.evidence.report;
    if (after === null) return "runner-crash";
    const broke = Object.entries(before).some(
      ([id, entry]) =>
        entry.status === "pass" && after[id] !== undefined && after[id]?.status !== "pass",
    );
    if (broke) return "killed";
    const lost = Object.entries(before).some(
      ([id, entry]) => entry.status === "pass" && after[id] === undefined,
    );
    return lost ? "runner-crash" : "survived";
  }
  if (head.run.result.exitCode !== 0 || mutant.run.result.result === "pass") return "survived";
  return mutant.run.result.exitCode === 1 ? "killed" : "runner-crash";
}
