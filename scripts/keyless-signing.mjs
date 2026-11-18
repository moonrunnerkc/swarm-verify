#!/usr/bin/env node
// Real keyless signing, run only in a GitHub Actions job that holds `id-token: write`: verify
// signs a small change through cosign and Sigstore with the job's own OIDC identity, then the
// bundle is checked against that identity and issuer, and refused for tampered evidence, another
// issuer and identities that are not this workflow's. Replay is run against the same signer
// policy. Every expectation is checked; any that does not hold fails the job.
//
//   node scripts/keyless-signing.mjs <cli> <work-dir>
// with EXPECTED_IDENTITY and EXPECTED_ISSUER set from the workflow's own context.

import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [cliArg, workArg] = process.argv.slice(2);
const identity = process.env.EXPECTED_IDENTITY;
const issuer = process.env.EXPECTED_ISSUER;
if (cliArg === undefined || workArg === undefined || !identity || !issuer) {
  console.error(
    "usage: EXPECTED_IDENTITY=... EXPECTED_ISSUER=... node scripts/keyless-signing.mjs <cli> <work-dir>",
  );
  process.exit(2);
}
const cli = resolve(cliArg);
const work = resolve(workArg);
const predicateType = "https://github.com/moonrunnerkc/swarm-verify/result/v1";
const checks = [];

function run(command, args, cwd = work) {
  const ran = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function expect(name, ran, wanted) {
  const held = wanted === "nonzero" ? ran.code !== 0 && ran.code !== null : ran.code === wanted;
  checks.push({ name, expected: wanted, exit: ran.code, held });
  console.log(`${held ? "ok    " : "FAILED"} ${name}: exit ${ran.code}, expected ${wanted}`);
  if (!held) console.log(`${ran.stdout.slice(-1500)}\n${ran.stderr.slice(-1500)}`);
}

function cosignVerify(bundle, blob, who, from) {
  return run("cosign", [
    "verify-blob-attestation",
    "--bundle",
    bundle,
    "--certificate-identity",
    who,
    "--certificate-oidc-issuer",
    from,
    "--type",
    predicateType,
    blob,
  ]);
}

function replay(evidence, who, from) {
  return run("node", [
    cli,
    "replay",
    evidence,
    "--workspace",
    fixture,
    "--certificate-identity",
    who,
    "--certificate-oidc-issuer",
    from,
    "--out",
    join(work, `replay-${checks.length}`),
  ]);
}

// A fixture repository: a failing base and a change that fixes it.
const fixture = join(work, "fixture");
mkdirSync(fixture, { recursive: true });
const git = (...args) => run("git", args, fixture);
git("init", "-q", "-b", "main");
git("config", "user.name", "keyless");
git("config", "user.email", "keyless@example.invalid");
writeFileSync(
  join(fixture, "package.json"),
  '{ "name": "fixture", "version": "1.0.0", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
);
writeFileSync(join(fixture, "add.js"), "export const add = (a, b) => a - b;\n");
writeFileSync(
  join(fixture, "add.test.js"),
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./add.js";\ntest("adds zero", () => assert.equal(add(2, 0), 2));\n',
);
git("add", ".");
git("commit", "-q", "-m", "base");
git("branch", "base");
writeFileSync(join(fixture, "add.js"), "export const add = (a, b) => a + b;\n");
appendFileSync(
  join(fixture, "add.test.js"),
  'test("adds two numbers", () => assert.equal(add(2, 3), 5));\n',
);
git("commit", "-q", "-am", "Add two numbers");

const evidence = join(work, "evidence");
const verified = run("node", [
  cli,
  "verify",
  "--workspace",
  fixture,
  "--range",
  "base..main",
  "--isolation",
  "isolated",
  "--dependencies",
  "none",
  "--sigstore",
  "--out",
  evidence,
  "--json",
]);
expect("verify signs keylessly with the job's identity", verified, 0);
const result = JSON.parse(verified.stdout.trim().split("\n").at(-1) ?? "null");
const bundlePath = join(evidence, "attestation.sigstore.json");
const patch = join(evidence, "change.patch");
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const raw = bundle.verificationMaterial?.certificate?.rawBytes;
const certificate = raw === undefined ? null : new X509Certificate(Buffer.from(raw, "base64"));
const tlog = bundle.verificationMaterial?.tlogEntries?.[0];

expect(
  "cosign verifies it for the expected identity and issuer",
  cosignVerify(bundlePath, patch, identity, issuer),
  0,
);

const tamperedPatch = join(work, "tampered.patch");
writeFileSync(tamperedPatch, `${readFileSync(patch, "utf8")}\n`);
expect(
  "cosign refuses a patch one byte longer",
  cosignVerify(bundlePath, tamperedPatch, identity, issuer),
  "nonzero",
);

const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
statement.predicate.state = statement.predicate.state === "complete" ? "incomplete" : "complete";
const forged = structuredClone(bundle);
forged.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
const forgedPath = join(work, "forged.sigstore.json");
writeFileSync(forgedPath, JSON.stringify(forged));
expect(
  "cosign refuses a bundle whose statement was edited",
  cosignVerify(forgedPath, patch, identity, issuer),
  "nonzero",
);

expect(
  "cosign refuses another issuer",
  cosignVerify(bundlePath, patch, identity, "https://accounts.google.com"),
  "nonzero",
);
const otherWorkflow = identity.replace(/[^/]+\.ya?ml@/, "release.yml@");
expect(
  "cosign refuses another workflow of this repository",
  cosignVerify(bundlePath, patch, otherWorkflow, issuer),
  "nonzero",
);
const otherOwner = identity.replace("github.com/moonrunnerkc/", "github.com/someone-else/");
expect(
  "cosign refuses the same workflow in another repository",
  cosignVerify(bundlePath, patch, otherOwner, issuer),
  "nonzero",
);

expect("replay authenticates the bundle and agrees", replay(evidence, identity, issuer), 0);
expect("replay refuses another identity (exit 6)", replay(evidence, otherWorkflow, issuer), 6);
expect(
  "replay refuses another issuer (exit 6)",
  replay(evidence, identity, "https://accounts.google.com"),
  6,
);
const tamperedEvidence = join(work, "evidence-tampered");
cpSync(evidence, tamperedEvidence, { recursive: true });
writeFileSync(join(tamperedEvidence, "attestation.sigstore.json"), JSON.stringify(forged));
expect(
  "replay refuses an edited statement (exit 6)",
  replay(tamperedEvidence, identity, issuer),
  6,
);

const summary = {
  identity,
  issuer,
  state: result?.state ?? null,
  delivery: result?.delivery?.status ?? null,
  integrity: result?.integrity ?? null,
  certificate:
    certificate === null
      ? null
      : {
          subjectAltName: certificate.subjectAltName,
          issuer: certificate.issuer,
          validFrom: certificate.validFrom,
          validTo: certificate.validTo,
          fingerprint256: certificate.fingerprint256,
        },
  rekor:
    tlog === undefined ? null : { logIndex: tlog.logIndex, integratedTime: tlog.integratedTime },
  cosign: run("cosign", ["version"]).stdout.match(/GitVersion:\s*(\S+)/)?.[1] ?? null,
  checks,
};
writeFileSync(join(work, "keyless-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  const rows = checks.map(
    (one) => `| ${one.held ? "held" : "FAILED"} | ${one.name} | ${one.exit} | ${one.expected} |`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Keyless signing\n\nIdentity \`${identity}\`, issuer \`${issuer}\`, certificate SAN \`${summary.certificate?.subjectAltName ?? "none"}\`, Rekor log index ${summary.rekor?.logIndex ?? "none"}.\n\n| | Check | Exit | Expected |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n`,
  );
}
const certified = summary.certificate?.subjectAltName === `URI:${identity}`;
console.log(
  `${certified ? "ok    " : "FAILED"} certificate names ${identity}: ${summary.certificate?.subjectAltName}`,
);
const failed =
  checks.filter((one) => !one.held).length + (certified ? 0 : 1) + (tlog === undefined ? 1 : 0);
if (tlog === undefined) console.log("FAILED the bundle carries no transparency-log entry");
process.exit(failed === 0 ? 0 : 1);
