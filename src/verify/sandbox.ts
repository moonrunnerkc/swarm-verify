import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { type ProcessRunResult, runProcessGroup } from "../exec/run-process.ts";

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
}

/** Images pinned by their multi-architecture index digests, so arm64 and amd64 hosts resolve the same pin. */
export const defaultImages = {
  node: "node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
  python:
    "ghcr.io/astral-sh/uv:python3.12-bookworm@sha256:85d4cb1afa769a7338e095b927bee941cf5ec92266c7424b3f6c0f2748567248",
} as const;

export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `isolated execution is not available: ${detail}. Start docker (for colima, \`colima start\`), or verify on the host with --isolation host, which the result reports as not isolated`,
    );
    this.name = "SandboxUnavailableError";
  }
}

const docker = (args: readonly string[], timeout = 600_000) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (settle) => {
      execFile(
        "docker",
        [...args],
        { timeout, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          settle({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    },
  );

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
    ...(input.stage === "prepare"
      ? [["--mount", `type=bind,src=${sandbox.cache},dst=/swarm-cache`]]
      : []),
  ].flat();
  const env = {
    ...input.env,
    PATH: containerPath(input.cwd),
    ...(input.stage === "prepare"
      ? {
          npm_config_cache: "/swarm-cache/npm",
          UV_CACHE_DIR: "/swarm-cache/uv",
          UV_PYTHON_DOWNLOADS: "automatic",
        }
      : {}),
  };
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    input.stage === "prepare" || input.network === "open" ? "bridge" : "none",
    "--user",
    sandbox.user,
    "--workdir",
    input.cwd,
    ...mounts,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    sandbox.image,
    "/bin/sh",
    "-c",
    input.command,
  ];
  return { name, args };
}

/** Removes a container a timed-out or cancelled run left behind; the client's exit does not stop it. */
export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name], 60_000);
}

/** The docker client's own variables: where the daemon is, never anything the checks get. */
const dockerClient = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

/**
 * One command in a fresh container. A run that times out or is cancelled has its container
 * removed, since stopping the client leaves the container running.
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
): Promise<ProcessRunResult> {
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
  const ran = await runProcessGroup("docker", run.args, {
    cwd: sandbox.scratch,
    env: client,
    timeoutMs: context.timeoutMs,
    maxOutputBytes: context.maxOutputBytes,
    signal: context.signal,
  });
  if (ran.timedOut || ran.cancelled) await removeContainer(run.name);
  // 125 is docker's own: the container never started, so no check ran in it.
  if (ran.exitCode === 125 && ran.startFailure === null) {
    return {
      ...ran,
      startFailure: `docker could not start the container: ${ran.stderr.trim().slice(-500)}`,
    };
  }
  return ran;
}
