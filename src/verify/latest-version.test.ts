import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestTargets, targetKey } from "./latest-version.ts";

let server: Server;
let base = "";
const asked: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    asked.push(`${request.url} ${request.headers.accept ?? ""}`);
    const bodies: Record<string, unknown> = {
      "/@stryker-mutator%2fcore": {
        versions: { "9.5.1": {}, "9.6.0": {}, "9.6.1": {}, "10.0.0": {}, "10.1.1": {} },
      },
      "/pypi/pytest/json": {
        releases: {
          "9.0.2": [{ yanked: false }],
          "9.2.0": [{ yanked: false }],
          "9.3.0": [{ yanked: true }],
          "9.4.0rc1": [{ yanked: false }],
          "9.5.0": [],
        },
      },
    };
    const body = bodies[request.url ?? ""];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const constraint = (name: string, ecosystem: "npm" | "pypi", range: string) => ({
  name,
  ecosystem,
  range,
  latest: true,
  wording: `the latest ${range}`,
});

describe("the latest version a range admits", () => {
  it("reads npm's abbreviated metadata and takes the highest release in the range", async () => {
    const wanted = constraint("@stryker-mutator/core", "npm", "9.x");
    const targets = await latestTargets([wanted], { npm: base, pypi: base });
    const target = targets.get(targetKey(wanted));
    expect(target?.version).toBe("9.6.1");
    expect(target?.source).toBe(`${base}/@stryker-mutator%2fcore`);
    expect(asked.some((line) => line.includes("application/vnd.npm.install-v1+json"))).toBe(true);
  });

  it("leaves out yanked and fileless PyPI releases and prereleases", async () => {
    const wanted = constraint("pytest", "pypi", "9.x");
    const target = (await latestTargets([wanted], { npm: base, pypi: base })).get(
      targetKey(wanted),
    );
    expect(target?.version).toBe("9.2.0");
  });

  it("records why no version was resolved, rather than guessing one", async () => {
    const missing = constraint("no-such-package", "npm", "1.x");
    const empty = constraint("@stryker-mutator/core", "npm", "11.x");
    const targets = await latestTargets([missing, empty], { npm: base, pypi: base });
    expect(targets.get(targetKey(missing))?.version).toBeNull();
    expect(targets.get(targetKey(missing))?.detail).toMatch(/404/);
    expect(targets.get(targetKey(empty))?.detail).toMatch(/no release within 11\.x/);
  });

  it("asks nothing for a constraint that does not ask for the latest", async () => {
    const before = asked.length;
    const pinned = { ...constraint("@stryker-mutator/core", "npm", "9.6.1"), latest: false };
    expect((await latestTargets([pinned], { npm: base, pypi: base })).size).toBe(0);
    expect(asked.length).toBe(before);
  });
});
