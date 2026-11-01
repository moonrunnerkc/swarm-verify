import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutationWitness } from "./mutation.ts";
import type { MutantOutcome } from "./per-test.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mutation-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const context = () => ({ dir, home: dir, timeoutMs: 60_000 });

describe("one mutant of the change", () => {
  // A parser's rejection fails every test that imports the file, which would read as a kill.
  it("never runs, or counts as killed, a mutant that does not parse", async () => {
    const source = "export const seen: Map<string, number> = new Map();\n";
    await writeFile(join(dir, "seen.ts"), source);
    let ran = 0;
    const outcome = async (): Promise<MutantOutcome> => {
      ran += 1;
      return "killed";
    };
    const mutation = await mutationWitness(
      [{ path: "seen.ts", status: "added", addedLines: [1] }],
      { status: "unmeasured", reason: "not measured here" },
      outcome,
      context(),
    );
    expect(mutation).toMatchObject({ status: "invalid-mutant", rejected: 1 });
    expect(ran).toBe(0);
    expect(await readFile(join(dir, "seen.ts"), "utf8")).toBe(source);
  });

  it("runs the next changed line's mutant when the first does not parse", async () => {
    const source =
      "export const seen: Map<string, number> = new Map();\nexport const half = (n: number) => n / 2 + 0;\n";
    await writeFile(join(dir, "seen.ts"), source);
    const mutation = await mutationWitness(
      [{ path: "seen.ts", status: "added", addedLines: [1, 2] }],
      { status: "unmeasured", reason: "not measured here" },
      async () => "killed",
      context(),
    );
    expect(mutation).toMatchObject({ status: "killed", line: 2, syntax: "valid", rejected: 1 });
  });
});
