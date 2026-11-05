import { access, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { detectChecks, renderSwarmToml } from "./config/detect.ts";
import { readSwarmToml, swarmTomlFileName } from "./config/swarm-toml.ts";
import { seal } from "./verify/held-out.ts";
import { validateHeldOut } from "./verify/held-out-validation.ts";

const write = (text: string) => process.stdout.write(`${text}\n`);

/**
 * `init`: write swarm.toml from the manifests where there is none. With --seal, move the files
 * a glob matches out of the workspace into the sealed store as held-out checks, once each check
 * is shown to fail at the base through a test and, with --reference <patch>, to pass on it.
 */
export async function init(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      workspace: { type: "string" },
      seal: { type: "string" },
      reference: { type: "string" },
    },
  });
  const workspace = resolve(values.workspace ?? process.cwd());
  const configured = await readSwarmToml(workspace);
  const checks = configured?.checks ?? (await detectChecks(workspace));

  if (values.seal !== undefined) {
    // Each held-out check must fail at the base through a test, and pass on a known-good patch.
    const reference = values.reference === undefined ? null : resolve(values.reference);
    for (const note of await validateHeldOut({ workspace, checks, reference })) write(note);
    const { directory, sealed } = await seal(workspace, values.seal, checks);
    write(`sealed ${sealed.files.length} file(s) matching ${sealed.glob} into ${directory}`);
    for (const check of sealed.checks) write(`  held-out check ${check.name}: ${check.command}`);
    write("They were removed from the workspace; commit that removal if they were tracked.");
    return 0;
  }

  const path = join(workspace, swarmTomlFileName);
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists) {
    write(`${path} already exists; it declares ${checks.length} check(s).`);
    return 0;
  }
  if (checks.length === 0) {
    write("No checks found in package.json scripts or a Python project; nothing was written.");
    return 4;
  }
  await writeFile(path, renderSwarmToml(checks));
  write(`wrote ${path}`);
  for (const check of checks) write(`  ${check.name}: ${check.command}`);
  return 0;
}
