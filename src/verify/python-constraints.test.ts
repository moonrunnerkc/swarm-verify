import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requirementSchema, type VersionConstraint } from "../api/request.ts";
import { type LatestTarget, targetKey } from "./latest-version.ts";
import type { CheckResult } from "./predicate.ts";
import { isConstraint, packageEvidence } from "./requirement-evidence.ts";
import { assessRequirements, type RequirementInputs } from "./requirements.ts";

const uvLock = (packages: readonly (readonly [string, string])[]) =>
  `version = 1\n${packages
    .map(([name, version]) => `\n[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("")}`;

const passing: CheckResult = {
  name: "test",
  command: "pytest",
  kind: "test",
  authority: "pre-existing",
  result: "pass",
  collected: null,
  exitCode: 0,
  durationMs: 1,
  outputSha256: "0".repeat(64),
};

const constraint = (name: string, range: string, latest = false): VersionConstraint => ({
  name,
  ecosystem: "pypi",
  range,
  latest,
  wording: `${latest ? "the latest " : ""}${range}`,
});

async function judge(
  packages: readonly (readonly [string, string])[],
  versions: readonly VersionConstraint[],
  latest: ReadonlyMap<string, LatestTarget> = new Map(),
) {
  const dir = await mkdtemp(join(tmpdir(), "python-constraint-"));
  await writeFile(join(dir, "uv.lock"), uvLock(packages));
  const inputs: RequirementInputs = {
    checks: [passing],
    outcomes: [],
    dir,
    readBase: async (path) => (path === "uv.lock" ? uvLock([["requests", "2.0.0"]]) : null),
    changed: true,
    regression: {
      status: "none",
      newFailures: [],
      inherited: [],
      removed: [],
      unresolved: [],
      flaky: [],
    },
    freshDependencies: true,
    latest,
  };
  const [outcome] = await assessRequirements(
    [
      requirementSchema.parse({
        id: "R1",
        text: "Upgrade the Python dependency",
        source: "user",
        kind: "upgrade",
        evidence: { checks: ["test"] },
        versions,
      }),
    ],
    inputs,
  );
  if (outcome === undefined) throw new Error("no outcome");
  return { outcome, constraints: outcome.evidence.filter(isConstraint) };
}

describe("a PyPI version constraint, by PEP 440", () => {
  it("does not take a fourth release number for the third", async () => {
    const { outcome, constraints } = await judge(
      [["requests", "1.2.3.4"]],
      [constraint("requests", "1.2.3")],
    );
    expect(constraints[0]?.outcome).toBe("fail");
    expect(outcome.status).toBe("failed");
  });

  it("leaves a version PEP 440 does not read unverified, and says what to do", async () => {
    const { outcome, constraints } = await judge(
      [["requests", "2.x-custom"]],
      [constraint("requests", "2.x")],
    );
    expect(constraints[0]?.outcome).toBe("not observed");
    expect(constraints[0]?.detail).toContain("2.x-custom is not a PEP 440 version");
    expect(outcome.status).toBe("unverified");
    expect(outcome.nextAction).toContain("2.x-custom is not a PEP 440 version");
  });

  it("holds a post release, and keeps a prerelease out unless the range names one", async () => {
    const post = await judge([["requests", "1.0.post1"]], [constraint("requests", ">=1.0")]);
    expect(post.outcome.status).toBe("satisfied");
    const pre = await judge([["requests", "2.0rc1"]], [constraint("requests", ">=1.0")]);
    expect(pre.outcome.status).toBe("failed");
    const named = await judge([["requests", "2.0rc1"]], [constraint("requests", ">=2.0rc1")]);
    expect(named.outcome.status).toBe("satisfied");
  });

  it("judges every resolution of the name, and names each one", async () => {
    const { outcome, constraints } = await judge(
      [
        ["requests", "1.4.0"],
        ["requests", "2.1.0"],
      ],
      [constraint("requests", "1.x")],
    );
    expect(outcome.status).toBe("failed");
    expect(constraints[0]?.detail).toContain("1.4.0");
    expect(constraints[0]?.detail).toContain("2.1.0");
    const both = await judge(
      [
        ["requests", "1.4.0"],
        ["requests", "1.9.0"],
      ],
      [constraint("requests", "1.x")],
    );
    expect(both.outcome.status).toBe("satisfied");
    expect(both.constraints[0]?.detail).toContain("1.4.0 and 1.9.0");
  });

  it("matches a lockfile name to the constraint's by PEP 503", async () => {
    const { outcome } = await judge([["Foo_Bar.baz", "1.0"]], [constraint("foo-bar-baz", "1.x")]);
    expect(outcome.status).toBe("satisfied");
  });

  it("holds the latest the registry names when the lockfile writes it another way", async () => {
    const wanted = constraint("requests", "1.x", true);
    const latest = new Map([
      [targetKey(wanted), { version: "1.10.0", source: "s", detail: "read" }],
    ]);
    const { outcome } = await judge([["requests", "1.10"]], [wanted], latest);
    expect(outcome.status).toBe("satisfied");
  });

  it("refuses no range the request accepted before, and leaves npm-only grammar unverified", async () => {
    const { outcome, constraints } = await judge(
      [["requests", "10.4.0"]],
      [constraint("requests", ">=9 <11")],
    );
    expect(outcome.status).toBe("unverified");
    expect(constraints[0]?.detail).toContain(">=9,<11");
  });
});

describe("a PyPI package claim", () => {
  it("reads its version by PEP 440", async () => {
    const dir = await mkdtemp(join(tmpdir(), "python-claim-"));
    await writeFile(join(dir, "uv.lock"), uvLock([["requests", "1.2.3.4"]]));
    const base = async (path: string) =>
      path === "uv.lock" ? uvLock([["requests", "1.0"]]) : null;
    const claim = { name: "requests", ecosystem: "pypi" as const };
    expect(await packageEvidence(base, dir, { ...claim, version: "1.2.3" })).toMatchObject({
      outcome: "fail",
    });
    expect(await packageEvidence(base, dir, { ...claim, version: "~=1.2.3" })).toMatchObject({
      outcome: "observed",
    });
  });
});
