import { describe, expect, it } from "vitest";
import { containerRun, defaultImages, type Sandbox } from "./sandbox.ts";

const sandbox: Sandbox = {
  image: defaultImages.node,
  scratch: "/s/run",
  readOnly: ["/s/run/judge"],
  hidden: ["/s/run/tree/.git"],
  cache: "/home/u/.swarm/cache",
  user: "501:20",
};
const args = (stage: "prepare" | "check", network?: "open" | "closed") =>
  containerRun(sandbox, {
    command: "npm test",
    cwd: "/s/run/tree",
    env: { CI: "true" },
    stage,
    ...(network === undefined ? {} : { network }),
  }).args;

describe("the container a command runs in", () => {
  it("runs a check with no network, the judge read-only and the git directory hidden", () => {
    const run = args("check");
    expect(run.slice(run.indexOf("--network"), run.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(run).toContain("type=bind,src=/s/run/judge,dst=/s/run/judge,readonly");
    expect(run).toContain("type=tmpfs,dst=/s/run/tree/.git");
    expect(run.join(" ")).not.toContain("/swarm-cache");
    expect(run.slice(-4)).toEqual([defaultImages.node, "/bin/sh", "-c", "npm test"]);
  });

  it("opens the network and mounts the dependency cache only while dependencies are prepared", () => {
    const run = args("prepare");
    expect(run).toContain("bridge");
    expect(run).toContain("type=bind,src=/home/u/.swarm/cache,dst=/swarm-cache");
  });

  it("opens the network for a check only where the policy records it, without the cache", () => {
    const run = args("check", "open");
    expect(run).toContain("bridge");
    expect(run.join(" ")).not.toContain("/swarm-cache");
  });

  it("never mounts the docker socket, the home directory or anything outside the run", () => {
    const sources = args("prepare")
      .filter((arg) => arg.startsWith("type=bind"))
      .map((arg) => /src=([^,]+)/.exec(arg)?.[1]);
    expect(sources).toEqual(["/s/run", "/s/run/judge", "/home/u/.swarm/cache"]);
    expect(args("check").join(" ")).not.toMatch(/docker\.sock|\/Users\/|\.ssh|\.aws/);
  });

  it("pins every default image by digest", () => {
    for (const image of Object.values(defaultImages))
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
