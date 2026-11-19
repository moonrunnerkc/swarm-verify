import { access } from "node:fs/promises";
import { join } from "node:path";

/** Images pinned by their multi-architecture index digests, so arm64 and amd64 hosts resolve the same pin. */
export const defaultImages = {
  node: "node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
  python:
    "ghcr.io/astral-sh/uv:python3.12-bookworm@sha256:85d4cb1afa769a7338e095b927bee941cf5ec92266c7424b3f6c0f2748567248",
} as const;

const pythonManifests = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "uv.lock"];
const nodeCommand =
  /(?:^|[\s;&|(])(?:node|npm|npx|pnpm|yarn|corepack|vitest|jest|mocha|tsc)(?=\s|$)/;

/**
 * The image for the base's ecosystem: Node for a package.json, Python and uv for a Python
 * manifest, and otherwise whichever the checks' commands run.
 */
export async function imageFor(dir: string, commands: readonly string[]): Promise<string> {
  const has = (name: string) =>
    access(join(dir, name)).then(
      () => true,
      () => false,
    );
  if (await has("package.json")) return defaultImages.node;
  for (const name of pythonManifests) if (await has(name)) return defaultImages.python;
  return commands.some((command) => nodeCommand.test(command))
    ? defaultImages.node
    : defaultImages.python;
}
