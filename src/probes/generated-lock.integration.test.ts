import { createHash } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replay } from "../api/replay.ts";
import { probeFixture, requirement } from "./fixture.ts";

/**
 * A Python project that tracks no uv.lock, verified in a container: the lock `uv lock` resolves
 * during preparation is what the statement calls reproducible, so it must travel with the
 * evidence and a replay must install from it. Needs a docker daemon, as isolated verification does.
 */
const parent = join(homedir(), ".swarm", "test-work", `lock-${process.pid}`);
afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

const files = {
  "pyproject.toml": '[project]\nname = "fixture"\nversion = "1.0.0"\nrequires-python = ">=3.10"\n',
  "half.py": "def half(n):\n    return n\n",
  "tests/__init__.py": "",
  "tests/test_half.py":
    "import unittest\nfrom half import half\n\nclass Half(unittest.TestCase):\n    def test_half_positive(self):\n        self.assertEqual(half(4), 2)\n",
};

/** Where the evidence keeps the base's generated lock, as the statement's logs name it. */
const keptBase = "lockfiles/base/uv.lock";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

describe("a uv.lock resolved while verifying", () => {
  it("is kept, signed, with the evidence, and the replay installs from it and agrees", async () => {
    const probe = await probeFixture(files, "python3 -m unittest discover -s tests -t .", parent);
    await probe.put("half.py", "def half(n):\n    return n / 2\n");
    const result = await probe.verify(
      [requirement("R1", "half(n) returns n / 2", "fix", ["test_half_positive"])],
      { mode: "isolated", dependencies: "prepare", network: "closed" },
    );
    const bundle = dirname(result.evidence.bundle ?? "");
    const kept = await readFile(join(bundle, keptBase), "utf8");
    expect(result.execution.dependencies.lockfiles["uv.lock"]).toBe(sha256(kept));
    expect(result.logs).toContainEqual({ name: keptBase, sha256: sha256(kept) });
    expect(result.execution.dependencies.note).toMatch(/resolved during preparation/);

    const replayed = await replay(bundle, {
      repository: probe.repo,
      out: join(probe.home, "replay"),
      verifierVersion: "probe",
      swarmHome: probe.home,
    });
    expect(replayed.divergences).toEqual([]);

    // A kept lock that is not the one the statement signed is never installed.
    const altered = join(probe.home, "altered");
    await cp(bundle, altered, { recursive: true });
    await writeFile(join(altered, keptBase), `${kept}# changed\n`);
    await expect(
      replay(altered, {
        repository: probe.repo,
        out: join(probe.home, "replay-altered"),
        verifierVersion: "probe",
        swarmHome: probe.home,
      }),
    ).rejects.toThrow(/lockfiles\/base\/uv.lock is not the lock the statement signed/);
  });
});
