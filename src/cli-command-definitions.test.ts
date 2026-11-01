import { describe, expect, it } from "vitest";
import { commandDefinitions } from "./cli-command-definitions.ts";
import { sharedOptions } from "./cli-verify.ts";

describe("the help the commands print", () => {
  // `--authorize-behavior-change` was accepted by verify and ci but named in neither line.
  it("names every option verify and ci accept", () => {
    for (const name of ["verify", "ci"]) {
      const syntax = commandDefinitions.find((one) => one.name === name)?.syntax ?? "";
      for (const option of Object.keys(sharedOptions)) {
        if (option === "workspace") continue;
        expect(syntax, `${name} --${option}`).toContain(`--${option}`);
      }
    }
  });
});
