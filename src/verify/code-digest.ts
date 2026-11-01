import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This build's code: src/ when run from source, dist/ when run from the package. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isCode = (path: string) =>
  /\.(ts|js|mjs)$/.test(path) && !/\.test\.ts$/.test(path) && !/\.d\.ts$/.test(path);

/**
 * A digest of the verifier's own code. The version string stays the same across builds that read
 * reports differently, so a base measured by one build and judged by another read the same tests
 * under different ids and reported them all as new failures.
 */
export const codeSha256 = (() => {
  const hash = createHash("sha256");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(isCode).sort();
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(root, file)));
  return hash.digest("hex");
})();

/** The cache key of a base run: the commit, its environment, the sealed checks and this code. */
export function baselineKey(input: {
  readonly baseCommit: string;
  readonly environmentSha256: string;
  readonly sealedSha256: string | null;
  readonly codeSha256: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.baseCommit,
        input.environmentSha256,
        input.sealedSha256,
        input.codeSha256,
      ]),
    )
    .digest("hex");
}
