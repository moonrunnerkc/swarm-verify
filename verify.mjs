#!/usr/bin/env node
// Checks a swarm-verify attestation with nothing but Node: the DSSE signature over the in-toto
// Statement, the subject digests recomputed from the files you name, and the recorded state
// re-derived from the recorded evidence.
//
//   node verify.mjs <attestation.sigstore.json> --key <public.pem> [--patch <file>] [--tree <dir>]
//                   [--evidence <dir>] [--ledger <ledger.jsonl>] [--report <report.json>]
//                   [--integrity-only]
//
// --evidence checks every log the statement lists, --ledger checks the producer's command ledger
// against the prefix the statement bound, and --report checks that a producer's report states
// the signed snapshot, state and requirement statuses and nothing else.
//
// Integrity and acceptance are separate answers with separate exit codes:
//   0  integrity holds and the task is accepted: the state is complete and the evidence supports it
//   1  integrity holds and the task is not accepted: incomplete or blocked
//   6  integrity fails: a signature, subject or statement problem, or a recorded state the
//      recorded evidence does not support
//   2  a command line it cannot read
// With --integrity-only, acceptance is not judged: 0 when integrity holds, 6 when it does not.
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

const payloadType = "application/vnd.in-toto+json";
const statementType = "https://in-toto.io/Statement/v1";
const predicateType = "https://github.com/moonrunnerkc/swarm-verify/result/v1";

function usage(problem) {
  process.stderr.write(
    `${problem}\nusage: node verify.mjs <attestation> --key <public.pem> [--patch <file>] [--tree <dir>] [--evidence <dir>] [--ledger <file>] [--report <file>] [--integrity-only]\n`,
  );
  process.exit(2);
}

function parse(argv) {
  const options = {
    attestation: null,
    key: null,
    patch: null,
    tree: null,
    evidence: null,
    ledger: null,
    report: null,
    integrityOnly: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    const flag = /^--(key|patch|tree|evidence|ledger|report)$/.exec(word);
    if (word === "--integrity-only") options.integrityOnly = true;
    else if (flag !== null) {
      if (argv[at + 1] === undefined) usage(`${word} needs a value`);
      options[flag[1]] = argv[++at];
    } else if (word.startsWith("--")) usage(`unknown option ${word}`);
    else if (options.attestation === null) options.attestation = word;
    else usage(`unexpected argument ${word}`);
  }
  if (options.attestation === null) usage("name the attestation to check");
  if (options.key === null)
    usage("--key is required: a signature means nothing without the expected signer");
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** DSSE pre-authentication encoding. */
function pae(type, body) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${body.length} `),
    body,
  ]);
}

/** The same digest swarm-verify computes: `<mode> <sha256> <path>` per file, sorted by path. */
function treeDigest(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isSymbolicLink() || stat.isFile()) {
        const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
        const content = stat.isSymbolicLink()
          ? Buffer.from(readlinkSync(path))
          : readFileSync(path);
        const name = relative(root, path).split(sep).join("/");
        entries.push({ path: Buffer.from(name), line: `${mode} ${sha256(content)} ${name}\n` });
      }
    }
  };
  walk(root);
  entries.sort((a, b) => Buffer.compare(a.path, b.path));
  return sha256(entries.map((entry) => entry.line).join(""));
}

const options = parse(process.argv.slice(2));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

let document;
try {
  document = JSON.parse(readFileSync(options.attestation, "utf8"));
} catch (error) {
  usage(`${options.attestation} is not readable JSON: ${error.message}`);
}
const envelope = document?.dsseEnvelope ?? document;
const signatures = Array.isArray(envelope?.signatures) ? envelope.signatures : [];
check(
  "envelope",
  envelope?.payloadType === payloadType && typeof envelope?.payload === "string",
  envelope?.payloadType ?? "missing",
);

const body = Buffer.from(typeof envelope?.payload === "string" ? envelope.payload : "", "base64");
const key = createPublicKey(readFileSync(options.key));
const signed = signatures.some((signature) => {
  try {
    return verify(null, pae(payloadType, body), key, Buffer.from(signature.sig, "base64"));
  } catch {
    return false;
  }
});
check(
  "signature",
  signed,
  signed ? "verifies under the given key" : "does not verify under the given key",
);

let statement = null;
try {
  statement = JSON.parse(body.toString("utf8"));
} catch {
  check("statement", false, "the payload is not JSON");
}
if (statement !== null) {
  check(
    "statement",
    statement._type === statementType && statement.predicateType === predicateType,
    `${statement._type} with ${statement.predicateType}`,
  );
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const digestOf = (match) => subjects.find(match)?.digest?.sha256;
  if (options.patch !== null) {
    const expected = digestOf((subject) => subject.name !== "tree");
    const actual = sha256(readFileSync(options.patch));
    check("patch", actual === expected, `sha256:${actual}`);
  }
  if (options.tree !== null) {
    const actual = treeDigest(options.tree);
    check("tree", actual === digestOf((subject) => subject.name === "tree"), `sha256:${actual}`);
  }
  const predicate = statement.predicate ?? {};
  if (options.evidence !== null) {
    const logs = Array.isArray(predicate.logs) ? predicate.logs : [];
    const broken = logs.filter((log) => {
      try {
        return sha256(readFileSync(join(options.evidence, log.name))) !== log.sha256;
      } catch {
        return true;
      }
    });
    check(
      "evidence",
      broken.length === 0,
      broken.length === 0
        ? `${logs.length} log(s) match`
        : `${broken.map((log) => log.name).join(", ")} missing or changed`,
    );
  }
  if (options.ledger !== null) {
    const producer = predicate.producer ?? {};
    const count = producer.ledgerRecords;
    const lines = readFileSync(options.ledger, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    const prefix = Number.isInteger(count) && lines.length >= count ? lines.slice(0, count) : null;
    const actual = prefix === null ? null : sha256(prefix.map((line) => `${line}\n`).join(""));
    check(
      "ledger",
      actual !== null && actual === producer.ledgerSha256,
      actual === null
        ? `the ledger holds ${lines.length} record(s), fewer than the ${count ?? "unrecorded"} bound`
        : `first ${count} record(s) sha256:${actual}`,
    );
  }
  if (options.report !== null) {
    let report = null;
    try {
      report = JSON.parse(readFileSync(options.report, "utf8"));
    } catch {
      // Reported below as a report that does not match.
    }
    const signed = new Map((predicate.requirements ?? []).map((one) => [one.id, one.status]));
    const stated = report?.requirements ?? [];
    const agrees =
      report !== null &&
      report.snapshot?.patchSha256 === digestOf((subject) => subject.name !== "tree") &&
      report.state === predicate.state &&
      stated.length === signed.size &&
      stated.every((one) => signed.get(one.id) === one.status);
    check(
      "report",
      agrees,
      agrees
        ? "states the signed snapshot, state and requirement statuses"
        : "does not state what the statement signed",
    );
  }
}

/**
 * The state the recorded evidence supports, by the rule the verifier applies (src/verify/
 * requirements.ts and assess.ts): complete only when the change applied, every required
 * requirement is satisfied by evidence that holds with at least one decisive witness its
 * implementation's author did not choose (a fix or feature: a test failing before and passing
 * after; a refactor: structure, nothing regressed; an upgrade: a resolved package on a fresh
 * install, nothing regressed), nothing regressed or stayed unresolved, no check failed or was
 * flaky, the held-out checks passed and the execution policy was met. `blocked` stands.
 */
const witnessing = new Set(["fixed", "witness", "superseded"]);
const holding = new Set([
  ...witnessing,
  "preserved",
  "pass",
  "observed",
  "passes before and after",
  "passes but for inherited failures",
]);

function satisfied(one, predicate) {
  const evidence = one.evidence ?? [];
  if (one.status !== "satisfied" || evidence.length === 0) return false;
  if (!evidence.every((ref) => holding.has(ref.outcome))) return false;
  const quiet = predicate.regression?.status === "none";
  const witnesses = (ref) => witnessing.has(ref.outcome);
  const decisive = {
    fix: witnesses,
    feature: witnesses,
    refactor: (ref) => ref.kind === "structure" || witnesses(ref),
    upgrade: (ref) => ref.kind === "package",
  }[one.kind];
  const shown = evidence.filter(decisive ?? (() => true));
  if (!shown.some((ref) => ref.authority !== "implementation-authored")) return false;
  if (one.kind === "refactor") return quiet;
  if (one.kind === "upgrade") {
    const fresh = predicate.execution?.dependencies?.mode === "prepared";
    return quiet && fresh && evidence.some((ref) => ref.kind === "package");
  }
  return true;
}

function derivedState(predicate) {
  if (predicate.state === "blocked") return "blocked";
  const required = (predicate.requirements ?? []).filter((one) => one.required);
  // A flaky test failed and passed on one snapshot: it leaves its check unresolved.
  const checksHold = (predicate.checks ?? []).every(
    (check) =>
      (check.result === "pass" || check.result === "inherited-failures") &&
      (check.tests?.flaky ?? []).length === 0,
  );
  const heldOut = predicate.heldOut;
  const heldOutHolds = heldOut?.status !== "measured" || heldOut.heldOutPassRate === 1;
  return predicate.change?.applied === true &&
    required.every((one) => satisfied(one, predicate)) &&
    predicate.regression?.status === "none" &&
    predicate.execution?.policyMet === true &&
    checksHold &&
    heldOutHolds
    ? "complete"
    : "incomplete";
}

const signedPredicate = statement?.predicate;
if (signed && signedPredicate !== undefined && signedPredicate !== null) {
  const predicate = signedPredicate;
  const derived = derivedState(predicate);
  check(
    "state",
    derived === predicate.state || (derived === "incomplete" && predicate.state === "incomplete"),
    derived === predicate.state
      ? `${predicate.state}, supported by the recorded evidence`
      : `recorded ${predicate.state}, but the recorded evidence supports ${derived}`,
  );
}

for (const result of results) {
  process.stdout.write(
    `${result.ok ? "ok    " : "FAILED"} ${result.name.padEnd(9)} ${result.detail}\n`,
  );
}
const intact = results.every((result) => result.ok);
const predicate = signedPredicate;
if (intact && predicate !== undefined && predicate !== null) {
  process.stdout.write(`execution ${predicate.execution?.statement ?? "not recorded"}\n`);
  for (const one of predicate.requirements ?? []) {
    process.stdout.write(
      `${one.id.padEnd(9)} ${one.status}${one.limitation ? `: ${one.limitation}` : ""}\n`,
    );
  }
  process.stdout.write(
    `state     ${predicate.state}${predicate.reasons?.length ? `: ${predicate.reasons.join("; ")}` : ""}\n`,
  );
}
process.exitCode = !intact ? 6 : options.integrityOnly || predicate?.state === "complete" ? 0 : 1;
