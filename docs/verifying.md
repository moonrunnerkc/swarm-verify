# Verifying a change

`swarm-verify verify` (or the `verify()` API) measures one candidate against one base commit and
signs what it found. This page says what runs, what each part of the result means, and where its
reach ends.

## Where it runs

By default every command runs in a fresh docker container (`--isolation isolated`, the API's
`mode: "isolated"`). The image is pinned by digest (`node:24` for a repository with a
`package.json`, uv on Python 3.12 otherwise, or the request's own); its content digest is
recorded in the environment identity. The container sees only the verification's scratch
directory, mounted at its own path: the checkout, the runner reports, a private HOME, and the
judge, mounted read-only. The checkout's `.git` is hidden behind an empty mount. Nothing else of
the host is mounted: not the docker socket, the user's home, credentials, the base-run cache, the
sealed store or the signing key. Dependencies are installed in one recorded stage with the
network open (and a dependency cache under the verifier's home mounted); every check runs with
`--network none` unless the request records that it needs a network. Linked dependencies are
refused in isolation.

The scratch directory lives under the verifier's home (`$SWARM_HOME/work`, `~/.swarm/work` by
default) because docker VMs on macOS (colima, Docker Desktop) share the user's home with the VM
and not the system's temporary directory.

`--isolation host` runs the same commands on the host as the invoking user. The result says
`host, not isolated`, and a request for isolation is never met by a host run: if docker does not
answer, the result is `blocked` with the step to take.

Each check's tracked files are read before and after it runs. A check that rewrites the tree it
was given (the delivered candidate, or the obligation or witness variant) is named, the execution
policy is not met, and the result is not complete.

## What runs, in order

1. The base commit is cloned into a temporary directory that shares the repository's objects.
2. The checks, the setup command and the timeout are read from the base's `swarm.toml`, or the
   checks from the base's manifests. Checks a request supplies (user acceptance or independently
   generated) are added with their authority. Nothing in the candidate can rewrite them.
3. Dependencies are prepared as the policy says: `prepare` runs the base's `[verify] setup`
   command or the install its lockfile asks for (`npm ci`, pnpm, yarn, bun, `uv sync --frozen`)
   in the checkout and digests the installed tree; `linked` links the workspace's `node_modules`
   and `.venv`, which is never reproducible; `none` prepares nothing. A preparation that cannot
   start, such as a lockfile package from beside the repository that is not there, is recorded
   as `refused` with its reason, and the result is blocked; a replay prepares again and meets the
   same refusal.
4. Every check and every sealed held-out check runs at the base commit with each runner's report
   written and the judge loaded. Results are kept under `$SWARM_HOME/baselines/` keyed by the
   base, the environment digest (commands, lockfiles and the installed tree), the sealed set and
   the judge's code, and reused only where the environment is reproducible.
5. The candidate is applied with `git apply --index`. Every changed path is a candidate artifact:
   source, tests, manifests, lockfiles, configuration and CI files may change together. When the
   candidate changes its lockfile or manifest, its dependencies are prepared again from its own.
6. The checks run on the candidate (the **candidate run**), with V8 or coverage.py measuring the
   changed lines.
7. Where the candidate modified or deleted test files, the checks run again with the base's
   versions of those files restored (the **obligation run**): the original regression
   obligations judge the new source.
8. Where the candidate added or rewrote test files, the checks run with the base's source and the
   candidate's tests (the **witness run**), to see which new tests fail before the change.
9. One mutant of a changed line, syntax-checked first, runs against the test checks.
10. The base's tests are put back, the sealed files copied in, and the held-out checks run with the
    judge loaded.

## Reading a check test by test

Six runners are read test by test. `node --test` gets its junit reporter through `NODE_OPTIONS`,
so it is read wherever the command runs it (behind `cd dir &&`, or in the one `package.json`
script a command names); the others get their reporter appended:

| Runner | Report |
| --- | --- |
| `node --test` | junit, through `NODE_OPTIONS` |
| pytest | `--continue-on-collection-errors --junitxml=<file>` |
| jest | `--json --outputFile=<file>` |
| vitest | `--reporter=default --reporter=json --outputFile.json=<file>` |
| mocha | `--reporter json --reporter-option output=<file>` |
| go test | `-json`, standard output to the file |

Each base test is judged by its original version against the candidate:

| At base | Against the candidate | Read as |
| --- | --- | --- |
| pass | pass | preserved (renamed, where its file moved with only imports changed) |
| fail | pass | fixed |
| fail | fail | inherited: reported, does not block |
| pass | fail, skipped or missing | new failure: blocks |
| present | its file deleted by the candidate | removed: blocks |
| any | fails, but the candidate's rewrite of it passes | expectation changed: blocks, unless the task authorized a behavior change and the rewrite fails against the base's source (superseded) |

Only the request authorizes a behavior change (`policy.behaviorChange`, or
`--authorize-behavior-change`); the result records which policy it was judged under, and
`replay` reruns under the same one.

Tests the candidate added are labeled `implementation-authored`. One that passes against the
candidate and fails against the base's source is a witness; one that fails against the candidate
blocks. A test file moved or edited with only its imports changed is matched to the base by the
tests' names, so a refactor that moves tests is not read as deleting them.

A check's result is `pass`, `inherited-failures` (nothing new fails, inherited failures remain),
`fail`, `error` (it could not run with the candidate), `no-tests` (it collected none, read from
the report or from the summary its runner printed; exit code zero is not test success), or
`unresolved`: a report did not parse, no collected test passes against the candidate, or the
check has no report read and fails at both commits. Unresolved never claims inheritance.

A failing run decides some verdicts by itself: a new failure, a rewritten expectation, a failing
added test, a fix (failing at the base), a witness (failing against the base's source). Each such
test is run again on the same snapshot, up to three times (`policy.reruns` in the request, zero to
ten), and stops at its first pass. A test that fails and then passes is `flaky`: it is never a
regression and never a fix or a witness, its check is `unresolved`, the regression is
`unresolved` and names it under `flaky`, and a requirement mapped to it stays `unverified`. A test
that fails on every run keeps its verdict. Every run of every rerun test is recorded in the
check's `tests.reruns` with the snapshot it ran on (`base`, `obligation`, `candidate` or
`witness`). Reruns at the base and against the base's source run after every candidate run,
with the base's dependencies installed again where the candidate installed its own.

A check without a report read is judged by its exit code and the count its runner printed:

| At base | Against the candidate | Result |
| --- | --- | --- |
| any | collected no tests | `no-tests` |
| pass | pass | `pass` |
| pass | fail | `fail`: a regression |
| fail | pass | `pass` |
| fail | fail | `unresolved` |

## Requirements

A request may name requirements, each with the evidence that should show it: tests by name,
checks by name, structural claims about the candidate tree, and packages an upgrade resolves.
The status comes from that evidence only. A named check holds when its result is `pass` or
`inherited-failures`; `no-tests` and `unresolved` leave it unobserved.

- A fix or feature is `satisfied` when a mapped test fails before and passes after (fixed, a
  witness, or superseded under an authorized behavior change), and nothing mapped fails.
- A refactor is `satisfied` when its mapped tests are preserved, no regression is found, and its
  structural claims hold (or source changed, where it names none). No failing baseline is asked for.
- An upgrade is `satisfied` when the candidate's lockfile resolves each named package to a new
  version, the candidate's dependencies were installed fresh from it, and nothing regressed. A
  package claim's `version` is exact (`10.1.1`) or a range written with `x` (`9.x`, `9.6.x`, or
  `9`); a resolved version outside it fails the requirement.
- A requirement with no mapped evidence, or whose evidence was not observed or is a flaky test,
  is `unverified`; one whose evidence fails is `failed`.

The overall state is `complete` only when every required requirement is satisfied, the regression
is `none`, and the execution policy was met; `blocked` when no check is declared, dependencies
would not prepare, or the policy cannot be met; otherwise `incomplete`. A request with no
requirements is `regression-only` and says so.

## Mutation

One mutant of a changed source line runs against the test checks, preferring covered lines. It
is syntax-checked first (`node --check` for JavaScript, Node's TypeScript transform for
TypeScript, `ast.parse` with the checkout's Python), and a mutant that does not parse is refused
and the next tried. `killed` means a test that passed with the candidate fails under the mutant;
`timeout` and `runner-crash` (no report, or tests that vanished) are told apart from it, and
`invalid-mutant` says no mutant parsed. Only `killed` counts as detection strength. Coverage and
mutation describe how strong the evidence is; they never substitute for a requirement.

## The judge

Tests run in the same process as the code they judge, so a change could patch the assertions
at import time. Every Node and Python process of a declared test check (at base and with the
change) and of a held-out check therefore loads a judge before any project module: `NODE_OPTIONS=--import` for Node and a `sitecustomize.py` on
`PYTHONPATH` for Python, both written outside the checkout.

- Node: the functions of `node:assert` and `node:assert/strict` become counting accessors that
  record any assignment; `node:test`'s exports, `Object.is`, `Array.prototype.includes` and the
  other builtins listed in `src/verify/judge.ts` are recorded as they were; and every ES module
  under a test directory of the checkout has its exported functions and prototype methods
  recorded once it evaluates.
- Python: `unittest.TestCase`'s assert, fail and run methods, the builtins tests compare with,
  and pytest's runtest, call and assertion-rewrite hooks. The interpreter's own sitecustomize
  still runs first.

At exit each process reports `ok` or what changed, and a Node process ended by SIGTERM, SIGINT
or SIGHUP reports before the signal ends it, as a test runner's worker processes are ended. A
held-out check fails when any process reports a change, or when a process that loaded the judge
never reports (it was killed outright, or its exit hooks were removed). A Node worker thread is
judged the same way when it ends on its own; one its runner terminates runs nothing more, so it
is listed under unmeasured as not checked rather than failing the check (vitest 1 runs its tests
in such threads). A declared test check fails on a finding its base run did not show,
so a suite whose workers are killed at exit is not refused for that at both commits. The
predicate records how many processes of the held-out checks loaded the judge and how many calls
went through `node:assert`. Files that change what loads before the judge (`.npmrc`,
`.yarnrc`, `sitecustomize.py`, `usercustomize.py`, `*.pth`) are reported as config artifacts.

## Replaying a result

`swarm-verify replay <evidence-dir> [--workspace <repo>]` reads the signed statement and patch
from a directory `verify` wrote, runs the same base, patch, requirements and request checks
again under the recorded execution with dependencies installed fresh from the lockfiles in the
tree, and compares the state, the execution mode, the regression, every check's result and test
lists, every requirement's status and the lockfile digests with what was recorded. A test
flaky in both runs agrees; one flaky in only one run is a single divergence naming its runs and
where the other run put it. It exits 0 when everything agrees, 1 on any divergence (each
named), 5 when it could not run. An isolated recording replays in a container from the recorded image; a
host recording replays on the host, and only on the platform it recorded (`environment.platform`,
such as `darwin-arm64`). A recording on linked dependencies is refused: the installed tree it ran
on is not reproducible.

## Checking a result offline

`verify.mjs` checks the signature and the subjects, and with `--evidence <dir>` every log the
statement lists, with `--ledger <file>` that a producer's command ledger still begins with the
records the statement bound (`producer.ledgerRecords` lines hashing to `producer.ledgerSha256`),
and with `--report <file>` that a producer's report states the signed patch digest, state and
requirement statuses. It re-derives the recorded state from the recorded evidence. Integrity
failures exit 6; a signed result that is not complete exits 1.

## Exit codes

`0` complete, `1` incomplete because something failed (a regression, a failing requirement, a
candidate that does not apply), `2` a command line it cannot read, `3` cancelled, `4` incomplete
because something stayed unverified or unresolved, `5` blocked.

## Limitations

- In a container, code under test still runs in the same process as its test framework and can
  manipulate the in-process oracle: rewrite the runner's report, patch an assertion helper the
  judge does not watch, or skip itself. The judge is a tripwire for in-process assertion
  patching, not a sandbox; test helpers loaded with `require` are not watched, and a runner that
  is neither Node nor Python runs its held-out checks unjudged. Decisive behavior is best checked
  from outside the process (a black-box acceptance check the request supplies).
- On the host (`--isolation host`), checks run as the invoking user and can reach the judge, the
  base-run cache, the sealed store and the installed verifier. The result says so.
- Dependency preparation runs the project's install scripts with the network open. Its output is
  digested, not inspected.
- Trust in a signing key is external to the bundle. A public key shipped beside an attestation
  says who signed it only if you already trust that key from elsewhere.
- Linked dependencies resolve through the workspace and are never reproducible; a baseline
  measured on them is not reused.
- Submodules are left out of the tree digest and are not checked out in the clean clone; a
  change inside a submodule is not judged.
- Held-out checks are judged per command.
- A worker thread a test runner terminates is not checked by the judge; a change made inside one
  is not caught by it. A Python process ended by a signal is not checked either.
- A test file moved with more than its imports changed is read as one file deleted and another
  added: its base tests are removed and the new ones are labeled implementation-authored.
