export interface CommandDefinition {
  readonly name: string;
  readonly syntax: string;
  readonly description: string;
}

/** The subcommands, in the order help lists them. */
export const commandDefinitions: readonly CommandDefinition[] = [
  {
    name: "verify",
    syntax:
      "verify [--base <ref>] [--patch <file> | --range <a..b>] [--isolation isolated|host] [--dependencies prepare|linked|none] [--requirements <file>] [--authorize-behavior-change] [--out <dir>] [--sigstore] [--json]",
    description: "rerun the declared checks on a change in a clean checkout and sign the verdict",
  },
  {
    name: "init",
    syntax: "init [--seal <glob>]",
    description: "write swarm.toml from the project's manifests, or seal held-out checks",
  },
  {
    name: "replay",
    syntax: "replay <evidence-dir> [--workspace <repo>] [--out <dir>] [--json]",
    description: "run a recorded verification again as it was run and compare every result",
  },
  {
    name: "ci",
    syntax:
      "ci [--base <ref>] [--isolation isolated|host] [--dependencies prepare|linked|none] [--requirements <file>] [--authorize-behavior-change] [--out <dir>] [--sigstore] [--json]",
    description: "verify HEAD's change against the pull request's base branch",
  },
];

/** A command line this program cannot read: exit code 2, with the usage. */
export class UsageError extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = "UsageError";
  }
}

export function usageFor(program: string): string {
  return [
    `${program} <command> [options]`,
    "",
    ...commandDefinitions.flatMap((command) => [
      `  ${program} ${command.syntax}`,
      `      ${command.description}`,
    ]),
    "",
    "Every command takes --workspace <dir> where it reads a repository; the default is here.",
  ].join("\n");
}
