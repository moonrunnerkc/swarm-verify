import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { envelopeOf } from "../verify/dsse.ts";
import { type Statement, statementSchema } from "../verify/predicate.ts";
import { requestVersion } from "./request.ts";
import type { VerifyResult } from "./result.ts";
import { verify } from "./verify.ts";

export interface Replay {
  readonly recorded: Statement["predicate"];
  readonly replayed: VerifyResult;
  /** What the replay found different, one line each; empty where it agrees. */
  readonly divergences: readonly string[];
}

export class UnreplayableBundleError extends Error {
  constructor(detail: string) {
    super(`the bundle cannot be replayed: ${detail}`);
    this.name = "UnreplayableBundleError";
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The signed statement and patch of an evidence directory written by `verify`. */
async function readBundle(
  directory: string,
): Promise<{ readonly statement: Statement; readonly patch: string }> {
  const document = JSON.parse(await readFile(join(directory, "attestation.sigstore.json"), "utf8"));
  const envelope = envelopeOf(document);
  if (envelope === null)
    throw new UnreplayableBundleError("attestation.sigstore.json holds no DSSE envelope");
  const statement = statementSchema.parse(
    JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
  );
  const patch = join(directory, "change.patch");
  const expected = statement.subject.find((subject) => subject.name === "change.patch")?.digest
    .sha256;
  if (expected === undefined || sha256(await readFile(patch)) !== expected) {
    throw new UnreplayableBundleError("change.patch is not the patch the statement signed");
  }
  return { statement, patch };
}

/** Every recorded check, test and requirement result the replay does not reproduce. */
export function divergencesOf(recorded: Statement["predicate"], replayed: VerifyResult): string[] {
  const found: string[] = [];
  const same = (what: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      found.push(`${what}: recorded ${JSON.stringify(before)}, replayed ${JSON.stringify(after)}`);
    }
  };
  same("state", recorded.state, replayed.state);
  same("regression", recorded.regression.status, replayed.regression.status);
  same(
    "lockfiles",
    recorded.execution.dependencies.lockfiles,
    replayed.execution.dependencies.lockfiles,
  );
  for (const check of recorded.checks) {
    const again = replayed.checks.find((one) => one.name === check.name);
    same(`check ${check.name}`, check.result, again?.result ?? "not run");
    for (const key of [
      "fixed",
      "newFailures",
      "inherited",
      "removed",
      "expectationChanges",
      "witnesses",
    ] as const) {
      same(`check ${check.name} ${key}`, check.tests?.[key] ?? [], again?.tests?.[key] ?? []);
    }
  }
  for (const requirement of recorded.requirements) {
    const again = replayed.requirements.find((one) => one.id === requirement.id);
    same(`requirement ${requirement.id}`, requirement.status, again?.status ?? "not judged");
  }
  return found;
}

/**
 * Runs the recorded verification again: the same base and signed patch, the same requirements
 * and checks, in a container from the recorded image with dependencies installed fresh from the
 * lockfiles in the tree, then compares every result with what was recorded.
 */
export async function replay(
  bundle: string,
  options: {
    readonly repository: string;
    readonly out: string;
    readonly verifierVersion: string;
    readonly swarmHome?: string;
  },
): Promise<Replay> {
  const { statement, patch } = await readBundle(bundle);
  const recorded = statement.predicate;
  const image = recorded.execution.image?.split(" (")[0];
  const replayed = await verify(
    {
      version: requestVersion,
      repository: options.repository,
      base: { commit: recorded.base.commit },
      candidate: { kind: "patch", path: patch, sha256: sha256(await readFile(patch)) },
      requirements: recorded.requirements.map((one) => ({
        id: one.id,
        text: one.text,
        source: one.source,
        kind: one.kind,
        required: one.required,
        assumptions: one.assumptions,
        evidence: one.expected,
      })),
      checks: recorded.checks
        .filter(
          (check) =>
            check.authority === "user-acceptance" || check.authority === "independently-generated",
        )
        .map((check) => ({
          name: check.name,
          command: check.command,
          kind: check.kind,
          authority:
            check.authority === "independently-generated"
              ? ("independently-generated" as const)
              : ("user-acceptance" as const),
        })),
      policy: {
        behaviorChange: recorded.policy.behaviorChange,
        execution: {
          mode: "isolated",
          network: recorded.execution.network,
          dependencies: "prepare",
          ...(image === undefined ? {} : { image }),
        },
      },
      artifacts: { directory: options.out },
      producer: recorded.producer,
    },
    {
      verifierVersion: options.verifierVersion,
      freshBase: true,
      ...(options.swarmHome === undefined ? {} : { swarmHome: options.swarmHome }),
    },
  );
  return { recorded, replayed, divergences: divergencesOf(recorded, replayed) };
}
