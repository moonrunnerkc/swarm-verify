import type { VersionConstraint } from "../api/request.ts";
import { pypiName } from "./lock-resolutions.ts";
import { highestWithin, parseVersionRange, unjudgeable } from "./version-range.ts";

/** Where versions are looked up. The public registries unless the caller names others. */
export interface Registries {
  readonly npm: string;
  readonly pypi: string;
}

export const publicRegistries: Registries = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
};

/** What a registry said the latest version within a range is, or why it said nothing usable. */
export interface LatestTarget {
  readonly version: string | null;
  readonly source: string;
  readonly detail: string;
}

export const targetKey = (constraint: VersionConstraint) =>
  `${constraint.ecosystem}:${constraint.ecosystem === "pypi" ? pypiName(constraint.name) : constraint.name}@${constraint.range}`;

interface Listing {
  readonly url: string;
  readonly versions: readonly string[];
}

async function fetchJson(url: string, accept: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function npmListing(name: string, registry: string): Promise<Listing> {
  // A scoped name keeps its @ and encodes its slash, as the registry expects.
  const url = `${registry}/${name.replace("/", "%2f")}`;
  const body = (await fetchJson(url, "application/vnd.npm.install-v1+json")) as {
    versions?: Record<string, unknown>;
  };
  return { url, versions: Object.keys(body.versions ?? {}) };
}

async function pypiListing(name: string, registry: string): Promise<Listing> {
  const url = `${registry}/pypi/${encodeURIComponent(pypiName(name))}/json`;
  const body = (await fetchJson(url, "application/json")) as {
    releases?: Record<string, readonly { yanked?: boolean }[]>;
  };
  // A release with no files, or only yanked ones, is not one an installer would choose.
  const installable = Object.entries(body.releases ?? {}).filter(([, files]) =>
    files.some((file) => file.yanked !== true),
  );
  return { url, versions: installable.map(([version]) => version) };
}

/**
 * The latest release within each constraint that asks for the latest, from the registry, once
 * per package and range. Read while dependencies are prepared, the one stage with the network
 * open; checks never see it.
 */
export async function latestTargets(
  constraints: readonly VersionConstraint[],
  registries: Registries,
): Promise<Map<string, LatestTarget>> {
  const targets = new Map<string, LatestTarget>();
  for (const constraint of constraints) {
    const key = targetKey(constraint);
    if (!constraint.latest || targets.has(key)) continue;
    const range = parseVersionRange(constraint.range, constraint.ecosystem);
    const registry = constraint.ecosystem === "npm" ? registries.npm : registries.pypi;
    const unsupported = range === null ? null : unjudgeable(range);
    if (unsupported !== null) {
      targets.set(key, { version: null, source: registry, detail: unsupported });
      continue;
    }
    try {
      const listing =
        constraint.ecosystem === "npm"
          ? await npmListing(constraint.name, registry)
          : await pypiListing(constraint.name, registry);
      const version = range === null ? null : highestWithin(listing.versions, range);
      targets.set(key, {
        version,
        source: listing.url,
        detail:
          version === null
            ? `the registry lists no release within ${constraint.range}`
            : `${version} is the latest within ${constraint.range} by ${listing.url}, read ${new Date().toISOString()}`,
      });
    } catch (error) {
      targets.set(key, {
        version: null,
        source: registry,
        detail: `the latest within ${constraint.range} was not resolved: ${(error as Error).message}`,
      });
    }
  }
  return targets;
}

/**
 * The registry answers a run judged its "latest" constraints by, kept as an evidence log so the
 * decision can be reproduced from what was read then, not from what a registry says later.
 */
export const latestLogName = "inputs/latest.json";
const latestLogVersion = "swarm-verify.inputs.latest/v1";

export function latestLog(targets: ReadonlyMap<string, LatestTarget>): string {
  const latest = [...targets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, target]) => ({ key, ...target }));
  return `${JSON.stringify({ version: latestLogVersion, latest }, null, 2)}\n`;
}

/** The answers a latest log recorded, or null where it is not one this version wrote. */
export function parseLatestLog(bytes: Buffer): Map<string, LatestTarget> | null {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      version?: unknown;
      latest?: { key: string; version: string | null; source: string; detail: string }[];
    };
    if (parsed.version !== latestLogVersion || !Array.isArray(parsed.latest)) return null;
    return new Map(
      parsed.latest.map(({ key, version, source, detail }) => [key, { version, source, detail }]),
    );
  } catch {
    return null;
  }
}
