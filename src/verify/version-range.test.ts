import { describe, expect, it } from "vitest";
import { highestWithin, parseVersionRange, satisfies } from "./version-range.ts";

const within = (version: string, range: string) => {
  const parsed = parseVersionRange(range);
  if (parsed === null) throw new Error(`${range} did not parse`);
  return satisfies(version, parsed);
};

describe("version ranges", () => {
  it("reads a major written with x as every release of that major", () => {
    expect(within("9.6.1", "9.x")).toBe(true);
    expect(within("9.0.0", "9")).toBe(true);
    expect(within("10.1.1", "9.x")).toBe(false);
    expect(within("8.9.9", "9.*")).toBe(false);
  });

  it("reads a caret and a tilde as npm does", () => {
    expect(within("9.7.0", "^9.6.1")).toBe(true);
    expect(within("9.6.0", "^9.6.1")).toBe(false);
    expect(within("10.0.0", "^9")).toBe(false);
    expect(within("0.3.9", "^0.3.1")).toBe(true);
    expect(within("0.4.0", "^0.3.1")).toBe(false);
    expect(within("9.6.9", "~9.6")).toBe(true);
    expect(within("9.7.0", "~9.6.1")).toBe(false);
  });

  it("reads three numbers as that version and no other", () => {
    expect(within("4.1.10", "4.1.10")).toBe(true);
    expect(within("4.1.11", "4.1.10")).toBe(false);
    expect(within("4.1.10", "v4.1.10")).toBe(true);
  });

  it("keeps prereleases out of a range, as npm does", () => {
    expect(within("9.7.0-beta.1", "9.x")).toBe(false);
    expect(within("2.1.0rc1", "2.x")).toBe(false);
  });

  it("compares PyPI versions of any length by their numbers", () => {
    expect(within("2.0", "2.x")).toBe(true);
    expect(within("9.2.0", "^9")).toBe(true);
    expect(within("1.2.3.4", "~1.2")).toBe(true);
  });

  it("reads every range npm reads, and refuses wording that is no range", () => {
    expect(within("10.4.0", ">=9 <11")).toBe(true);
    expect(within("11.0.0", ">=9 <11")).toBe(false);
    expect(within("1.3.9", "1.2.3 - 1.4")).toBe(true);
    expect(within("1.5.0", "1.2.3 - 1.4")).toBe(false);
    expect(within("2.4.0", "^1 || ^2")).toBe(true);
    expect(parseVersionRange("latest")).toBeNull();
    expect(parseVersionRange("nine")).toBeNull();
    expect(parseVersionRange("")).toBeNull();
  });

  it("finds the highest release a range admits, by number and not by text", () => {
    const range = parseVersionRange("9.x");
    if (range === null) throw new Error("9.x did not parse");
    const versions = ["9.1.0", "9.10.0", "9.6.1", "10.1.1", "9.11.0-rc.1", "9.2.0"];
    expect(highestWithin(versions, range)).toBe("9.10.0");
    expect(highestWithin(["10.0.0"], range)).toBeNull();
  });
});
