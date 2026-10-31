import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionPolicy } from "../api/request.ts";
import { imageFor, readyImage, type Sandbox, SandboxUnavailableError } from "./sandbox.ts";

export type Isolated =
  | { readonly sandbox: Sandbox; readonly imageId: string }
  | { readonly unavailable: string };

/**
 * The container for an isolated verification, or why there is none. Linked dependencies are
 * refused here: they are the caller's own tree, built for the host and writable by it.
 */
export async function isolate(
  policy: ExecutionPolicy,
  dir: string,
  scratch: string,
  home: string,
  commands: readonly string[],
): Promise<Isolated> {
  if (policy.dependencies === "linked") {
    return {
      unavailable:
        "linked dependencies cannot be used in isolation; prepare them from the lockfile instead",
    };
  }
  const image = policy.image ?? (await imageFor(dir, commands));
  try {
    const imageId = await readyImage(image);
    const judge = join(scratch, "judge");
    const cache = join(home, "cache");
    await mkdir(judge, { recursive: true, mode: 0o700 });
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    return {
      imageId,
      sandbox: {
        image,
        scratch,
        readOnly: [judge],
        hidden: [join(dir, ".git")],
        cache,
        user,
        clock: { lastEnded: 0 },
      },
    };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { unavailable: error.message };
    throw error;
  }
}
