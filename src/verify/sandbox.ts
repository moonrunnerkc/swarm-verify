import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type ProcessRunResult, runProcessGroup } from "../exec/run-process.ts";
import { MissingExecutableError, trustedCommand } from "../exec/trusted-executable.ts";
import type { BoundFile } from "./container-user.ts";

export { defaultImages, imageFor } from "./images.ts";

import { type Resources, resourceArgs } from "./resources.ts";

/**
 * The one isolated backend: docker. Every check runs in a fresh container from a pinned image
 * with the network closed; dependency preparation is the one stage that opens it. The container
 * sees the verification's scratch directory at its own path and nothing else of the host: not
 * the docker socket, the home directory, credentials, the baseline cache, the sealed store or
 * signing keys. The checkout's git directory is hidden behind an empty mount, and the judge is
 * mounted read-only.
 */
export interface Sandbox {
  /** The image reference, pinned by digest. */
  readonly image: string;
  /** The verification's scratch directory, mounted read-write at the same path. */
  readonly scratch: string;
  /** Directories under scratch the checks may read and never write. */
  readonly readOnly: readonly string[];
  /** Directories mounted empty over what is under them. */
  readonly hidden: readonly string[];
  /** A dependency cache under the verifier's home, mounted only while dependencies are prepared. */
  readonly cache: string;
  readonly user: string;
  /** Files bound read-only over the image's own, such as account files listing `user`. */
  readonly files: readonly BoundFile[];
  /** When the last container run ended, to space runs out where the host's files reach the VM late. */
  readonly clock: { lastEnded: number };
  /** Memory, swap and CPU bounds for every container, probed as enforced before the first. */
  readonly limits: Resources;
}

/**
 * Where docker runs in a VM (macOS, Windows), the VM's shared filesystem keeps a file's entry for
 * about a second: a file the host replaced, created or removed just before a container starts
 * reads as its old self or as missing (measured on colima with virtiofs: stale up to 0.8 s after
 * the change, never at 1.0 s or later). Every host-side change to the checkout happens between
 * container runs, so the next run starts no sooner than this after the last one ended.
 */
export const sharedFilesystemSettleMs = process.platform === "linux" ? 0 : 1500;

/**
 * How long to wait before a container run: the settle time less what passed since the last run
 * ended. A sandbox's first run (no run yet, `lastEnded` 0) waits all of it, since the host has
 * just written the checkout and the run's home.
 */
export function settleWait(lastEnded: number, now: number, settleMs: number): number {
  const since = lastEnded === 0 ? 0 : now - lastEnded;
  return Math.max(0, settleMs - since);
}

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `isolated execution is not available: ${detail}. Start docker (for colima, \`colima start\`), or verify on the host with --isolation host, which the result reports as not isolated`,
    );
    this.name = "SandboxUnavailableError";
  }
}

export const docker = async (args: readonly string[], timeout = 600_000) => {
  const file = await trustedCommand("docker");
  if (file === null)
    return { code: 127, stdout: "", stderr: new MissingExecutableError("docker").message };
  return new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (settle) => {
      execFile(
        file,
        [...args],
        { timeout, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          settle({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    },
  );
};

/**
 * The daemon answers and the image is present, pulled here where it is not. Returns the image's
 * content digest as the daemon reports it, for the environment identity.
 */
export async function readyImage(image: string): Promise<string> {
  const server = await docker(["version", "--format", "{{.Server.Version}}"], 30_000);
  if (server.code !== 0)
    throw new SandboxUnavailableError(
      `the docker daemon does not answer (${server.stderr.trim() || "no output"})`,
    );
  let inspected = await docker(
    ["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", image],
    30_000,
  );
  if (inspected.code !== 0) {
    const pulled = await docker(["pull", "--quiet", image]);
    if (pulled.code !== 0)
      throw new SandboxUnavailableError(
        `the image ${image} could not be pulled (${pulled.stderr.trim()})`,
      );
    inspected = await docker(
      ["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", image],
      30_000,
    );
  }
  const [id = "", architecture = ""] = inspected.stdout.trim().split(" ");
  if (!id.startsWith("sha256:"))
    throw new SandboxUnavailableError(`the image ${image} has no content digest`);
  return `${id} ${architecture}`;
}

/** The PATH inside the container, with the checkout's virtual environment first. */
export function containerPath(dir: string): string {
  return `${join(dir, ".venv", "bin")}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}

/**
 * Node images ship corepack but no pnpm. A shim in the run's own home lets a declared `pnpm`
 * command run with the version the manifest pins, fetched while dependencies are prepared and
 * read from the home's corepack cache after. The command itself runs as declared.
 */
export const pnpmShim =
  'command -v corepack >/dev/null 2>&1 && mkdir -p "$HOME/.swarm-bin" && corepack enable --install-directory "$HOME/.swarm-bin" pnpm >/dev/null 2>&1; ';

export interface ContainerRun {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * The `docker run` for one command. `prepare` opens the network and mounts the dependency
 * cache; a check runs with no network unless the policy recorded that it needs one.
 */
export function containerRun(
  sandbox: Sandbox,
  input: {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stage: "prepare" | "check";
    /** Whether a check may reach the network; preparation always may. */
    readonly network?: "open" | "closed";
  },
): ContainerRun {
  const name = `swarm-verify-${randomBytes(6).toString("hex")}`;
  const mounts = [
    ["--mount", `type=bind,src=${sandbox.scratch},dst=${sandbox.scratch}`],
    ...sandbox.readOnly.map((path) => ["--mount", `type=bind,src=${path},dst=${path},readonly`]),
    ...sandbox.hidden.map((path) => ["--mount", `type=tmpfs,dst=${path}`]),
    ...sandbox.files.map((file) => [
      "--mount",
      `type=bind,src=${file.src},dst=${file.dst},readonly`,
    ]),
    ...(input.stage === "prepare"
      ? [["--mount", `type=bind,src=${sandbox.cache},dst=/swarm-cache`]]
      : []),
  ].flat();
  const shims = input.env.HOME === undefined ? "" : `${input.env.HOME}/.swarm-bin:`;
  const env = {
    ...input.env,
    PATH: `${shims}${containerPath(input.cwd)}`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    ...(input.stage === "prepare"
      ? {
          npm_config_cache: "/swarm-cache/npm",
          UV_CACHE_DIR: "/swarm-cache/uv",
          UV_PYTHON_DOWNLOADS: "automatic",
        }
      : {}),
  };
  // Not --rm: the container is inspected for an OOM kill after it exits, then removed.
  const args = [
    "run",
    "--name",
    name,
    "--network",
    input.stage === "prepare" || input.network === "open" ? "bridge" : "none",
    "--user",
    sandbox.user,
    ...containerLimits,
    ...resourceArgs(sandbox.limits),
    "--workdir",
    input.cwd,
    ...mounts,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    sandbox.image,
    "/bin/sh",
    "-c",
    `${pnpmShim}${input.command}`,
  ];
  return { name, args };
}

/**
 * What every container gets regardless of the project: no capabilities, no privilege gained
 * through setuid, and a bound on processes, so a fork bomb stops at the bound. Memory and CPU
 * bounds are the caller's, from `Sandbox.limits`.
 */
export const containerLimits = [
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=4096",
  "--init",
];

/** Removes a container a timed-out or cancelled run left behind; the client's exit does not stop it. */
export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name], 60_000);
}

/** The docker client's own variables: where the daemon is, never anything the checks get. */
const dockerClient = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

/** A container run, with whether the kernel killed a process in it for exceeding its memory. */
export type SandboxRunResult = ProcessRunResult & {
  /** Why the run cannot count as measured for want of resources, or null. */
  readonly exhausted: string | null;
  /** The container's name; it is removed before this returns. */
  readonly container: string;
};

/**
 * Whether a process in the exited container was OOM-killed, from docker's own State.OOMKilled.
 * An exit code of 137 alone is a SIGKILL from anywhere and proves nothing; a state that cannot be
 * read leaves the kill unruled out.
 */
async function exhaustion(name: string, limits: Resources): Promise<string | null> {
  const state = await docker(["inspect", "--format", "{{.State.OOMKilled}}", name], 60_000);
  if (state.code !== 0)
    return `its container's state could not be read after it ran, so a kill at the ${limits.memoryMiB} MiB memory limit cannot be ruled out`;
  return state.stdout.trim() === "true"
    ? `it reached the container's ${limits.memoryMiB} MiB memory limit and a process in it was killed`
    : null;
}

/**
 * One command in a fresh container, removed after it exits, times out or is cancelled (stopping
 * the client leaves the container running).
 */
export async function runInSandbox(
  sandbox: Sandbox,
  command: string,
  context: {
    readonly dir: string;
    readonly home: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal | undefined;
    readonly checkNetwork?: "closed" | "open" | undefined;
  },
  env: Readonly<Record<string, string>>,
  stage: "prepare" | "check",
): Promise<SandboxRunResult> {
  const run = containerRun(sandbox, {
    command,
    cwd: context.dir,
    env: { CI: "true", HOME: context.home, TMPDIR: "/tmp", ...env },
    stage,
    network: context.checkNetwork === "open" ? "open" : "closed",
  });
  const client = Object.fromEntries(
    dockerClient.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const waited = settleWait(sandbox.clock.lastEnded, Date.now(), sharedFilesystemSettleMs);
  if (waited > 0) await new Promise((settle) => setTimeout(settle, waited));
  const ran = await runProcessGroup((await trustedCommand("docker")) ?? "docker", run.args, {
    cwd: sandbox.scratch,
    env: client,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
  });
  sandbox.clock.lastEnded = Date.now();
  const ended = !ran.timedOut && !ran.cancelled && ran.startFailure === null;
  const exhausted = ended ? await exhaustion(run.name, sandbox.limits) : null;
  await removeContainer(run.name);
  // 125 is docker's own: the container never started, so no check ran in it.
  if (ran.exitCode === 125 && ran.startFailure === null) {
    return {
      ...ran,
      exhausted: null,
      container: run.name,
      startFailure: `docker could not start the container: ${ran.stderr.trim().slice(-500)}`,
    };
  }
  return { ...ran, exhausted, container: run.name };
}
