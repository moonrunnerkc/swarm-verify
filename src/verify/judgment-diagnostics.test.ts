import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestFileChanges } from "./compare.ts";
import { readDiagnostics } from "./diagnostics.ts";
import { judgeCheck } from "./judgment.ts";
import type { MeasuredRun } from "./per-test.ts";

// depose at 3429b76 and fix-claimcheck-d2f136c (2026-11-06): typecheck and build failed at the
// base, and every candidate's identical failure was unresolved, so no patch could be complete.
const depose = readFileSync(
  join(import.meta.dirname, "fixtures", "reports", "tsc-depose-typecheck.txt"),
  "utf8",
);
const added =
  "packages/core/src/events/ids.ts(52,7): error TS2322: Type 'string' is not assignable to type 'number'.";

const none: TestFileChanges = {
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
  moved: new Map(),
  movedAndEdited: new Map(),
  relocated: new Set(),
};

const run = (output: string, exitCode = 1, truncated = false): MeasuredRun => ({
  run: {
    result: {
      name: "typecheck",
      command: "pnpm run typecheck",
      kind: "other",
      authority: "pre-existing",
      result: exitCode === 0 ? "pass" : "fail",
      collected: null,
      exitCode,
      durationMs: 1,
      outputSha256: "0".repeat(64),
    },
    output,
    outputTail: output.slice(-4000),
    notRun: null,
    diagnostics: exitCode === 0 ? null : readDiagnostics(output, truncated),
  },
  evidence: { runner: null, report: null, unreadable: null, judge: null },
});

const judge = (base: MeasuredRun, head: MeasuredRun) =>
  judgeCheck({
    base,
    obligation: head,
    candidate: head,
    witness: null,
    changes: none,
    behaviorChange: "none",
    reruns: [],
  });

describe("a check without a runner report that fails at both commits", () => {
  it("inherits its failure where the candidate prints only the base's diagnostics", () => {
    const moved = depose.replace("hash-chain.ts(18,59)", "hash-chain.ts(24,59)");
    const judged = judge(run(depose), run(moved));
    expect(judged.run.result.result).toBe("inherited-failures");
    expect(judged.unmeasured).toBeNull();
    expect(judged.failure).toBeNull();
    expect(judged.reasons).toEqual([
      "check typecheck: 11 diagnostic(s) it printed at the base commit it still prints, and the candidate adds none, compared by file, code and message",
    ]);
  });

  it("fails where the candidate adds a diagnostic, naming it", () => {
    const judged = judge(run(depose), run(`${depose}\n${added}`));
    expect(judged.run.result.result).toBe("fail");
    expect(judged.failure).toContain(added);
    expect(judged.reasons).toEqual([
      "check typecheck: 1 diagnostic(s) the candidate adds: packages/core/src/events/ids.ts: TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
  });

  it("stays unresolved where either run printed no diagnostic to compare", () => {
    expect(judge(run(depose), run("Killed")).run.result.result).toBe("unresolved");
    expect(judge(run("make: *** [build] Error 1"), run(depose)).run.result.result).toBe(
      "unresolved",
    );
  });

  it("stays unresolved where a run's output was cut, whatever the kept part holds", () => {
    expect(judge(run(depose), run(depose, 1, true)).run.result.result).toBe("unresolved");
  });
});
