import { mkdir } from "node:fs/promises";
import { accountFiles } from "./container-user.ts";
import { probeResources } from "./isolate.ts";
import { defaultResources, type ResourceRecord, type Resources } from "./resources.ts";
import {
  imageFor,
  readyImage,
  runInSandbox,
  type Sandbox,
  type SandboxRunResult,
  SandboxUnavailableError,
} from "./sandbox.ts";

/**
 * What a caller that runs untrusted commands of its own (a coding agent's model) hands over to
 * have them contained the way the verifier's checks are.
 */
export interface WorkerPolicy {
  /** The one tree the commands may write, mounted at its own path. */
  readonly workspace: string;
  /** A private HOME for the commands, outside the workspace, writable. */
  readonly home: string;
  /** Paths the commands may read and never write, such as the object stores a clone borrows from. */
  readonly readOnly: readonly string[];
  /**
   * Directories the commands see in place of others: `src` mounted writable at `dst`. A copy of
   * the workspace's git directory goes here, so git works for the commands and nothing they
   * write to it (a hook, a config) is ever read by the caller's own git.
   */
  readonly standIns?: readonly { readonly src: string; readonly dst: string }[];
  /** A dependency cache, mounted only while dependencies are fetched. */
  readonly cache: string;
  /** Where the container's account files are written; outside the workspace. */
  readonly accounts: string;
  /** The project's check commands, which decide the image where no manifest does. */
  readonly commands?: readonly string[] | undefined;
  readonly image?: string | undefined;
  readonly resources?: Resources | undefined;
}

export interface WorkerRun {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * closed: no network at all, the default. dependencies: the network and the dependency cache,
   * for a package manager fetching what a manifest names; the caller decides which commands
   * those are and what they may execute meanwhile.
   */
  readonly network?: "closed" | "dependencies";
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A container boundary for commands the caller does not trust. Each command runs in a fresh
 * container from a pinned image as the caller's uid, with no capabilities, bounded memory, CPU
 * and processes, and no network unless the run asks for the dependency stage. It sees the
 * workspace, its private HOME and the read-only paths, and nothing else of the host: not the
 * caller's home, credentials, environment, docker socket or evidence. This contains the
 * commands; it does not defend against a compromised host, daemon or kernel.
 */
export interface Worker {
  readonly image: string;
  /** The image's content digest and architecture, as the daemon reports them. */
  readonly imageId: string;
  /** The bounds asked for and read back from a container's cgroup. */
  readonly resources: ResourceRecord;
  run(command: string, options: WorkerRun): Promise<SandboxRunResult>;
}

/**
 * The worker for a workspace, or why there is none. Nothing here falls back to the host: a
 * caller that gets `unavailable` stops, or runs on the host only because its user said so.
 */
export async function openWorker(
  policy: WorkerPolicy,
): Promise<Worker | { readonly unavailable: string }> {
  const image = policy.image ?? (await imageFor(policy.workspace, policy.commands ?? []));
  try {
    const imageId = await readyImage(image);
    const limits = policy.resources ?? defaultResources;
    const resources = await probeResources(image, limits);
    await mkdir(policy.cache, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const sandbox: Sandbox = {
      image,
      scratch: policy.workspace,
      readOnly: policy.readOnly,
      writable: [policy.home, ...(policy.standIns ?? [])],
      hidden: [],
      cache: policy.cache,
      user: `${uid}:${gid}`,
      files: await accountFiles(image, policy.accounts, uid, gid),
      clock: { lastEnded: 0 },
      limits,
    };
    return {
      image,
      imageId,
      resources,
      run: (command, options) =>
        runInSandbox(
          sandbox,
          command,
          {
            dir: policy.workspace,
            home: policy.home,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes,
            signal: options.signal,
          },
          { ...gitTrusts(policy.workspace), ...options.env },
          options.network === "dependencies" ? "prepare" : "check",
        ),
    };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) return { unavailable: error.detail };
    throw error;
  }
}

/**
 * A docker VM's shared filesystem can present the workspace under another owner, and git then
 * refuses the repository; the commands are told this one directory is theirs to read.
 */
const gitTrusts = (workspace: string) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: workspace,
});
