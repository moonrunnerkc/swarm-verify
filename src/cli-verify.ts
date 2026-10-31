import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { requestVersion, type VerifyRequestInput } from "./api/request.ts";
import type { VerifyResult } from "./api/result.ts";
import { snapshotWorkingTree, verify as verifyRequest } from "./api/verify.ts";
import { buildVersion } from "./build-version.ts";
import { UsageError } from "./cli-command-definitions.ts";
import { commitOf, git } from "./verify/change.ts";
import { exitCodeOf, renderMarkdown, renderText } from "./verify/report.ts";

const shared = {
  workspace: { type: "string" },
  out: { type: "string" },
  sigstore: { type: "boolean" },
  json: { type: "boolean" },
  isolation: { type: "string" },
  dependencies: { type: "string" },
  requirements: { type: "string" },
  "authorize-behavior-change": { type: "boolean" },
} as const;

interface SharedValues {
  readonly out?: string | undefined;
  readonly sigstore?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly isolation?: string | undefined;
  readonly dependencies?: string | undefined;
  readonly requirements?: string | undefined;
  readonly "authorize-behavior-change"?: boolean | undefined;
  readonly model?: string | undefined;
  readonly "prompt-sha256"?: string | undefined;
}

const write = (text: string) => process.stdout.write(`${text}\n`);

function choice<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  flag: string,
): T {
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new UsageError(`${flag} is ${allowed.join(" or ")}`);
}

async function requirementsFrom(path: string | undefined): Promise<unknown[]> {
  if (path === undefined) return [];
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (!Array.isArray(parsed))
    throw new UsageError(`${path} must hold a JSON array of requirements`);
  return parsed;
}

async function run(
  workspace: string,
  base: string,
  candidate: VerifyRequestInput["candidate"],
  values: SharedValues,
): Promise<{ readonly code: number; readonly result: VerifyResult }> {
  const out = resolve(values.out ?? join(workspace, ".swarm", "verify"));
  // Isolated unless the host is asked for by name: a host run is reported as not isolated.
  const mode = choice(values.isolation, ["isolated", "host"] as const, "isolated", "--isolation");
  const request: VerifyRequestInput = {
    version: requestVersion,
    repository: workspace,
    base: { commit: base },
    candidate,
    requirements: (await requirementsFrom(
      values.requirements,
    )) as VerifyRequestInput["requirements"],
    policy: {
      behaviorChange: values["authorize-behavior-change"] === true ? "authorized" : "none",
      execution: {
        mode,
        // Isolated checks run with the network closed; a host run cannot close it.
        network: mode === "isolated" ? "closed" : "open",
        dependencies: choice(
          values.dependencies,
          ["prepare", "linked", "none"] as const,
          mode === "isolated" ? "prepare" : "linked",
          "--dependencies",
        ),
      },
    },
    artifacts: { directory: out },
    producer: {
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values["prompt-sha256"] === undefined ? {} : { promptSha256: values["prompt-sha256"] }),
    },
  };
  const result = await verifyRequest(request, {
    sigstore: values.sigstore === true,
    verifierVersion: buildVersion,
  });
  if (values.json === true) {
    write(JSON.stringify(result));
  } else {
    write(renderText(result));
    if (result.failureOutput.length > 0) write(`\n${result.failureOutput}\n`);
    if (result.evidence.bundle !== null) write(`attestation  ${result.evidence.bundle}`);
    if (result.evidence.publicKey !== null) write(`public key   ${result.evidence.publicKey}`);
    for (const problem of result.integrity.problems) write(`signing      ${problem}`);
  }
  return { code: exitCodeOf(result), result };
}

/** `verify`: the working tree, a ref range or a patch file, against a base commit. */
export async function verify(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      ...shared,
      base: { type: "string" },
      patch: { type: "string" },
      range: { type: "string" },
      model: { type: "string" },
      "prompt-sha256": { type: "string" },
    },
  });
  if (values.patch !== undefined && values.range !== undefined) {
    throw new UsageError("verify takes --patch or --range, not both");
  }
  if (values.range !== undefined && values.base !== undefined) {
    throw new UsageError("--range names its own base; drop --base");
  }
  const workspace = resolve(values.workspace ?? process.cwd());
  if (values.range !== undefined) {
    const [from, to, extra] = values.range.split("..");
    if (!from || !to || extra !== undefined) {
      throw new UsageError(`${values.range} is not a range of the form base..head`);
    }
    const head = await commitOf(workspace, to);
    return (
      await run(
        workspace,
        await commitOf(workspace, from),
        { kind: "commit", commit: head },
        values,
      )
    ).code;
  }
  const base = await commitOf(workspace, values.base ?? "HEAD");
  if (values.patch !== undefined) {
    const path = resolve(values.patch);
    const sha256 = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    return (await run(workspace, base, { kind: "patch", path, sha256 }, values)).code;
  }
  const scratch = await mkdtemp(join(tmpdir(), "swarm-verify-candidate-"));
  try {
    const snapshot = await snapshotWorkingTree(workspace, base, join(scratch, "candidate.patch"));
    return (
      await run(
        workspace,
        base,
        { kind: "patch", path: snapshot.path, sha256: snapshot.sha256 },
        values,
      )
    ).code;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * `ci`: the change on HEAD since it left the base branch, with a Markdown summary where the CI
 * system reads one. The base is --base, else the pull request's base branch.
 */
export async function ci(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { ...shared, base: { type: "string" } },
  });
  const workspace = resolve(values.workspace ?? process.cwd());
  const baseRef =
    values.base ??
    (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
  if (baseRef === undefined) {
    throw new UsageError("ci needs --base <ref> outside a pull request");
  }
  const mergeBase = (await git(workspace, ["merge-base", baseRef, "HEAD"])).toString().trim();
  const head = await commitOf(workspace, "HEAD");
  const { code, result } = await run(
    workspace,
    mergeBase,
    { kind: "commit", commit: head },
    values,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) await appendFile(summary, renderMarkdown(result));
  return code;
}
