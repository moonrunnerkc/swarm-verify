import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessGroup } from "../exec/run-process.ts";
import { trustedCommand } from "../exec/trusted-executable.ts";
import { type Envelope, envelopeOf, pae } from "../verify/dsse.ts";
import { predicateType, type Statement, statementSchema } from "../verify/predicate.ts";

/**
 * Who a caller trusts to have signed a bundle. A key policy names the public keys themselves; a
 * keyless policy names the certificate identity and OIDC issuer Sigstore must have bound. A public
 * key that travels beside a bundle authorizes nothing on its own: the caller must pass it.
 */
export type SignerPolicy =
  | { readonly kind: "key"; readonly publicKeys: readonly string[] }
  | { readonly kind: "keyless"; readonly identity: string; readonly issuer: string };

export class UnauthenticatedBundleError extends Error {
  constructor(detail: string) {
    super(`the bundle was not authenticated, so nothing in it was used: ${detail}`);
    this.name = "UnauthenticatedBundleError";
  }
}

/** Larger than any bundle swarm-verify writes, small enough that parsing it is bounded. */
export const maxBundleBytes = 32 * 1024 * 1024;

export interface Authenticated {
  readonly statement: Statement;
  /** The exact bytes the signature was checked over, as read once. */
  readonly bundleBytes: Buffer;
  readonly signer: { readonly kind: "key"; readonly fingerprint: string } | SignerPolicy;
}

/** A regular file read once, refused when it is a link or larger than the bound. */
async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      throw new UnauthenticatedBundleError(`${path} could not be opened (${error.code ?? error})`);
    },
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new UnauthenticatedBundleError(`${path} is not a regular file`);
    if (stats.size > limit)
      throw new UnauthenticatedBundleError(`${path} is ${stats.size} bytes, over ${limit}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function trustedKeys(pems: readonly string[]): { key: KeyObject; fingerprint: string }[] {
  if (pems.length === 0) throw new UnauthenticatedBundleError("no trusted public key was given");
  return pems.map((pem) => {
    try {
      const key = createPublicKey(pem);
      const der = key.export({ type: "spki", format: "der" });
      return { key, fingerprint: createHash("sha256").update(der).digest("hex") };
    } catch {
      throw new UnauthenticatedBundleError("a trusted public key is not a valid PEM public key");
    }
  });
}

/** The fingerprint of the trusted key that signed the envelope, or null when none did. */
function signedBy(envelope: Envelope, pems: readonly string[]): string | null {
  const message = pae(envelope.payloadType, Buffer.from(envelope.payload, "base64"));
  for (const { key, fingerprint } of trustedKeys(pems)) {
    for (const signature of envelope.signatures) {
      const valid = (() => {
        try {
          return verify(null, message, key, Buffer.from(signature.sig, "base64"));
        } catch {
          return false;
        }
      })();
      if (valid) return fingerprint;
    }
  }
  return null;
}

/**
 * Sigstore's own verification of the exact bytes read, against the identity and issuer the caller
 * names. Subject claims are checked by the caller against the files it holds.
 */
async function keylessVerifies(
  bytes: Buffer,
  policy: Extract<SignerPolicy, { kind: "keyless" }>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const cosign = await trustedCommand("cosign");
  if (cosign === null)
    throw new UnauthenticatedBundleError(
      "cosign is not on PATH, and a keyless bundle is checked by it; install cosign or trust a key",
    );
  const scratch = await mkdtemp(join(tmpdir(), "swarm-verify-auth-"));
  try {
    const bundle = join(scratch, "bundle.json");
    await writeFile(bundle, bytes, { mode: 0o600 });
    const args = [
      "verify-blob-attestation",
      "--bundle",
      bundle,
      "--certificate-identity",
      policy.identity,
      "--certificate-oidc-issuer",
      policy.issuer,
      "--type",
      predicateType,
      "--check-claims=false",
    ];
    const ran = await runProcessGroup(cosign, args, {
      cwd: scratch,
      env: { PATH: process.env.PATH ?? "", HOME: scratch },
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
      signal,
    });
    if (ran.startFailure !== null || ran.exitCode !== 0 || ran.timedOut || ran.cancelled)
      throw new UnauthenticatedBundleError(
        `cosign did not verify it for ${policy.identity} from ${policy.issuer}: ${ran.stderr.trim().slice(-500) || ran.startFailure || "no output"}`,
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The statement of a bundle, decoded only after its envelope verifies against the signer policy.
 * Nothing in the payload (commands, paths, policy) is read before that.
 */
export async function authenticatedStatement(
  path: string,
  policy: SignerPolicy,
  signal?: AbortSignal,
): Promise<Authenticated> {
  const bundleBytes = await boundedRead(path, maxBundleBytes);
  let document: unknown;
  try {
    document = JSON.parse(bundleBytes.toString("utf8"));
  } catch {
    throw new UnauthenticatedBundleError(`${path} is not JSON`);
  }
  const envelope = envelopeOf(document);
  if (envelope === null) throw new UnauthenticatedBundleError(`${path} holds no DSSE envelope`);
  let signer: Authenticated["signer"];
  if (policy.kind === "key") {
    const fingerprint = signedBy(envelope, policy.publicKeys);
    if (fingerprint === null)
      throw new UnauthenticatedBundleError("no signature verifies against a trusted key");
    signer = { kind: "key", fingerprint };
  } else {
    await keylessVerifies(bundleBytes, policy, signal);
    signer = policy;
  }
  let statement: Statement;
  try {
    statement = statementSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
    );
  } catch {
    throw new UnauthenticatedBundleError(
      "the signed payload is not a swarm-verify statement this version reads",
    );
  }
  return { statement, bundleBytes, signer };
}
