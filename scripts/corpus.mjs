/**
 * The real-repository corpus: every acceptance and comparison task the verifier has judged, each
 * at its base with its held-out checks, its declared checks, its requirement record and the
 * patches judged on it, with the statuses they are expected to read. For each entry: clone the
 * base (and a sibling it builds against) at its pinned revision, install as its user did, seal the
 * held-out files (checked at the base and on the reference patch first), then verify every patch
 * with the built CLI and compare.
 *
 *   node scripts/corpus.mjs [--full | --only id,id --patches name,name] [--source github|local]
 *                           [--local-root dir] [--work dir] [--out file] [--cli path]
 *
 * --full runs every patch the manifest plans, private entries included, and fails unless every
 * one reached a verdict. --only and --patches select a scope, recorded as selected; a name that
 * selects nothing fails the run. A private entry (and, with --source local, every entry) is cloned
 * from <local-root>/<repository name>, whose origin must be that repository; there is no default.
 *
 * Exit 0 when every selected patch reached a verdict and none differs from its expectation, 1 on
 * a difference or a run with no verdict, 2 when something selected was not set up or not run, or
 * the plan or the filters are wrong. Execution and agreement are recorded apart (corpus-plan.mjs).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { judged, loadPlan, runRecordVersion, select } from "./corpus-plan.mjs";

const root = join(import.meta.dirname, "..");
const corpus = join(root, "corpus");

const { values } = parseArgs({
  options: {
    full: { type: "boolean" },
    only: { type: "string" },
    patches: { type: "string" },
    source: { type: "string", default: "github" },
    "local-root": { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
    // An installed verifier's CLI, for a release's packed install; this tree's build otherwise.
    cli: { type: "string" },
  },
});
const usage = (problem) => {
  process.stderr.write(`corpus: ${problem}\n`);
  process.exit(2);
};
if (values.full === true && (values.only !== undefined || values.patches !== undefined))
  usage("--full runs every planned patch; leave out --only and --patches");
if (values.source !== "github" && values.source !== "local") usage("--source is github or local");
const cli = resolve(values.cli ?? join(root, "dist", "swarm-verify.js"));
const work = resolve(values.work ?? join(root, ".corpus-work"));
const localRoot = values["local-root"] === undefined ? null : resolve(values["local-root"]);
const list = (raw) => raw?.split(",").filter(Boolean) ?? null;

const { plan, problems } = loadPlan(corpus);
const { selected, unmatched } = select(plan, {
  only: list(values.only),
  patches: list(values.patches),
});
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sh = (command, cwd, env = {}) =>
  spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, ...env } });

/** A clone of `repository` at exactly `commit`, from GitHub or the named local checkout. */
function clone(repository, commit, into, local) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? ""))
    throw new Error(`${repository} is pinned to ${commit}, not a full commit`);
  let from = `https://github.com/${repository}.git`;
  if (local) {
    if (localRoot === null)
      throw new Error(
        `${repository} is cloned from a local checkout; name its parent with --local-root`,
      );
    from = join(localRoot, repository.split("/").at(-1));
    const origin = existsSync(from) ? git(["remote", "get-url", "origin"], from) : "";
    if (!origin.replace(/\.git$/, "").endsWith(`/${repository}`))
      throw new Error(`${from} is not a checkout of ${repository} (origin ${origin || "absent"})`);
  }
  execFileSync("git", ["clone", "-q", from, into]);
  execFileSync("git", ["checkout", "-q", "--detach", commit], { cwd: into });
  const head = git(["rev-parse", "HEAD"], into);
  if (head !== commit) throw new Error(`${repository} checked out ${head}, pinned ${commit}`);
  git(["config", "user.email", "corpus@localhost"], into);
  git(["config", "user.name", "corpus"], into);
  return head;
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
  return { state: predicate.state, requirements, heldOut };
}

const results = [];
const entries = [];
const record = (planned, outcome, extra = {}) =>
  results.push({
    id: planned.id,
    patch: planned.patch,
    sha256: planned.sha256,
    specification: planned.specification,
    expected: planned.expected,
    outcome,
    ...extra,
  });
for (const id of [...new Set(selected.map((one) => one.id))]) {
  const entry = JSON.parse(readFileSync(join(corpus, id, "entry.json"), "utf8"));
  const mine = selected.filter((one) => one.id === id);
  const dir = join(work, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, entry.repository.split("/").at(-1));
  const log = (line) => process.stdout.write(`${id}: ${line}\n`);
  const local = entry.local === true || values.source === "local";
  const facts = { id, repository: entry.repository, base: entry.base, local: entry.local === true };
  entries.push(facts);
  if (entry.local === true && localRoot === null) {
    log(
      "not run: a private repository; run with --local-root naming the directory that holds its checkout",
    );
    for (const one of mine)
      record(one, "not run", { why: "private repository and no --local-root" });
    continue;
  }
  try {
    facts.head = clone(entry.repository, entry.base, repo, local);
    if (entry.sibling !== undefined) {
      const into = join(dir, entry.sibling.path.replace(/^\.\.\//, ""));
      facts.sibling = { repository: entry.sibling.repository, commit: entry.sibling.commit };
      facts.sibling.head = clone(entry.sibling.repository, entry.sibling.commit, into, local);
    }
    const setup = sh(entry.setup, repo);
    if (setup.status !== 0)
      throw new Error(`setup exited ${setup.status}: ${setup.stderr.slice(-400)}`);
  } catch (error) {
    log(`not set up: ${error.message}`);
    for (const one of mine) record(one, "not set up", { why: error.message.slice(0, 400) });
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
      for (const one of mine)
        record(one, "not set up", { why: `init --seal exited ${sealed.status}` });
      continue;
    }
  }
  cpSync(join(corpus, id, "swarm.toml"), join(repo, "swarm.toml"));
  const dependencies = entry.isolation === "host" ? "linked" : "prepare";
  for (const one of mine) {
    const out = join(dir, "verdicts", one.patch);
    const started = Date.now();
    const args = [
      cli,
      "verify",
      "--base",
      entry.base,
      "--patch",
      one.file,
      "--isolation",
      entry.isolation,
      "--dependencies",
      dependencies,
      "--requirements",
      join(corpus, id, "requirements.json"),
      "--out",
      out,
    ];
    const ran = spawnSync(process.execPath, args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, SWARM_HOME: home },
    });
    const policy = {
      isolation: entry.isolation,
      dependencies,
      seconds: Math.round((Date.now() - started) / 1000),
      exit: ran.status,
    };
    const statement = join(out, "statement.json");
    if (!existsSync(statement)) {
      log(`${one.patch}: no verdict (exit ${ran.status}): ${ran.stderr.slice(-300)}`);
      record(one, "no verdict", { policy });
      continue;
    }
    const seen = observed(statement);
    const verdict = judged(one, seen);
    log(
      `${one.patch}: ${verdict.outcome}: ${seen.state} ${JSON.stringify(seen.requirements)} held-out ${seen.heldOut}${verdict.differences.length > 0 ? ` (${verdict.differences.join("; ")})` : ""}`,
    );
    record(one, verdict.outcome, { observed: seen, differences: verdict.differences, policy });
  }
}

const tally = (outcome) => results.filter((one) => one.outcome === outcome).length;
const summary = {
  planned: values.full === true ? plan.length : selected.length,
  executed: tally("agrees") + tally("differs") + tally("observed"),
  agrees: tally("agrees"),
  differs: tally("differs"),
  observedOnly: tally("observed"),
  setupFailed: tally("not set up"),
  noVerdict: tally("no verdict"),
  notRun: tally("not run"),
};
const head = git(["rev-parse", "HEAD"], root);
const runRecord = {
  version: runRecordVersion,
  scope:
    values.full === true
      ? { kind: "full" }
      : { kind: "selected", only: list(values.only), patches: list(values.patches) },
  verifier: {
    commit: head,
    dirty: git(["status", "--porcelain"], root) !== "",
    cli,
    version: spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).stdout.trim(),
  },
  runtime: { node: process.version, platform: `${process.platform}-${process.arch}` },
  source: values.source,
  problems: [...problems, ...unmatched.map((name) => `${name} selects nothing`)],
  entries,
  summary,
  results,
};
if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(runRecord, null, 2)}\n`);
process.stdout.write(`corpus: ${JSON.stringify(summary)}\n`);
for (const problem of runRecord.problems) process.stdout.write(`corpus: ${problem}\n`);
const incomplete = summary.executed < summary.planned || runRecord.problems.length > 0;
process.exit(summary.differs > 0 || summary.noVerdict > 0 ? 1 : incomplete ? 2 : 0);
