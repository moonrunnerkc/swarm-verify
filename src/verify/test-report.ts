import { isAbsolute, relative } from "node:path";
import { z } from "zod";

export const runners = ["pytest", "jest", "vitest", "mocha", "go", "node"] as const;
export type Runner = (typeof runners)[number];

/**
 * Each test's status by id. `file` names where the test lives as closely as the runner says:
 * a repository path for the JavaScript runners, a dotted module path turned into slashes for
 * pytest, the package directory for go.
 */
export const testReportSchema = z.record(
  z.string(),
  z.object({ status: z.enum(["pass", "fail", "skip"]), file: z.string().nullable() }),
);
export type TestReport = z.infer<typeof testReportSchema>;
type Status = TestReport[string]["status"];

/** What one run of a declared check leaves for judging it test by test. */
export const testEvidenceSchema = z.object({
  runner: z.enum(runners).nullable(),
  report: testReportSchema.nullable(),
  /** Why a recognized runner left no report: the command could not run, or it did not parse. */
  unreadable: z.string().nullable(),
  /** What the judge found the code under test changed, or null. */
  judge: z.string().nullable(),
});
export type TestEvidence = z.infer<typeof testEvidenceSchema>;

const rank: Record<Status, number> = { skip: 0, pass: 1, fail: 2 };

function put(report: Record<string, TestReport[string]>, id: string, entry: TestReport[string]) {
  const before = report[id];
  // A test reported twice, as reruns or parametrized ids can be, counts at its worst.
  if (before === undefined || rank[entry.status] > rank[before.status]) report[id] = entry;
}

const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X")
      ? String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      : name.startsWith("#")
        ? String.fromCodePoint(Number(name.slice(1)))
        : (entities[name] ?? whole),
  );

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const one of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[one[1] ?? ""] = decodeEntities(one[2] ?? one[3] ?? "");
  }
  return attributes;
}

/**
 * JUnit XML. pytest names a test `classname::name`; Node's runner gives every test the same
 * classname and the absolute file, so its tests are named `file::suite > test` with the file
 * relative to `root`. Nested suites are read in document order.
 */
export function parseJunit(xml: string, root: string | null = null): TestReport | null {
  if (!/<testsuites?\b/.test(xml)) return null;
  const report: Record<string, TestReport[string]> = {};
  const suites: string[] = [];
  const tags =
    /<testsuite\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<\/testsuite>|<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(tags)) {
    if (match[0].startsWith("</testsuite")) {
      suites.pop();
      continue;
    }
    if (match[0].startsWith("<testsuite")) {
      if (match[2] !== "/") suites.push(attributesOf(match[1] ?? "").name ?? "");
      continue;
    }
    const attributes = attributesOf(match[3] ?? "");
    const name = attributes.name ?? "";
    const classname = attributes.classname ?? "";
    const body = match[4] ?? "";
    const status: Status = /<(?:failure|error)\b/.test(body)
      ? "fail"
      : /<skipped\b/.test(body)
        ? "skip"
        : "pass";
    if (root !== null && attributes.file !== undefined) {
      const file = fromRoot(root, attributes.file);
      const title = [...suites.filter((suite) => suite.length > 0), name].join(" > ");
      put(report, `${file}::${title}`, { status, file });
      continue;
    }
    const file = attributes.file ?? pytestModule(classname || name);
    put(report, classname === "" ? name : `${classname}::${name}`, { status, file });
  }
  return report;
}

/**
 * The file a pytest classname names: its dotted parts up to the last test module
 * (`tests.unit.test_promote.TestScan` is `tests/unit/test_promote.py`), so a test is known by the
 * file it lives in, not by a path no file has. A classname with no test module keeps its parts.
 */
function pytestModule(classname: string): string {
  const parts = classname.split(".");
  let last = -1;
  parts.forEach((part, at) => {
    if (/^test_\w*$|^\w+_test$/.test(part)) last = at;
  });
  return last < 0 ? parts.join("/") : `${parts.slice(0, last + 1).join("/")}.py`;
}

const fromRoot = (root: string, path: string) =>
  isAbsolute(path) ? relative(root, path).split("\\").join("/") : path;

const jestShape = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string().optional(),
      assertionResults: z.array(
        z.object({
          title: z.string(),
          fullName: z.string().nullish(),
          ancestorTitles: z.array(z.string()).optional(),
          status: z.string(),
        }),
      ),
    }),
  ),
});

/** Jest's --json report, which vitest's json reporter also writes. */
export function parseJestJson(text: string, root: string): TestReport | null {
  const parsed = jestShape.safeParse(safeJson(text));
  if (!parsed.success) return null;
  const report: Record<string, TestReport[string]> = {};
  for (const suite of parsed.data.testResults) {
    const file = fromRoot(root, suite.name);
    // A file that failed to load reports no tests; it stands for them as one failing entry.
    if (suite.assertionResults.length === 0 && suite.status === "failed") {
      put(report, file, { status: "fail", file });
    }
    for (const test of suite.assertionResults) {
      // Suites joined as junit joins them, so a test reads the same whichever report it came from.
      const title =
        test.ancestorTitles === undefined
          ? (test.fullName ?? test.title)
          : [...test.ancestorTitles.filter((suite) => suite.length > 0), test.title].join(" > ");
      const status: Status =
        test.status === "passed" ? "pass" : test.status === "failed" ? "fail" : "skip";
      put(report, `${file}::${title}`, { status, file });
    }
  }
  return report;
}

const mochaTest = z.object({
  title: z.string().optional(),
  fullTitle: z.string(),
  file: z.string().optional(),
});

/** Mocha joins the suites and the title with spaces; only the title's own end is certain. */
const mochaTitle = (test: z.infer<typeof mochaTest>): string => {
  const own = test.title;
  if (own === undefined || own === test.fullTitle || !test.fullTitle.endsWith(` ${own}`)) {
    return test.fullTitle;
  }
  return `${test.fullTitle.slice(0, -own.length - 1)} > ${own}`;
};

const mochaShape = z.object({
  passes: z.array(mochaTest),
  failures: z.array(mochaTest),
  pending: z.array(mochaTest),
});

export function parseMochaJson(text: string, root: string): TestReport | null {
  const parsed = mochaShape.safeParse(safeJson(text));
  if (!parsed.success) return null;
  const report: Record<string, TestReport[string]> = {};
  for (const [status, tests] of [
    ["pass", parsed.data.passes],
    ["fail", parsed.data.failures],
    ["skip", parsed.data.pending],
  ] as const) {
    for (const test of tests) {
      const file = test.file === undefined ? null : fromRoot(root, test.file);
      put(report, `${file ?? ""}::${mochaTitle(test)}`, { status, file });
    }
  }
  return report;
}

const goEvent = z.object({
  Action: z.string(),
  Package: z.string().optional(),
  Test: z.string().optional(),
});

/**
 * go test -json events. `module` is the go.mod module path, which turns a package's import
 * path into its directory in the repository.
 */
export function parseGoJson(text: string, module: string | null): TestReport | null {
  const report: Record<string, TestReport[string]> = {};
  const tested = new Set<string>();
  const failedPackages = new Map<string, string>();
  let events = 0;
  for (const line of text.split("\n")) {
    const event = goEvent.safeParse(line.startsWith("{") ? safeJson(line) : null);
    if (!event.success || event.data.Package === undefined) continue;
    events += 1;
    const { Action: action, Package: pkg, Test: test } = event.data;
    if (action !== "pass" && action !== "fail" && action !== "skip") continue;
    const file =
      module === null
        ? pkg
        : pkg === module
          ? "."
          : pkg.startsWith(`${module}/`)
            ? pkg.slice(module.length + 1)
            : pkg;
    if (test === undefined) {
      if (action === "fail") failedPackages.set(pkg, file);
      continue;
    }
    tested.add(pkg);
    put(report, `${pkg}::${test}`, { status: action, file });
  }
  // A package that fails with no test reported failed to build; it stands for its tests.
  for (const [pkg, file] of failedPackages) {
    if (!tested.has(pkg)) put(report, pkg, { status: "fail", file });
  }
  return events === 0 ? null : report;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseReport(
  runner: Runner,
  text: string,
  root: string,
  goModule: string | null,
): TestReport | null {
  if (runner === "pytest") return parseJunit(text);
  if (runner === "node") return parseJunit(text, root);
  if (runner === "go") return parseGoJson(text, goModule);
  if (runner === "mocha") return parseMochaJson(text, root);
  return parseJestJson(text, root);
}

/** Whether a test reported with `file` lives in the repository path `path`. */
export function livesIn(file: string | null, path: string): boolean {
  if (file === null) return false;
  if (path.endsWith("_test.go")) {
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    return file === directory;
  }
  const stem = path.replace(/\.[^./]+$/, "");
  return file === path || file === stem || file.startsWith(`${stem}/`);
}

const summaries: readonly RegExp[] = [
  // node:test's spec and TAP reporters
  /^\u2139 tests (\d+)$/gm,
  /^# tests (\d+)$/gm,
  // pytest: "collected 3 items", and "no tests ran" when it collected none
  /^collected (\d+) items?\b/gm,
];
const nothingCollected = [
  /^=+ no tests ran\b/m,
  /^No tests found, exiting with code/m,
  /^No test files found, exiting with code/m,
  /^\s*0 passing\b/m,
];

/**
 * How many tests a run collected, from the summary its runner printed: the sum where a command
 * ran the runner more than once, 0 where it said it found nothing, null where nothing printed
 * says. The fallback for a check whose runner writes no report the verifier reads.
 */
export function collectedFromOutput(output: string): number | null {
  let total: number | null = null;
  for (const pattern of summaries) {
    for (const match of output.matchAll(pattern)) total = (total ?? 0) + Number(match[1]);
  }
  if (total !== null) return total;
  return nothingCollected.some((pattern) => pattern.test(output)) ? 0 : null;
}
