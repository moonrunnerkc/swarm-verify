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

## 2026-10-31: execution trust

- Docker is the one isolated backend, used through its CLI; there is no backend abstraction. Images: `node:24` and `ghcr.io/astral-sh/uv:python3.12-bookworm`, pinned by their multi-architecture index digests (both resolved to arm64 on the development machine), chosen by whether the base has a package.json. A request may name its own image.
- Pulling a missing image happens in the verifier before any check, as part of preparing the execution environment; the image's content digest goes into the environment identity.
- The scratch directory of an isolated verification lives under `$SWARM_HOME/work`: colima and Docker Desktop share the user's home with their VM and not `/var/folders`, so a mount from the system temporary directory fails with "bind source path does not exist" (observed on colima 2026-10-31).
- The container runs as the invoking user's uid and gid, so files it writes into the scratch directory can be removed by the verifier on Linux; on colima the mapping is the same.
- The judge's code is written once per verification and never replaced: replacing it between runs made the file read as missing inside the next container through colima's shared filesystem (observed: ENOENT for judge.mjs on the second run). Its reports moved to `judge-reports/` so the judge directory can be mounted read-only.
- In isolation, a Python project without uv.lock is resolved with `uv lock` during the dependency stage and the generated lock's digest is recorded; with uv.lock it is `uv sync --frozen --all-extras`. pnpm and yarn go through corepack, which may fetch the manager during that same stage.
- A dependency cache under the verifier's home is mounted only during the dependency stage. Its entries are content-addressed by the package managers, so a candidate's install scripts cannot substitute bytes another lockfile resolves.
- Tracked files are digested before and after every check of every run (candidate, obligation, witness), because restoring the candidate's files between runs would otherwise erase the evidence of a check that rewrote them. The cost is one tree digest per check per run.
- `restoreFrom` now removes a path from the index as well as the disk when the tree it restores from lacks the path; the tree recheck found that an index entry outlived its file after a witness run of a refactor.
- `replay` compares states, regression, every check's result and test lists, every requirement status and the lockfile digests. It reruns with the request's own checks and the base's declared ones, and with the recorded image.
- Mutants' Python syntax is checked with the host's `python3`, since a checkout's `.venv` may hold the container's Linux binaries.
- The tamper suite runs on the host by default (`SWARM_TAMPER_ISOLATION=isolated` runs it in containers) so it measures the verifier's judgment apart from the isolation it adds.
- Gates now need a docker daemon for the isolated integration tests; isolated is the default execution, so a test suite that skipped it would not test the product.
- On macOS and Windows, container runs are spaced at least 1.5 s apart, measured from the end of one to the start of the next. colima's virtiofs share keeps a file's entry for about a second, so a file the host replaced just before a container started read as missing (measured: stale up to 0.8 s after the change, never from 1.0 s; this made `npm ci` find no package.json after `git apply`, and the judge read as missing). Every host-side change to the checkout happens between runs, so spacing the runs covers them all; Linux shares no VM filesystem and does not wait.
- A package an npm lockfile installs from outside the repository (`file:../sibling/pkg`, recorded as a `../` key in `packages`) is copied from beside the request's repository into the same place beside the checkout, without its host-built node_modules, and its production dependencies are installed from its own lockfile in the same dependency stage. Its content digest joins the lockfile digests as `local:<path>`. A path that would leave the scratch directory, or a source that is not there, blocks the run. Found on dossier, whose tests import `@ironroot/core` from `../ironroot/packages/core-ts`.
- Dependency preparation moved from checks.ts to prepare.ts.

## 2026-11-01: naming evidence as runners print it

- Test ids from jest, vitest and mocha join suites to the title with ` > `, as the junit reader already did, so one test reads the same whichever report it came from. vitest's and jest's ids come from `ancestorTitles` and `title`; mocha's report holds only `fullTitle` and the test's own `title`, so its suites stay joined by spaces and only the boundary before the title is certain. Ids recorded before this change do not compare with ids recorded after it; no release carried the old ids since 2.0.0 is unpublished.
- A requirement's test name selects a test when its ` > ` parts are a contiguous run of the test's suite path and title. A name that is a substring of a title, or skips a level, selects nothing. Found when a local model named `walkRepo > skips extra directories` and the requirement stayed unverified with the test passing.
- A requirement citing a check that did not run, or a test name that matched nothing, gets a next action naming the checks that ran or the shape of a test path, in place of "run a check that exercises it". A check stays only one the project or the request declares; a command the agent ran is not a check.

## 2026-11-01: authorized behavior changes, end to end

- `verify()` passes the request's `policy.behaviorChange` to the judgment; it was dropped at the API boundary, so no request could authorize a change and `--authorize-behavior-change` did nothing. Found while adding an end-to-end acceptance case for an approved behavior change; only a unit test of `compareRuns` exercised the authorized path before.
- A superseded test's status after the change is its rewritten version's (and before, the witness run's), not the failing old expectation's: the authorized new version replaces the obligation.
- The rule for a check that exits worse with no failing test fires only where the run's report has no failing test, for the obligation run and the candidate's own. A superseded expectation fails in the obligation run by design and explains its exit.
- The predicate records `policy.behaviorChange`, and replay reruns under it; without it a replay of an authorized run would judge the rewrite as unauthorized and diverge.
- A requirement with no mapped evidence gets a next action naming, by title, up to eight tests the executed results show witnessing the change. This names, it does not map: the requirement stays unverified until the producer maps evidence. Found on an acceptance run where a local model added three witnessing tests, never mapped them, and spent its remaining steps elsewhere.

## 2026-11-01: what a cached base run may stand for

- A cached base run is keyed on a digest of the verifier's own code (non-test source, or the built files), with the base commit, the environment and the sealed set. The version string did not change between builds that read reports differently: an acceptance run reused a base read under the old test ids, and every one of its 98 tests read as a new failure. Caches written by other code are left on disk and never read.
- `replay` measures the base afresh, through a call option the public API now carries (`freshBase`), and does not read the cache; the fresh run is still written to it. A replay that reads the base it is checking is not independent: the same acceptance run's replay agreed with the false regressions.
- A failed structure claim says why: the path is a directory, there is no file, or the file lacks the text. An unverified requirement's next action also names, by title, up to eight witnessing tests it does not map, whatever else it maps. Both from the crossfire acceptance run, where the producer's claims named directories and its two witnessing tests went unmapped through two verifications (session 20261101T021508-a9fb2e).
- A requirement's named check holds when its result is `inherited-failures`, as when it is `pass`: the check shows the change broke nothing it measures. It was read as unobserved, so on crossfire, where one unrelated em-dash test fails at both commits, the requirement naming `test` stayed unverified through four verifications with its two witness tests mapped (session 20261101T023752-7721a4). `verify.mjs` holds the same set; a mismatch there reads a correct result as tampered.
