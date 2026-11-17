import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { structureEvidence } from "./structure-claims.ts";
import { symbolsOf } from "./symbols.ts";

const made: string[] = [];
async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "symbols-runtime-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const judge = async (dir: string, claim: Parameters<typeof structureEvidence>[1]) => {
  const ref = await structureEvidence(dir, claim);
  return [ref.outcome, ref.detail ?? ""] as const;
};

describe("a provides claim a parser cannot establish is never observed", () => {
  it("leaves a name behind a module-level __getattr__ unresolved, naming the dynamic lookup", async () => {
    const dir = await tree({
      "lazy.py": "def __getattr__(name):\n    raise AttributeError(name)\n",
    });
    const [outcome, detail] = await judge(dir, { path: "lazy.py", symbol: "nope", provides: true });
    expect(outcome).toBe("unresolved");
    expect(detail).toMatch(/__getattr__/);
    expect(detail).toMatch(/a test that imports nope/);
  });

  it("leaves a Python name bound only on some paths unresolved, and one bound on every path observed", async () => {
    const dir = await tree({
      "flag.py":
        "import os\nif os.environ.get('X'):\n    def g():\n        pass\nwith open(__file__):\n    h = 1\n",
      "both.py":
        "if True:\n    k = 1\nelse:\n    k = 2\ntry:\n    import json as j\nexcept ImportError:\n    j = None\n",
    });
    for (const claim of [
      { path: "flag.py", symbol: "g", provides: true },
      { path: "flag.py", symbol: "g" },
      { path: "flag.py", symbol: "h", provides: true },
    ]) {
      const [outcome, detail] = await judge(dir, claim);
      expect(outcome).toBe("unresolved");
      expect(detail).toMatch(/only on some paths through it/);
    }
    expect((await judge(dir, { path: "flag.py", symbol: "g", absent: true }))[0]).toBe(
      "not observed",
    );
    expect(await judge(dir, { path: "both.py", symbol: "k", provides: true })).toEqual([
      "observed",
      "defined there",
    ]);
    expect((await judge(dir, { path: "both.py", symbol: "j", provides: true }))[0]).toBe(
      "observed",
    );
  });

  it("leaves a name an unreadable import * might bring unresolved, naming the module", async () => {
    const dir = await tree({ "star.py": "from os.path import *\n" });
    const [outcome, detail] = await judge(dir, { path: "star.py", symbol: "join", provides: true });
    expect(outcome).toBe("unresolved");
    expect(detail).toMatch(/os\.path/);
  });

  it("does not take a TypeScript type for a runtime export", async () => {
    const dir = await tree({
      "types.ts":
        "export interface Shape { a: 1 }\nexport const both = 1;\nexport type both = number;\n",
      "index.ts": [
        "export type Foo = string;",
        'import type { Shape } from "./types.js";',
        "export { Shape };",
        'export { type both as alias } from "./types.js";',
        'export type { both as other } from "./types.js";',
        "export declare const ambient: number;",
        "export const real = 1;",
      ].join("\n"),
    });
    for (const symbol of ["Foo", "Shape", "alias", "other", "ambient"]) {
      const [outcome, detail] = await judge(dir, { path: "index.ts", symbol, provides: true });
      expect([symbol, outcome]).toEqual([symbol, "unresolved"]);
      expect(detail).toMatch(/only as a type/);
    }
    expect((await judge(dir, { path: "types.ts", symbol: "both", provides: true }))[0]).toBe(
      "observed",
    );
    expect((await judge(dir, { path: "types.ts", symbol: "Shape", provides: true }))[0]).toBe(
      "unresolved",
    );
    expect((await judge(dir, { path: "index.ts", symbol: "real", provides: true }))[0]).toBe(
      "observed",
    );
    expect((await judge(dir, { path: "index.ts", symbol: "Foo" }))[0]).toBe("observed");
  });

  it("leaves a name an unreadable export * might bring unresolved, naming the module", async () => {
    const dir = await tree({
      "index.ts": 'export * from "some-package";\nexport * from "./gone.js";\n',
    });
    const [outcome, detail] = await judge(dir, { path: "index.ts", symbol: "x", provides: true });
    expect(outcome).toBe("unresolved");
    expect(detail).toMatch(/some-package/);
    expect(detail).toMatch(/\.\/gone\.js/);
  });
});

describe("reading a Python module's names", () => {
  it("never runs a module the checkout holds, whatever it is named", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "symbols-marker-"));
    made.push(markerDir);
    const touched = join(markerDir, "ran");
    const plant = `open(${JSON.stringify(touched)}, "w").write("ran")\n`;
    const dir = await tree({
      "ast.py": plant,
      "json.py": plant,
      "os.py": plant,
      "sitecustomize.py": plant,
      "pkg/ast.py": plant,
      "pkg/mod.py": "from .other import *\nx = 1\n",
      "pkg/other.py": "y = 2\n",
    });
    const read = await symbolsOf(dir, "pkg/mod.py");
    expect("provided" in read && [...read.provided].sort()).toEqual(["x", "y"]);
    await expect(access(touched)).rejects.toThrow();
  });
});
