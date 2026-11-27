import { createHash } from "node:crypto";
import { type Configured, configuredConventions } from "./configured.ts";
import { conventionSources, measureConventions, type SourceText } from "./measure.ts";
import { type ConventionRule, conventionValues } from "./rules.ts";
import { type UnsafeFinding, unsafePatterns } from "./unsafe.ts";

/** Enough sites, in enough files, all agreeing, for a value to be more than a guess. */
const firm = { sites: 3, files: 2 };

/** What samples support proposing, and what they do not, for a person to edit and approve. */
export interface ConventionProposal {
  readonly files: number;
  /** A value every measured site agrees on. `basis` says how many, and whether that is thin. */
  readonly proposed: readonly {
    readonly rule: ConventionRule;
    readonly value: string;
    readonly basis: string;
    readonly values: readonly string[];
  }[];
  /** Rules the samples are mixed on: what was counted, and nothing proposed. */
  readonly observed: readonly string[];
  /** Rules the repository's lint configuration already decides, which samples do not override. */
  readonly settled: readonly Configured[];
  /** Where the samples disagree with that configuration. */
  readonly conflicts: readonly string[];
  /** The file that owns formatting, which is never proposed. */
  readonly formatter: string | null;
  /** Unsafe patterns in the samples, each with its safe form: never a value a rule can take. */
  readonly unsafe: readonly UnsafeFinding[];
  /** The samples by path and digest; their text is not kept. */
  readonly sources: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * What a set of samples supports as conventions. Every value is counted from the samples'
 * syntax; nothing a sample says in a comment or a string is read as an instruction. One sample,
 * or a few sites, makes a tentative proposal, and mixed samples make none. `dir` is the
 * repository whose configuration is consulted first.
 */
export async function conventionProposal(
  samples: readonly SourceText[],
  dir: string,
): Promise<ConventionProposal> {
  const files = samples.filter((one) => conventionSources.test(one.path));
  const configured = await configuredConventions(dir);
  const settled = new Map<ConventionRule, Configured>(
    configured.rules.map((one) => [one.rule, one]),
  );
  const proposed: ConventionProposal["proposed"][number][] = [];
  const observed: string[] = [];
  const conflicts: string[] = [];
  for (const tally of measureConventions(files)) {
    if (tally.sites === 0) continue;
    const [value = "", count = 0] =
      Object.entries(tally.counts).sort((a, b) => b[1] - a[1])[0] ?? [];
    const by = settled.get(tally.rule);
    if (by !== undefined) {
      if (count > 0 && value !== by.value)
        conflicts.push(
          `${tally.rule}: the samples mostly use ${value}, and ${by.by} enforces ${by.value}; the configuration wins`,
        );
      continue;
    }
    if (count < tally.sites) {
      const seen = Object.entries(tally.counts).map(([name, sites]) => `${name} ${sites}`);
      observed.push(`${tally.rule}: ${seen.join(", ")} of ${tally.sites} site(s)`);
      continue;
    }
    const kind = tally.sites >= firm.sites && files.length >= firm.files ? "inferred" : "tentative";
    proposed.push({
      rule: tally.rule,
      value,
      basis: `${kind}: ${count} of ${tally.sites} site(s) in ${files.length} file(s)`,
      values: conventionValues[tally.rule],
    });
  }
  return {
    files: files.length,
    proposed,
    observed,
    settled: [...settled.values()],
    conflicts,
    formatter: configured.formatter,
    unsafe: unsafePatterns(files),
    sources: files.map((one) => ({
      path: one.path,
      sha256: createHash("sha256").update(one.text).digest("hex"),
    })),
  };
}
