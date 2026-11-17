import { dirname, join, normalize } from "node:path";
import ts from "typescript-compiler";
import { moduleText, readCandidateText, type SymbolProblem } from "./candidate-read.ts";
import { pythonSymbols } from "./symbols-python.ts";

/** The top-level names a module defines and the names importing it provides, read by its parser. */
export interface ModuleSymbols {
  /** Declared in the module itself: a function, class, variable, type or assignment. */
  readonly defined: ReadonlySet<string>;
  /** Importable from it: its exports (TypeScript) or its namespace (Python), re-exports included. */
  readonly provided: ReadonlySet<string>;
  /** Bound only on some paths through a Python module: inside a top-level if, try, with or loop. */
  readonly conditional: ReadonlySet<string>;
  /** Exported only as a TypeScript type, which compiles away: an importer gets no value. */
  readonly typeOnly: ReadonlySet<string>;
  /** A Python module-level `__getattr__`, which may provide any name; a parser cannot say which. */
  readonly dynamic: boolean;
  /** Each `import *` or `export *` whose module was not read, with why: it may provide any name. */
  readonly unread: readonly string[];
}

export type { SymbolProblem };

export type SymbolRead = ModuleSymbols | SymbolProblem;

const tsExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isPython = (path: string) => path.endsWith(".py");

/** A relative specifier as the file it names in the tree, or why it names none that is read. */
async function resolveScript(
  dir: string,
  from: string,
  spec: string,
): Promise<{ path: string } | { why: string }> {
  if (!spec.startsWith(".")) return { why: "a package, not a file in the checkout" };
  const base = normalize(join(dirname(from), spec));
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    base,
    ...tsExtensions.map((ext) => `${stem}${ext}`),
    ...tsExtensions.map((ext) => join(stem, `index${ext}`)),
  ];
  for (const one of candidates) {
    const read = await readCandidateText(dir, one);
    if (read.kind === "file") return { path: one };
    if (read.kind === "link" || read.kind === "refused" || read.kind === "unreadable")
      return { why: read.detail };
  }
  return { why: "no file in the checkout" };
}

const has = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((one) => one.kind === kind);

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
}

/** The names a top-level declaration binds, and whether they are types alone (erased at runtime). */
function declared(statement: ts.Statement, file: ts.SourceFile) {
  const names = new Set<string>();
  if (ts.isVariableStatement(statement))
    for (const one of statement.declarationList.declarations) bindingNames(one.name, names);
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  if (named && statement.name !== undefined && ts.isIdentifier(statement.name))
    names.add(statement.name.text);
  const type =
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    has(statement, ts.SyntaxKind.DeclareKeyword) ||
    file.isDeclarationFile;
  return { names, type };
}

/** The names an import binds, each with whether it is imported as a type alone. */
function importedNames(statement: ts.ImportDeclaration): [string, boolean][] {
  const clause = statement.importClause;
  if (clause === undefined) return [];
  const names: [string, boolean][] = [];
  if (clause.name !== undefined) names.push([clause.name.text, clause.isTypeOnly]);
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings))
    names.push([bindings.name.text, clause.isTypeOnly]);
  else if (bindings !== undefined)
    for (const one of bindings.elements)
      names.push([one.name.text, clause.isTypeOnly || one.isTypeOnly]);
  return names;
}

async function scriptSymbols(dir: string, path: string, seen: Set<string>): Promise<SymbolRead> {
  const text = await moduleText(dir, path);
  if (typeof text !== "string") return text;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const defined = new Set<string>();
  // Local names that are values, and those that are only types: a type exported is no value.
  const values = new Set<string>();
  const localTypes = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      for (const [name, type] of importedNames(statement)) (type ? localTypes : values).add(name);
      continue;
    }
    const { names, type } = declared(statement, file);
    for (const name of names) {
      defined.add(name);
      (type ? localTypes : values).add(name);
    }
  }
  const runtime = new Set<string>();
  const types = new Set<string>();
  const unread: string[] = [];
  for (const statement of file.statements) {
    if (has(statement, ts.SyntaxKind.ExportKeyword)) {
      const { names, type } = declared(statement, file);
      for (const name of names) (type ? types : runtime).add(name);
    }
    if (ts.isExportAssignment(statement)) runtime.add("default");
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    const from = statement.moduleSpecifier;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const one of clause.elements) {
        const own = (one.propertyName ?? one.name).text;
        const erased =
          statement.isTypeOnly ||
          one.isTypeOnly ||
          (from === undefined && localTypes.has(own) && !values.has(own));
        (erased ? types : runtime).add(one.name.text);
      }
    } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
      (statement.isTypeOnly ? types : runtime).add(clause.name.text);
    } else if (from !== undefined && ts.isStringLiteral(from)) {
      // export * from "./m": every name m exports but its default.
      const target = await resolveScript(dir, path, from.text);
      if ("why" in target) {
        unread.push(`${from.text} (${target.why})`);
        continue;
      }
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      const inner = await scriptSymbols(dir, target.path, seen);
      if ("problem" in inner) {
        unread.push(`${from.text} (${inner.problem})`);
        continue;
      }
      unread.push(...inner.unread);
      for (const name of inner.provided)
        if (name !== "default")
          (statement.isTypeOnly || inner.typeOnly.has(name) ? types : runtime).add(name);
    }
  }
  return {
    defined,
    provided: new Set([...runtime, ...types]),
    conditional: new Set(),
    typeOnly: new Set([...types].filter((name) => !runtime.has(name))),
    dynamic: false,
    unread,
  };
}

/** The module's names, by Python's ast or the TypeScript compiler, never by matching text. */
export async function symbolsOf(dir: string, path: string): Promise<SymbolRead> {
  if (isPython(path)) return pythonSymbols(dir, path);
  if (tsExtensions.some((ext) => path.endsWith(ext)))
    return scriptSymbols(dir, path, new Set([path]));
  return {
    problem: `${path} is neither Python nor TypeScript or JavaScript, so no parser reads its names`,
    state: "invalid",
  };
}
