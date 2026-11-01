import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  livesIn,
  parseGoJson,
  parseJestJson,
  parseJunit,
  parseMochaJson,
  parseReport,
  titleSelects,
} from "./test-report.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "reports", name), "utf8");

describe("reading recorded reports", () => {
  const statuses = (report: Record<string, { status: string }> | null) =>
    Object.fromEntries(Object.entries(report ?? {}).map(([id, entry]) => [id, entry.status]));

  it("reads pytest's junit XML", () => {
    const report = parseJunit(fixture("pytest-base.xml"));
    expect(statuses(report)).toEqual({
      "tests.test_calc.TestCalc::test_stays": "pass",
      "tests.test_calc.TestCalc::test_fixed": "fail",
      "tests.test_calc.TestCalc::test_broken": "pass",
      "tests.test_calc.TestCalc::test_red": "fail",
      "tests.test_calc.TestCalc::test_gone": "pass",
    });
    expect(report?.["tests.test_calc.TestCalc::test_red"]?.file).toBe("tests/test_calc/TestCalc");
  });

  it("reads jest's and vitest's JSON with paths from the checkout root and suites as in junit", () => {
    for (const name of ["jest-head.json", "vitest-head.json"]) {
      const report = parseJestJson(fixture(name), "/work/calc");
      expect(statuses(report)).toEqual({
        "test/calc.test.js::calc > stays": "pass",
        "test/calc.test.js::calc > fixed": "pass",
        "test/calc.test.js::calc > broken": "fail",
        "test/calc.test.js::calc > red": "fail",
        "test/calc.test.js::calc > added": "pass",
      });
      expect(report?.["test/calc.test.js::calc > red"]?.file).toBe("test/calc.test.js");
    }
  });

  it("drops the empty suite title vitest gives a file's top level", () => {
    const report = parseJestJson(
      JSON.stringify({
        testResults: [
          {
            name: "/work/calc/test/cli.test.ts",
            assertionResults: [
              { title: "parses", ancestorTitles: ["", "parseArgs"], status: "passed" },
            ],
          },
        ],
      }),
      "/work/calc",
    );
    expect(Object.keys(report ?? {})).toEqual(["test/cli.test.ts::parseArgs > parses"]);
  });

  it("reads mocha's JSON, the suites apart from the test's own title", () => {
    expect(statuses(parseMochaJson(fixture("mocha-base.json"), "/work/calc"))).toEqual({
      "test/calc.test.js::calc > stays": "pass",
      "test/calc.test.js::calc > fixed": "fail",
      "test/calc.test.js::calc > broken": "pass",
      "test/calc.test.js::calc > red": "fail",
      "test/calc.test.js::calc > gone": "pass",
    });
  });

  it("reads go test -json events, the package standing in only when no test reported", () => {
    const report = parseGoJson(fixture("go-base.jsonl"), "example.com/calc");
    expect(statuses(report)).toEqual({
      "example.com/calc::TestStays": "pass",
      "example.com/calc::TestFixed": "fail",
      "example.com/calc::TestBroken": "pass",
      "example.com/calc::TestRed": "fail",
      "example.com/calc::TestGone": "pass",
    });
    expect(report?.["example.com/calc::TestRed"]?.file).toBe(".");
    const unbuilt =
      '{"Action":"start","Package":"example.com/calc/x"}\n{"Action":"fail","Package":"example.com/calc/x"}\n';
    expect(parseGoJson(unbuilt, "example.com/calc")).toEqual({
      "example.com/calc/x": { status: "fail", file: "x" },
    });
  });

  it("returns null for a report that does not parse", () => {
    expect(parseReport("pytest", "Traceback (most recent call last):", "/", null)).toBeNull();
    expect(parseReport("jest", "{ not json", "/", null)).toBeNull();
    expect(parseReport("mocha", '{"stats":{}}', "/", null)).toBeNull();
    expect(
      parseReport("go", "# example.com/calc\n./calc.go:3: syntax error\n", "/", null),
    ).toBeNull();
  });
});

describe("naming a test", () => {
  it("selects a test by its own title, a suite, or a contiguous run of the path between", () => {
    const title = "walkRepo > options > skips extra directories";
    for (const name of [
      "skips extra directories",
      "walkRepo",
      "options",
      "walkRepo > options > skips extra directories",
      "options > skips extra directories",
      "walkRepo > options",
    ]) {
      expect(titleSelects(title, name)).toBe(true);
    }
    for (const name of [
      "walkRepo > skips extra directories",
      "skips extra",
      "walkRepo options skips extra directories",
      "",
    ]) {
      expect(titleSelects(title, name)).toBe(false);
    }
  });
});

describe("placing a test in a file", () => {
  it("matches each runner's notion of where a test lives", () => {
    expect(livesIn("tests/test_calc/TestCalc", "tests/test_calc.py")).toBe(true);
    expect(livesIn("tests/test_calc", "tests/test_calc.py")).toBe(true);
    expect(livesIn("tests/test_calculus/TestCalc", "tests/test_calc.py")).toBe(false);
    expect(livesIn("test/calc.test.js", "test/calc.test.js")).toBe(true);
    expect(livesIn(".", "calc_test.go")).toBe(true);
    expect(livesIn("pkg/x", "pkg/x/x_test.go")).toBe(true);
    expect(livesIn("pkg", "pkg/x/x_test.go")).toBe(false);
    expect(livesIn(null, "test/calc.test.js")).toBe(false);
  });
});

describe("reading Node's own runner", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="test/broken.test.mjs" classname="test" file="/work/calc/test/broken.test.mjs" failure="test failed">
		<failure type="testCodeFailure" message="test failed">x</failure>
	</testcase>
	<testcase name="half positive" classname="test" file="/work/calc/test/half.test.mjs"/>
	<testsuite name="group" tests="2" failures="0" skipped="1">
		<testcase name="inner ok" classname="test" file="/work/calc/test/half.test.mjs"/>
		<testcase name="skipped one" classname="test" file="/work/calc/test/half.test.mjs">
			<skipped type="skipped" message="true"/>
		</testcase>
	</testsuite>
	<!-- tests 4 -->
</testsuites>`;

  it("names each test by its file and suites, with a file that failed to load as one entry", () => {
    const report = parseReport("node", xml, "/work/calc", null);
    expect(report).toEqual({
      "test/broken.test.mjs::test/broken.test.mjs": {
        status: "fail",
        file: "test/broken.test.mjs",
      },
      "test/half.test.mjs::half positive": { status: "pass", file: "test/half.test.mjs" },
      "test/half.test.mjs::group > inner ok": { status: "pass", file: "test/half.test.mjs" },
      "test/half.test.mjs::group > skipped one": { status: "skip", file: "test/half.test.mjs" },
    });
  });

  it("reads a run that collected nothing as an empty report, not an unreadable one", () => {
    expect(
      parseReport("node", "<testsuites>\n\t<!-- tests 0 -->\n</testsuites>", "/w", null),
    ).toEqual({});
  });
});

describe("reading how many tests a run collected from what it printed", () => {
  it("reads node:test's spec and TAP summaries and pytest's collection line", async () => {
    const { collectedFromOutput } = await import("./test-report.ts");
    expect(collectedFromOutput("ℹ tests 0\nℹ suites 0\n")).toBe(0);
    expect(collectedFromOutput("1..3\n# tests 3\n# pass 3\n")).toBe(3);
    expect(collectedFromOutput("ℹ tests 2\n...\nℹ tests 5\n")).toBe(7);
    expect(collectedFromOutput("collected 12 items\n\n...\n")).toBe(12);
    expect(collectedFromOutput("===== no tests ran in 0.01s =====\n")).toBe(0);
    expect(collectedFromOutput("all good\n")).toBeNull();
  });
});
