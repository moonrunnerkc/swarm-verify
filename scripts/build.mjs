/**
 * Builds the package into dist/ and refuses a build whose closure crosses the verifier's
 * boundary: no model client, agent loop, chokepoint or terminal interface, and no runtime
 * dependency beyond the two the package declares. A boundary that is only tested is a boundary
 * a build can cross quietly, so the emitted tree itself is read.
 *
 *   node scripts/build.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { argv, exit, stdout } from "node:process";

const root = join(import.meta.dirname, "..");
const destination = join(root, "dist");

/** Module paths and import specifiers the verifier must never carry. */
const forbiddenModules =
  /(?:^|\/)(?:agent|tools|core|providers|screen|tui)\/|^cli(?:-run|-doctor)?\.js$/;
const forbiddenImports =
  /from\s+["'](?:openai|@anthropic-ai\/[^"']*|ollama|@ai-sdk\/[^"']*|ai|ink|react|blessed)["']/;
export const allowedDependencies = ["smol-toml", "zod"];

/** Every emitted JavaScript file, relative to dist, so the closure is read off what tsc wrote. */
export async function emittedModules(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
    }
  }
  return found.sort();
}

/** The emitted modules whose path crosses the boundary. */
export function crossings(modules) {
  return modules.filter((module) => forbiddenModules.test(module));
}

/** The emitted modules that import a model client or a terminal interface. */
export function forbiddenImporters(sources) {
  return sources.filter(([, text]) => forbiddenImports.test(text)).map(([module]) => module);
}

/** Runtime dependencies beyond the declared two. */
export function extraDependencies(manifest) {
  return Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !allowedDependencies.includes(name),
  );
}

function compiler() {
  const path = join(root, "node_modules", ".bin", "tsc");
  if (existsSync(path)) return path;
  throw new Error(`no TypeScript compiler at ${path}; run npm ci first`);
}

async function build() {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const extra = extraDependencies(manifest);
  if (extra.length > 0) {
    throw new Error(`runtime dependencies beyond ${allowedDependencies.join(", ")}: ${extra}`);
  }
  await rm(destination, { recursive: true, force: true });
  execFileSync(compiler(), ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  const modules = await emittedModules(destination);
  const sources = await Promise.all(
    modules.map(async (module) => [module, await readFile(join(destination, module), "utf8")]),
  );
  const crossed = [...crossings(modules), ...forbiddenImporters(sources)];
  if (crossed.length > 0) {
    throw new Error(`the verifier reached modules it must not carry: ${crossed.join(", ")}`);
  }
  stdout.write(`build: dist/ emitted, ${modules.length} module(s), boundary held\n`);
}

// Importable for its test without building, run for its effect from the command line.
if (argv[1] === import.meta.filename) {
  await build().catch((cause) => {
    process.stderr.write(`build failed: ${cause.message}\n`);
    exit(1);
  });
}
