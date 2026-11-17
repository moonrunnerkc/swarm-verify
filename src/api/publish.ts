import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeContained } from "../fs/contained.ts";
import { type WrittenAttestation, writeAttestation } from "../verify/dsse.ts";
import type { ResolvedKey } from "../verify/signing.ts";

export const manifestVersion = "swarm-verify.manifest/v1";

/**
 * Whether the run's evidence reached its directory as asked. signed: published and signed.
 * unsigned: published without a signature the caller made optional. failed: a required signature
 * or the publication itself failed; the task's state says nothing about this.
 */
export type DeliveryStatus = "signed" | "unsigned" | "failed";

export interface Delivery {
  readonly status: DeliveryStatus;
  readonly runId: string;
  /** The directory holding this run's files, or null where nothing was published. */
  readonly directory: string | null;
  readonly manifest: string | null;
  readonly attestation: WrittenAttestation | null;
  readonly statement: string | null;
  readonly problems: readonly string[];
}

export interface PublishInput {
  readonly directory: string;
  readonly statement: unknown;
  readonly patch: Buffer;
  readonly logs: readonly { readonly name: string; readonly text: string }[];
  readonly sigstore: boolean;
  /** A run whose signature fails is delivered as failed unless the caller made it optional. */
  readonly signing: "required" | "optional";
  readonly resolveKey: () => Promise<ResolvedKey>;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Whether the path is absent or an empty directory, the only targets a run is published to. */
async function vacant(path: string): Promise<boolean> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return true;
  return stats.isDirectory() && (await readdir(path)).length === 0;
}

/**
 * Writes one run's evidence into a staging directory beside the target, binds every file in a
 * manifest, and moves the whole directory into place with one rename. A target that already holds
 * a run is never written to, so a failed or concurrent run cannot leave another run's files
 * looking like its own; a reader takes the run identity from the returned delivery or the
 * manifest.
 */
export async function publishEvidence(input: PublishInput): Promise<Delivery> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;
  const target = input.directory;
  const refused = (problem: string): Delivery => ({
    status: "failed",
    runId,
    directory: null,
    manifest: null,
    attestation: null,
    statement: null,
    problems: [problem],
  });
  if (!(await vacant(target)))
    return refused(
      `${target} already holds evidence, and a run is never published over another; give each run its own directory`,
    );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}.staging-`));
  try {
    const problems: string[] = [];
    const files: { path: string; sha256: string; bytes: number }[] = [];
    const put = async (path: string, content: Buffer | string, mode = 0o600) => {
      await writeContained(staging, path, content, mode);
      files.push({ path, sha256: sha256(content), bytes: Buffer.byteLength(content) });
    };
    for (const log of input.logs) await put(log.name, log.text);
    let attestation: WrittenAttestation | null = null;
    try {
      attestation = await writeAttestation(input.statement, input.patch, staging, {
        sigstore: input.sigstore,
        resolveKey: input.resolveKey,
      });
      if (attestation.notice !== null) problems.push(attestation.notice);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      await writeContained(staging, "change.patch", input.patch);
    }
    for (const name of ["change.patch", "attestation.sigstore.json", "attestation.pub.pem"]) {
      const written = await lstat(join(staging, name)).catch(() => null);
      if (written === null) continue;
      const bytes = await readFile(join(staging, name));
      files.push({ path: name, sha256: sha256(bytes), bytes: bytes.length });
    }
    // Written after signing: the keyless path leaves its own copy of the statement here.
    await put("statement.json", `${JSON.stringify(input.statement, null, 2)}\n`);
    const status: DeliveryStatus =
      attestation !== null ? "signed" : input.signing === "optional" ? "unsigned" : "failed";
    const manifest = {
      version: manifestVersion,
      runId,
      delivery: status,
      statementSha256: sha256(JSON.stringify(input.statement)),
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      problems,
    };
    await writeContained(staging, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    try {
      await rename(staging, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR")
        return refused(
          `another run published to ${target} first; this run's evidence was not kept`,
        );
      throw error;
    }
    const at = (path: string | undefined) => (path === undefined ? null : join(target, path));
    return {
      status,
      runId,
      directory: target,
      manifest: join(target, "manifest.json"),
      attestation:
        attestation === null
          ? null
          : {
              ...attestation,
              bundle: at(basename(attestation.bundle)) ?? attestation.bundle,
              patch: at(basename(attestation.patch)) ?? attestation.patch,
              publicKey:
                attestation.publicKey === null ? null : join(target, "attestation.pub.pem"),
            },
      statement: join(target, "statement.json"),
      problems,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
