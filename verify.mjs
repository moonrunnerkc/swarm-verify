#!/usr/bin/env node
// Checks a swarm-verify attestation with nothing but Node: the DSSE signature over the in-toto
// Statement, the subject digests recomputed from the files you name, and the recorded state
// re-derived from the recorded evidence.
//
//   node verify.mjs <attestation.sigstore.json> --key <public.pem> [--patch <file>] [--tree <dir>]
//                   [--integrity-only]
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
    `${problem}\nusage: node verify.mjs <attestation> --key <public.pem> [--patch <file>] [--tree <dir>] [--integrity-only]\n`,
  );
  process.exit(2);
}

function parse(argv) {
  const options = { attestation: null, key: null, patch: null, tree: null, integrityOnly: false };
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    const flag = /^--(key|patch|tree)$/.exec(word);
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
}

/**
 * The state the recorded evidence supports, by the rule the verifier applies: complete only when
 * the change applied, every required requirement is satisfied with passing evidence, nothing
 * regressed or stayed unresolved, no check or held-out check failed, and the execution policy
 * was met. A recorded `blocked` stands: it can only withhold acceptance, never grant it.
 */
function derivedState(predicate) {
  if (predicate.state === "blocked") return "blocked";
  const passing = new Set(["fixed", "pass", "observed", "added-passing", "preserved", "resolved"]);
  const required = (predicate.requirements ?? []).filter((one) => one.required);
  const satisfied = required.every(
    (one) =>
      one.status === "satisfied" &&
      (one.evidence ?? []).length > 0 &&
      one.evidence.every((ref) => passing.has(ref.outcome)),
  );
  const checksHold = (predicate.checks ?? []).every((check) => check.result === "pass");
  const heldOut = predicate.heldOut;
  const heldOutHolds = heldOut?.status !== "measured" || heldOut.heldOutPassRate === 1;
  return predicate.change?.applied === true &&
    satisfied &&
    predicate.regression?.status === "none" &&
    predicate.execution?.policyMet === true &&
    checksHold &&
    heldOutHolds
    ? "complete"
    : "incomplete";
}

const predicate = statement?.predicate;
if (signed && predicate !== undefined && predicate !== null) {
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
