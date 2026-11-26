import { describe, expect, it } from "vitest";
import { unsafePatterns } from "./unsafe.ts";

const kinds = (text: string, path = "src/sample.ts") =>
  unsafePatterns([{ path, text }]).map((one) => `${one.kind}@${one.line}`);

describe("unsafePatterns", () => {
  it("finds a credential written to a log", () => {
    expect(kinds("console.log('signing in', user.password);\nlogger.info({ apiKey });\n")).toEqual([
      "logs-credential@1",
      "logs-credential@2",
    ]);
    expect(kinds("console.log('token refreshed for', userId);\nlog.debug(count);\n")).toEqual([]);
  });

  it("finds code built from strings", () => {
    expect(kinds("eval(input);\nconst f = new Function('a', body);\n")).toEqual([
      "dynamic-code@1",
      "dynamic-code@2",
    ]);
  });

  it("finds certificate verification turned off", () => {
    expect(
      kinds(
        "const agent = new Agent({ rejectUnauthorized: false });\nprocess.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n",
      ),
    ).toEqual(["tls-verification-off@1", "tls-verification-off@2"]);
    expect(kinds("const agent = new Agent({ rejectUnauthorized: true });\n")).toEqual([]);
  });

  it("finds SQL built by joining values into its text, once per statement", () => {
    expect(
      kinds(
        [
          "db.query('SELECT * FROM invoices WHERE id = ' + id + ' AND open = 1');",
          ["const sql = `delete from users where id = $", "{id}`;"].join(""),
          "db.query('SELECT * FROM invoices WHERE id = ?', [id]);",
          ["const label = `selected $", "{count} rows`;"].join(""),
        ].join("\n"),
      ),
    ).toEqual(["sql-concatenation@1", "sql-concatenation@2"]);
  });

  it("finds an empty catch", () => {
    expect(kinds("try { run(); } catch {}\ntry { run(); } catch (e) { report(e); }\n")).toEqual([
      "swallowed-error@1",
    ]);
  });

  it("finds a route that reads a resource by id without consulting the caller", () => {
    const leaky =
      "app.get('/invoices/:id', (req, res) => {\n  res.json(store.find(req.params.id));\n});\n";
    const found = unsafePatterns([{ path: "src/routes.ts", text: leaky }]);
    expect(found.map((one) => one.kind)).toEqual(["unscoped-resource-read"]);
    expect(found[0]?.detail).toContain("without consulting who is asking");
    expect(found[0]?.safer).toContain("owner");
  });

  it("does not flag a handler that checks the owner, or a route with no parameter", () => {
    const owned = [
      "router.get('/invoices/:id', requireUser, (req, res) => {",
      "  const invoice = store.find(req.params.id);",
      "  if (invoice.ownerId !== req.user.id) return res.sendStatus(404);",
      "  res.json(invoice);",
      "});",
      "router.get('/health', (req, res) => res.json({ ok: true, params: req.params }));",
    ].join("\n");
    expect(kinds(owned)).toEqual([]);
  });

  it("gives every finding a safer form and ignores other languages", () => {
    const all = unsafePatterns([{ path: "a.js", text: "eval(x); try { y(); } catch {}" }]);
    expect(all).toHaveLength(2);
    expect(all.every((one) => one.safer.length > 0 && one.detail.length > 0)).toBe(true);
    expect(kinds("eval(x)", "notes.md")).toEqual([]);
  });
});
