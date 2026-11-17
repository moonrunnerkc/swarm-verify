import { resolve } from "node:path";
import { detectChecks } from "../config/detect.ts";
import { readSwarmToml } from "../config/swarm-toml.ts";
import { trustedCommand } from "../exec/trusted-executable.ts";
import { acceptancePolicy } from "../verify/acceptance.ts";
import { cloneBase } from "../verify/checkout.ts";
import { allChecks } from "../verify/checks.ts";
import { reportPlans } from "../verify/per-test.ts";
import { lockfileInstall } from "../verify/prepare.ts";
import { docker, imageFor } from "../verify/sandbox.ts";
import { readSealed, swarmHome } from "../verify/sealed-store.ts";
import { signingKeyVariable } from "../verify/signing.ts";
import type { VerifyRequestInput } from "./request.ts";
import { parseRequest } from "./verify.ts";

/**
 * What a verification of a request would do, read without running anything the project
 * controls: the base is cloned and its declarations read, never executed, and no image is pulled.
 */
export interface Preflight {
  readonly baseCommit: string;
  readonly candidate: string;
  readonly scope: "requirements" | "regression-only";
  readonly requirements: readonly {
    readonly id: string;
    readonly kind: string;
    readonly required: boolean;
  }[];
  readonly checks: readonly {
    readonly name: string;
    readonly command: string;
    readonly authority: string;
    /** The runner whose report judges it test by test, or null where its exit code does. */
    readonly runner: string | null;
  }[];
  readonly heldOut: { readonly sealed: boolean; readonly checks: number };
  readonly execution: {
    readonly mode: "isolated" | "host";
    readonly network: "open" | "closed";
    readonly image: string | null;
    readonly imagePresent: boolean | null;
  };
  /** The command dependencies would be prepared with, or why none. */
  readonly setup: string;
  readonly stages: readonly string[];
  readonly signing: string;
  readonly acceptance: string;
  /** What must change before the run can measure anything; empty where nothing. */
  readonly missing: readonly string[];
}

export async function preflight(
  input: VerifyRequestInput,
  options: { readonly sigstore?: boolean; readonly swarmHome?: string } = {},
): Promise<Preflight> {
  const request = parseRequest(input);
  const workspace = resolve(request.repository);
  const policy = request.policy.execution;
  const home = resolve(options.swarmHome ?? swarmHome());
  const missing: string[] = [];
  const candidate =
    request.candidate.kind === "commit"
      ? `commit ${request.candidate.commit}`
      : `patch ${request.candidate.path} (sha256 ${request.candidate.sha256})`;
  const checkout = await cloneBase(workspace, request.base.commit);
  try {
    const config = await readSwarmToml(checkout.dir);
    const checks = allChecks(config?.checks ?? (await detectChecks(checkout.dir)), request.checks);
    const plans = await reportPlans(checkout.dir, checks);
    if (checks.length === 0) missing.push("no checks are declared in swarm.toml or the manifests");
    const sealed = await readSealed(workspace, home);
    const isolated = policy.mode === "isolated";
    const commands = checks.map((check) => check.command);
    const image = isolated ? (policy.image ?? (await imageFor(checkout.dir, commands))) : null;
    let imagePresent: boolean | null = null;
    if (image !== null) {
      const server = await docker(["version", "--format", "{{.Server.Version}}"], 30_000);
      if (server.code !== 0)
        missing.push(`a docker daemon that answers (${server.stderr.trim() || "no answer"})`);
      else imagePresent = (await docker(["image", "inspect", image], 30_000)).code === 0;
    }
    if (isolated && policy.dependencies === "linked")
      missing.push("prepared dependencies: linked dependencies cannot be used in isolation");
    const install =
      policy.dependencies === "none"
        ? null
        : policy.dependencies === "linked"
          ? "the workspace's node_modules and .venv, linked"
          : (config?.setup ?? (await lockfileInstall(checkout.dir, isolated)));
    if (options.sigstore === true && (await trustedCommand("cosign")) === null)
      missing.push("cosign on PATH, for keyless signing");
    if ((await trustedCommand("git")) === null) missing.push("git on PATH");
    const stages = [
      "clone the base",
      ...(install === null ? [] : ["prepare dependencies (network open)"]),
      "measure the base",
      "apply the candidate",
      "measure the candidate and rerun deciding failures",
      ...(sealed === null ? [] : ["run the sealed held-out checks"]),
      "coverage and one mutant",
      "judge requirements",
      "sign and publish the evidence",
    ];
    return {
      baseCommit: checkout.baseCommit,
      candidate,
      scope: request.requirements.length > 0 ? "requirements" : "regression-only",
      requirements: request.requirements.map(({ id, kind, required }) => ({ id, kind, required })),
      checks: checks.map((check, at) => ({
        name: check.name,
        command: check.command,
        authority: check.authority ?? "pre-existing",
        runner: plans[at]?.runner ?? null,
      })),
      heldOut: { sealed: sealed !== null, checks: sealed?.checks.length ?? 0 },
      execution: { mode: policy.mode, network: policy.network, image, imagePresent },
      setup: install ?? "none: no dependencies are prepared",
      stages,
      signing:
        options.sigstore === true
          ? "keyless through cosign and Sigstore, required"
          : process.env[signingKeyVariable] !== undefined
            ? `the key in ${signingKeyVariable}, required`
            : "the OS keychain's key, or a per-run key with a notice, required",
      acceptance: acceptancePolicy,
      missing,
    };
  } finally {
    await checkout.remove();
  }
}
