import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "swarm-verify.ts");
const verifier = resolve(import.meta.dirname, "..", "verify.mjs");
const signingKey = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

// Synthetic values in credential shapes, kept in a project fixture file, never the environment.
const secrets = {
  github: `ghp_${"Zq9xW2vK7m".repeat(4)}`,
  aws: `AKIA${"7".repeat(8)}${"QWERTYUI"}`,
  password: "correct-horse-battery-staple",
  keyBody: "c3ludGhldGljLWtleS1ib2R5LW5vdC1hLXJlYWwta2V5LWF0LWFsbA",
  split: `ghp_${"Sp1itAcr0ss".repeat(3)}`,
};
const privateKey = `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\n${secrets.keyBody}\n${secrets.keyBody}\n-----END OPENSSH ${"PRIVATE"} KEY-----`;
const values = [...Object.values(secrets)];

let root = "";
let repo = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const node = (args: string[]) =>
  spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SWARM_SIGNING_KEY: signingKey, SWARM_HOME: join(root, "home") },
  });
const verify = (range: string, out: string, ...flags: string[]) =>
  node([cli, "verify", "--isolation", "host", "--range", range, "--out", out, ...flags]);

/** Every file under `dir`, with each DSSE payload decoded, as one text. */
async function everything(dir: string): Promise<string> {
  const texts: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = await readFile(join(entry.parentPath, entry.name), "utf8");
    texts.push(text);
    if (entry.name.endsWith(".sigstore.json"))
      texts.push(Buffer.from(JSON.parse(text).dsseEnvelope.payload, "base64").toString("utf8"));
  }
  return texts.join("\n");
}
const leaks = (text: string) => values.filter((value) => text.includes(value));

const diag = `import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const creds = JSON.parse(readFileSync("fixtures/creds.json", "utf8"));
console.log("loaded", creds.github, creds.aws);
console.log(\`password=\${creds.password}\`);
console.error(creds.privateKey);
console.log("outputTokens: 1234 tokens_per_second=12.5");
process.stdout.write(creds.split.slice(0, 12));
await setTimeout(150);
process.stdout.write(\`\${creds.split.slice(12)}\\n\`);
`;
// 4 MiB of output, with a key starting 40 bytes before the cap so its end is cut off.
const big = `import { readFileSync } from "node:fs";
const creds = JSON.parse(readFileSync("fixtures/creds.json", "utf8"));
process.stdout.write("x".repeat(4 * 1024 * 1024 - 40) + creds.privateKey + "\\n");
`;
const halfTest = (body: string) =>
  `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nimport { half } from "../half.mjs";\nconst creds = JSON.parse(readFileSync("fixtures/creds.json", "utf8"));\n${body}\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-redaction-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "test"), { recursive: true });
  await mkdir(join(repo, "fixtures"));
  await mkdir(join(repo, "scripts"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(
    join(repo, "swarm.toml"),
    '[checks]\ntest = "node --test"\ndiag = "node scripts/diag.mjs"\nbig = "node scripts/big.mjs"\n',
  );
  await writeFile(join(repo, "fixtures", "creds.json"), JSON.stringify({ ...secrets, privateKey }));
  await writeFile(join(repo, "scripts", "diag.mjs"), diag);
  await writeFile(join(repo, "scripts", "big.mjs"), big);
  await writeFile(join(repo, "half.mjs"), "export const half = (n) => n;\n");
  await writeFile(
    join(repo, "test", "half.test.mjs"),
    halfTest(
      'test("half", () => { console.log("token", creds.github); assert.equal(half(4), 2, "password=" + creds.password); });',
    ),
  );
  git("add", "-A");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "fix");
  await writeFile(join(repo, "half.mjs"), "export const half = (n) => n / 2;\n");
  git("commit", "-qam", "fix");
  git("checkout", "-qb", "broken", "fix");
  await writeFile(join(repo, "half.mjs"), "export const half = (n) => n * 3;\n");
  git("commit", "-qam", "broken");
  git("checkout", "-qb", "leak", "fix");
  await writeFile(join(repo, "id_test"), `${privateKey}\n`);
  git("add", "-A");
  git("commit", "-qm", "leak a key");
  git("checkout", "-qb", "named", "fix");
  await writeFile(
    join(repo, "test", "named.test.mjs"),
    halfTest(`test("refuses ${secrets.github}", () => assert.equal(half(2), 1));`),
  );
  git("add", "-A");
  git("commit", "-qm", "a test named with a token");
  git("checkout", "-q", "main");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("evidence logs are redacted before they are hashed, signed and published", () => {
  it("publishes no fixture secret, binds the redacted bytes, and still verifies and replays", async () => {
    const out = join(root, "out-fix");
    const ran = verify("main..fix", out);
    expect(ran.status).toBe(0);
    expect(leaks(ran.stdout + ran.stderr)).toEqual([]);
    expect(leaks(await everything(out))).toEqual([]);

    const statement = JSON.parse(await readFile(join(out, "statement.json"), "utf8"));
    for (const log of statement.predicate.logs) {
      const bytes = await readFile(join(out, log.name));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(log.sha256);
    }
    for (const check of statement.predicate.checks) {
      const bytes = await readFile(join(out, "logs", `${check.name}.txt`));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(check.outputSha256);
    }
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    for (const file of manifest.files) {
      const bytes = await readFile(join(out, file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(statement.predicate.policy.redaction.policy).toBe("swarm-verify.redaction/v1");
    expect(statement.predicate.policy.redaction.markers).toMatchObject({
      "github-token": expect.any(Number),
      "aws-access-key-id": expect.any(Number),
      "private-key-block": expect.any(Number),
      "credential-assignment": expect.any(Number),
    });
    const diagLog = await readFile(join(out, "logs", "diag.txt"), "utf8");
    expect(diagLog).toContain("outputTokens: 1234 tokens_per_second=12.5");
    expect(diagLog).toContain("[redacted:github-token]");
    const bigLog = await readFile(join(out, "logs", "big.txt"), "utf8");
    expect(bigLog.endsWith("[redacted:private-key-block]")).toBe(true);
    expect(statement.predicate.checks.map((one: { result: string }) => one.result)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);

    const offline = node([
      verifier,
      join(out, "attestation.sigstore.json"),
      "--key",
      join(out, "attestation.pub.pem"),
      "--patch",
      join(out, "change.patch"),
    ]);
    expect(offline.status).toBe(0);
    const replayed = node([
      cli,
      "replay",
      out,
      "--key",
      join(out, "attestation.pub.pem"),
      "--allow-host",
      "--out",
      join(root, "replay-fix"),
    ]);
    expect(replayed.stdout).toMatch(/^agreement/m);
    expect(replayed.status).toBe(0);
    expect(leaks(await everything(join(root, "replay-fix")))).toEqual([]);
  });

  it("keeps a failing run's reasons and output free of the secrets its test printed", async () => {
    const out = join(root, "out-broken");
    const ran = verify("fix..broken", out, "--json");
    expect(ran.status).toBe(1);
    const result = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "");
    expect(result.checks.find((one: { name: string }) => one.name === "test")?.result).not.toBe(
      "pass",
    );
    expect(result.failureOutput.length).toBeGreaterThan(0);
    expect(leaks(ran.stdout + ran.stderr)).toEqual([]);
    expect(leaks(await everything(out))).toEqual([]);
  });

  it.each([
    [
      "a patch that adds a private key",
      "main..leak",
      /the candidate's patch \(private-key-block\)/,
    ],
    ["a test named with a token", "main..named", /observations\.json \(github-token\)/],
  ])("publishes nothing for %s, signed or not, and says where", async (_, range, where) => {
    for (const flags of [[], ["--allow-unsigned"]]) {
      const out = join(root, `out-${range.replace("..", "-")}-${flags.length}`);
      const ran = verify(range, out, "--json", ...flags);
      expect(ran.status).toBe(7);
      const result = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "");
      expect(result.delivery.status).toBe("failed");
      expect(result.delivery.problems.join("\n")).toMatch(where);
      expect(result.snapshot.patchSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await readdir(out).catch(() => [])).toEqual([]);
      expect(leaks(result.delivery.problems.join("\n"))).toEqual([]);
    }
  });
});
