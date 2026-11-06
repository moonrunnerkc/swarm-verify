/**
 * The real-repository corpus: every acceptance and comparison task the verifier has judged, each
 * at its base with its held-out checks, its declared checks, its requirement record and the
 * patches judged on it, with the statuses they are expected to read. For each entry: clone the
 * base, install as its user did, seal the held-out files (checked at the base and on the
 * reference patch first), then verify every patch with the built CLI and compare.
 *
 *   node scripts/corpus.mjs [--only id,id] [--patches name,name] [--source github|local]
 *                           [--work dir] [--out file] [--cli path/to/swarm-verify.js]
 *
 * --patches verifies only the named patches of each entry; CI runs one job a patch, since t6's
 * eight in one job outlasted its five hours.
 *
 * An expected status of null is a status the record does not establish: it is reported as
 * observed, never counted as a pass. A private repository runs only with --source local.
 * Exit 0 when every expected status was observed, 1 on any difference, 2 when an entry could
 * not be set up.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dirname, "..");
const corpus = join(root, "corpus");

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    patches: { type: "string" },
    source: { type: "string", default: "github" },
    work: { type: "string" },
    out: { type: "string" },
    // An installed verifier's CLI, for a release's packed install; this tree's build otherwise.
    cli: { type: "string" },
  },
});
const cli = resolve(values.cli ?? join(root, "dist", "swarm-verify.js"));
const work = resolve(values.work ?? join(root, ".corpus-work"));
const only = values.only?.split(",").filter(Boolean) ?? null;
const chosen = values.patches?.split(",").filter(Boolean) ?? null;
const ids = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8")).filter(
  (id) => only === null || only.includes(id),
);

const sh = (command, cwd, env = {}) =>
  spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

function clone(repository, base, into, local) {
  const name = repository.split("/").at(-1);
  const from =
    values.source === "local" || local
      ? `/Users/brad/projects/${name}`
      : `https://github.com/${repository}.git`;
  execFileSync("git", ["clone", "-q", from, into]);
  execFileSync("git", ["checkout", "-q", base], { cwd: into });
  execFileSync("git", ["config", "user.email", "corpus@localhost"], { cwd: into });
  execFileSync("git", ["config", "user.name", "corpus"], { cwd: into });
}

/** What a verdict says, in the corpus's terms. */
function observed(statement) {
  const predicate = JSON.parse(readFileSync(statement, "utf8")).predicate;
  const requirements = Object.fromEntries(
    predicate.requirements.map((one) => [one.id, one.status]),
  );
  const heldOut =
    predicate.heldOut.status === "measured"
      ? predicate.heldOut.heldOutPassRate === 1
        ? "pass"
        : "fail"
      : null;
  return { state: predicate.state, requirements, heldOut, reasons: predicate.reasons.slice(0, 3) };
}

/** Every expected status that is set and differs from what was observed. */
function differences(expected, seen) {
  if (expected === null) return [];
  const found = [];
  if (expected.state !== null && expected.state !== seen.state)
    found.push(`state ${seen.state}, expected ${expected.state}`);
  for (const [id, status] of Object.entries(expected.requirements ?? {}))
    if (status !== null && seen.requirements[id] !== status)
      found.push(`${id} ${seen.requirements[id] ?? "absent"}, expected ${status}`);
  if (expected.heldOut != null && expected.heldOut !== seen.heldOut)
    found.push(`held-out ${seen.heldOut ?? "not measured"}, expected ${expected.heldOut}`);
  return found;
}

const results = [];
let failedSetup = false;
for (const id of ids) {
  const entry = JSON.parse(readFileSync(join(corpus, id, "entry.json"), "utf8"));
  const dir = join(work, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const name = entry.repository.split("/").at(-1);
  const repo = join(dir, name);
  const log = (line) => process.stdout.write(`${id}: ${line}\n`);
  if (entry.local === true && values.source !== "local") {
    log("not run: a private repository; run with --source local on a machine that has it");
    results.push({ id, patch: null, outcome: "not run", why: "private repository" });
    continue;
  }
  try {
    clone(entry.repository, entry.base, repo, entry.local === true);
    if (entry.sibling !== undefined)
      clone(
        entry.sibling.repository,
        entry.sibling.base,
        join(dir, entry.sibling.repository.split("/").at(-1)),
        false,
      );
    const setup = sh(entry.setup, repo);
    if (setup.status !== 0)
      throw new Error(`setup exited ${setup.status}: ${setup.stderr.slice(-400)}`);
  } catch (error) {
    log(`not set up: ${error.message}`);
    results.push({ id, patch: null, outcome: "not set up", why: error.message });
    failedSetup = true;
    continue;
  }
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  if (entry.heldOut !== null) {
    cpSync(join(corpus, id, "held-out"), repo, { recursive: true });
    writeFileSync(
      join(repo, "swarm.toml"),
      `[checks]\nheld-out = { command = ${JSON.stringify(entry.heldOut.command)}, kind = "test" }\n`,
    );
    const reference = entry.patches.find((one) => one.name === "reference" || one.name === "human");
    const args = [
      cli,
      "init",
      "--seal",
      entry.heldOut.glob,
      ...(reference === undefined ? [] : ["--reference", join(corpus, id, reference.file)]),
    ];
    const sealed = spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, SWARM_HOME: home },
    });
    log(`sealed: ${(sealed.stdout + sealed.stderr).trim().split("\n").join(" | ").slice(0, 400)}`);
    if (sealed.status !== 0) {
      results.push({
        id,
        patch: null,
        outcome: "not set up",
        why: `init --seal exited ${sealed.status}`,
      });
      failedSetup = true;
      continue;
    }
  }
  cpSync(join(corpus, id, "swarm.toml"), join(repo, "swarm.toml"));
  for (const patch of entry.patches.filter((one) => chosen === null || chosen.includes(one.name))) {
    const out = join(dir, "verdicts", patch.name);
    const ran = spawnSync(
      process.execPath,
      [
        cli,
        "verify",
        "--base",
        entry.base,
        "--patch",
        join(corpus, id, patch.file),
        "--isolation",
        entry.isolation,
        "--dependencies",
        entry.isolation === "host" ? "linked" : "prepare",
        "--requirements",
        join(corpus, id, "requirements.json"),
        "--out",
        out,
      ],
      { cwd: repo, encoding: "utf8", env: { ...process.env, SWARM_HOME: home } },
    );
    const statement = join(out, "statement.json");
    if (!existsSync(statement)) {
      log(`${patch.name}: no verdict (exit ${ran.status}): ${ran.stderr.slice(-300)}`);
      results.push({ id, patch: patch.name, outcome: "no verdict", expected: patch.expected });
      continue;
    }
    const seen = observed(statement);
    const found = differences(patch.expected, seen);
    const open = patch.expected === null || patch.expected.state === null;
    const outcome = found.length > 0 ? "differs" : open ? "observed" : "as expected";
    log(
      `${patch.name}: ${outcome}: ${seen.state} ${JSON.stringify(seen.requirements)} held-out ${seen.heldOut}${found.length > 0 ? ` (${found.join("; ")})` : ""}`,
    );
    results.push({
      id,
      patch: patch.name,
      isolation: entry.isolation,
      outcome,
      observed: seen,
      expected: patch.expected,
      differences: found,
    });
  }
}
const summary = {
  entries: ids.length,
  verdicts: results.filter((one) => one.observed !== undefined).length,
  asExpected: results.filter((one) => one.outcome === "as expected").length,
  observedOnly: results.filter((one) => one.outcome === "observed").length,
  differs: results.filter((one) => one.outcome === "differs" || one.outcome === "no verdict")
    .length,
  notRun: results.filter((one) => one.outcome === "not run").length,
};
if (values.out !== undefined)
  writeFileSync(values.out, `${JSON.stringify({ summary, results }, null, 2)}\n`);
process.stdout.write(`corpus: ${JSON.stringify(summary)}\n`);
process.exit(summary.differs > 0 ? 1 : failedSetup ? 2 : 0);
