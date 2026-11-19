# Swarm Verify

Measure a candidate change against a project's own checks and declared requirements, in a clean
checkout of its base, test by test, and sign what was measured as an in-toto Statement in a DSSE
envelope. It works on a change from any source: the Swarm Orchestrator coding agent, another
agent, or a person. It needs no model and imports none.

```sh
npx swarm-verify verify                           # the working tree against HEAD
npx swarm-verify verify --range main..feature     # a branch's change
npx swarm-verify verify --patch change.diff       # a patch against HEAD (or --base)
npx swarm-verify ci --base origin/main            # HEAD against a pull request's base
npx swarm-verify verify --preflight               # what a run would do, running nothing of the project's
npx swarm-verify init                             # write swarm.toml from the project's scripts
npx swarm-verify replay <evidence-dir> --key <trusted.pub.pem>   # authenticate, rerun and compare
```

## What a result says

Every run returns one result (`--json` prints it as `swarm-verify.result/v2`) with these answers
kept apart:

| Field | What it says |
| --- | --- |
| `state` | `complete`, `incomplete` or `blocked` |
| `requirements` | each declared requirement as `satisfied`, `failed`, `unverified` or `blocked`, with the evidence that decided it |
| `regression` | `none`, `found` or `unresolved`: the candidate against the base, test by test where a runner's report was read |
| `checks` | every check that ran, with its authority: `pre-existing`, `user-acceptance`, `independently-generated` or `implementation-authored` |
| `execution` | how the checks were contained, with the per-container memory and CPU bounds the container's cgroup applied; a host run says `host, not isolated` and is not bounded |
| `integrity` | whether the statement was signed, and by which key |
| `delivery` | whether the evidence reached its directory as required: `signed`, `unsigned` (only with `--allow-unsigned`) or `failed` |
| `evidence` | the run's own directory, its `runId` and the `manifest.json` that binds every file of the run |

`complete` means at least one check ran against a measured base and held, every required
requirement is satisfied by executed evidence with a decisive witness its implementation did not
choose, nothing regressed or stayed unresolved, and the execution policy was met. The rule is
versioned (`swarm-verify.acceptance/v1`, recorded in each statement) and is the same code in the
verifier and in `verify.mjs`. With no requirements declared, the result says it covers
regressions only: that is not completion of requested work. Unverified is never satisfied, and
zero collected tests, a malformed report or an unmeasured base is never a pass.

When isolation is requested and the container cannot be made (no daemon, an image that will not
pull, a refused policy), the run is `blocked` and nothing the project declares is run: no setup,
no install, no check. Host execution happens only when it is asked for by name.

Exit codes of `verify` and `ci`:

| Code | Meaning |
| --- | --- |
| 0 | complete |
| 1 | incomplete: something failed (a regression, a failing requirement, a change that does not apply) |
| 2 | a command line it cannot read |
| 3 | cancelled |
| 4 | incomplete: something stayed unverified or unresolved, and nothing failed |
| 5 | blocked: no checks, dependencies that would not prepare, or an execution policy it cannot meet |
| 7 | the evidence was not delivered as required: a required signature or the publication failed, whatever the state |

Precedence: 2, then 3, then 7, then the state's own code. Each run is written to its own
directory (`.swarm/verify/<run>` by default); a directory that already holds a run is never
written over, so a failed or concurrent run can never leave another run's bundle looking like its
own. `--preflight` prints the plan (candidate, checks and the runner that judges each, image,
setup, stages, signer, what is missing) and exits 0, or 5 where something is missing.

## Checking a result offline

`verify.mjs` ships with the package and needs nothing but Node. It checks the signature, the
subject digests of the files you name, and re-derives the recorded state from the recorded
evidence. Integrity and acceptance are separate answers:

```sh
node verify.mjs attestation.sigstore.json --key attestation.pub.pem --patch change.patch
```

| Code | Meaning |
| --- | --- |
| 0 | integrity holds and the task is accepted |
| 1 | integrity holds and the task is not accepted |
| 6 | integrity fails, including a recorded state the recorded evidence does not support |
| 2 | a command line it cannot read |

`--integrity-only` skips the acceptance answer. A signature is tamper-evident evidence against
the key you trust; it does not prove the code is correct, the tests comprehensive, or that
nothing unobserved happened, and a public key shipped beside a bundle is not by itself a trusted
identity. `verify.mjs` also refuses a record it cannot judge (an acceptance policy it does not
implement, a requirement ID or check name given twice) and a requirement recorded satisfied that
its evidence does not support. cosign checks the same key-signed bundle:
`cosign verify-blob-attestation --key attestation.pub.pem --bundle attestation.sigstore.json --type https://github.com/moonrunnerkc/swarm-verify/result/v1 --insecure-ignore-tlog change.patch`
(the bundle carries no transparency-log entry, hence the flag).

## Replaying a result

`replay` runs a recorded verification again and compares every observation both ways. It first
authenticates the bundle against the signer you trust, and nothing in the bundle (its commands,
paths or policy) is read before that:

```sh
swarm-verify replay <evidence-dir> --key trusted.pub.pem
swarm-verify replay <evidence-dir> --certificate-identity <id> --certificate-oidc-issuer <url>
```

A recording made on the host replays on this host only with `--allow-host`; the recording's own
setting is not that permission. "Latest" constraints are judged from the registry answers the
recording kept; `currentRegistries` in the API revalidates against today's registries instead.
Exit 0 agrees, 1 diverges, 5 could not run, 6 the bundle was not authenticated. Toolchain or
platform differences are reported as environment drift, apart from divergences.

## As a library

```ts
import { requestVersion, snapshotWorkingTree, verify } from "swarm-verify";

const candidate = await snapshotWorkingTree(repo, "HEAD", "/tmp/candidate.patch");
const result = await verify(
  {
    version: requestVersion,
    repository: repo,
    base: { commit: candidate.baseCommit },
    candidate: { kind: "patch", path: candidate.path, sha256: candidate.sha256 },
    requirements: [
      {
        id: "R1",
        text: "half(n) returns n / 2",
        source: "user",
        kind: "fix",
        evidence: { tests: [{ name: "half positive" }] },
      },
    ],
    policy: { execution: { mode: "host", network: "open", dependencies: "linked" } },
    artifacts: { directory: "/tmp/evidence" },
  },
  { verifierVersion: "3.0.0" },
);
```

The request and result schemas are exported (`verifyRequestSchema`, `verifyResultSchema`).
`swarm-verify/execution` exports the child-environment builder, the process-group runner and the
credential detector the verifier runs checks with.

## GitHub Action

```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
  with:
    fetch-depth: 0
- uses: moonrunnerkc/swarm-verify@v3
  id: verify
```

The Action builds the verifier from this repository at the ref you name and runs `ci` against
the pull request's base. Inputs: `base`, `isolation`, `dependencies`, `requirements`, `sigstore`
(keyless signing with the workflow's identity; the job needs `id-token: write`),
`allow-unsigned` (default `false`: a failed signature fails the step), `upload-evidence` (default
`true`) and `authorize-behavior-change` (default `false`), which lets a test the base passes
change its expectation where the change witnesses the new behavior, and records that it did.
Outputs: `state`, `delivery`, `run-id`, `evidence-directory`, `manifest`, `patch-sha256` and
`exit-code`. Run it in a workflow that does not hand pull-request code secrets
(`pull_request`, not `pull_request_target`).
[docs/integrations.md](docs/integrations.md) covers other CI systems, pre-commit and MCP;
[docs/verifying.md](docs/verifying.md) says what runs and where its reach ends.
[docs/capabilities.md](docs/capabilities.md) says what is supported per ecosystem.
[docs/migration-3.md](docs/migration-3.md) lists what changed from 2.x, and
[docs/migration-2.md](docs/migration-2.md) what changed from 1.x.

## Releases

A full version tag (`v3.0.0`) on `main` runs the release workflow: the gates, a check that the tag
matches `package.json`, then `npm publish` through npm trusted publishing. The workflow holds no
npm token; npm accepts the job's GitHub OIDC token and records a provenance statement naming this
repository, the workflow and the commit. Where the version is already on the registry, it packs
the tag instead and fails unless the pack's integrity equals the registry's. 2.0.1 was published
from a workstation and carries no provenance; 2.0.2 is the first release published by the
workflow. `v3` is the Action alias: it is moved to each 3.x release so
`moonrunnerkc/swarm-verify@v3` follows the major version, and it is not a release tag; pushing it
publishes nothing. `v2` stays at 2.1.0. Pin a full tag or a commit where you need the exact verifier.

## Ownership

This repository owns the verifier: source, tests, build, releases and the Action. Swarm
Orchestrator, the coding agent, consumes it at an exact version through the API above. Report a
defect at [this repository's issues](https://github.com/moonrunnerkc/swarm-verify/issues).

Node 22.13 or newer and git. ISC licensed; see [LICENSE](LICENSE).
