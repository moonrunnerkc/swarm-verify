import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The program `name` names, looked up in the PATH entries that are absolute directories only. An
 * empty or relative entry (`.`, `bin`) resolves against the working directory, which for a
 * verifier may be the candidate's tree, so it is skipped rather than searched.
 */
export async function executableOnPath(
  name: string,
  path: string | undefined,
): Promise<string | null> {
  for (const entry of (path ?? "").split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const full = join(entry, name);
    const found = await stat(full).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!found) continue;
    if (
      await access(full, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return full;
  }
  return null;
}
