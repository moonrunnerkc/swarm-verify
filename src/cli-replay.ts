import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type SignerPolicy, UnauthenticatedBundleError } from "./api/bundle-auth.ts";
import { replay, UnreplayableBundleError } from "./api/replay.ts";
import { buildVersion } from "./build-version.ts";
import { UsageError } from "./cli-command-definitions.ts";

const write = (text: string) => process.stdout.write(`${text}\n`);

/** The signer the caller trusts, from the command line: keys, or a keyless identity and issuer. */
async function signerFrom(values: {
  readonly key?: readonly string[] | undefined;
  readonly "certificate-identity"?: string | undefined;
  readonly "certificate-oidc-issuer"?: string | undefined;
}): Promise<SignerPolicy> {
  const identity = values["certificate-identity"];
  const issuer = values["certificate-oidc-issuer"];
  const keys = values.key ?? [];
  if (keys.length > 0 && (identity !== undefined || issuer !== undefined))
    throw new UsageError("replay trusts --key or a keyless identity, not both");
  if (keys.length > 0)
    return {
      kind: "key",
      publicKeys: await Promise.all(keys.map((path) => readFile(resolve(path), "utf8"))),
    };
  if (identity !== undefined && issuer !== undefined) return { kind: "keyless", identity, issuer };
  throw new UsageError(
    "replay needs the signer you trust: --key <public.pem>, or --certificate-identity and --certificate-oidc-issuer for a keyless bundle; a key beside the bundle is not trusted by itself",
  );
}

/**
 * `replay <bundle>`: the recorded verification authenticated against the signer the caller
 * trusts, then run again under its recorded execution (in a container, or on this host where the
 * caller allows it) with dependencies installed fresh, and every result compared. 0 when the
 * replay agrees, 1 when it diverges, 5 when it could not run, 6 when the bundle was not
 * authenticated (nothing in it ran).
 */
export async function replayCommand(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean" },
      key: { type: "string", multiple: true },
      "certificate-identity": { type: "string" },
      "certificate-oidc-issuer": { type: "string" },
      "allow-host": { type: "boolean" },
    },
  });
  const [bundle] = positionals;
  if (bundle === undefined)
    throw new UsageError("replay needs the evidence directory verify wrote");
  const signer = await signerFrom(values);
  const directory = resolve(bundle);
  const out = resolve(values.out ?? `${directory}.replay-${Date.now()}`);
  let ran: Awaited<ReturnType<typeof replay>>;
  try {
    ran = await replay(directory, {
      repository: resolve(values.workspace ?? process.cwd()),
      out,
      verifierVersion: buildVersion,
      signer,
      allowHost: values["allow-host"] === true,
    });
  } catch (error) {
    if (error instanceof UnauthenticatedBundleError) {
      process.stderr.write(`${error.message}\n`);
      return 6;
    }
    if (!(error instanceof UnreplayableBundleError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 5;
  }
  if (values.json === true) {
    write(
      JSON.stringify({ divergences: ran.divergences, state: ran.replayed.state, evidence: out }),
    );
  } else {
    write(`recorded     ${ran.recorded.state} (${ran.recorded.execution.statement})`);
    write(`replayed     ${ran.replayed.state} (${ran.replayed.execution.statement})`);
    for (const line of ran.divergences) write(`diverges     ${line}`);
    if (ran.divergences.length === 0)
      write("agreement    every recorded check, test and requirement result was reproduced");
    write(`evidence     ${out}`);
  }
  if (ran.replayed.state === "blocked") return 5;
  return ran.divergences.length === 0 ? 0 : 1;
}
