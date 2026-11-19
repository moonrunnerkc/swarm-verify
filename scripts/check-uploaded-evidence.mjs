#!/usr/bin/env node
// Fails unless the evidence directory an Action run uploads holds a complete, signed run that
// carries none of the fixture's credential values (DSSE payloads decoded) and records the
// memory and CPU bounds the job asked for.
//
//   node scripts/check-uploaded-evidence.mjs <evidence-dir> <creds.json>
// with STATE and DELIVERY from the Action's outputs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, credsPath] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credsPath, "utf8"));
const values = [creds.github, creds.aws, creds.password, creds.privateKey.split("\n")[1]];
const texts = [];
for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
  texts.push(text);
  if (entry.name.endsWith(".sigstore.json"))
    texts.push(Buffer.from(JSON.parse(text).dsseEnvelope.payload, "base64").toString("utf8"));
}
const failures = [];
const leaked = values.filter((value) => texts.some((text) => text.includes(value)));
if (leaked.length > 0)
  failures.push(`${leaked.length} fixture credential value(s) in the evidence`);
if (process.env.STATE !== "complete") failures.push(`state ${process.env.STATE}`);
if (process.env.DELIVERY !== "signed") failures.push(`delivery ${process.env.DELIVERY}`);
const statement = JSON.parse(readFileSync(join(dir, "statement.json"), "utf8"));
const resources = statement.predicate.execution.resources;
if (resources?.requested?.memoryMiB !== 1024 || resources?.requested?.cpus !== 1)
  failures.push(`requested bounds ${JSON.stringify(resources?.requested)}`);
if (
  resources?.effective?.memoryBytes !== 1024 * 1024 * 1024 ||
  resources?.effective?.swapBytes !== 0
)
  failures.push(`effective bounds ${JSON.stringify(resources?.effective)}`);
const markers = statement.predicate.policy.redaction?.markers ?? {};
console.log(
  `files ${texts.length}; redaction markers ${JSON.stringify(markers)}; bounds ${JSON.stringify(resources?.effective)}`,
);
for (const failure of failures) console.log(`FAILED ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
