import type { Handler } from "./cli-main.ts";

/**
 * The verifier's subcommands as handlers, for its own binary and for a caller that offers the
 * same commands under its own name (the coding agent's `swarm verify`, `swarm init`, `swarm ci`)
 * without a second implementation behind them.
 */
export const verifierCommands: Readonly<Record<"verify" | "init" | "ci" | "replay", Handler>> = {
  verify: async (args, signal) => (await import("./cli-verify.ts")).verify(args, signal),
  init: async (args) => (await import("./cli-init.ts")).init(args),
  ci: async (args, signal) => (await import("./cli-verify.ts")).ci(args, signal),
  replay: async (args, signal) => (await import("./cli-replay.ts")).replayCommand(args, signal),
};

export { describeRunningVersion } from "./build-version.ts";
export {
  type CommandDefinition,
  commandDefinitions,
  UsageError,
  usageFor,
} from "./cli-command-definitions.ts";
export { dispatch, type Handler } from "./cli-main.ts";
