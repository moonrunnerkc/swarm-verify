import { detectChecks } from "./detect.ts";
import { type DeclaredCheck, readSwarmToml } from "./swarm-toml.ts";

/** The checks the verifier runs for a tree: its swarm.toml's, or those its manifests imply. */
export async function declaredChecks(dir: string): Promise<readonly DeclaredCheck[]> {
  const config = await readSwarmToml(dir);
  return config?.checks ?? (await detectChecks(dir));
}
