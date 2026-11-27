import ts from "typescript-compiler";
import { wordsOf } from "../evidence/credential-names.ts";
import { conventionSources, type SourceText } from "./measure-sites.ts";

export type UnsafeKind =
  | "logs-credential"
  | "dynamic-code"
  | "tls-verification-off"
  | "sql-concatenation"
  | "swallowed-error"
  | "unscoped-resource-read";

export interface UnsafeFinding {
  readonly kind: UnsafeKind;
  readonly path: string;
  readonly line: number;
  readonly detail: string;
  readonly safer: string;
}

const safer: Readonly<Record<UnsafeKind, string>> = {
  "logs-credential": "Log that the value was present, or an identifier for it, never the value.",
  "dynamic-code": "Call the function directly, or look the behavior up in a fixed table.",
  "tls-verification-off":
    "Leave certificate verification on and trust a private authority by adding its certificate.",
  "sql-concatenation": "Pass the values as query parameters and keep the statement a constant.",
  "swallowed-error": "Handle the error, or let it reach a caller that does.",
  "unscoped-resource-read":
    "Compare the resource's owner with the authenticated user on the server before returning it.",
};

/** Narrower than the evidence scrubber's words: a logged `account` or `key` is usually not a secret. */
const secretWords = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secrets",
  "token",
  "tokens",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
]);
const secretNames = new Set(["apikey", "sessionid", "privatekey", "secretkey", "accesskey"]);

function namesCredential(name: string): boolean {
  const words = wordsOf(name);
  const joined = words.join("");
  return (
    words.some((word) => secretWords.has(word)) ||
    [...secretNames].some((one) => joined.includes(one))
  );
}

const loggers = /^(?:console|logger|log)$/;
const routeVerbs = new Set(["get", "post", "put", "patch", "delete"]);
const sqlStart = /^\s*(?:select|insert|update|delete)\b/i;
const paramRead = /\b(?:req|request)\.params\b|\bc\.req\.param\b|\bctx\.params\b/;
const identity = /\.(?:user|session|auth)\b|userid|ownerid|currentuser/i;

/** The leftmost literal text of a concatenation or a template with substitutions, else null. */
function builtSqlHead(node: ts.Node): string | null {
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left: ts.Expression = node.left;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken)
      left = left.left;
    if (ts.isStringLiteral(left) || ts.isNoSubstitutionTemplateLiteral(left)) return left.text;
    if (ts.isTemplateExpression(left)) return left.head.text;
  }
  return null;
}

/** Whether any identifier or property name under the node reads as a credential. */
function mentionsCredential(node: ts.Node): string | null {
  if (ts.isIdentifier(node) && namesCredential(node.text)) return node.text;
  if (ts.isStringLiteralLike(node)) return null;
  return ts.forEachChild(node, mentionsCredential) ?? null;
}

function fileFindings(file: SourceText): UnsafeFinding[] {
  const { path, text } = file;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const findings: UnsafeFinding[] = [];
  const add = (kind: UnsafeKind, node: ts.Node, detail: string) =>
    findings.push({
      kind,
      path,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      detail,
      safer: safer[kind],
    });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "eval")
        add("dynamic-code", node, "eval runs a string as code");
      if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression;
        if (ts.isIdentifier(receiver) && loggers.test(receiver.text)) {
          const name = node.arguments.map(mentionsCredential).find((one) => one !== null);
          if (name != null)
            add("logs-credential", node, `it logs ${name}, which names a credential`);
        }
        const route = node.arguments[0];
        if (
          routeVerbs.has(callee.name.text) &&
          route !== undefined &&
          ts.isStringLiteralLike(route) &&
          /\/:\w/.test(route.text)
        ) {
          for (const handler of node.arguments.slice(1)) {
            if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) continue;
            const body = handler.getText(source);
            if (paramRead.test(body) && !identity.test(body))
              add(
                "unscoped-resource-read",
                handler,
                `the handler for ${route.text} reads a resource by id without consulting who is asking`,
              );
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Function")
        add("dynamic-code", node, "new Function builds code from a string");
    } else if (ts.isPropertyAssignment(node)) {
      if (
        node.name.getText(source).replace(/["']/g, "") === "rejectUnauthorized" &&
        node.initializer.kind === ts.SyntaxKind.FalseKeyword
      )
        add("tls-verification-off", node, "rejectUnauthorized: false accepts any certificate");
    } else if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      add("swallowed-error", node, "the catch block is empty, so the error is lost");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText(source).includes("NODE_TLS_REJECT_UNAUTHORIZED") &&
      ts.isStringLiteralLike(node.right) &&
      node.right.text === "0"
    )
      add("tls-verification-off", node, "NODE_TLS_REJECT_UNAUTHORIZED=0 accepts any certificate");
    const head = builtSqlHead(node);
    // The outermost concatenation only: its left operand is a concatenation too.
    const nested =
      ts.isBinaryExpression(node.parent ?? node) &&
      node.parent !== undefined &&
      builtSqlHead(node.parent) !== null;
    if (head !== null && sqlStart.test(head) && !nested)
      add("sql-concatenation", node, "a SQL statement is built by joining values into its text");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/**
 * Patterns in sample code that must never be learned as a convention, each with the safe form.
 * Heuristic and advisory: it reads syntax, not data flow, so it can miss a pattern and can flag
 * code that is safe for a reason it cannot see. It proves nothing about code it does not flag.
 */
export function unsafePatterns(files: readonly SourceText[]): UnsafeFinding[] {
  return files.filter((file) => conventionSources.test(file.path)).flatMap(fileFindings);
}
