import { describe, expect, it } from "vitest";
import { verifyRequestSchema, versionConstraintSchema } from "./request.ts";

const reads = (ecosystem: "npm" | "pypi", range: string) =>
  versionConstraintSchema.safeParse({ name: "pkg", ecosystem, range, wording: range }).success;

describe("a version constraint's range", () => {
  it("accepts the forms the request has always accepted, in either ecosystem", () => {
    for (const range of ["1.2.3", "9", "9.x", "9.6.x", "^9.6.1", "~9.6", ">=9 <11"]) {
      expect(reads("npm", range)).toBe(true);
      expect(reads("pypi", range)).toBe(true);
    }
  });

  it("accepts a PEP 440 specifier set for PyPI only", () => {
    for (const range of [">=1.4,<2", "~=1.4.5,!=1.4.7"]) {
      expect(reads("pypi", range)).toBe(true);
      expect(reads("npm", range)).toBe(false);
    }
    for (const range of ["===1.0", "==1.0+local", "1.0RC1", "1!2.0", "==1.2.*"]) {
      expect(reads("pypi", range)).toBe(true);
    }
  });

  it("refuses wording that is no range, and says where", () => {
    const parsed = versionConstraintSchema.safeParse({
      name: "pkg",
      ecosystem: "pypi",
      range: "latest",
      wording: "the latest",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["range"]);
    expect(reads("npm", "")).toBe(false);
  });
});

describe("a request's names", () => {
  const request = (extra: Record<string, unknown>) =>
    verifyRequestSchema.safeParse({
      version: "swarm-verify.request/v1",
      repository: "/repo",
      base: { commit: "a".repeat(40) },
      candidate: { kind: "commit", commit: "b".repeat(40) },
      policy: { execution: { mode: "host" } },
      artifacts: { directory: "/out" },
      ...extra,
    });
  const requirement = (id: string) => ({ id, text: "x", source: "user", kind: "fix" });
  const check = (name: string) => ({
    name,
    command: "true",
    kind: "test",
    authority: "user-acceptance",
  });

  it("refuses a requirement ID or a check name given twice", () => {
    expect(request({ requirements: [requirement("R1"), requirement("R1")] }).success).toBe(false);
    expect(request({ checks: [check("held"), check("held")] }).success).toBe(false);
    expect(request({ requirements: [requirement("R1"), requirement("R2")] }).success).toBe(true);
  });
});
