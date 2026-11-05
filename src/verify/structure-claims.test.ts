import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { structureEvidence } from "./structure-claims.ts";

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "symbols-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const read = async (dir: string, claim: Parameters<typeof structureEvidence>[1]) => {
  const ref = await structureEvidence(dir, claim);
  return [ref.outcome, ref.detail];
};

// ironroot (2026-11-04): a copy of three falsifiers into builtin_claims.py, the old module left
// as it was, read as the move under text claims; and a move served through __getattr__.
const old = "src/ironroot/verification/falsification.py";
const moved = "src/ironroot/verification/builtin_claims.py";
const definitions =
  "async def _falsify_chain(session):\n    return None\n\n_BUILTIN_CLAIMS = (_falsify_chain,)\n";

describe("a structure claim about a Python module, read by its syntax tree", () => {
  it("tells a move from a copy", async () => {
    const move = await tree({
      [moved]: definitions,
      [old]: "from .builtin_claims import _BUILTIN_CLAIMS\n\ndef run_falsification():\n    pass\n",
    });
    const copy = await tree({
      [moved]: definitions,
      [old]: `${definitions}\ndef run_falsification():\n    pass\n`,
    });
    const gone = { path: old, symbol: "_falsify_chain", absent: true };
    expect(await read(move, gone)).toEqual(["observed", "not defined there"]);
    expect(await read(copy, gone)).toEqual(["not observed", "the module still defines it"]);
    expect(await read(move, { path: moved, symbol: "_falsify_chain" })).toEqual([
      "observed",
      "defined there",
    ]);
    expect(await read(move, { path: old, symbol: "_BUILTIN_CLAIMS", provides: true })).toEqual([
      "observed",
      "imported or re-exported there",
    ]);
  });

  it("follows import *: public names, or __all__, never an underscore name it does not list", async () => {
    const star = await tree({ [moved]: definitions, [old]: "from .builtin_claims import *\n" });
    expect(await read(star, { path: old, symbol: "_BUILTIN_CLAIMS", provides: true })).toEqual([
      "not observed",
      "an importer of the module does not get it: it is neither defined, imported nor re-exported there",
    ]);
    const listed = await tree({
      [moved]: `${definitions}__all__ = ["_BUILTIN_CLAIMS"]\n`,
      [old]: "from .builtin_claims import *\n",
    });
    expect(await read(listed, { path: old, symbol: "_BUILTIN_CLAIMS", provides: true })).toEqual([
      "observed",
      "imported or re-exported there",
    ]);
  });

  it("says a module-level __getattr__ may provide a name, and that no parser can say", async () => {
    const lazy = await tree({
      [old]:
        "def __getattr__(name):\n    from .builtin_claims import _BUILTIN_CLAIMS\n    return _BUILTIN_CLAIMS\n",
    });
    const [outcome, detail] = await read(lazy, {
      path: old,
      symbol: "_BUILTIN_CLAIMS",
      provides: true,
    });
    expect(outcome).toBe("observed");
    expect(detail).toMatch(/__getattr__ may provide it/);
  });

  it("counts a definition inside a top-level try or if, and refuses a file that is not Python", async () => {
    const guarded = await tree({
      "a.py": "try:\n    def f():\n        pass\nexcept ImportError:\n    f = None\n",
    });
    expect(await read(guarded, { path: "a.py", symbol: "f" })).toEqual([
      "observed",
      "defined there",
    ]);
    const broken = await tree({ "a.py": "def f(:\n" });
    const [outcome, detail] = await read(broken, { path: "a.py", symbol: "f" });
    expect(outcome).toBe("not observed");
    expect(detail).toMatch(/^a\.py does not parse as Python/);
  });
});

describe("a structure claim about a TypeScript module, read by the compiler", () => {
  it("reads declarations, exports, re-exports and export *", async () => {
    const dir = await tree({
      "src/cli.ts":
        "export function parseArgs(argv: string[]) { return argv; }\nconst local = 1;\n",
      "src/index.ts": 'export { parseArgs } from "./cli.js";\nexport * from "./more.js";\n',
      "src/more.ts": "export const reviewers = ['tech-debt'];\nexport default 1;\n",
    });
    expect(await read(dir, { path: "src/cli.ts", symbol: "parseArgs" })).toEqual([
      "observed",
      "defined there",
    ]);
    expect(await read(dir, { path: "src/cli.ts", symbol: "local", provides: true })).toEqual([
      "not observed",
      "an importer of the module does not get it: it is neither defined, imported nor re-exported there",
    ]);
    expect(await read(dir, { path: "src/index.ts", symbol: "parseArgs", provides: true })).toEqual([
      "observed",
      "imported or re-exported there",
    ]);
    expect(await read(dir, { path: "src/index.ts", symbol: "reviewers", provides: true })).toEqual([
      "observed",
      "imported or re-exported there",
    ]);
    expect(await read(dir, { path: "src/index.ts", symbol: "parseArgs", absent: true })).toEqual([
      "observed",
      "defined elsewhere, and still importable from here",
    ]);
  });
});
