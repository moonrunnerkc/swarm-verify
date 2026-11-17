import { describe, expect, it } from "vitest";
import { listed, pypiName, resolvedVersions } from "./lock-resolutions.ts";

const reading = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe("the versions a lockfile resolves a name to", () => {
  it("normalizes a PyPI name as PEP 503 does", () => {
    expect(pypiName("Foo_Bar.baz")).toBe("foo-bar-baz");
    expect(pypiName("foo--bar__baz")).toBe("foo-bar-baz");
  });

  it("reads every npm resolution, nested ones included, each once", async () => {
    const lock = JSON.stringify({
      packages: {
        "": { name: "app" },
        "node_modules/semver": { version: "7.6.0" },
        "node_modules/make-dir/node_modules/semver": { version: "6.3.1" },
        "node_modules/other/node_modules/semver": { version: "6.3.1" },
        "node_modules/not-semver": { version: "1.0.0" },
        "node_modules/linked": { link: true },
      },
    });
    const read = reading({ "package-lock.json": lock });
    expect(await resolvedVersions(read, { name: "semver", ecosystem: "npm" })).toEqual([
      "7.6.0",
      "6.3.1",
    ]);
    expect(await resolvedVersions(read, { name: "linked", ecosystem: "npm" })).toEqual([]);
  });

  it("reads every uv.lock entry of the name, by its PEP 503 form", async () => {
    const lock = [
      "version = 1",
      '[[package]]\nname = "numpy"\nversion = "1.26.4"',
      '[[package]]\nname = "NumPy"\nversion = "2.1.0"',
      '[[package]]\nname = "numpy-financial"\nversion = "1.0.0"',
    ].join("\n\n");
    const read = reading({ "uv.lock": lock });
    expect(await resolvedVersions(read, { name: "numpy", ecosystem: "pypi" })).toEqual([
      "1.26.4",
      "2.1.0",
    ]);
    expect(await resolvedVersions(reading({}), { name: "numpy", ecosystem: "pypi" })).toEqual([]);
  });

  it("names versions as a detail reads them", () => {
    expect(listed([])).toBe("nothing");
    expect(listed(["1.0"])).toBe("1.0");
    expect(listed(["1.0", "2.0"])).toBe("1.0 and 2.0");
    expect(listed(["1.0", "1.1", "2.0"])).toBe("1.0, 1.1 and 2.0");
  });
});
