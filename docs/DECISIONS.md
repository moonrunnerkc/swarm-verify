# Decisions

Open choices made while building Swarm Verify, dated, with the reason. Append only.

## 2026-10-31: ownership

- This repository becomes the verifier's source home (ADR 0015 in Swarm Orchestrator). Until the source moves in, the README says so and the Action keeps installing the published 1.3.1.
- `AGENTS.md` is a link to `CLAUDE.md`, as in the orchestrator, so both agent conventions read one file.

## 2026-10-31: the source moves here

- History came from swarm-orchestrator by `git filter-repo` on a scratch clone, keeping the verifier's paths, then a merge with unrelated histories into this repository: 151 commits since the 2026-10-28 rebuild. Earlier history was under other paths and stays in the orchestrator and its archive.
- The signed predicate is the result model: the API result is the predicate plus integrity, evidence paths and failure output. One typed result model, so the signed record and what callers read cannot disagree. The predicate type becomes `https://github.com/moonrunnerkc/swarm-verify/result/v1`; `verdict/v1` is retired with its `pass`, `fail`, `unmeasured` vocabulary.
- A request with no requirements yields `scope: regression-only`, stated in the text report, so a pass of a pull request without declared requirements is never read as task acceptance.
- No declared or detected checks is `blocked`, not `unmeasured`: a missing prerequisite, not a property of the change.
- Requesting isolated execution is `blocked` until the container backend exists, rather than silently running on the host. Host runs say `host, not isolated` and report an open network.
- Exit codes: 0 complete, 1 failed, 4 unverified or unresolved, 5 blocked; the offline checker uses 6 for an integrity failure and 1 for a valid but not-complete result, so integrity and acceptance never share a zero.
- verify.mjs re-derives the recorded state from the recorded evidence with the same rule; a recorded `complete` that the evidence does not support is an integrity failure.
- The first requirement evaluator maps named tests, named checks and structural claims to statuses; kind-specific witnesses (fail before and pass after, preserved behavior, resolved versions) follow with per-test identities.
- `dependencies: "prepare"` runs the base's declared setup command or the install its lockfile asks for (npm ci, pnpm, yarn, bun, uv sync --frozen); `linked` keeps the old behavior and is never reproducible.
- The Action builds the verifier from this repository at the workflow's ref (`npm ci`, `npm run build`) instead of installing a published version, so `@v2` runs the source at that tag. The 1.x Action reference, the fork example and the recorded demos described commands 2.0 does not have and were removed; they remain in 1.x history.
- Released changelog sections are not path-checked here: they describe releases built from swarm-orchestrator's tree.
- The changelog's `2.0.0 - 2026-10-29` section was tagged `swarm-verify-v2.0.0` in swarm-orchestrator and never reached npm (its release job failed). That tag is left where it is; 2.0.0 will be released from this repository, and its changelog section is rewritten at release to cover what ships.
- devDependencies resolved fresh (biome 2.6.4); biome.json migrated to its schema.

## 2026-10-31: verification semantics

- The eleven review probes are split by where their behavior lives: eight are verifier tests (src/probes/probes.integration.test.ts), and the three that need the agent loop (the empty `double(n)` completion, a correct edit on the last step, a stale attestation) are orchestrator tests. All eight verifier probes failed against the code before this change; the run log records each observation.
- The ignored `.swarm` failure reproduces on git 2.54.0 (Apple Git-157) as on 2.51.1.
- `node --test` reporters go in through `NODE_OPTIONS`, because flags placed after a positional test path are read as file patterns and npm script forwarding appends there. A command with two `node --test` runs is not read test by test, since both would write one report.
- One run model replaces protected paths: obligation (base tests against candidate source), candidate (as delivered), witness (candidate tests against base source). The obligation run happens only when the candidate modified or deleted test files and the witness run only when it added or rewrote some, so a source-only change still costs one candidate run.
- "Removed" blocks: a test file the candidate deleted takes its base tests with it, even when their originals still pass against the candidate, because the delivered tree no longer carries them.
- A check whose collected tests all fail at both commits is `unresolved`, not `inherited-failures`: nothing in it tells the candidate from no change. Zero collected is `no-tests`.
- Relocation is "identical after removing import statements and blank lines", a deterministic rule; a move that also edits test bodies is read as a delete and an add, which blocks, and is listed as a limitation.
- TypeScript mutants are checked with Node's built-in `stripTypeScriptTypes` in transform mode, since `node --check` exits 0 on a broken `.ts` file; JSX and TSX lines are not mutated because nothing here parses them.
- Held-out runs restore only test-category files to the base (not lockfiles or manifests), so an upgrade is judged by the held-out checks on its own dependencies.
- `scripts/check-caps.mjs` enforces the 300-line file cap here, as in the orchestrator.

## 2026-10-31: offline re-derivation

- verify.mjs re-derives a complete state with the same kind rules as src/verify/requirements.ts. The rule is written twice (TypeScript and the dependency-free checker) because the checker must run with nothing installed; allowed-changes.integration.test.ts runs the checker on every complete result so the two cannot drift silently.
