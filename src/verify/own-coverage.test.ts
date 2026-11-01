import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownCoverage } from "./own-coverage.ts";

const project = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), "own-coverage-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
};

describe("a project that measures coverage itself", () => {
  it("is found through pytest-cov in its pytest options or coverage.py's parallel mode", async () => {
    // tracemantle: addopts runs pytest-cov, and [tool.coverage.run] sets parallel.
    const tracemantle = await project({
      "pyproject.toml":
        '[tool.pytest.ini_options]\naddopts = "--cov=tracemantle --cov-report=term-missing"\n\n[tool.coverage.run]\nparallel = true\n',
    });
    expect(await ownCoverage(tracemantle)).toBe(
      "the project measures coverage itself (pytest-cov in its pytest options), which a second coverage run would break",
    );
    const parallel = await project({ ".coveragerc": "[run]\nbranch = True\nparallel = True\n" });
    expect(await ownCoverage(parallel)).toBe(
      "the project measures coverage itself (coverage.py in parallel mode), which a second coverage run would break",
    );
    const ini = await project({ "pytest.ini": "[pytest]\naddopts = -q --cov src\n" });
    expect(await ownCoverage(ini)).toContain("pytest-cov in its pytest options");
  });

  it("is not found where the project leaves coverage alone", async () => {
    const plain = await project({
      "pyproject.toml":
        '[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.coverage.run]\nbranch = true\n',
    });
    expect(await ownCoverage(plain)).toBeNull();
    expect(await ownCoverage(await project({}))).toBeNull();
  });
});
