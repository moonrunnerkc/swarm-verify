import { describe, expect, it } from "vitest";
import { redactionPolicy, redactionRecord, redactText, secretShapes } from "./redact.ts";

// Synthetic values in the shapes real credentials take; none is a real credential.
const fake = {
  github: `ghp_${"a1B2c3D4e5".repeat(4)}`,
  aws: `AKIA${"Q".repeat(16)}`,
  jwt: `eyJ${"x".repeat(12)}.${"y".repeat(12)}.${"z".repeat(12)}`,
  anthropic: `sk-ant-${"k".repeat(24)}`,
  key: `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQUFBQUFBQUFBQUFB\n-----END OPENSSH ${"PRIVATE"} KEY-----`,
};

describe("redacting diagnostic text", () => {
  it.each([
    ["API_KEY=hunter2swordfish", "API_KEY=[redacted:credential-assignment]"],
    ["export GITHUB_TOKEN=abc123", "export GITHUB_TOKEN=[redacted:credential-assignment]"],
    ['{"password": "pa ss"}', '{"password": "[redacted:credential-assignment]"}'],
    ["db_password: 'x y z'", "db_password: '[redacted:credential-assignment]'"],
    ["pin=1234;", "pin=[redacted:credential-assignment];"],
    ["?api_key=abc&x=1", "?api_key=[redacted:credential-assignment]&x=1"],
  ])("replaces the value of a credential assignment %j", (input, output) => {
    expect(redactText(input).text).toBe(output);
  });

  it("replaces tokens in the shapes that name themselves, wherever they sit", () => {
    const text = `got ${fake.github} and ${fake.aws}\nAuthorization: Bearer ${"t".repeat(30)}\njwt ${fake.jwt} ${fake.anthropic}`;
    const { text: out, counts } = redactText(text);
    for (const value of [fake.github, fake.aws, fake.jwt, fake.anthropic, "t".repeat(30)])
      expect(out).not.toContain(value);
    expect(counts).toMatchObject({
      "github-token": 1,
      "aws-access-key-id": 1,
      "json-web-token": 1,
      "anthropic-key": 1,
      "bearer-token": 1,
    });
  });

  it("replaces a multiline private key, and one cut off by the output cap", () => {
    expect(redactText(`before\n${fake.key}\nafter`).text).toBe(
      "before\n[redacted:private-key-block]\nafter",
    );
    const cut = fake.key.slice(0, 60);
    expect(redactText(`log\n${cut}`).text).toBe("log\n[redacted:private-key-block]");
  });

  it("is idempotent and deterministic", () => {
    const text = `TOKEN=abc ${fake.github}\n${fake.key}\n"secret": "v"`;
    const once = redactText(text).text;
    expect(redactText(once)).toEqual({ text: once, counts: {} });
    expect(redactText(text).text).toBe(once);
  });

  it("leaves ordinary output and metrics as they are", () => {
    const text = [
      "Tests  12 passed (12)",
      "outputTokens: 1234",
      "tokens_per_second=12.5",
      "maxTokens=4096",
      "keySource: keychain",
      "Duration 1.23s",
      "mapping=1 spinCount=2",
      "✓ rejects a bad key (3 ms)",
    ].join("\n");
    expect(redactText(text)).toEqual({ text, counts: {} });
  });

  it("reads a lookalike-lettered name as the name it shows", () => {
    expect(redactText("pаssword=abc").text).toBe("pаssword=[redacted:credential-assignment]");
  });
});

describe("what a publication gate finds", () => {
  it("names the shapes left in text it must not edit, never the values", () => {
    const found = secretShapes(`+const key = "${fake.github}";\n+${fake.key}`);
    expect(found).toEqual(["private-key-block", "github-token"]);
    expect(found.join(" ")).not.toContain(fake.github.slice(4));
    expect(secretShapes("+export const half = (n) => n / 2;")).toEqual([]);
  });

  it("records the policy and marker counts", () => {
    expect(
      redactionRecord([
        "a [redacted:github-token] b",
        "[redacted:github-token][redacted:credential-assignment]",
      ]),
    ).toEqual({
      policy: redactionPolicy,
      markers: { "github-token": 2, "credential-assignment": 1 },
    });
  });
});
