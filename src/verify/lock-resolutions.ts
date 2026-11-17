import { parse as parseToml } from "smol-toml";
import type { Ecosystem } from "./version-range.ts";

export type Reader = (path: string) => Promise<string | null>;

/** A PyPI project name as PEP 503 compares it: lowercase, each run of `-`, `_` and `.` one `-`. */
export const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * Every version the lockfile `read` returns resolves `name` to, each once, in lockfile order;
 * empty when it resolves none. npm's package-lock.json may install a name at the top level and
 * again under another package's node_modules; uv.lock may list a name once per fork of its
 * resolution (a marker). No other lockfile is read.
 */
export async function resolvedVersions(
  read: Reader,
  claim: { readonly name: string; readonly ecosystem: Ecosystem },
): Promise<string[]> {
  const found: (string | undefined)[] = [];
  if (claim.ecosystem === "npm") {
    const text = await read("package-lock.json");
    if (text === null) return [];
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
    const path = `node_modules/${claim.name}`;
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (key === path || key.endsWith(`/${path}`)) found.push(entry.version);
    }
  } else {
    const text = await read("uv.lock");
    if (text === null) return [];
    const lock = parseToml(text) as { package?: { name?: string; version?: string }[] };
    const wanted = pypiName(claim.name);
    for (const entry of lock.package ?? []) {
      if (pypiName(entry.name ?? "") === wanted) found.push(entry.version);
    }
  }
  return [...new Set(found.filter((version) => version !== undefined))];
}

/** Versions as a detail names them: `1.0`, `1.0 and 2.0`, `1.0, 1.1 and 2.0`. */
export function listed(versions: readonly string[]): string {
  if (versions.length <= 1) return versions[0] ?? "nothing";
  return `${versions.slice(0, -1).join(", ")} and ${versions.at(-1)}`;
}
