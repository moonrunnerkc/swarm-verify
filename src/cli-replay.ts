import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { replay } from "./api/replay.ts";
import { buildVersion } from "./build-version.ts";
import { UsageError } from "./cli-command-definitions.ts";

const write = (text: string) => process.stdout.write(`${text}\n`);

/**
 * `replay <bundle>`: the recorded verification run again in a container with dependencies
 * installed fresh, and every result compared. 0 when the replay agrees, 1 when it diverges, 5
 * when it could not run.
 */
export async function replayCommand(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { workspace: { type: "string" }, out: { type: "string" }, json: { type: "boolean" } },
  });
  const [bundle] = positionals;
  if (bundle === undefined)
    throw new UsageError("replay needs the evidence directory verify wrote");
  const directory = resolve(bundle);
  const out = resolve(values.out ?? `${directory}.replay-${Date.now()}`);
  const ran = await replay(directory, {
    repository: resolve(values.workspace ?? process.cwd()),
    out,
    verifierVersion: buildVersion,
  });
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
