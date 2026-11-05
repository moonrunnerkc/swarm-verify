import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requirementSchema } from "../api/request.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

/** The tree changed, nothing regressed, the checks passed and no test is mapped. */
const inputs: RequirementInputs = {
  checks: [
    {
      name: "test",
      command: "python3 -m pytest -q",
      kind: "test",
      authority: "pre-existing",
      result: "pass",
      collected: null,
      exitCode: 0,
      durationMs: 1,
      outputSha256: "0".repeat(64),
    },
  ],
  outcomes: [],
  dir: "/nonexistent",
  readBase: async () => null,
  changed: true,
  regression: {
    status: "none",
    newFailures: [],
    inherited: [],
    removed: [],
    unresolved: [],
    flaky: [],
  },
  freshDependencies: true,
  latest: new Map(),
};

/**
 * qwen3.6:35b-a3b on the orchestrator's t6 task (session 20261104T060822-ad6089): asked to move two
 * modules into a package, leave shims, move three test files and update two config lists, it
 * added two files and named no evidence; any changed source file then counted as the refactor's
 * evidence, and the run was called complete.
 */
describe("a refactor that names no structure", () => {
  const moved = requirementSchema.parse({
    id: "R1",
    text: "Move core/history_io.py into a new tracemantle/history/ package, leaving a re-export shim at the old path",
    kind: "refactor",
    source: "user",
  });

  it("is unverified though the tree changed and nothing regressed, and is told what to name", async () => {
    const [outcome] = await assessRequirements([moved], inputs);
    expect(outcome?.status).toBe("unverified");
    expect(outcome?.evidence).toEqual([]);
    expect(outcome?.nextAction).toContain('"structure"');
  });

  it("is satisfied once the structure it names holds and nothing regressed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refactor-structure-"));
    await mkdir(join(dir, "src", "tracemantle", "history"), { recursive: true });
    await writeFile(
      join(dir, "src", "tracemantle", "history", "history_io.py"),
      "def load(): ...\n",
    );
    const named = requirementSchema.parse({
      ...moved,
      evidence: {
        structure: [
          { path: "src/tracemantle/history/history_io.py", contains: "def load" },
          { path: "src/tracemantle/core/history_io.py", absent: true },
        ],
      },
    });
    const [outcome] = await assessRequirements([named], { ...inputs, dir });
    expect(outcome?.status).toBe("satisfied");
  });
});

/**
 * The comparison's ironroot refactor (session 20261105T081734-bfcef7): asked to move three
 * falsifiers into a new module, it copied them and left falsification.py as it was. Its claims
 * named only what the new file holds, and no claim could say a text had left the old one, so the
 * copy read as the move and the run was called complete.
 */
describe("a move whose text stays behind in the old file", () => {
  async function tree(oldText: string) {
    const dir = await mkdtemp(join(tmpdir(), "refactor-text-absent-"));
    await writeFile(join(dir, "builtin_claims.py"), "async def _falsify_chain(): ...\n");
    await writeFile(join(dir, "falsification.py"), oldText);
    return dir;
  }
  const moved = requirementSchema.parse({
    id: "R1",
    text: "Move _falsify_chain out of falsification.py into builtin_claims.py",
    kind: "refactor",
    source: "user",
    evidence: {
      structure: [
        { path: "builtin_claims.py", contains: "async def _falsify_chain" },
        { path: "falsification.py", contains: "async def _falsify_chain", absent: true },
      ],
    },
  });

  it("is unverified while the old file still holds the text", async () => {
    const dir = await tree("class Registry: ...\nasync def _falsify_chain(): ...\n");
    const [outcome] = await assessRequirements([moved], { ...inputs, dir });
    expect(outcome?.status).toBe("unverified");
    expect(outcome?.evidence[1]).toMatchObject({
      ref: 'falsification.py lacks "async def _falsify_chain"',
      outcome: "not observed",
      detail: "the file still contains it",
    });
  });

  it("is satisfied once the old file no longer holds it, or is gone", async () => {
    const kept = await tree("class Registry: ...\n");
    expect((await assessRequirements([moved], { ...inputs, dir: kept }))[0]?.status).toBe(
      "satisfied",
    );
    const gone = await tree("");
    const { rm } = await import("node:fs/promises");
    await rm(join(gone, "falsification.py"));
    expect((await assessRequirements([moved], { ...inputs, dir: gone }))[0]?.status).toBe(
      "satisfied",
    );
  });

  it("is told it can name a text that leaves a file", async () => {
    const bare = requirementSchema.parse({ ...moved, evidence: {} });
    const [outcome] = await assessRequirements([bare], inputs);
    expect(outcome?.nextAction).toContain('"contains": "text", "absent": true');
  });
});
