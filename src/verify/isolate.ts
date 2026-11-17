import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionPolicy } from "../api/request.ts";
import { type ExecutionCapability, hostExecution } from "./checks.ts";
import { accountFiles } from "./container-user.ts";
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
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const files = await accountFiles(image, join(scratch, "account"), uid, gid);
    return {
      imageId,
      sandbox: {
        image,
        scratch,
        readOnly: [judge],
        hidden: [join(dir, ".git")],
        cache,
        user: `${uid}:${gid}`,
        files,
        clock: { lastEnded: 0 },
      },
    };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { unavailable: error.message };
    throw error;
  }
}

/**
 * Whether project-controlled commands may run at all, and where. Host is ready only because the
 * policy names it; a requested container that cannot be made leaves nothing ready.
 */
export type Readiness =
  | {
      readonly ready: true;
      readonly execution: ExecutionCapability;
      readonly isolated: { readonly image: string; readonly imageId: string } | null;
    }
  | { readonly ready: false; readonly reason: string };

export async function readiness(
  policy: ExecutionPolicy,
  dir: string,
  scratch: string,
  home: string,
  checks: readonly { readonly command: string }[],
): Promise<Readiness> {
  if (policy.mode === "host") return { ready: true, execution: hostExecution, isolated: null };
  const commands = checks.map((check) => check.command);
  const made = await isolate(policy, dir, scratch, home, commands);
  if ("unavailable" in made) return { ready: false, reason: made.unavailable };
  return {
    ready: true,
    execution: { kind: "isolated", sandbox: made.sandbox },
    isolated: { image: made.sandbox.image, imageId: made.imageId },
  };
}
