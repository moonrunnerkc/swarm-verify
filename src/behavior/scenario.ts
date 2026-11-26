/**
 * The trusted driver of a behavior check: it sends the HTTP requests a scenario names to a
 * running target and reports, case by case, whether the responses are the expected ones. It
 * runs in a process and a filesystem the target cannot reach, so what it prints is its own
 * reading of the responses and never the target's word. It imports nothing outside Node, since
 * it is copied on its own into the container that runs it.
 */

interface ScenarioRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface ScenarioStep {
  readonly request: ScenarioRequest;
  readonly times: number;
  readonly waitMs: number;
  readonly expect: {
    readonly status: readonly number[];
    readonly count?: { readonly min: number; readonly max: number } | undefined;
    readonly otherwise: readonly number[];
    readonly json: readonly {
      readonly path: string;
      readonly equals?: unknown;
      readonly delta?: { readonly of: string; readonly by: number } | undefined;
    }[];
    readonly bodyIncludes: readonly string[];
    readonly bodyExcludes: readonly string[];
  };
  readonly capture: Readonly<Record<string, string>>;
}

export interface Scenario {
  readonly ready: { readonly path: string; readonly timeoutMs: number };
  readonly cases: readonly { readonly name: string; readonly steps: readonly ScenarioStep[] }[];
}

export interface CaseResult {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface ScenarioResult {
  /** Whether the target answered at all before its time ran out. */
  readonly ready: boolean;
  readonly cases: readonly CaseResult[];
}

type Variables = Record<string, string>;

const requestTimeoutMs = 15_000;

const fill = (text: string, variables: Variables) =>
  text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => variables[name] ?? whole);

/** A value at a dotted path of parsed JSON; undefined where the path leads nowhere. */
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".").filter((part) => part.length > 0)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface Answer {
  readonly status: number;
  readonly text: string;
}

async function send(
  base: string,
  request: ScenarioRequest,
  variables: Variables,
): Promise<Answer | string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = fill(value, variables);
  let body: string | undefined;
  if (request.body !== undefined) {
    body = fill(
      typeof request.body === "string" ? request.body : JSON.stringify(request.body),
      variables,
    );
    if (typeof request.body !== "string" && headers["content-type"] === undefined)
      headers["content-type"] = "application/json";
  }
  try {
    const response = await fetch(`${base}${fill(request.path, variables)}`, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const listed = (values: readonly number[]) => values.join(" or ");
const excerpt = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}...` : text);

/** Why a step's answers are not the expected ones, or null where they are. */
function judged(
  step: ScenarioStep,
  answers: readonly Answer[],
  variables: Variables,
): string | null {
  const { expect } = step;
  const matching = answers.filter((answer) => expect.status.includes(answer.status));
  const others = answers.filter((answer) => !expect.status.includes(answer.status));
  if (expect.count === undefined) {
    const wrong = others[0];
    if (wrong !== undefined)
      return `expected status ${listed(expect.status)}, got ${wrong.status} (${excerpt(wrong.text)})`;
  } else {
    const { min, max } = expect.count;
    if (matching.length < min || matching.length > max)
      return `of ${answers.length} requests sent at once, ${matching.length} got status ${listed(expect.status)}; expected ${min === max ? `exactly ${min}` : `${min} to ${max}`} (statuses: ${answers.map((answer) => answer.status).join(", ")})`;
    const stray = others.find((answer) => !expect.otherwise.includes(answer.status));
    if (expect.otherwise.length > 0 && stray !== undefined)
      return `a request beyond the allowed ones got status ${stray.status}; expected ${listed(expect.otherwise)}`;
  }
  const first = matching[0] ?? answers[0];
  if (first === undefined) return "no request was sent";
  for (const text of expect.bodyIncludes)
    if (!first.text.includes(fill(text, variables)))
      return `the response does not hold ${JSON.stringify(text)} (${excerpt(first.text)})`;
  for (const text of expect.bodyExcludes)
    if (first.text.includes(fill(text, variables)))
      return `the response holds ${JSON.stringify(text)}, which it must not`;
  const json = parsed(first.text);
  for (const claim of expect.json) {
    const found = at(json, claim.path);
    if (claim.delta !== undefined) {
      const from = Number(variables[claim.delta.of]);
      if (Number(found) !== from + claim.delta.by)
        return `${claim.path} is ${JSON.stringify(found)}; expected ${from + claim.delta.by} (${from} before, changed by ${claim.delta.by})`;
      continue;
    }
    const wanted = typeof claim.equals === "string" ? fill(claim.equals, variables) : claim.equals;
    if (JSON.stringify(found) !== JSON.stringify(wanted))
      return `${claim.path} is ${JSON.stringify(found)}; expected ${JSON.stringify(wanted)}`;
  }
  for (const [name, path] of Object.entries(step.capture)) {
    const found = at(json, path);
    if (found === undefined || found === null)
      return `the response has nothing at ${path} to carry forward as ${name} (${excerpt(first.text)})`;
    variables[name] = typeof found === "string" ? found : JSON.stringify(found);
  }
  return null;
}

async function runCase(base: string, steps: readonly ScenarioStep[]): Promise<string | null> {
  const variables: Variables = {};
  for (const [index, step] of steps.entries()) {
    const where = `step ${index + 1} (${step.request.method} ${step.request.path})`;
    if (step.waitMs > 0) await new Promise((settle) => setTimeout(settle, step.waitMs));
    const sent = await Promise.all(
      Array.from({ length: step.times }, () => send(base, step.request, variables)),
    );
    const failed = sent.find((one) => typeof one === "string");
    if (typeof failed === "string") return `${where}: no response (${failed})`;
    const problem = judged(step, sent as Answer[], variables);
    if (problem !== null) return `${where}: ${problem}`;
  }
  return null;
}

async function answers(base: string, ready: Scenario["ready"]): Promise<boolean> {
  const deadline = Date.now() + ready.timeoutMs;
  for (;;) {
    try {
      await fetch(`${base}${ready.path}`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((settle) => setTimeout(settle, 250));
    }
  }
}

/** Every case of a scenario against the target at `base`, in order, each from fresh variables. */
export async function runScenario(scenario: Scenario, base: string): Promise<ScenarioResult> {
  if (!(await answers(base, scenario.ready))) return { ready: false, cases: [] };
  const cases: CaseResult[] = [];
  for (const one of scenario.cases) {
    const problem = await runCase(base, one.steps);
    cases.push({
      name: one.name,
      status: problem === null ? "pass" : "fail",
      detail: problem ?? "",
    });
  }
  return { ready: true, cases };
}

/** The name the driver is copied under; run by that name, it reads a scenario and prints its result. */
export const driverName = "behavior-driver";

// `node behavior-driver.mjs <scenario.json> <base url>` prints the result as one JSON line.
const [, entry, file, base] = process.argv;
if (entry?.includes(driverName) && file !== undefined && base !== undefined) {
  const { readFileSync } = await import("node:fs");
  const result = await runScenario(JSON.parse(readFileSync(file, "utf8")) as Scenario, base);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
