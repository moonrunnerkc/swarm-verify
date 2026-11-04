import type { ExecutionPolicy, Producer, Requirement, TrustedCheck } from "../api/request.ts";
import type { ResolvedChange } from "./change.ts";
import type { PinnedLocks } from "./generated-lock.ts";
import type { Registries } from "./latest-version.ts";
import type { Statement } from "./predicate.ts";

/** What one verification of a resolved change takes, and what it gives back. */
export interface VerifyOptions {
  readonly workspace: string;
  readonly change: ResolvedChange;
  readonly requirements?: readonly Requirement[];
  readonly trustedChecks?: readonly TrustedCheck[];
  readonly policy: ExecutionPolicy;
  readonly behaviorChange?: "none" | "authorized";
  /** Reruns of a test whose failing first run decides its verdict; three where unset. */
  readonly reruns?: number;
  readonly producer?: Producer;
  readonly swarmHome?: string;
  /** Measure the base again instead of reading a cached run: a replay checks, it does not reuse. */
  readonly freshBase?: boolean;
  readonly signal?: AbortSignal;
  readonly version: string;
  /** Where a constraint's latest version is looked up; the public registries by default. */
  readonly registries?: Registries;
  /** The uv.lock a recording generated for each side, which a replay installs from. */
  readonly pinnedLocks?: PinnedLocks;
}

export interface VerifyOutcome {
  readonly statement: Statement;
  readonly patch: Buffer;
  /** The files the statement's `logs` name, for the caller to write beside it. */
  readonly logs: readonly { readonly name: string; readonly text: string }[];
  /** What failed, as the checks printed it: the text a person or the agent acts on. */
  readonly failureText: string;
}
