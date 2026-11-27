import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitText } from "../verify/change.ts";

const frameworks = ["express", "fastify", "koa", "hono", "@nestjs/core", "restify", "@hapi/hapi"];
const routes =
  /\.(?:get|post|put|patch|delete)\(\s*["'`]\/|createServer\(|new Hono\(|\bfastify\(|\bexpress\(/;
const sources = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const tests = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./;

/**
 * What of an HTTP API a JavaScript or TypeScript repository holds, for deciding whether a
 * behavior check has anything to drive: a server framework among its dependencies, or routes in
 * its tracked sources. `found` is null where there is neither; `files` are the sources with routes.
 */
export async function httpSurface(
  dir: string,
): Promise<{ readonly found: string | null; readonly files: readonly string[] }> {
  let dependencies: Record<string, unknown> = {};
  try {
    const manifest: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const declared = (manifest as { readonly dependencies?: unknown } | null)?.dependencies;
    if (declared !== null && typeof declared === "object")
      dependencies = declared as Record<string, unknown>;
  } catch {
    // No manifest, or one that does not parse: the sources still say whether there are routes.
  }
  const framework = frameworks.find((name) => name in dependencies);
  const tracked = (await gitText(dir, ["ls-files"])).split("\n");
  const files: string[] = [];
  for (const path of tracked.filter((one) => sources.test(one) && !tests.test(one)).slice(0, 400)) {
    const text = await readFile(join(dir, path), "utf8").catch(() => "");
    if (text.length < 200_000 && routes.test(text)) files.push(path);
  }
  const found =
    framework !== undefined
      ? `${framework} among its dependencies`
      : files.length > 0
        ? `routes in ${files[0]}`
        : null;
  return { found, files };
}
