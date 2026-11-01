import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

const read = (dir: string, name: string) => readFile(join(dir, name), "utf8").catch(() => null);

/** The lines of one INI section, from its header to the next. */
function section(text: string, names: readonly string[]): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => names.includes(line.trim().toLowerCase()));
  if (at < 0) return "";
  const end = lines.findIndex((line, index) => index > at && /^\s*\[/.test(line));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}

const truthy = /^\s*parallel\s*=\s*(true|1|yes|on)\s*$/im;
const pytestCov = /--cov\b/;

/**
 * Why the verifier's own coverage run cannot wrap a project's tests, or null where it can: the
 * project measures coverage itself, with pytest-cov in its pytest options, or with coverage.py in
 * parallel mode, which refuses the appended data file the wrapper writes. Its checks then run as
 * declared, and changed-line coverage is unmeasured.
 */
export async function ownCoverage(dir: string): Promise<string | null> {
  const say = (how: string) =>
    `the project measures coverage itself (${how}), which a second coverage run would break`;
  let addopts = "";
  let parallel = false;
  const pyproject = await read(dir, "pyproject.toml");
  if (pyproject !== null) {
    try {
      const parsed = parseToml(pyproject) as {
        tool?: {
          pytest?: { ini_options?: { addopts?: unknown } };
          coverage?: { run?: { parallel?: unknown } };
        };
      };
      const options = parsed.tool?.pytest?.ini_options?.addopts;
      addopts += Array.isArray(options) ? options.join(" ") : String(options ?? "");
      parallel ||= parsed.tool?.coverage?.run?.parallel === true;
    } catch {
      // A pyproject.toml that does not parse is the project's to report; it decides nothing here.
    }
  }
  for (const [name, pytest, coverage] of [
    ["pytest.ini", ["[pytest]"], []],
    ["tox.ini", ["[pytest]"], ["[coverage:run]"]],
    ["setup.cfg", ["[tool:pytest]"], ["[coverage:run]"]],
    [".coveragerc", [], ["[run]"]],
  ] as const) {
    const text = await read(dir, name);
    if (text === null) continue;
    addopts += ` ${section(text, pytest)}`;
    parallel ||= truthy.test(section(text, coverage));
  }
  if (pytestCov.test(addopts)) return say("pytest-cov in its pytest options");
  if (parallel) return say("coverage.py in parallel mode");
  return null;
}
