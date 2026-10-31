import type { ArtifactCategory } from "../config/swarm-toml.ts";

/**
 * Every path a candidate changes is a candidate artifact: source, tests, manifests, lockfiles,
 * configuration and CI files may change together. The category says which runs a change
 * affects (a test file's base version still judges the candidate; a lockfile's change prepares
 * the candidate's dependencies afresh); it never refuses the change by itself.
 */
export interface ChangedArtifact {
  readonly path: string;
  readonly category: ArtifactCategory | "source";
}

const lockfiles = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);
const manifests = new Set(["package.json", "pyproject.toml", "Pipfile", "Cargo.toml", "go.mod"]);
const testDirectories = new Set(["test", "tests", "__tests__", "spec", "specs", "testing"]);
const testConfig =
  /^(?:(?:jest|vitest|mocha|karma|playwright|cypress|ava)\.config\.[cm]?[jt]s|\.mocharc\.[a-z]+|pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|noxfile\.py)$/;
const testFile =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.py$|_test\.go$|Test\.java$|_spec\.rb$)/;
const ciFiles = new Set([".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "Jenkinsfile"]);
const ciDirectories = [".github/", ".circleci/", ".buildkite/"];
// Files that change how a check's Node or Python processes start, and so what loads first.
const startupFiles = /^(?:\.npmrc|\.yarnrc(?:\.yml)?|sitecustomize\.py|usercustomize\.py|.*\.pth)$/;

/** The category of a candidate artifact, or null for source. */
export function categoryOf(path: string): ArtifactCategory | null {
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  if (path === "swarm.toml" || path.startsWith(".swarm/") || startupFiles.test(name))
    return "config";
  if (ciFiles.has(path) || ciDirectories.some((prefix) => path.startsWith(prefix))) return "ci";
  if (lockfiles.has(name)) return "lockfiles";
  if (manifests.has(name)) return "manifests";
  if (testConfig.test(name) || testFile.test(name)) return "tests";
  if (segments.slice(0, -1).some((segment) => testDirectories.has(segment))) return "tests";
  return null;
}

export function artifactsOf(paths: readonly string[]): ChangedArtifact[] {
  return paths.map((path) => ({ path, category: categoryOf(path) ?? "source" }));
}
