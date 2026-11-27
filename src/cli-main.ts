import { buildVersion } from "./build-version.ts";
import { UsageError, usageFor } from "./cli-command-definitions.ts";

export type Handler = (args: readonly string[], signal?: AbortSignal) => Promise<number>;

const stopping = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Dispatches one command line, with usage errors exiting 2. */
export async function dispatch(
  program: string,
  handlers: Readonly<Record<string, Handler>>,
  argv: readonly string[],
  /** A program offering these commands under its own name gives its own usage and version. */
  own: { readonly usage?: string; readonly version?: string } = {},
): Promise<number> {
  const usage = own.usage ?? usageFor(program);
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  if (command === "--version") {
    process.stdout.write(`${own.version ?? buildVersion}\n`);
    return 0;
  }
  const handler = handlers[command];
  // A signal cancels the run: its process groups and containers are stopped, then it exits 3.
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("the run was cancelled by a signal"));
  for (const name of stopping) process.once(name, cancel);
  try {
    if (handler === undefined) throw new UsageError(`"${command}" is not a ${program} command`);
    const code = await handler(rest, controller.signal);
    return controller.signal.aborted ? 3 : code;
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(`${program}: the run was cancelled\n`);
      return 3;
    }
    const message = error instanceof Error ? error.message : String(error);
    // parseArgs reports an unknown or malformed flag with a code; that is a usage error too.
    const usageProblem =
      error instanceof UsageError ||
      (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS") === true;
    process.stderr.write(usageProblem ? `${message}\n\n${usage}\n` : `${program}: ${message}\n`);
    return usageProblem ? 2 : 1;
  } finally {
    for (const name of stopping) process.removeListener(name, cancel);
  }
}
