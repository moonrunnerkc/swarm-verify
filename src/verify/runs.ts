import type { DeclaredCheck } from "../config/swarm-toml.ts";
import { type BaseCheckout, restoreFrom, treeDigest } from "./checkout.ts";
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
 * The candidate as delivered, then the base's tests against it where the candidate rewrote,
 * moved and edited, or removed some, then the candidate's tests against the base's source where it added or rewrote
 * some. Every variant is laid out from git objects in the one checkout and put back afterwards,
 * so the candidate tree is what remains for the mutation pass and the held-out checks.
 */
export async function measureCandidate(input: RunInput): Promise<CandidateRuns> {
  const { checkout, changes, candidateTree } = input;
  const rewrites: string[] = [];
  const candidate = await runAll(input, "candidate", input.wrap, rewrites);
  // A file moved and edited is judged at its old path, so its moved copy is out of that run.
  const edited = [...changes.movedAndEdited];
  const rewritten = [...changes.modified, ...changes.deleted, ...edited.flat()];
  let obligation: readonly MeasuredRun[] = candidate;
  if (rewritten.length > 0) {
    await restoreFrom(checkout, checkout.baseCommit, rewritten);
    obligation = await runAll(input, "obligation", null, rewrites);
    await restoreFrom(checkout, candidateTree, rewritten);
  }
  const authored = [
    ...changes.added,
    ...changes.modified,
    ...changes.moved.values(),
    ...changes.movedAndEdited.values(),
    ...changes.relocated,
  ];
  let witness: readonly (MeasuredRun | null)[] = input.checks.map(() => null);
  if (authored.length > 0 && input.otherPaths.length === 0) {
    // Only tests changed, so the base's source is the candidate's: the candidate run is the witness.
    witness = candidate;
  } else if (authored.length > 0) {
    await restoreFrom(checkout, checkout.baseCommit, input.otherPaths);
    witness = await runAll(input, "witness", null, rewrites);
    await restoreFrom(checkout, candidateTree, input.otherPaths);
  }
  return { candidate, obligation, witness, rewrites };
}
