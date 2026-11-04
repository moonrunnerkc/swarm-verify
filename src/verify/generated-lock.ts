import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./change.ts";

export type LockSide = "base" | "candidate";

/** The uv.lock texts a recording kept, which a replay installs from instead of resolving again. */
export interface PinnedLocks {
  readonly base?: string;
  readonly candidate?: string;
}

/** Where the evidence keeps a side's generated lock; the statement's logs name and digest it. */
export const keptLockName = (side: LockSide) => `lockfiles/${side}/uv.lock`;

export interface GeneratedLocks {
  /** Before a side is prepared: its recorded lock written in, or whether `uv lock` must run again. */
  before(side: LockSide): Promise<{ readonly relock: boolean }>;
  /** After a side is prepared: the lock it generated, kept. */
  after(side: LockSide): Promise<void>;
  /** Before the base is installed again in a checkout the candidate's lock now holds. */
  restoreBase(): Promise<void>;
  /** The generated locks, as evidence files. */
  kept(): readonly { readonly name: string; readonly text: string }[];
}

/**
 * A Python project that tracks no uv.lock is resolved with `uv lock` while it is prepared, so
 * what its tree was installed from exists only in the checkout. Each side's generated lock is
 * kept with the evidence, and a replay given them installs frozen from the same lock. A lock the
 * base tracks, or one the candidate brings, is the project's own and is not kept.
 */
export async function generatedLocks(
  dir: string,
  pinned: PinnedLocks = {},
): Promise<GeneratedLocks> {
  const path = join(dir, "uv.lock");
  const read = () => readFile(path, "utf8").catch(() => null);
  const tracked = (await runGit(dir, ["ls-files", "--error-unmatch", "--", "uv.lock"])).code === 0;
  const kept = new Map<LockSide, string>();
  let candidateGenerated = false;
  return {
    async before(side) {
      if (tracked) return { relock: false };
      const recorded = pinned[side];
      if (side === "candidate") {
        // The base's generated lock still in the tree means the candidate brought none of its own.
        const base = kept.get("base");
        candidateGenerated = base !== undefined && (await read()) === base;
        if (!candidateGenerated) return { relock: false };
      }
      if (recorded !== undefined) {
        await writeFile(path, recorded);
        return { relock: false };
      }
      return { relock: side === "candidate" };
    },
    async after(side) {
      if (tracked || (side === "candidate" && !candidateGenerated)) return;
      const text = await read();
      if (text !== null) kept.set(side, text);
    },
    async restoreBase() {
      const base = kept.get("base");
      if (base !== undefined) await writeFile(path, base);
    },
    kept: () => [...kept].map(([side, text]) => ({ name: keptLockName(side), text })),
  };
}
