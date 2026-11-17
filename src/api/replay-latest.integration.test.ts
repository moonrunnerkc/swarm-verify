import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureSigner, halfTest, probeFixture } from "../probes/fixture.ts";
import { replay } from "./replay.ts";
import { requestVersion } from "./request.ts";
import { snapshotWorkingTree, verify } from "./verify.ts";

let server: Server;
let registry = "";
let listed = ["1.0.0", "1.1.0"];
beforeAll(async () => {
  server = createServer((request, response) => {
    const known = request.url === "/leftpad";
    response.writeHead(known ? 200 : 404, { "content-type": "application/json" });
    response.end(
      JSON.stringify(known ? { versions: Object.fromEntries(listed.map((one) => [one, {}])) } : {}),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

const lock = (version: string) =>
  `${JSON.stringify({ name: "p", lockfileVersion: 3, packages: { "": { name: "p" }, "node_modules/leftpad": { version } } })}\n`;

// U4 (2026-11-17 review): a "latest" constraint was judged by whatever the registry said when the
// replay ran, so a replay after a new release could not reproduce the recorded decision.
describe("replaying a decision that read the registry's latest", () => {
  it("reproduces it from the recorded answers, and revalidates only when asked", async () => {
    const probe = await probeFixture({
      "half.mjs": "export const half = n => n / 2;\n",
      "test/half.test.mjs": halfTest,
      "package-lock.json": lock("1.0.0"),
    });
    await probe.put("package-lock.json", lock("1.1.0"));
    const out = join(probe.home, "recorded");
    await mkdir(probe.home, { recursive: true });
    const snapshot = await snapshotWorkingTree(probe.repo, "HEAD", join(probe.home, "c.patch"));
    const requirement = {
      id: "R1",
      text: "upgrade leftpad to the latest 1.x",
      source: "user" as const,
      kind: "upgrade" as const,
      versions: [
        {
          name: "leftpad",
          ecosystem: "npm" as const,
          range: "1.x",
          latest: true,
          wording: "the latest 1.x",
        },
      ],
    };
    const result = await verify(
      {
        version: requestVersion,
        repository: probe.repo,
        base: { commit: snapshot.baseCommit },
        candidate: { kind: "patch", path: snapshot.path, sha256: snapshot.sha256 },
        requirements: [requirement],
        policy: { execution: { mode: "host", network: "open", dependencies: "none" } },
        artifacts: { directory: out },
      },
      {
        verifierVersion: "probe",
        swarmHome: probe.home,
        registries: { npm: registry, pypi: registry },
      },
    );
    const constraint = (refs: readonly { kind: string; outcome: string }[] | undefined) =>
      refs?.find((one) => one.kind === "package")?.outcome;
    expect(constraint(result.requirements[0]?.evidence)).toBe("observed");

    listed = ["1.0.0", "1.1.0", "1.2.0"];
    const options = (currentRegistries: boolean) => ({
      repository: probe.repo,
      out: join(probe.home, `replay-${currentRegistries}`),
      verifierVersion: "probe",
      swarmHome: probe.home,
      signer: fixtureSigner(),
      allowHost: true,
      currentRegistries,
      registries: { npm: registry, pypi: registry },
    });
    const reproduced = await replay(dirname(result.evidence.bundle ?? ""), options(false));
    expect(constraint(reproduced.replayed.requirements[0]?.evidence)).toBe("observed");
    expect(reproduced.divergences).toEqual([]);

    const revalidated = await replay(dirname(result.evidence.bundle ?? ""), options(true));
    expect(constraint(revalidated.replayed.requirements[0]?.evidence)).toBe("fail");
    expect(revalidated.divergences.join("\n")).toMatch(/requirement R1/);
  });
});
