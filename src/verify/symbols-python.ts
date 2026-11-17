import { tmpdir } from "node:os";
import { childEnvironment } from "../exec/child-environment.ts";
import { runProcessGroup } from "../exec/run-process.ts";
import { trustedCommand, trustedPythonArgs } from "../exec/trusted-executable.ts";
import { moduleText } from "./candidate-read.ts";
import type { SymbolRead } from "./symbols.ts";

/**
 * Python's module namespace from its syntax tree, never by importing it: top-level definitions,
 * imported names, `__all__`, `__getattr__`, and each `from m import *` resolved to the file it
 * names, providing `__all__` or every public name. A name is sure only where every path through
 * the module's top level binds it; one bound inside an if without an else, a with, a loop or a
 * try some handler skips is conditional. The claimed module comes on stdin, read by the caller;
 * a module an import * names is read here, with every component checked by lstat and opened
 * with O_NOFOLLOW, so no link takes the reader out of the checkout.
 */
const pythonReader = `
import ast, json, os, stat, sys
root, path = sys.argv[1], sys.argv[2]
TRY = (ast.Try,) + ((ast.TryStar,) if hasattr(ast, "TryStar") else ())
LOOP = (ast.For, ast.AsyncFor, ast.While)
KINDS = {"link": "a symbolic link", "special": "not a regular file", "outside": "outside the checkout"}
def entry(rel):
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or ".." in parts or os.path.isabs(rel): return "outside"
    at = root
    for i, part in enumerate(parts):
        at = os.path.join(at, part)
        try: mode = os.lstat(at).st_mode
        except FileNotFoundError: return None
        except OSError as e: return "unreadable (" + type(e).__name__ + ")"
        if stat.S_ISLNK(mode): return "link"
        last = i == len(parts) - 1
        if last and stat.S_ISREG(mode): return "file"
        if last and stat.S_ISDIR(mode): return "directory"
        if last or not stat.S_ISDIR(mode): return "special"
    return None
def text(rel):
    before = os.lstat(os.path.join(root, rel))
    fd = os.open(os.path.join(root, rel), os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as f:
        opened = os.fstat(f.fileno())
        if (opened.st_ino, opened.st_dev) != (before.st_ino, before.st_dev): raise OSError("replaced while read")
        return f.read().decode("utf-8")
def read(rel, seen, source):
    tree = ast.parse(source, rel)
    defined, imported, unread, names_all, getattr_ = set(), set(), [], None, False
    def star(node):
        label = "." * node.level + (node.module or "")
        target, why = resolve(rel, node.module, node.level)
        if target is None: unread.append(label + " (" + why + ")"); return set()
        if target in seen: return set()
        seen.add(target)
        try: inner = read(target, seen, text(target))
        except (OSError, SyntaxError, ValueError) as e:
            unread.append(label + " (" + target + " was not read: " + type(e).__name__ + ")"); return set()
        imported.update(inner["star"]); unread.extend(inner["unread"])
        return set(inner["star"]) & set(inner["sure"])
    def walk(body):
        nonlocal names_all, getattr_
        sure = set()
        for node in body:
            bound = set()
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name); bound.add(node.name); getattr_ = getattr_ or node.name == "__getattr__"
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for leaf in ast.walk(target):
                        if isinstance(leaf, ast.Name):
                            defined.add(leaf.id)
                            if node.value is not None: bound.add(leaf.id)
                    if isinstance(target, ast.Name) and target.id == "__all__" and isinstance(node.value, (ast.List, ast.Tuple)):
                        names_all = [e.value for e in node.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name.split(".")[0]; imported.add(name); bound.add(name)
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == "*": bound |= star(node)
                    else: name = alias.asname or alias.name; imported.add(name); bound.add(name)
            elif isinstance(node, ast.If):
                bound = walk(node.body) & walk(node.orelse)
            elif isinstance(node, TRY):
                bound = walk(node.body) | walk(node.orelse)
                for handler in node.handlers: bound &= walk(handler.body)
                bound |= walk(node.finalbody)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                walk(node.body)
            elif isinstance(node, LOOP):
                if not isinstance(node, ast.While):
                    for leaf in ast.walk(node.target):
                        if isinstance(leaf, ast.Name): defined.add(leaf.id)
                walk(node.body); walk(node.orelse)
            sure |= bound
        return sure
    sure = walk(tree.body)
    namespace = defined | imported
    public = set(names_all) if names_all is not None else {n for n in namespace if not n.startswith("_")}
    return {"defined": sorted(defined), "provided": sorted(namespace), "sure": sorted(namespace & sure),
            "star": sorted(public), "dynamic": getattr_, "unread": unread}
def resolve(rel, module, level):
    parts = (module or "").split(".") if module else []
    if level > 0:
        base = os.path.dirname(rel)
        for _ in range(level - 1): base = os.path.dirname(base)
        bases = [base]
    else:
        bases = ["", "src"] + sorted(d for d in os.listdir(root) if parts and entry(os.path.join(d, parts[0])) == "directory")
    for base in bases:
        stem = os.path.join(base, *parts)
        for candidate in (stem + ".py", os.path.join(stem, "__init__.py")):
            found = entry(os.path.normpath(candidate))
            if found == "file": return os.path.normpath(candidate), None
            if found is not None and found != "directory": return None, os.path.normpath(candidate) + " is " + KINDS.get(found, found) + ", which is not read"
    return None, "no file in the checkout"
print(json.dumps(read(path, {path}, sys.stdin.buffer.read().decode("utf-8"))))
`;

/**
 * The Python reader runs the interpreter found in PATH's absolute entries, isolated (-I: no
 * script directory or working directory on sys.path, no user site, no PYTHON* variables), writing
 * no bytecode (-B) and in the system scratch directory, so nothing in the checkout is importable, and it never imports
 * the module it reads.
 */
export async function pythonSymbols(dir: string, path: string): Promise<SymbolRead> {
  const source = await moduleText(dir, path);
  if (typeof source !== "string") return source;
  const python = await trustedCommand("python3");
  if (python === null)
    return {
      problem: `no python3 in an absolute PATH entry, so ${path} was not read`,
      state: "unreadable",
    };
  const trusted = tmpdir();
  const ran = await runProcessGroup(python, [...trustedPythonArgs, "-c", pythonReader, dir, path], {
    stdin: source,
    cwd: trusted,
    env: childEnvironment(process.env, { homeDir: trusted }).variables,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  if (ran.startFailure !== null)
    return { problem: `python3 could not read ${path}: ${ran.startFailure}`, state: "unreadable" };
  if (ran.exitCode !== 0)
    return {
      problem: `${path} does not parse as Python: ${ran.stderr.trim().split("\n").at(-1) ?? ""}`,
      state: "invalid",
    };
  const parsed = JSON.parse(ran.stdout) as {
    defined: string[];
    provided: string[];
    sure: string[];
    dynamic: boolean;
    unread: string[];
  };
  const sure = new Set(parsed.sure);
  return {
    defined: new Set(parsed.defined),
    provided: new Set(parsed.provided),
    conditional: new Set(parsed.provided.filter((name) => !sure.has(name))),
    typeOnly: new Set(),
    dynamic: parsed.dynamic,
    unread: parsed.unread,
  };
}
