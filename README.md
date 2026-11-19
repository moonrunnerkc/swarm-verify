# Swarm Verify

[![npm](https://img.shields.io/npm/v/swarm-verify)](https://www.npmjs.com/package/swarm-verify)
[![ci](https://github.com/moonrunnerkc/swarm-verify/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/moonrunnerkc/swarm-verify/actions/workflows/ci.yml)

Swarm Verify checks a software change against the project's own tests and the requirements you
declare for it, and records signed evidence of what it measured. It is for teams and tools that
need to know whether a change from a person or a coding agent did what was asked without breaking
anything, and to keep a record that anyone can check later.

Each run applies the change to a clean checkout of its base commit, runs the project's checks at
the base and on the change, compares them test by test, and decides each requirement from that
executed evidence. The result says whether the task is `complete`, `incomplete` or `blocked`,
why, and how the checks were contained. The evidence is a signed, tamper-evident bundle that can
be validated offline and replayed.

Swarm Verify is a standalone verifier with a CLI, a Node API, a GitHub Action and an MCP server.
It is not a coding agent, it uses no language model, and it does not prove a change correct: it
reports what the project's checks showed.

## What you can use it for

- Check a branch, commit range or patch before you merge it, including changes written by an agent.
- Gate pull requests in CI on regressions and declared requirements.
- Keep signed evidence of what was run, where and with what result, and validate it offline.
- Replay a recorded verification later and see whether the same checks still agree.

## Prerequisites

- **Node.js 22.13.0 or newer.** CI installs the packed package on exactly 22.13.0; 22.12.0 cannot
  load it.
- **Git**, and a repository whose base commit is present locally.
- **Docker**, for the default isolated mode. The daemon must enforce memory, swap and CPU limits;
  a daemon that cannot is reported as `blocked` and nothing runs.
- **Platforms:** tested on Linux x64 (GitHub-hosted Ubuntu runners) and on macOS arm64 with
  Docker in a VM (colima). Windows is not tested.
- **Signing** needs no setup for a local run: the key in `SWARM_SIGNING_KEY` signs, otherwise one
  kept in the macOS keychain or the Linux Secret Service, otherwise a new key for that run.
  Keyless signing in GitHub Actions needs `id-token: write`; the Action installs cosign.

Host execution (`--isolation host`) runs the checks directly on your machine as your user. It
exists for projects that cannot run in a container. It is never used unless you ask for it, it
is reported as `host, not isolated`, and it has no memory or CPU bounds.

## Quickstart

This builds a small repository with a known bug and a fix, then verifies the fix. It needs Node,
Git and a running Docker daemon. The first run pulls a pinned `node:24` image.

1. Create the base commit. It holds the bug and a test that reports it:

```sh
mkdir swarm-quickstart && cd swarm-quickstart
git init -q -b main
git config user.name "Quickstart"
git config user.email "quickstart@example.invalid"
cat > package.json <<'JSON'
{ "name": "quickstart", "private": true, "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > add.js <<'JS'
export const add = (a, b) => a - b;
JS
cat > add.test.js <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./add.js";
test("adds zero", () => assert.equal(add(2, 0), 2));
test("adds two numbers", () => assert.equal(add(2, 3), 5));
JS
git add . && git commit -q -m "Report the add() bug with a failing test"
```

2. Commit the candidate change on a branch:

```sh
git switch -q -c fix
cat > add.js <<'JS'
export const add = (a, b) => a + b;
JS
git commit -q -am "Fix add()"
```

3. Declare what the change must do, outside the repository, so the change cannot edit it:

```sh
cat > ../requirements.json <<'JSON'
[
  {
    "id": "R1",
    "text": "add(a, b) returns the sum of a and b",
    "source": "user",
    "kind": "fix",
    "evidence": { "tests": [{ "name": "adds two numbers" }] }
  }
]
JSON
```

4. Verify the change from `main` to `fix`. The project has no dependencies to install:

```sh
npx --yes swarm-verify@3.1.0 verify --range main..fix --requirements ../requirements.json \
  --dependencies none --out ../evidence
```

The verifier clones `main` into a temporary checkout, runs `npm run test` there in a container
with the network closed, applies the change, runs the test again, and compares the two runs. The
evidence goes to `../evidence`, which must not exist yet or be empty. An abridged excerpt of a
real run, with long lines shortened (your commit and run IDs will differ):

```text
state        complete
requirement  R1 satisfied (add(a, b) returns the sum of a and b)
regression   none
check        test: pass (npm run test, pre-existing)
baseline     0 of 1 check(s) pass at the base commit
mutation     killed: + to - at add.js:1
execution    isolated: docker node:24@sha256:e7add2a4..., network closed for checks and open only
             while dependencies were prepared; memory 4096 MiB with no swap and 2 CPUs, per container
delivery     signed (run 2026-11-19T19-15-09-542Z-2e29d614654e)
```

The command exits 0 because the task is complete. R1 is satisfied because a test that existed
before the change failed at the base and passes with it.

5. Check the evidence. `replay` authenticates the bundle against a public key you trust, then
runs the verification again and compares every result:

```sh
npx --yes swarm-verify@3.1.0 replay ../evidence --key ../evidence/attestation.pub.pem
```

Here you can trust `attestation.pub.pem` because your own machine just produced it. Evidence from
someone else is only as trustworthy as the key or signing identity you already trust for them.
To validate the signature, the file digests and the recorded state without running anything,
use `verify.mjs` from an installed copy of the package:

```sh
npm install --prefix ../tools swarm-verify@3.1.0
node ../tools/node_modules/swarm-verify/verify.mjs ../evidence/attestation.sigstore.json \
  --key ../evidence/attestation.pub.pem --patch ../evidence/change.patch --evidence ../evidence
```

For your own project, run `npx swarm-verify init` to write a `swarm.toml` from its scripts, then
`npx swarm-verify verify --range <base>..<branch>`. `verify --preflight` shows what a run would
do without running any of the project's commands.

## Reading the result

A result keeps three answers apart:

- **Task acceptance** (`state`). `complete` means at least one check ran against a measured base
  and passed, nothing regressed or stayed unresolved, the execution policy was met, and every
  required requirement is `satisfied`. `incomplete` means something failed or could not be
  established. `blocked` means the run could not happen as asked: no checks, dependencies that
  would not install, or isolation or resource limits that could not be enforced.
- **Execution assurance** (`execution`). Whether the checks ran in an isolated container or on
  the host, with which image, network and per-container memory and CPU bounds.
- **Evidence integrity** (`integrity`, `delivery`). Whether the statement was signed and by
  which key, and whether the evidence was written as required: `signed`, `unsigned` (only with
  `--allow-unsigned`) or `failed`.

A requirement is `satisfied` only on executed evidence that the change itself did not choose: a
pre-existing test, a check you supply, or a sealed held-out check. A requirement witnessed only
by tests the change added is `unverified`, as is one whose evidence did not run; one whose
evidence ran and failed is `failed`. A check whose output cannot be parsed, or that ran out of
memory, is unresolved, never a pass. A run with no requirements declared covers regressions only
and says so; it is not evidence that requested work was done.

A delivery failure (exit 7) means the evidence was not published as required, whatever the task
state: a required signature failed, or credential-shaped content remained in evidence that is
kept exactly as measured.

Exit codes of `verify` and `ci`: `0` complete, `1` incomplete with a failure, `4` incomplete with
something unverified or unresolved, `5` blocked, `7` evidence not delivered, `2` unreadable
command line, `3` cancelled. The codes for `verify.mjs` and `replay` are listed with the
[full result reference](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/verifying.md#exit-codes).

## GitHub Actions

A workflow that verifies each pull request against its base branch and signs the evidence
keylessly with the workflow's own identity:

```yaml
name: swarm-verify
on:
  pull_request:
permissions:
  contents: read
  id-token: write # keyless signing
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          fetch-depth: 0 # the base commit must be present
      - uses: moonrunnerkc/swarm-verify@v3
        with:
          sigstore: "true"
```

The Action builds the verifier from this repository at the ref you name, runs `ci` against the
pull request's base in a container, installs dependencies from the lockfile, writes the result
to the job summary and uploads the evidence as a workflow artifact. The step fails on any exit
code but 0. Useful inputs:

| Input | Default | Purpose |
| --- | --- | --- |
| `requirements` | none | JSON array of requirements; without one the run covers regressions only |
| `memory-mib`, `cpus` | `4096`, `2` | per-container bounds |
| `isolation` | `isolated` | `host` runs on the runner, unbounded and reported as not isolated |
| `dependencies` | `prepare` | `none` installs nothing |
| `allow-unsigned` | `false` | accept evidence whose signature failed, delivered as `unsigned` |

Pull request code runs in the job, so use the `pull_request` event, not `pull_request_target`,
and give the job no secrets it does not need. A `requirements` file read from the checkout comes
from the pull request, so review changes to it like any other change. Keyless signing needs an
OIDC token for the job: where the job cannot obtain one, signing fails and the step exits 7
unless `allow-unsigned` is `"true"`. Without `sigstore`, the run is signed with a key you pass
from a secret in the `SWARM_SIGNING_KEY` environment variable, or else with a key made for that
run, which identifies no one. `v3` follows the latest 3.x release; pin a full tag or commit SHA
where you need an exact verifier. All inputs and outputs are in
[`action.yml`](https://github.com/moonrunnerkc/swarm-verify/blob/main/action.yml).

## From code

The package exports the same verifier as a Node API. Run this beside `swarm-quickstart` and
`requirements.json` from the quickstart, after `npm install swarm-verify@3.1.0`:

```js
// verify-fix.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requestVersion, verifierVersion, verify } from "swarm-verify";

const repository = resolve("swarm-quickstart");
const commit = (ref) =>
  execFileSync("git", ["rev-parse", ref], { cwd: repository, encoding: "utf8" }).trim();

const result = await verify(
  {
    version: requestVersion,
    repository,
    base: { commit: commit("main") },
    candidate: { kind: "commit", commit: commit("fix") },
    requirements: JSON.parse(readFileSync("requirements.json", "utf8")),
    policy: { execution: { mode: "isolated", dependencies: "none" } },
    artifacts: { directory: resolve("api-evidence") },
  },
  { verifierVersion },
);
console.log(result.state, result.delivery.status);
```

`node verify-fix.mjs` prints `complete signed`. The request and result schemas are exported as
`verifyRequestSchema` and `verifyResultSchema`.

## Limits and trust

- Evidence is tamper-evident, not tamper-proof. A valid signature shows that the evidence has not
  changed since a key or identity signed it. It does not show that the code is correct, that the
  tests are complete, or that nothing unobserved happened.
- Trust in a signer comes from your own policy. A public key shipped beside a bundle identifies
  no one unless you already trust that key from elsewhere.
- Logs are redacted before they are hashed and signed. Redaction catches known credential
  formats and values assigned to credential-like names; a secret in any other form passes
  through, so keep real credentials out of what checks print.
- Memory and CPU bounds apply to each container separately. Concurrent containers and
  concurrent runs can together use more of the host.
- Code under test runs in the same process as its test framework and can interfere with it.
  Sealed held-out checks and checks you supply reduce what a change can influence.

[What runs and where its reach ends](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/verifying.md#limitations)
covers the rest.

## Changes in 3.1

- Isolated containers are bounded by default to 4096 MiB of memory, no swap and 2 CPUs. Set
  `--memory-mib` and `--cpus`, the Action's `memory-mib` and `cpus`, or
  `policy.execution.resources` to change them.
- Limits that cannot be enforced block the run before anything executes. A check killed at the
  memory limit is left unmeasured, so the run is not complete.
- Memory and CPU settings together with host execution are rejected.
- Credential-shaped content left in evidence that must be kept as measured, such as the patch or a
  test name, stops publication (exit 7), including with `--allow-unsigned`.
- A recording made by 3.0.0 replays under the current default bounds, and the difference is
  reported as environment drift.

Details and the full history are in the
[changelog](https://github.com/moonrunnerkc/swarm-verify/blob/main/CHANGELOG.md).

## Documentation

- [Verifying a change](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/verifying.md):
  what runs, result fields, requirements, redaction, replay, offline checks, exit codes, limits.
- [Integrations](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/integrations.md):
  the command line, other CI systems, pre-commit, MCP, agent hooks and the API.
- [Capabilities](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/capabilities.md):
  what is supported for Node, Python, Go and other projects.
- [Moving from 2.x to 3.0](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/migration-3.md)
  and [from 1.x to 2.0](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/migration-2.md).
- [Design decisions](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/DECISIONS.md).

## Support and contributing

Report defects and ask questions in
[GitHub issues](https://github.com/moonrunnerkc/swarm-verify/issues). The rules every change to
this repository follows are in
[AGENTS.md](https://github.com/moonrunnerkc/swarm-verify/blob/main/AGENTS.md).

## License

ISC. See [LICENSE](https://github.com/moonrunnerkc/swarm-verify/blob/main/LICENSE).
