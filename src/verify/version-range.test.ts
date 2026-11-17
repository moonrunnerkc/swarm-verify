import { describe, expect, it } from "vitest";
import { type Ecosystem, highestWithin, parseVersionRange, place } from "./version-range.ts";

const placed = (version: string, range: string, ecosystem: Ecosystem) => {
  const parsed = parseVersionRange(range, ecosystem);
  if (parsed === null) throw new Error(`${range} did not parse`);
  return place(version, parsed);
};
const within = (version: string, range: string, ecosystem: Ecosystem = "npm") =>
  placed(version, range, ecosystem) === "within";
const pypi = (version: string, range: string) => within(version, range, "pypi");

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
    expect(pypi("2.1.0rc1", "2.x")).toBe(false);
  });

  it("compares PyPI versions of any length by their numbers", () => {
    expect(pypi("2.0", "2.x")).toBe(true);
    expect(pypi("9.2.0", "^9")).toBe(true);
    expect(pypi("1.2.3.4", "~1.2")).toBe(true);
  });

  it("reads every range npm reads, and refuses wording that is no range", () => {
    expect(within("10.4.0", ">=9 <11")).toBe(true);
    expect(within("11.0.0", ">=9 <11")).toBe(false);
    expect(within("1.3.9", "1.2.3 - 1.4")).toBe(true);
    expect(within("1.5.0", "1.2.3 - 1.4")).toBe(false);
    expect(within("2.4.0", "^1 || ^2")).toBe(true);
    for (const ecosystem of ["npm", "pypi"] as const) {
      expect(parseVersionRange("latest", ecosystem)).toBeNull();
      expect(parseVersionRange("nine", ecosystem)).toBeNull();
      expect(parseVersionRange("", ecosystem)).toBeNull();
    }
  });

  it("finds the highest release a range admits, by number and not by text", () => {
    const range = parseVersionRange("9.x", "npm");
    if (range === null) throw new Error("9.x did not parse");
    const versions = ["9.1.0", "9.10.0", "9.6.1", "10.1.1", "9.11.0-rc.1", "9.2.0"];
    expect(highestWithin(versions, range)).toBe("9.10.0");
    expect(highestWithin(["10.0.0"], range)).toBeNull();
  });

  it("says an npm version semver cannot read cannot be judged, rather than outside", () => {
    expect(placed("file:../local", "9.x", "npm")).toEqual({
      unjudged: "file:../local is not a version npm's semver reads",
    });
  });
});

describe("PyPI ranges, by PEP 440", () => {
  it("never takes a fourth release number for the third", () => {
    expect(pypi("1.2.3.4", "==1.2.3")).toBe(false);
    expect(pypi("1.2.3.4", "1.2.3")).toBe(false);
    expect(pypi("1.2.3.0", "==1.2.3")).toBe(true);
  });

  it("normalizes a version before it compares it", () => {
    expect(pypi("1.0.0", "==1.0")).toBe(true);
    expect(pypi("1.0RC1", "==1.0rc1")).toBe(true);
    expect(pypi("1.0-1", "==1.0.post1")).toBe(true);
    expect(pypi("v2.0", "==2")).toBe(true);
  });

  it("orders an epoch before every release number", () => {
    expect(pypi("1!1.0", ">=2.0")).toBe(true);
    expect(pypi("1.0", "<1!1.0")).toBe(true);
    expect(pypi("1!2.0", "==2.*")).toBe(false);
    expect(pypi("1!2.0", "==1!2.*")).toBe(true);
  });

  it("keeps a prerelease out unless the specifier names one", () => {
    expect(pypi("2.0rc1", ">=1.0")).toBe(false);
    expect(pypi("2.0rc1", ">=2.0rc1")).toBe(true);
    expect(pypi("1.5.dev3", ">=1.0")).toBe(false);
    expect(pypi("1.0.dev3", "==1.0.dev3")).toBe(true);
    expect(pypi("1.5rc1", "!=1.4rc1")).toBe(false);
  });

  it("admits a post release where its release is admitted", () => {
    expect(pypi("1.0.post1", ">=1.0")).toBe(true);
    expect(pypi("1.0.post1", "==1.0.*")).toBe(true);
    expect(pypi("1.0.post1", "==1.0")).toBe(false);
  });

  it("compares exclusively as PEP 440 says, by the base release", () => {
    expect(pypi("2.0", ">2.0rc1")).toBe(true);
    expect(pypi("1.7rc1", "<1.7rc2")).toBe(true);
    expect(pypi("1.7.post2", ">1.7.post1")).toBe(true);
    expect(pypi("1.7.post1", ">1.7")).toBe(false);
    expect(pypi("1.7.1", ">1.7")).toBe(true);
    expect(pypi("1.7+local", ">1.7")).toBe(false);
    expect(pypi("1.7rc1", "<1.7,>=1.7rc0")).toBe(false);
  });

  it("ignores a local label except where the specifier has one or is arbitrary", () => {
    expect(pypi("1.0+local", "==1.0")).toBe(true);
    expect(pypi("1.0+local", "===1.0")).toBe(false);
    expect(pypi("1.0", "===1.0")).toBe(true);
    expect(pypi("1.0+local", "==1.0+other")).toBe(false);
    expect(pypi("1.0+local", "==1.0+LOCAL")).toBe(true);
    expect(pypi("1.0+local", ">=1.0")).toBe(true);
    expect(parseVersionRange(">=1.0+local", "pypi")?.range).not.toHaveProperty("sets");
  });

  it("reads ~= as at least that version within its prefix", () => {
    expect(pypi("1.4.5", "~=1.4.5")).toBe(true);
    expect(pypi("1.4.9", "~=1.4.5")).toBe(true);
    expect(pypi("1.4.4", "~=1.4.5")).toBe(false);
    expect(pypi("1.5.0", "~=1.4.5")).toBe(false);
    expect(pypi("1.9", "~=1.4")).toBe(true);
    expect(pypi("2.0", "~=1.4")).toBe(false);
    for (const version of ["1.4.4", "1.4.5", "1.4.5.1", "1.4.6rc1", "1.4.99.post2", "1.5", "2"]) {
      expect(pypi(version, "~=1.4.5")).toBe(pypi(version, ">=1.4.5,==1.4.*"));
    }
    // PEP 440 has no ~= of one number; npm reads it as ~1, which is no PEP 440 reading.
    expect(placed("1.5", "~=1", "pypi")).toMatchObject({ unjudged: expect.any(String) });
  });

  it("matches a prefix with the candidate's release padded with zeros", () => {
    expect(pypi("1", "==1.0.*")).toBe(true);
    expect(pypi("1.2.7", "==1.2.*")).toBe(true);
    expect(pypi("1.20", "==1.2.*")).toBe(false);
    expect(pypi("1.3", "!=1.2.*")).toBe(true);
    expect(pypi("1.2.0", "!=1.2.*")).toBe(false);
  });

  it("reads a comma as every clause holding, and || as any alternative", () => {
    expect(pypi("1.5", ">=1.4,<2,!=1.5")).toBe(false);
    expect(pypi("1.6", ">= 1.4, < 2, != 1.5")).toBe(true);
    expect(pypi("2.4", "^1 || ^2")).toBe(true);
    expect(pypi("3.0", "^1 || ^2")).toBe(false);
  });

  it("defines the request's npm-style forms on PEP 440 versions", () => {
    expect(pypi("9.6.1.2", "9.x")).toBe(true);
    expect(pypi("2024.1.3", "2024.1")).toBe(true);
    expect(pypi("2024.10", "2024.1")).toBe(false);
    expect(pypi("9.9.post1", "^9.6.1")).toBe(true);
    expect(pypi("10.0rc1", "^9.6.1")).toBe(false);
    expect(pypi("0.3.9", "^0.3.1")).toBe(true);
    expect(pypi("0.4", "^0.3.1")).toBe(false);
    expect(pypi("9.6.9.1", "~9.6")).toBe(true);
    expect(pypi("9.7", "~9.6.1")).toBe(false);
    expect(pypi("5.0", "*")).toBe(true);
    expect(pypi("5.0rc1", "*")).toBe(false);
  });

  it("cannot judge a version PEP 440 does not read, and says so", () => {
    expect(placed("2.x-custom", ">=1", "pypi")).toEqual({
      unjudged:
        "2.x-custom is not a PEP 440 version, so it cannot be judged within >=1: resolve a release PEP 440 reads, or judge it by a check",
    });
  });

  it("keeps npm grammar PEP 440 does not define readable, and judges nothing by it", () => {
    const range = parseVersionRange(">=9 <11", "pypi");
    if (range === null) throw new Error(">=9 <11 did not parse");
    const placement = place("10.0", range);
    expect(placement).toMatchObject({ unjudged: expect.stringContaining("such as >=9,<11") });
    expect(highestWithin(["10.0"], range)).toBeNull();
  });

  it("finds the highest final release by PEP 440's order", () => {
    const range = parseVersionRange(">=1", "pypi");
    if (range === null) throw new Error(">=1 did not parse");
    expect(highestWithin(["1.10", "1.9", "1.10rc1", "1.10.post1", "bogus"], range)).toBe(
      "1.10.post1",
    );
    expect(highestWithin(["2.0rc1"], range)).toBeNull();
  });
});
