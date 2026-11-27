import ts from "typescript-compiler";
import type { ConventionRule } from "./rules.ts";

/** Files this reads; others are ignored. */
export const conventionSources = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** One place a rule applies, with the values of the rule it conforms to. */
export interface Site {
  readonly rule: ConventionRule;
  readonly path: string;
  readonly line: number;
  readonly found: string;
  readonly conforms: readonly string[];
}

const camel = /^[a-z][a-zA-Z0-9]*$/;
const snake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const pascal = /^[A-Z][a-zA-Z0-9]*$/;
const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const allCaps = /^[A-Z][A-Z0-9_]*$/;
const testFile = /\.(?:test|spec)\.[^/]+$/;
const testDirectory = /(?:^|\/)(?:test|tests|__tests__)\//;

const casings = (name: string, among: readonly (readonly [string, RegExp])[]) =>
  among.filter(([, pattern]) => pattern.test(name)).map(([value]) => value);

const identifierCasings = [
  ["camelCase", camel],
  ["snake_case", snake],
] as const;
const fileCasings = [
  ["kebab-case", kebab],
  ["camelCase", camel],
  ["snake_case", snake],
  ["PascalCase", pascal],
] as const;

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

const isFunctionValue = (
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression =>
  node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

const has = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((one) => one.kind === kind);

/** Whether a JSDoc block is the last comment before the node. */
function documented(node: ts.Node, text: string): boolean {
  const last = (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []).at(-1);
  return last !== undefined && text.startsWith("/**", last.pos);
}

const literalKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

/**
 * Whether a file's text does not parse. Sites are still read from what the parser recovered, and
 * a file it could not read to the end shows no violation in the part it never reached.
 */
export function unparsed(file: SourceText): boolean {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(file.path),
  );
  const found = (source as unknown as { readonly parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  return (found?.length ?? 0) > 0;
}

/** Every site in one file, read from its syntax tree. Comments are never read as code. */
function fileSites(file: SourceText): Site[] {
  const { path, text } = file;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const typed = !/\.[cm]?jsx?$/.test(path);
  const sites: Site[] = [];
  const add = (rule: ConventionRule, node: ts.Node, found: string, conforms: readonly string[]) =>
    sites.push({
      rule,
      path,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      found,
      conforms,
    });

  const name = path.slice(path.lastIndexOf("/") + 1).split(".")[0] ?? "";
  if (name !== "index" && name !== "")
    sites.push({
      rule: "file-names",
      path,
      line: 1,
      found: name,
      conforms: casings(name, fileCasings),
    });
  if (testFile.test(path)) {
    const where = testDirectory.test(path) ? "tests-directory" : "beside-sources";
    sites.push({ rule: "test-location", path, line: 1, found: where, conforms: [where] });
  }

  const functionName = (node: ts.Node, id: ts.Node | undefined) => {
    if (id === undefined || !ts.isIdentifier(id) || pascal.test(id.text)) return;
    add("function-names", node, id.text, casings(id.text, identifierCasings));
  };
  const variableName = (id: ts.BindingName) => {
    if (!ts.isIdentifier(id)) return;
    const text = id.text.replace(/^\$+/, "");
    if (text.length <= 1 || id.text.startsWith("_") || allCaps.test(text) || pascal.test(text))
      return;
    add("variable-names", id, id.text, casings(text, identifierCasings));
  };
  const exportedDoc = (node: ts.Node, label: string) =>
    add("exported-docs", node, label, documented(node, text) ? ["documented"] : []);
  const returnType = (node: ts.Node, label: string, declared: boolean) => {
    if (typed) add("exported-return-types", node, label, declared ? ["explicit"] : []);
  };

  let anyCount = 0;
  const visit = (node: ts.Node): void => {
    const exported = has(node, ts.SyntaxKind.ExportKeyword);
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      anyCount += 1;
      add("explicit-any", node, "any", []);
    } else if (ts.isExportAssignment(node)) {
      add("exports", node, "default", ["default"]);
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const asDefault =
        clause !== undefined &&
        ts.isNamedExports(clause) &&
        clause.elements.some((one) => one.name.text === "default");
      const kind = asDefault ? "default" : "named";
      add("exports", node, kind, [kind]);
    } else if (ts.isCatchClause(node)) {
      const empty = node.block.statements.length === 0;
      add("empty-catch", node, empty ? "empty" : "handled", empty ? [] : ["forbidden"]);
    } else if (ts.isThrowStatement(node)) {
      const literal = literalKinds.has(node.expression.kind);
      add(
        "thrown-values",
        node,
        literal ? "literal" : "error object",
        literal ? [] : ["error-objects"],
      );
    } else if (ts.isMethodDeclaration(node)) {
      functionName(node, node.name);
    } else if (ts.isParameter(node) || ts.isBindingElement(node)) {
      variableName(node.name);
    } else if (ts.isVariableDeclaration(node)) {
      if (isFunctionValue(node.initializer)) functionName(node, node.name);
      else variableName(node.name);
    }
    if (exported) {
      const kind = has(node, ts.SyntaxKind.DefaultKeyword) ? "default" : "named";
      add("exports", node, kind, [kind]);
    }
    if (ts.isFunctionDeclaration(node)) {
      functionName(node, node.name);
      if (exported) {
        const label = node.name?.text ?? "default";
        exportedDoc(node, label);
        returnType(node, label, node.type !== undefined);
      }
    } else if (ts.isVariableStatement(node) && exported) {
      for (const one of node.declarationList.declarations) {
        const label = ts.isIdentifier(one.name) ? one.name.text : "binding";
        exportedDoc(node, label);
        if (isFunctionValue(one.initializer))
          returnType(one, label, one.initializer.type !== undefined || one.type !== undefined);
      }
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const label = node.name?.text;
      if (label !== undefined)
        add("type-names", node, label, pascal.test(label) ? ["PascalCase"] : []);
      if (exported) exportedDoc(node, label ?? "default");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (anyCount === 0)
    sites.push({ rule: "explicit-any", path, line: 1, found: "no any", conforms: ["forbidden"] });
  return sites;
}

/** Every site of every rule across the JavaScript and TypeScript files given. */
export function conventionSites(files: readonly SourceText[]): Site[] {
  return files.filter((file) => conventionSources.test(file.path)).flatMap(fileSites);
}
