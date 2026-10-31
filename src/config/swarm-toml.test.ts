import { describe, expect, it } from "vitest";
import { MalformedSwarmTomlError, parseSwarmToml } from "./swarm-toml.ts";

describe("swarm.toml", () => {
  it("reads checks and the allowance, and leaves the agent's table to the agent", () => {
    const parsed = parseSwarmToml(
      [
        "[checks]",
        'test = "npm test"',
        'unit = { command = "node --test", kind = "test" }',
        'lint = "npm run lint"',
        "[protect]",
        'allow = ["tests"]',
        "[agent]",
        'endpoint = "http://localhost:11434/v1"',
        'api_key_env = "OPENAI_API_KEY"',
        "max_steps = 40",
        'anything_the_agent_adds = "later"',
      ].join("\n"),
      "swarm.toml",
    );
    expect(parsed.checks.map((check) => [check.name, check.kind])).toEqual([
      ["test", "test"],
      ["unit", "test"],
      ["lint", "other"],
    ]);
    expect(parsed.allow).toEqual(["tests"]);
    expect(parsed).not.toHaveProperty("agent");
  });

  it("refuses a table it does not know", () => {
    expect(() => parseSwarmToml('[checkz]\ntest = "npm test"', "swarm.toml")).toThrow(
      MalformedSwarmTomlError,
    );
  });

  it("names the line of broken TOML", () => {
    expect(() => parseSwarmToml("[checks\n", "swarm.toml")).toThrow(/line 1/);
  });
});
