import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { privateHome } from "./checks.ts";
import { reportPlans, runMeasured } from "./per-test.ts";

export class HeldOutRefused extends Error {
  constructor(detail: string) {
    super(`nothing was sealed: ${detail}`);
    this.name = "HeldOutRefused";
  }
}

/** How a check run read: its exit code, and its failing and passing tests where a report was read. */
async function measure(check: DeclaredCheck, dir: string, label: string) {
  const scratch = await mkdtemp(join(tmpdir(), "swarm-verify-validate-"));
  try {
    const plans = await reportPlans(dir, [check]);
    const context = { dir, home: await privateHome(scratch), timeoutMs: 20 * 60_000 };
    const run = await runMeasured({
      check,
      plan: plans[0] ?? null,
      context,
      scratch,
      label,
      judge: false,
    });
    const report = run.evidence.report;
    const statuses = report === null ? null : Object.values(report).map((one) => one.status);
    return {
      exitCode: run.run.result.exitCode,
      failing: statuses?.filter((one) => one === "fail").length ?? null,
      passing: statuses?.filter((one) => one === "pass").length ?? null,
      tail: run.run.outputTail.slice(-600),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const git = (cwd: string, args: readonly string[]) =>
  new Promise<void>((settle, fail) =>
    execFile("git", [...args], { cwd }, (error, _out, stderr) =>
      error === null
        ? settle()
        : fail(new HeldOutRefused(`the reference patch does not apply: ${stderr.trim()}`)),
    ),
  );

/**
 * Before anything is sealed: each held-out test check, with the held-out files in place, fails at
 * the base because a test fails, not because of a gate around the tests (a coverage threshold
 * fails any run of one file with every test passing); and, given the change known to be right,
 * passes on it. A check that fails for a reason no change removes would fail every candidate.
 */
export async function validateHeldOut(input: {
  readonly workspace: string;
  readonly checks: readonly DeclaredCheck[];
  /** A patch known to complete the task, applied to a copy of the workspace. */
  readonly reference: string | null;
}): Promise<string[]> {
  const notes: string[] = [];
  for (const check of input.checks.filter((one) => one.kind === "test")) {
    const base = await measure(check, input.workspace, "validate-base");
    if (base.exitCode === 0) {
      notes.push(`held-out check ${check.name} passes at the base, so it tells no change apart`);
    } else if (base.failing === 0 && (base.passing ?? 0) > 0) {
      throw new HeldOutRefused(
        `held-out check ${check.name} exits ${base.exitCode} at the base with every one of its ${base.passing} test(s) passing, so it fails for a reason around the tests (a coverage threshold or another gate), and would fail every candidate: run it without that gate (pytest --no-cov). ${base.tail}`,
      );
    }
    if (input.reference === null) continue;
    const copy = await mkdtemp(join(tmpdir(), "swarm-verify-reference-"));
    try {
      await cp(input.workspace, copy, { recursive: true, verbatimSymlinks: true });
      await git(copy, ["apply", "--whitespace=nowarn", input.reference]);
      const after = await measure(check, copy, "validate-reference");
      if (after.exitCode !== 0) {
        throw new HeldOutRefused(
          `held-out check ${check.name} fails on the reference patch (exit ${after.exitCode}${after.failing === null ? "" : `, ${after.failing} failing test(s)`}), so no correct change could pass it: ${after.tail}`,
        );
      }
      notes.push(
        `held-out check ${check.name} fails at the base and passes on the reference patch`,
      );
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  }
  return notes;
}
