import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";

export const swarmTomlFileName = "swarm.toml";

/** What a protected-path allowance can name. */
export const protectedCategories = ["tests", "ci", "lockfiles", "manifests", "config"] as const;
export type ProtectedCategory = (typeof protectedCategories)[number];

const nonEmpty = z.string().min(1);
const positive = z.number().int().positive();

const fileSchema = z.strictObject({
  checks: z
    .record(
      nonEmpty,
      z.union([
        nonEmpty,
        z.strictObject({ command: nonEmpty, kind: z.enum(["test", "other"]).optional() }),
      ]),
    )
    .optional(),
  protect: z.strictObject({ allow: z.array(z.enum(protectedCategories)).optional() }).optional(),
  verify: z
    .strictObject({ setup: nonEmpty.optional(), timeout_minutes: positive.optional() })
    .optional(),
  // The coding agent's own table. The verifier never reads it, and leaves validating it to the agent.
  agent: z.record(z.string(), z.unknown()).optional(),
});

export interface DeclaredCheck {
  readonly name: string;
  readonly command: string;
  readonly kind: "test" | "other";
  /** Who stands behind it; the base's own declared checks are pre-existing. */
  readonly authority?: "pre-existing" | "user-acceptance" | "independently-generated";
}

export interface SwarmToml {
  readonly checks: readonly DeclaredCheck[];
  readonly allow: readonly ProtectedCategory[];
  readonly setup: string | null;
  readonly timeoutMinutes: number;
}

export class MalformedSwarmTomlError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} cannot be used: ${detail}. Fix the file or delete it.`);
    this.name = "MalformedSwarmTomlError";
  }
}

export function parseSwarmToml(text: string, source: string): SwarmToml {
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    const where = error instanceof TomlError ? ` at line ${error.line}` : "";
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    throw new MalformedSwarmTomlError(source, `its TOML syntax is broken${where}: ${message}`);
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new MalformedSwarmTomlError(source, `${path || "the file"}: ${issue?.message ?? ""}`);
  }
  const raw = parsed.data;
  return {
    checks: Object.entries(raw.checks ?? {}).map(([name, entry]) => {
      const command = typeof entry === "string" ? entry : entry.command;
      const declared = typeof entry === "string" ? undefined : entry.kind;
      return { name, command, kind: declared ?? (name === "test" ? "test" : "other") };
    }),
    allow: raw.protect?.allow ?? [],
    setup: raw.verify?.setup ?? null,
    timeoutMinutes: raw.verify?.timeout_minutes ?? 20,
  };
}

/** The workspace's swarm.toml, or null where it has none. */
export async function readSwarmToml(workspace: string): Promise<SwarmToml | null> {
  const path = join(workspace, swarmTomlFileName);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  return parseSwarmToml(text, path);
}
