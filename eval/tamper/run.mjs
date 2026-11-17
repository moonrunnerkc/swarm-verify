import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { classifyRun, renderSummary, summarize } from "./classify.mjs";
import { buildFixture, fixtures } from "./fixtures.mjs";
import { generatePatches, patchDefinitions } from "./generate.mjs";

// Runs `swarm-verify verify` on every honest and cheating patch, classifies each run (see
// classify.mjs) and compares it with the fixture's expected outcome. Exits 1 on any crash or
// any outcome off its expectation.
// Usage: node eval/tamper/run.mjs [--keep] [--only <id substring>]...
//   --keep leaves the scratch directory in place; --only runs the cases whose id contains it.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "src", "swarm-verify.ts");

const durations = (checks) =>
  (Array.isArray(checks) ? checks : []).map(({ name, result, durationMs }) => ({
    name,
    result,
    durationMs,
  }));

/** Per-check durations, the only stage timing a result records. */
function timingOf(result) {
  if (result === undefined) return null;
  const baseline = result.baseline?.status === "measured" ? result.baseline : null;
  return {
    checks: durations(result.checks),
    heldOut: result.heldOut.status === "measured" ? durations(result.heldOut.checks) : [],
    baseline:
      baseline === null
        ? null
        : {
            cached: baseline.cached,
            checks: durations(baseline.checks),
            heldOut: durations(baseline.heldOut),
          },
  };
}

function verifyPatch(patch, workspace, out, env) {
  const args = [cli, "verify", "--workspace", workspace, "--patch", patch.path];
  args.push("--isolation", process.env.SWARM_TAMPER_ISOLATION ?? "host");
  args.push("--base", "HEAD", "--out", out, "--json");
  const started = Date.now();
  const ran = spawnSync(process.execPath, args, { cwd: repoRoot, env, encoding: "utf8" });
  const durationMs = Date.now() - started;
  const { result, ...classified } = classifyRun(ran);
  const tail = `${ran.stderr ?? ""}${ran.stdout ?? ""}`.trim().slice(-2000);
  return {
    ...classified,
    exitCode: ran.status ?? null,
    signal: ran.signal ?? null,
    reasons: result?.reasons ?? [],
    output: classified.outcome === "crashed" ? tail : null,
    durationMs,
    timing: timingOf(result),
  };
}

function tryRun(command, args) {
  const ran = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
  return ran.status === 0 ? ran.stdout.trim() : null;
}

function environment() {
  const dockerVersion = tryRun("docker", ["info", "--format", "{{.ServerVersion}}"]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const dirty = tryRun("git", ["-C", repoRoot, "status", "--porcelain"]);
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    docker: { available: dockerVersion !== null, serverVersion: dockerVersion },
    isolation: process.env.SWARM_TAMPER_ISOLATION ?? "host",
    verifier: { commit: commit.trim(), dirty: dirty === null ? null : dirty !== "" },
  };
}

async function main() {
  const { values } = parseArgs({
    options: { keep: { type: "boolean" }, only: { type: "string", multiple: true } },
  });
  const only = values.only ?? [];
  const selected =
    only.length === 0
      ? patchDefinitions
      : patchDefinitions.filter((one) => only.some((part) => one.id.includes(part)));
  if (selected.length === 0) throw new Error(`--only ${only.join(", ")} matches no case`);
  // Isolated runs mount the verifier's home, which docker VMs share only under the user's home.
  const isolated = process.env.SWARM_TAMPER_ISOLATION === "isolated";
  const parent = isolated ? join(homedir(), ".swarm", "tamper-work") : tmpdir();
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, "swarm-tamper-"));
  const signingKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const env = { ...process.env, SWARM_HOME: join(scratch, "home"), SWARM_SIGNING_KEY: signingKey };
  try {
    const repoDirs = {};
    const repos = new Set(selected.map((one) => one.repo));
    for (const fixture of fixtures.filter((one) => repos.has(one.name))) {
      repoDirs[fixture.name] = join(scratch, "repos", fixture.name);
      await buildFixture(fixture, repoDirs[fixture.name], cli, env);
    }
    const patches = await generatePatches(repoDirs, join(scratch, "patches"), selected);
    const cases = [];
    for (const patch of patches) {
      const out = join(scratch, "out", patch.id);
      const run = verifyPatch(patch, repoDirs[patch.repo], out, env);
      const differs = patch.expected !== null && run.outcome !== patch.expected;
      process.stderr.write(
        `${patch.id}: ${run.outcome} (expected ${patch.expected ?? "nothing: observed only"})${differs ? " DIFFERS" : ""}\n`,
      );
      const { id, repo, kind, technique, expected } = patch;
      cases.push({ id, repo, kind, technique, expected, ...run });
    }
    const summary = summarize(cases);
    const generatedAt = new Date().toISOString();
    const resultsDir = join(repoRoot, "eval", "results");
    await mkdir(resultsDir, { recursive: true });
    const subset = only.length === 0 ? "" : "-subset";
    const file = join(resultsDir, `tamper-${generatedAt.replace(/[:.]/g, "-")}${subset}.json`);
    const report = {
      generatedAt,
      environment: environment(),
      selection: { only, cases: cases.length, of: patchDefinitions.length },
      cases,
      summary,
    };
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${renderSummary(summary)}\n\nWrote ${file}\n`);
    if (!summary.passed) process.exitCode = 1;
  } finally {
    if (values.keep === true) process.stderr.write(`kept ${scratch}\n`);
    else await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
