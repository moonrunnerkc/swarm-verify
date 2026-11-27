import type { DeclaredCheck } from "../config/swarm-toml.ts";
import {
  type BaseCheckout,
  removeWrittenSince,
  restoreFrom,
  treeDigest,
  untrackedPaths,
} from "./checkout.ts";
import type { CheckContext } from "./checks.ts";
import type { TestFileChanges } from "./compare.ts";
import { type MeasuredRun, runMeasured, type Wrap } from "./per-test.ts";
import type { ReportPlan } from "./report-plan.ts";

export interface CandidateRuns {
  /** Runs that changed tracked files they were measuring, which makes them measure something else. */
  readonly rewrites: readonly string[];
  readonly candidate: readonly MeasuredRun[];
  /**
   * The candidate's source with the base's versions of the test files it modified, deleted, or
   * moved and edited.
   */
  readonly obligation: readonly MeasuredRun[];
  /** The base's source with the candidate's test files; null for each check where none changed. */
  readonly witness: readonly (MeasuredRun | null)[];
  /** The untracked paths every one of these runs started from. */
  readonly untracked: ReadonlySet<string>;
}

interface RunInput {
  readonly checkout: BaseCheckout;
  readonly checks: readonly DeclaredCheck[];
  readonly plans: readonly (ReportPlan | null)[];
  readonly context: CheckContext;
  readonly scratch: string;
  readonly wrap: Wrap | null;
  readonly changes: TestFileChanges;
  /** The tree the candidate produced, from which its files are laid back after each variant. */
  readonly candidateTree: string;
  /** Every path the candidate changed that is not a test file it added, modified or moved. */
  readonly otherPaths: readonly string[];
}

/**
 * Every check on the tree as it stands, each read before and after: a check that rewrites a
 * tracked file is named, since what it then measures is not the tree it was given.
 */
async function runAll(
  input: RunInput,
  label: string,
  wrap: Wrap | null,
  rewrites: string[],
): Promise<MeasuredRun[]> {
  const runs: MeasuredRun[] = [];
  for (const [at, check] of input.checks.entries()) {
    const plan = input.plans[at] ?? null;
    const { context, scratch } = input;
    const before = await treeDigest(input.checkout.dir);
    runs.push(await runMeasured({ check, plan, context, scratch, label, judge: true, wrap }));
    if ((await treeDigest(input.checkout.dir)) !== before) {
      rewrites.push(`check ${check.name} rewrote tracked files during the ${label} run`);
    }
  }
  return runs;
}

/**
 * The base's tests against the candidate's source where the candidate rewrote, moved and edited,
 * or removed some, then the candidate's tests against the base's source where it added or rewrote
 * some, then the candidate as delivered. Every variant is laid out from git objects in the one
 * checkout and put back afterwards, and starts from the untracked paths the base's run started
 * from: the base's tests once ran on the build output the candidate's checks had just written, and
 * files that could not load at the base loaded there (fix-depose-09b01c1, 2026-11-07). The
 * candidate runs last, so what it leaves is what the mutation pass and the held-out checks run
 * on, as the base's held-out run follows the base's checks.
 */
export async function measureCandidate(input: RunInput): Promise<CandidateRuns> {
  const { checkout, changes, candidateTree } = input;
  const rewrites: string[] = [];
  const untracked = await untrackedPaths(checkout);
  const variant = async (label: string, paths: readonly string[], from: string) => {
    await restoreFrom(checkout, from, paths);
    const runs = await runAll(input, label, null, rewrites);
    await restoreFrom(checkout, candidateTree, paths);
    await removeWrittenSince(checkout, untracked);
    return runs;
  };
  // A file moved and edited is judged at its old path, so its moved copy is out of that run.
  const edited = [...changes.movedAndEdited];
  const rewritten = [...changes.modified, ...changes.deleted, ...edited.flat()];
  const obligation =
    rewritten.length > 0 ? await variant("obligation", rewritten, checkout.baseCommit) : null;
  const authored = [
    ...changes.added,
    ...changes.modified,
    ...changes.moved.values(),
    ...changes.movedAndEdited.values(),
    ...changes.relocated,
  ];
  // Where only tests changed, the base's source is the candidate's: the candidate run is the witness.
  const ownWitness = authored.length > 0 && input.otherPaths.length > 0;
  const witnessRuns = ownWitness
    ? await variant("witness", input.otherPaths, checkout.baseCommit)
    : null;
  const candidate = await runAll(input, "candidate", input.wrap, rewrites);
  const witness: readonly (MeasuredRun | null)[] =
    witnessRuns ?? (authored.length > 0 ? candidate : input.checks.map(() => null));
  return { candidate, obligation: obligation ?? candidate, witness, rewrites, untracked };
}
