import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedDiagnostics, readDiagnostics } from "./diagnostics.ts";

// depose at 3429b76 (2026-11-06): `tsc --build --noEmit` fails at the base on project references
// that disable emit, and on modules the workspace links did not provide.
const depose = readFileSync(
  join(import.meta.dirname, "fixtures", "reports", "tsc-depose-typecheck.txt"),
  "utf8",
);

describe("compiler diagnostics a check printed", () => {
  it("reads each tsc error by file, code and message, without its line and column", () => {
    const read = readDiagnostics(depose);
    expect(read).toHaveLength(11);
    expect(read?.[0]).toBe(
      "packages/core/src/reconstruct/destructive-rules.ts: TS2307: Cannot find module 'yaml' or its corresponding type declarations.",
    );
  });

  it("reads the file:line:col form other compilers and type checkers print", () => {
    const text = [
      'src/app.py:12: error: Incompatible return value type (got "int", expected "str")  [return-value]',
      "src/main.c:4:10: error: unknown type name 'size_tt'",
      "Found 2 errors in 2 files (checked 9 source files)",
    ].join("\n");
    expect(readDiagnostics(text)).toEqual([
      'src/app.py: Incompatible return value type (got "int", expected "str")  [return-value]',
      "src/main.c: unknown type name 'size_tt'",
    ]);
  });

  it("reads none where a run printed no diagnostic, or was cut at the output cap", () => {
    expect(readDiagnostics("1 failed, 3 passed")).toBeNull();
    expect(readDiagnostics(depose, true)).toBeNull();
  });

  it("reads an error that names no file, which a candidate could add as well as any", () => {
    expect(
      readDiagnostics("error TS5083: Cannot read file '/work/tree/tsconfig.base.json'."),
    ).toEqual(["TS5083: Cannot read file '/work/tree/tsconfig.base.json'."]);
  });

  it("strips terminal colors before it reads", () => {
    const colored =
      "\u001b[96msrc/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable to type 'number'.";
    expect(readDiagnostics(colored)).toEqual([
      "src/a.ts: TS2322: Type 'string' is not assignable to type 'number'.",
    ]);
  });
});

describe("the diagnostics a candidate adds", () => {
  it("are none where the candidate prints the base's, on whatever lines they moved to", () => {
    const moved = depose.replace("destructive-rules.ts(19,36)", "destructive-rules.ts(31,36)");
    expect(addedDiagnostics(readDiagnostics(depose) ?? [], readDiagnostics(moved) ?? [])).toEqual(
      [],
    );
  });

  it("count a repeat of one the base printed once", () => {
    const line =
      "packages/chain/src/hash-chain.ts(40,9): error TS2307: Cannot find module '@depose/core' or its corresponding type declarations.";
    const head = readDiagnostics(`${depose}\n${line}`) ?? [];
    expect(addedDiagnostics(readDiagnostics(depose) ?? [], head)).toEqual([
      "packages/chain/src/hash-chain.ts: TS2307: Cannot find module '@depose/core' or its corresponding type declarations.",
    ]);
  });
});
