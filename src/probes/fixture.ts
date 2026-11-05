import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { Requirement } from "../api/request.ts";
import { requestVersion, type VerifyRequestInput } from "../api/request.ts";
import type { VerifyResult } from "../api/result.ts";
import { snapshotWorkingTree, verify } from "../api/verify.ts";

/**
 * The disposable repositories of the 2026-10-31 review's Appendix A probes: a `half(n)` module,
 * a node:test suite and a swarm.toml naming the check, committed as the base.
 */
export const halfTest = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {half} from '../half.mjs';
test('half positive',()=>assert.equal(half(4),2));
`;

export interface Probe {
  readonly repo: string;
  readonly home: string;
  put(path: string, content: string): Promise<void>;
  git(...args: string[]): string;
  verify(
    requirements?: readonly Requirement[],
    extra?: Partial<RequestExtras>,
    producer?: VerifyRequestInput["producer"],
  ): Promise<VerifyResult>;
}

interface RequestExtras {
  readonly behaviorChange: "none" | "authorized";
  readonly dependencies: "prepare" | "linked" | "none";
  readonly mode: "isolated" | "host";
  readonly network: "open" | "closed";
  readonly reruns: number;
  /** Where baselines and sealed checks live, if not the fixture's own home. */
  readonly swarmHome: string;
}

process.env.SWARM_SIGNING_KEY ??= generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

export async function probeFixture(
  files: Readonly<Record<string, string>>,
  command = "node --test",
  parent: string = tmpdir(),
): Promise<Probe> {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "probe-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Swarm audit");
  git("config", "user.email", "audit@localhost");
  const initial = {
    ".gitignore": "node_modules/\n",
    "swarm.toml": `[checks]\ntest = ${JSON.stringify(command)}\n`,
    ...files,
  };
  for (const [path, content] of Object.entries(initial)) await put(path, content);
  git("add", "-A");
  git("commit", "-qm", "Audit fixture baseline");
  let runs = 0;
  return {
    repo,
    home,
    put,
    git,
    async verify(requirements = [], extra = {}, producer = { instructions: [] }) {
      runs += 1;
      const out = join(root, `out-${runs}`);
      await mkdir(out, { recursive: true });
      const snapshot = await snapshotWorkingTree(repo, "HEAD", join(out, "candidate.patch"));
      return verify(
        {
          version: requestVersion,
          repository: repo,
          base: { commit: snapshot.baseCommit },
          candidate: { kind: "patch", path: snapshot.path, sha256: snapshot.sha256 },
          requirements: [...requirements],
          policy: {
            behaviorChange: extra.behaviorChange ?? "none",
            ...(extra.reruns === undefined ? {} : { reruns: extra.reruns }),
            execution: {
              mode: extra.mode ?? "host",
              network: extra.network ?? "open",
              dependencies: extra.dependencies ?? "linked",
            },
          },
          artifacts: { directory: join(out, "evidence") },
          producer,
        },
        { verifierVersion: "probe", swarmHome: extra.swarmHome ?? home },
      );
    },
  };
}

export const requirement = (
  id: string,
  text: string,
  kind: Requirement["kind"],
  tests: readonly string[],
): Requirement => ({
  id,
  text,
  source: "user",
  kind,
  required: true,
  testsAsked: false,
  behaviorAsked: false,
  assumptions: [],
  evidence: { tests: tests.map((name) => ({ name })), checks: [], structure: [], packages: [] },
  versions: [],
});

const checker = join(import.meta.dirname, "..", "..", "verify.mjs");

/** The dependency-free checker re-derives the same complete state from the signed evidence. */
export function checksOffline(result: VerifyResult): void {
  const { bundle, publicKey, patch } = result.evidence;
  const ran = spawnSync(
    process.execPath,
    [checker, bundle ?? "", "--key", publicKey ?? "", "--patch", patch ?? ""],
    {
      encoding: "utf8",
    },
  );
  expect(ran.stdout).toContain("ok     state     complete, supported by the recorded evidence");
  expect(ran.status).toBe(0);
}
