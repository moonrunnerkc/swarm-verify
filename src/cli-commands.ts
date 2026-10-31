import type { Handler } from "./cli-main.ts";

/**
 * The verifier's subcommands as handlers, for its own binary and for a caller that offers the
 * same commands under its own name (the coding agent's `swarm verify`, `swarm init`, `swarm ci`)
 * without a second implementation behind them.
 */
export const verifierCommands: Readonly<Record<"verify" | "init" | "ci" | "replay", Handler>> = {
  verify: async (args) => (await import("./cli-verify.ts")).verify(args),
  init: async (args) => (await import("./cli-init.ts")).init(args),
  ci: async (args) => (await import("./cli-verify.ts")).ci(args),
  replay: async (args) => (await import("./cli-replay.ts")).replayCommand(args),
};

export { commandDefinitions, UsageError } from "./cli-command-definitions.ts";
export type { Handler } from "./cli-main.ts";
