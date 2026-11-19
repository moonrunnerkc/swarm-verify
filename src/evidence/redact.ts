import { assignmentLabel, isCredentialName, knownSecretPatterns } from "./credential-names.ts";

/**
 * Diagnostic text (check output, tails, failure reasons) is redacted before it is hashed,
 * written or signed. Known-pattern scrubbing: a credential in a shape or under a name nobody
 * listed survives, so it narrows what evidence can leak and guarantees nothing.
 */
export const redactionPolicy = "swarm-verify.redaction/v1";

const marker = (label: string) => `[redacted:${label}]`;
const keyLabel = "private-key-block";
const keyBlock = "-----BEGIN[A-Z ]*PRIVATE KEY-----";
const keyEnd = "-----END[A-Z ]*PRIVATE KEY-----";

/**
 * The shapes, most specific first: a whole key block, then one whose end was cut off (output is
 * capped from its head), then `sk-ant-` before the `sk-` that would also match it.
 */
const shapes: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: keyLabel, pattern: new RegExp(`${keyBlock}[\\s\\S]*?${keyEnd}`, "g") },
  { label: keyLabel, pattern: new RegExp(`${keyBlock}[\\s\\S]*$`, "g") },
  ...[...knownSecretPatterns]
    .filter((one) => one.label !== keyLabel)
    .sort((a, b) => (a.label === "anthropic-key" ? -1 : b.label === "anthropic-key" ? 1 : 0))
    .map((one) => ({ label: one.label, pattern: new RegExp(one.source, "g") })),
];

/**
 * `name=value`, `name: value` and `"name": "value"`, where the name says the value is a
 * credential (credential-names.ts, which exempts metrics by name). The value stops at
 * whitespace, a quote or a delimiter; a quoted one at its closing quote.
 */
const assignment =
  /(?<![\p{L}\p{N}_.-])([\p{L}_][\p{L}\p{N}_.-]{0,63})(["']?[ \t]*[:=][ \t]*)("[^"\n]{1,4096}"|'[^'\n]{1,4096}'|[^\s"',;&}\])]{1,4096})/gu;

export interface Redacted {
  readonly text: string;
  /** How many values each rule replaced. Never the values or anything derived from them. */
  readonly counts: Readonly<Record<string, number>>;
}

/** Deterministic and idempotent: redacting redacted text changes nothing. */
export function redactText(text: string): Redacted {
  const counts: Record<string, number> = {};
  const count = (label: string) => {
    counts[label] = (counts[label] ?? 0) + 1;
    return marker(label);
  };
  let out = text;
  for (const { label, pattern } of shapes) out = out.replace(pattern, () => count(label));
  out = out.replace(assignment, (whole, name: string, separator: string, value: string) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
    const bare = quote === "" ? value : value.slice(1, -1);
    if (bare.startsWith("[redacted:") || !isCredentialName(name)) return whole;
    return `${name}${separator}${quote}${count(assignmentLabel)}${quote}`;
  });
  return { text: out, counts };
}

/** The known shapes left in text that must be published as it is: a patch, test ids, sources. */
export function secretShapes(text: string): readonly string[] {
  return [
    ...new Set(
      shapes.filter(({ pattern }) => new RegExp(pattern).test(text)).map((one) => one.label),
    ),
  ];
}

/** How many markers of each label the published diagnostics carry. */
export function redactionRecord(texts: readonly string[]): {
  readonly policy: string;
  readonly markers: Readonly<Record<string, number>>;
} {
  const markers: Record<string, number> = {};
  for (const text of texts)
    for (const found of text.matchAll(/\[redacted:([a-z-]+)\]/g)) {
      const label = found[1] ?? "";
      markers[label] = (markers[label] ?? 0) + 1;
    }
  return { policy: redactionPolicy, markers };
}
