#!/usr/bin/env node
// The packed package as a consumer runs it, with nothing of this repository's development tools:
// the tarball installed into a clean directory, then the API, the CLI, preflight, the offline
// verifier, authenticated replay and the TypeScript mutation path, each checked by its outcome.
// Plain Node, so it runs on the runtime under test (the declared minimum in CI).
//
//   node scripts/consumer-smoke.mjs <tarball> [--expect-node v22.13.0]

import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "expect-node": { type: "string" } },
});
const tarball = positionals[0] === undefined ? null : resolve(positionals[0]);
if (tarball === null) {
  console.error("usage: node scripts/consumer-smoke.mjs <tarball> [--expect-node vX.Y.Z]");
  process.exit(2);
}
const failures = [];
const check = (name, held, detail = "") => {
  console.log(`${held ? "ok    " : "FAILED"} ${name}${detail === "" ? "" : `: ${detail}`}`);
  if (!held) failures.push(name);
};

console.log(`node ${process.version} on ${process.platform}-${process.arch}`);
if (values["expect-node"] !== undefined)
  check(
    `runtime is ${values["expect-node"]}`,
    process.version === values["expect-node"],
    process.version,
  );

const work = realpathSync(mkdtempSync(join(tmpdir(), "consumer-smoke-")));
const consumer = join(work, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  '{ "name": "consumer", "private": true, "type": "module" }\n',
);
const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
  cwd: consumer,
  encoding: "utf8",
});
check("npm installs the tarball", npm.status === 0, npm.status === 0 ? "" : npm.stderr.slice(-800));
const bin = join(consumer, "node_modules", "swarm-verify", "dist", "swarm-verify.js");
const offline = join(consumer, "node_modules", "swarm-verify", "verify.mjs");
const key = generateKeyPairSync("ed25519");
const env = {
  ...process.env,
  SWARM_HOME: join(work, "home"),
  SWARM_SIGNING_KEY: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const run = (args, cwd = consumer) =>
  spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// A TypeScript project, so the mutation pass parses a TypeScript mutant with Node's own transform.
const repo = join(work, "repo");
mkdirSync(join(repo, "test"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.name", "consumer");
git("config", "user.email", "consumer@example.invalid");
writeFileSync(
  join(repo, "package.json"),
  '{ "name": "fixture", "version": "1.0.0", "private": true, "type": "module" }\n',
);
writeFileSync(
  join(repo, "swarm.toml"),
  '[checks]\ntest = "node --experimental-strip-types --test test/half.test.ts"\n',
);
writeFileSync(join(repo, "half.ts"), "export const half = (n: number): number => n;\n");
writeFileSync(
  join(repo, "test", "half.test.ts"),
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { half } from "../half.ts";\ntest("half positive", () => assert.equal(half(4), 2));\n',
);
git("add", ".");
git("commit", "-q", "-m", "base");
git("branch", "base");
writeFileSync(join(repo, "half.ts"), "export const half = (n: number): number => n / 2;\n");
git("commit", "-q", "-am", "halve");

// The API, through the package's own export.
const api = join(consumer, "api.mjs");
writeFileSync(
  api,
  `import { requestVersion, snapshotWorkingTree, verify, verifierVersion, parseRequest } from "swarm-verify";
const repo = process.argv[2];
const snapshot = await snapshotWorkingTree(repo, "base", process.argv[3] + "/candidate.patch");
const result = await verify({
  version: requestVersion, repository: repo, base: { commit: snapshot.baseCommit },
  candidate: { kind: "patch", path: snapshot.path, sha256: snapshot.sha256 },
  requirements: [{ id: "R1", text: "half(n) returns n / 2", source: "user", kind: "fix", evidence: { tests: [{ name: "half positive" }] } }],
  policy: { execution: { mode: "host", network: "open", dependencies: "none" } },
  artifacts: { directory: process.argv[3] + "/evidence" },
}, { verifierVersion });
console.log(JSON.stringify({ state: result.state, delivery: result.delivery.status, mutation: result.mutation, parse: typeof parseRequest }));
`,
);
mkdirSync(join(work, "api"));
const viaApi = run([api, repo, join(work, "api")]);
const answer = (() => {
  try {
    return JSON.parse(viaApi.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
})();
check(
  "the API verifies a change to complete",
  answer?.state === "complete",
  viaApi.status === 0 ? JSON.stringify(answer?.state) : viaApi.stderr.slice(-800),
);
check("the API delivers signed evidence", answer?.delivery === "signed", String(answer?.delivery));
check(
  "the mutation pass parsed and ran a TypeScript mutant",
  answer?.mutation?.path === "half.ts" &&
    answer?.mutation?.syntax === "valid" &&
    answer?.mutation?.status === "killed",
  JSON.stringify(answer?.mutation),
);

// The CLI, preflight, the offline verifier and replay, through the installed bin.
const out = join(work, "cli");
const cli = run([
  bin,
  "verify",
  "--workspace",
  repo,
  "--range",
  "base..main",
  "--isolation",
  "host",
  "--dependencies",
  "none",
  "--out",
  out,
]);
check(
  "the CLI verifies the change (exit 0)",
  cli.status === 0,
  `exit ${cli.status} ${cli.stderr.slice(-400)}`,
);
check("the CLI reports complete", /^state\s+complete/m.test(cli.stdout));
const plan = run([
  bin,
  "verify",
  "--workspace",
  repo,
  "--range",
  "base..main",
  "--isolation",
  "host",
  "--preflight",
]);
check(
  "preflight plans without running (exit 0)",
  plan.status === 0 && /^acceptance\s+swarm-verify\.acceptance\/v1/m.test(plan.stdout),
  `exit ${plan.status}`,
);
const verified = run([
  offline,
  join(out, "attestation.sigstore.json"),
  "--key",
  join(out, "attestation.pub.pem"),
  "--patch",
  join(out, "change.patch"),
]);
check(
  "verify.mjs checks the signature and accepts (exit 0)",
  verified.status === 0,
  `exit ${verified.status}`,
);
const trusted = join(work, "trusted.pub.pem");
writeFileSync(trusted, key.publicKey.export({ type: "spki", format: "pem" }).toString());
const replayed = run([
  bin,
  "replay",
  out,
  "--workspace",
  repo,
  "--key",
  trusted,
  "--allow-host",
  "--out",
  join(work, "replay"),
]);
check(
  "replay authenticates against the trusted key and agrees (exit 0)",
  replayed.status === 0,
  `exit ${replayed.status} ${replayed.stderr.slice(-400)}`,
);
const stranger = join(work, "stranger.pub.pem");
writeFileSync(
  stranger,
  generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
);
const refused = run([
  bin,
  "replay",
  out,
  "--workspace",
  repo,
  "--key",
  stranger,
  "--allow-host",
  "--out",
  join(work, "replay-2"),
]);
check(
  "replay refuses a key it was not signed with (exit 6)",
  refused.status === 6,
  `exit ${refused.status}`,
);
const version = JSON.parse(
  readFileSync(join(consumer, "node_modules", "swarm-verify", "package.json"), "utf8"),
).version;
check("the installed version answers --version", run([bin, "--version"]).stdout.includes(version));

console.log(
  failures.length === 0 ? "consumer smoke: all held" : `consumer smoke: ${failures.length} failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
