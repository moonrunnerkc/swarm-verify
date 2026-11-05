import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import ts from "typescript-compiler";
import { childEnvironment } from "../exec/child-environment.ts";
import { runProcessGroup } from "../exec/run-process.ts";

/** The top-level names a module defines and the names importing it provides, read by its parser. */
export interface ModuleSymbols {
  /** Declared in the module itself: a function, class, variable, type or assignment. */
  readonly defined: ReadonlySet<string>;
  /** Importable from it: its exports (TypeScript) or its namespace (Python), re-exports included. */
  readonly provided: ReadonlySet<string>;
  /** A Python module-level `__getattr__`, which may provide any name; a parser cannot say which. */
  readonly dynamic: boolean;
}

type Read = ModuleSymbols | { readonly problem: string };

const tsExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isPython = (path: string) => path.endsWith(".py");

/** A relative TypeScript or JavaScript specifier as the file it names in the tree. */
async function resolveScript(dir: string, from: string, spec: string): Promise<string | null> {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(from), spec));
  const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    base,
    ...tsExtensions.map((ext) => `${stem}${ext}`),
    ...tsExtensions.map((ext) => join(stem, `index${ext}`)),
  ];
  for (const one of candidates) {
    if (
      await readFile(join(dir, one), "utf8").then(
        () => true,
        () => false,
      )
    )
      return one;
  }
  return null;
}

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((one) => one.kind === ts.SyntaxKind.ExportKeyword);

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) into.add(name.text);
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
}

async function scriptSymbols(dir: string, path: string, seen: Set<string>): Promise<Read> {
  const text = await readFile(join(dir, path), "utf8").catch(() => null);
  if (text === null) return { problem: `no file at ${path}` };
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const defined = new Set<string>();
  const provided = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      const names = new Set<string>();
      for (const one of statement.declarationList.declarations) bindingNames(one.name, names);
      for (const name of names) {
        defined.add(name);
        if (exported(statement)) provided.add(name);
      }
      continue;
    }
    const named =
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement);
    if (named && statement.name !== undefined && ts.isIdentifier(statement.name)) {
      defined.add(statement.name.text);
      if (exported(statement)) provided.add(statement.name.text);
    }
    if (ts.isExportAssignment(statement)) provided.add("default");
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      for (const one of clause.elements) provided.add(one.name.text);
    } else if (clause !== undefined && ts.isNamespaceExport(clause)) {
      provided.add(clause.name.text);
    } else if (
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      // export * from "./m": every name m exports but its default.
      const target = await resolveScript(dir, path, statement.moduleSpecifier.text);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      const inner = await scriptSymbols(dir, target, seen);
      if ("provided" in inner)
        for (const name of inner.provided) if (name !== "default") provided.add(name);
    }
  }
  return { defined, provided, dynamic: false };
}

/**
 * Python's module namespace from its syntax tree, never by importing it: top-level definitions
 * (inside a top-level if or try too), imported names, `__all__`, `__getattr__`, and each
 * `from m import *` resolved to the file it names, providing `__all__` or every public name.
 */
const pythonReader = String.raw`
import ast, json, os, sys
root, path = sys.argv[1], sys.argv[2]
def read(rel, seen):
    full = os.path.join(root, rel)
    if not os.path.isfile(full): return None
    tree = ast.parse(open(full, encoding="utf-8").read(), rel)
    defined, imported, names_all, getattr_ = set(), set(), None, False
    def walk(body):
        nonlocal names_all, getattr_
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name); getattr_ = getattr_ or node.name == "__getattr__"
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for leaf in ast.walk(target):
                        if isinstance(leaf, ast.Name): defined.add(leaf.id)
                    if isinstance(target, ast.Name) and target.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                        names_all = [e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            elif isinstance(node, ast.Import):
                for alias in node.names: imported.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name != "*": imported.add(alias.asname or alias.name); continue
                    target = resolve(rel, node.module, node.level)
                    if target is None or target in seen: continue
                    seen.add(target); inner = read(target, seen)
                    if inner is not None: imported.update(inner["star"])
            elif isinstance(node, (ast.If, ast.Try, ast.With)):
                walk(node.body)
                for handler in getattr(node, "handlers", []): walk(handler.body)
                walk(getattr(node, "orelse", [])); walk(getattr(node, "finalbody", []))
    walk(tree.body)
    namespace = defined | imported
    star = set(names_all) if names_all is not None else {n for n in namespace if not n.startswith("_")}
    return {"defined": sorted(defined), "provided": sorted(namespace), "star": sorted(star), "dynamic": getattr_}
def resolve(rel, module, level):
    parts = (module or "").split(".") if module else []
    if level > 0:
        base = os.path.dirname(rel)
        for _ in range(level - 1): base = os.path.dirname(base)
        bases = [base]
    else:
        bases = ["", "src"] + [d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, *parts[:1]))]
    for base in bases:
        stem = os.path.join(base, *parts)
        for candidate in (stem + ".py", os.path.join(stem, "__init__.py")):
            if os.path.isfile(os.path.join(root, candidate)): return os.path.normpath(candidate)
    return None
result = read(path, {path})
print(json.dumps(result))
`;

async function pythonSymbols(dir: string, path: string): Promise<Read> {
  const ran = await runProcessGroup("python3", ["-I", "-c", pythonReader, dir, path], {
    cwd: dir,
    env: childEnvironment(process.env, { homeDir: dir }).variables,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (ran.startFailure !== null)
    return { problem: `python3 could not read ${path}: ${ran.startFailure}` };
  if (ran.exitCode !== 0)
    return {
      problem: `${path} does not parse as Python: ${ran.stderr.trim().split("\n").at(-1) ?? ""}`,
    };
  const parsed = JSON.parse(ran.stdout) as {
    defined: string[];
    provided: string[];
    dynamic: boolean;
  } | null;
  if (parsed === null) return { problem: `no file at ${path}` };
  return {
    defined: new Set(parsed.defined),
    provided: new Set(parsed.provided),
    dynamic: parsed.dynamic,
  };
}

/** The module's names, by Python's ast or the TypeScript compiler, never by matching text. */
export async function symbolsOf(dir: string, path: string): Promise<Read> {
  if (isPython(path)) return pythonSymbols(dir, path);
  if (tsExtensions.some((ext) => path.endsWith(ext)))
    return scriptSymbols(dir, path, new Set([path]));
  return {
    problem: `${path} is neither Python nor TypeScript or JavaScript, so no parser reads its names`,
  };
}
