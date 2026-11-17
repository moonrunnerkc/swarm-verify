import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostExecution } from "./checks.ts";
import { mutationWitness, parses } from "./mutation.ts";

let dir = "";
let markers = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mutation-shadow-"));
  markers = await mkdtemp(join(tmpdir(), "mutation-markers-"));
  const marker = (name: string) =>
    `open(${JSON.stringify(join(markers, name))}, "w").write("ran")\n`;
  await writeFile(join(dir, "ast.py"), marker("ast"));
  await writeFile(join(dir, "json.py"), marker("json"));
  await writeFile(join(dir, "sitecustomize.py"), marker("sitecustomize"));
  await writeFile(join(dir, "usercustomize.py"), marker("usercustomize"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(markers, { recursive: true, force: true });
});

// F2 (2026-11-17 review): the mutation pass parsed Python with the host's python3 started in the
// candidate's tree without isolation, so a candidate ast.py ran on the host.
describe("parsing a Python mutant beside candidate module shadows", () => {
  it("parses with the standard library and runs none of the candidate's files", async () => {
    const valid = await parses("half.py", "def half(n):\n    return n / 2\n", dir);
    const invalid = await parses("half.py", "def half(n):\n    return (n / 2\n", dir);
    expect(await readdir(markers)).toEqual([]);
    expect(valid).toBe(true);
    expect(invalid).toBe(false);
  });

  it("runs none of them through a whole mutation pass either", async () => {
    await writeFile(join(dir, "half.py"), "def half(n):\n    return n >= 2\n");
    const mutation = await mutationWitness(
      [{ path: "half.py", status: "modified", addedLines: [2] }] as never,
      { status: "unmeasured", reason: "not measured" },
      async () => "killed",
      { dir, home: dir, timeoutMs: 60_000, execution: hostExecution },
    );
    expect(mutation.status).toBe("killed");
    expect(await readdir(markers)).toEqual([]);
  });
});
