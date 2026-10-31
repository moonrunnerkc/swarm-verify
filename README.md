# Swarm Verify

An agent says the work is done. Swarm Verify checks what was actually measured.

It runs a project's own checks the way a CI job would, records what ran, and reports apart
what passed, what failed, what could not be trusted and what nobody measured. It works on a
change from any source: Swarm Orchestrator, Claude Code, Codex, Copilot, another agent or a
person. No model, no API key and no configuration are needed for any verification path.

```sh
npx swarm-verify
```

Run that in a git repository whose dependencies are installed (`npm ci`, `pnpm install
--frozen-lockfile` or `uv sync`; it names the missing step and exits 4 when they are not). It
reads the checks the project declares, runs them unattended, and prints its conclusions. A
failed check exits 1 and names the check. A check whose result cannot be trusted, such as a
pass reported by a test configuration the change itself edited, exits 4 and says why. A pass
with no requirement contract is a regression-only pass, and the result line says so.

It creates no configuration file and keeps its evidence outside the repository, under
`~/.swarm/sessions` by default. While it runs it briefly adds, then removes, its own
`swarm-falsification-bond.*` fixtures to show each passing check can fail, and the project's
own commands may write build output or caches as they always do.

## What it reports, apart

One run never collapses into one word. Every report separates these answers, and
`unmeasured` is an answer of its own that never renders as a pass.

| Answer | What it says | What it does not say |
| --- | --- | --- |
| command execution | whether each declared check actually ran, with its exit code and output recorded | that the check was the right one |
| regression | whether any check fails because of the change; a failure the base already had, in the same tests the same way, is shown as inherited and not counted | that every check passed, or that the task was done |
| task acceptance | whether a requirement contract or an acceptance command you supplied says the work was done | anything, when no contract was supplied: it reads `unmeasured` |
| challenge coverage | whether the contract's checks could have caught wrong work: a base control per requirement, mechanical mutations of the changed lines witnessed by the suite, sealed fixtures, named missing obligations | that the code is semantically correct |
| execution trust | how the commands were contained: host with a built environment and no credentials, or a measured container | that the host run was a sandbox; it is a policy |
| integrity | that the evidence bundle's hash chain, blobs and recorded verdicts are intact and re-derive | who produced it |
| signer identity | whether the bundle or verdict was signed by the key or workflow you expected | that the signer ran the right checks |

Integrity is not correctness. Tests passing is not task completion. Deterministic is not
correct. Signed is not trustworthy execution. Unmeasured is not passed.

## The commands

```sh
swarm-verify                                   # check the current directory (the same as `check`)
swarm-verify check [--explain] [--json]        # plan or run the declared checks unattended
swarm-verify ci --patch <file> | --branch <ref> | --pr <owner/repo#n>
                [--goal-contract <file>] [--challenges off|report|required]
swarm-verify verify <bundle> [--signer <fp>]   # check a bundle, and who signed it
swarm-verify verdict <verdict.json> [--repo <owner/repo>] [--signer-workflow <ref>] [--head <sha>]
swarm-verify gates [--workspace <dir>]         # run a workspace's gates and bond each pass
swarm-verify hook | mcp | pre-commit           # the editor, MCP and git integrations
```

`check` discovers the declared checks from the manifests (npm or pnpm scripts; configured
pytest, Ruff and mypy; a declared formatter), runs them with no terminal on stdin and `CI=true`
in the child environment, and reports the answers above. `--explain` prints the plan and runs
nothing; `--json` prints one `swarm.check.v1` object.

`ci` verifies a change in a fresh checkout of its base: exactly one of a patch file, a branch
or a GitHub pull request. The working tree, index and branch are never touched. It answers
`regression` and `task` apart. With a goal contract, `--challenges` asks whether the
contract's checks could have caught wrong work; `report` records the findings, `required`
refuses on a gap, `off` asks nothing.

`verify` checks an evidence bundle: the chain, every blob, every recorded verdict and the
signature, then judges the signer against the fingerprint you name. `verdict` binds a signed
verdict document to the report, summary and bundle beside it, then hands the signer question to
`gh attestation verify` against Sigstore's public trust root; it never reimplements that check.

Exit codes: 0 acceptable, 1 not acceptable, 2 an unreadable command line, 3 cancelled, 4
incomplete or unavailable, 5 internal error. A missing prerequisite, an ambiguous workspace, a
watch-mode test script, a directory with no manifest and a suite that collected nothing are all
4, each with the exact next step.

## In CI

One job, one Action, the permissions a signed comment needs
([the complete workflow](https://github.com/moonrunnerkc/swarm-verify/blob/main/examples/swarm-verification.yml)):

```yaml
name: swarm-verify
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
  id-token: write
  attestations: write
  artifact-metadata: write
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: moonrunnerkc/swarm-verify@v1
        with:
          install: true # install from the lockfile, scripts off, then run skipped scripts offline; omit for a project with no dependencies
```

The Action fetches the pull request's head and base by commit id into a checkout it owns, runs
the checks in a network-disabled container, signs the verdict as a GitHub artifact attestation,
and posts one comment bound to the head that says what was measured and what was not. Forks
and Dependabot have
[a documented trusted route](https://github.com/moonrunnerkc/swarm-verify/blob/main/examples/swarm-verification-forks.yml).
Every input, every output and how to verify a signed verdict from outside the run are in
[the Action reference](https://github.com/moonrunnerkc/swarm-verify/blob/main/docs/action.md).
Pin by full commit SHA where immutability matters: `moonrunnerkc/swarm-verify@<sha> # v1.x.y`.

## From an editor or a git hook

Three thin clients of the same verifier, none of which carries verification logic of its own:

```sh
npx swarm-verify hook install          # Claude Code: route the agent's test command through check
npx swarm-verify mcp --root .          # an MCP server over stdio with three bounded tools
npx swarm-verify pre-commit install    # verify the staged tree before each commit
```

With the pre-commit framework, use `repo: https://github.com/moonrunnerkc/swarm-verify` with
`rev: v1.2.0` or later and the hook id `swarm-verify`.

## Checking evidence without this package

Every run exports a bundle carrying its own dependency-free verifier. `node <bundle>/verify.mjs
<bundle>` checks the chain, the signature and every recorded verdict with nothing installed,
on any machine with Node. The committed demonstration verifies a bundle, flips one byte of one
record, and is refused with the broken link named:

![A bundle verifies, one byte is changed, and the verifier refuses it with the broken link named](https://raw.githubusercontent.com/moonrunnerkc/swarm-orchestrator/v13-main/docs/evidence/2026-09-27/verifier-first/tamper-demo.gif)

That recording shows integrity. Who signed the bundle, and whether the checks it records
measured the right thing, are the separate answers above.

## What it does not establish

- That the work is correct. A requirement contract defines scope, its checks are evidence, a
  challenge asks whether a check could fail, and a signature says who produced a bundle.
- That the host run was isolated. Locally, commands run on the host with a built environment
  and no credentials, which is a policy and not a sandbox; the Action's container is measured
  per run and `--isolation` asks for one locally.
- That it catches more wrong work than another tool. No completed comparison supports that
  claim; the comparative study and its result are recorded with the source.
- That secrets are removed from evidence. Known credential patterns are scrubbed by name and
  shape; that is known-pattern scrubbing, not secret removal.

## Requirements

Node 22 or newer and git; `uv` for a Python project. Every measurement runs on Node 22.8 or
newer; on 22.0 to 22.7 the changed-line coverage measurement reports unmeasured by name. Linux
and macOS run every command; Windows runs bundle and verdict verification.

## Ownership

Swarm Verify is the standalone verifier and this repository owns it: the source, tests, build,
releases and this Action ([ADR 0015 in Swarm Orchestrator](https://github.com/moonrunnerkc/swarm-orchestrator/blob/v13-main/docs/adr/0015-coding-agent-consumes-standalone-verifier.md)).
[Swarm Orchestrator](https://github.com/moonrunnerkc/swarm-orchestrator) is the coding agent; it
consumes this package at an exact version through its public API, and nothing of the agent is
installed with this package or needed by it. The verifier imports no model client.

Until the 2.0.0 source lands here, the Action installs the published `swarm-verify@1.3.1`,
pinned by integrity in the lockfile and built from the commit named in [SOURCE.json](SOURCE.json).
Releases are independent of the agent's; the verifier's changes are in [CHANGELOG.md](CHANGELOG.md).
Report a defect at [this repository's issues](https://github.com/moonrunnerkc/swarm-verify/issues).
