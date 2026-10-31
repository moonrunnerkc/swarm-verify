import { describe, expect, it } from "vitest";
import { crossings, extraDependencies, forbiddenImporters } from "./build.mjs";

describe("what the verifier's build refuses", () => {
  it("refuses the agent loop, its chokepoint and model client, and an agent entry", () => {
    expect(
      crossings([
        "cli-verify.js",
        "verify/verify.js",
        "agent/loop.js",
        "tools/chokepoint.js",
        "core/model-client.js",
        "cli.js",
        "cli-run.js",
      ]),
    ).toEqual([
      "agent/loop.js",
      "tools/chokepoint.js",
      "core/model-client.js",
      "cli.js",
      "cli-run.js",
    ]);
  });

  it("refuses a module that imports a model client, whatever its path", () => {
    expect(
      forbiddenImporters([
        ["verify/verify.js", 'import { z } from "zod";'],
        ["verify/sneaky.js", 'import OpenAI from "openai";'],
        ["verify/also.js", 'import { generateText } from "ai";'],
      ]),
    ).toEqual(["verify/sneaky.js", "verify/also.js"]);
  });

  it("refuses runtime dependencies beyond zod and smol-toml", () => {
    expect(extraDependencies({ dependencies: { zod: "1", "smol-toml": "1" } })).toEqual([]);
    expect(extraDependencies({ dependencies: { zod: "1", openai: "1" } })).toEqual(["openai"]);
  });
});
