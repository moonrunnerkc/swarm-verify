import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChange } from "./change.ts";

describe("snapshotting a working tree", () => {
  it("works where the repository ignores the verifier's .swarm directory", async () => {
    // git 2.51 and later refuse an add pathspec that names an ignored path; the review saw it
    // on 2.51.1 and it reproduces on 2.54.0.
    const repo = await mkdtemp(join(tmpdir(), "change-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    await writeFile(join(repo, ".gitignore"), ".swarm/\n");
    await writeFile(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    await mkdir(join(repo, ".swarm", "verify"), { recursive: true });
    await writeFile(join(repo, ".swarm", "verify", "attestation.sigstore.json"), "{}\n");
    await writeFile(join(repo, "a.txt"), "b\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    const change = await resolveChange(repo, { kind: "working-tree", base: "HEAD" });
    const patch = change.patch.toString();
    expect(patch).toContain("+++ b/a.txt");
    expect(patch).toContain("+++ b/new.txt");
    expect(patch).not.toContain(".swarm");
  });

  it("leaves a .swarm directory out even where the repository does not ignore it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "change-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    await writeFile(join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    await mkdir(join(repo, ".swarm"), { recursive: true });
    await writeFile(join(repo, ".swarm", "x.json"), "{}\n");
    await writeFile(join(repo, "a.txt"), "b\n");
    const patch = (
      await resolveChange(repo, { kind: "working-tree", base: "HEAD" })
    ).patch.toString();
    expect(patch).toContain("+++ b/a.txt");
    expect(patch).not.toContain(".swarm");
  });
});
