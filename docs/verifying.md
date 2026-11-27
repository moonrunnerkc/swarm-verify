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
sealed store or the signing key. Dependencies are fetched in one recorded stage with the
network open (and a dependency cache under the verifier's home mounted). For npm, pnpm and
classic yarn nothing a package ships runs during it: install scripts run afterwards with the
network closed. Every check runs with `--network none` unless the request records that it needs
a network. Linked dependencies are
refused in isolation.

Every container that runs project code (dependency setup, base and candidate checks, reruns,
the mutant and held-out checks) is bounded: 4096 MiB of memory with no swap (`--memory` and
`--memory-swap` equal) and 2 CPUs (a CFS quota) by default, changed with `--memory-mib` and
`--cpus`, the Action's `memory-mib` and `cpus` inputs, or `policy.execution.resources` in the
API. The candidate's tree cannot set them. Before the first project command, a container from
the same image under the same flags reads its own cgroup; a daemon that refuses the bounds or
applies less (no swap accounting, no CPU quota) leaves the run `blocked`, and nothing runs. The
result's `execution.resources` records what was asked and what the cgroup applied. These are
per-container bounds: concurrent containers and concurrent verifications can together use more
of the host. A host run is not bounded and does not claim to be.

A check is unmeasured, never failed, when docker reports that the kernel killed a process in its
container at the memory limit (`State.OOMKilled`); an exit code of 137 alone is a SIGKILL from
anywhere and is read as the exit it is. A check that runs out of memory or time cannot make a
task complete or count as a rejected cheat.

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
   same refusal. In a container, a Python project that tracks no `uv.lock` is resolved with
   `uv lock` first; that lock, for the base and for a candidate that resolves again, is kept with
   the evidence under `lockfiles/` and digested in the statement, and a replay installs from it.
4. Every check and every sealed held-out check runs at the base commit with each runner's report
   written and the judge loaded. Results are kept under `$SWARM_HOME/baselines/` keyed by the
   base, the environment digest (commands, lockfiles and the installed tree), the sealed set and
   the judge's code, and reused only where the environment is reproducible.
5. The candidate is applied with `git apply --index`. Every changed path is a candidate artifact:
   source, tests, manifests, lockfiles, configuration and CI files may change together. When the
   candidate changes its lockfile or manifest, its dependencies are prepared again from its own.
6. Where the candidate modified or deleted test files, the checks run with the base's versions
   of those files restored (the **obligation run**): the original regression obligations judge
   the new source.
7. Where the candidate added or rewrote test files, the checks run with the base's source and the
   candidate's tests (the **witness run**), to see which new tests fail before the change.
8. The checks run on the candidate (the **candidate run**), with V8 or coverage.py measuring the
   changed lines. It runs last, and each of these three runs starts from the untracked paths the
   base's run started from: what an earlier run's checks wrote outside git (build output, caches)
   is removed first, so no run's tests load what another run built.
9. One mutant of a changed line, syntax-checked first, runs against the test checks.
10. The base's tests are put back, the sealed files copied in, and the held-out checks run with the
    judge loaded.

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

Each run is written to its own directory (`.swarm/verify/<run>` by default, or `--out`, which
must be absent or empty); a directory that already holds a run is never written over, so a
failed or concurrent run can never leave another run's bundle looking like its own.
`--preflight` prints the plan (candidate, checks and the runner that judges each, image, setup,
stages, signer, bounds, what is missing) and exits 0, or 5 where something is missing.

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
| its file could not load | the file loads | the whole-file failure is fixed where every test in the file passes, inherited otherwise; the base's tests in it that fail are inherited, and a failing test only the candidate's version of the file holds blocks |
| present | its file deleted by the candidate | removed: blocks |
| any | fails, but the candidate's rewrite of it passes | expectation changed: blocks, unless the task authorized a behavior change and the rewrite fails against the base's source (superseded) |

Only the request authorizes a behavior change (`policy.behaviorChange`, or
`--authorize-behavior-change`); the result records which policy it was judged under, and
`replay` reruns under the same one.

Tests the candidate added are labeled `implementation-authored`. One that passes against the
candidate and fails against the base's source is a witness; one that fails against the candidate
blocks. A test file moved or edited with only its imports changed is matched to the base by the
tests' names, so a refactor that moves tests is not read as deleting them. A deleted test file
and an added one that git pairs as a rename, with more than imports changed (a fixture path one
directory further up, say), were moved and edited: the base's version runs at its old path against
the candidate's source, with the moved copy out of that run, and each test is read as one
rewritten in place, its rewrite being the test of the same name in the moved copy. A pair git does
not see as a rename stays a deletion and an addition.

A check's result is `pass`, `inherited-failures` (nothing new fails, inherited failures remain),
`fail`, `error` (it could not run with the candidate), `no-tests` (it collected none, read from
the report or from the summary its runner printed; exit code zero is not test success), or
`unresolved`: a report did not parse, no collected test passes against the candidate, or the
check has no report read and fails at both commits with no diagnostics to compare. Unresolved
never claims inheritance.

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
| fail | fail | by the diagnostics both runs printed, below; `unresolved` where either printed none |

A check such as `typecheck` or `build` that fails at both commits is compared by the compiler
diagnostics each run printed: the `tsc` forms and `path:line[:col]: error: message`, each read as
file, code and message with the line and column dropped, and counted, so a repeat is one more.
Where the candidate adds none the check is `inherited-failures` and the regression lists it as
`check <name>`; where it adds any the check is `fail` and names them. Where either run printed
none that could be read, or its output was cut at the 4 MiB kept, it stays `unresolved`. A base
run reused from the cache is compared by the diagnostics kept with it.

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
  package claim's `version`, like a version constraint's `range`, is exact (`10.1.1`), a range
  written with `x` (`9.x`, `9.6.x`, or `9`), a caret (`^9.6.1`) or a tilde (`~9.6`); npm reads
  it as npm does. For PyPI it is read by PEP 440: `9.x` is `==9.*`, `^9.6.1` is `>=9.6.1,<10`,
  `~9.6` is `>=9.6,<9.7`, `1.2.3` is `==1.2.3`, and a PEP 440 specifier set (`>=1.4,<2`,
  `~=1.4.5`) is read as written. A prerelease is within a range only where the range names one.
  Every version the lockfile resolves the package to (package-lock.json, nested installs
  included, or uv.lock, names compared by PEP 503) must be within it; one outside fails the
  requirement, and one that cannot be judged (a version PEP 440 does not read, or npm range
  grammar PEP 440 does not define, such as `>=9 <11`) leaves it `unverified` with the reason.
- A requirement with no mapped evidence, or whose evidence was not observed or is a flaky test,
  is `unverified`; one whose evidence fails is `failed`.

The overall state is `complete` only when every required requirement is satisfied, the regression
is `none`, and the execution policy was met; `blocked` when no check is declared, dependencies
would not prepare, or the policy cannot be met; otherwise `incomplete`. A request with no
requirements is `regression-only` and says so.

A decisive witness counts only where the change's own author did not choose it: a pre-existing
test, a check the request supplies (`user-acceptance` or `independently-generated`), or a sealed
held-out check (`swarm-verify init --seal <glob>`). A requirement whose every decisive witness is
`implementation-authored` (tests or claims the change itself added) is `unverified` with the
witness recorded as `self-attested`, and the result names the missing independent evidence.

## Behavior checks

A request's `behavior` array holds checks of what the running application does. Each names the
requirements it witnesses, how to start the target (`start`, `port`, optional `env` and `ready`),
and cases. A case is a sequence of HTTP requests with what each must answer: a status, how many
of several requests sent at once may succeed (`times`, `count`), values in the JSON response
(`json`, by value or by change from a captured one), and text the body must or must not hold.
A step may wait (`waitMs`) and carry a value forward (`capture`, used as `{{name}}`).

Isolated, the target runs in a container with no network but its own loopback, and the driver
runs in a second container that shares that loopback and nothing else. The driver's code and
scenario are written by the verifier and mounted read-only; its report is read from its own
output. Nothing the target prints or writes is taken for a result. The cases run at the base
and on the candidate, so a case that already held is `preserved` and one the change made hold is
`fixed`; a case the candidate fails is a failure of its requirement, and one that could not be
measured (the target never answered) leaves it unverified, with the reason and a log.

This is stronger evidence than a unit test for the same behavior, which shares a process with
the code it tests. It is still only the requests that were sent. Every check must hold a case
with role `allowed` and one with another role.

`securityCases(binding)` builds the cases of three checks from a project's binding. See the
orchestrator's reference for the binding's shape. A binding is refused where it could not show
what it claims (the other user is the owner, the redemption never uses the token, the observed
number cannot move). An ownership binding should name `signedIn`, a request the base already
answers for any signed-in user and refuses without credentials: without it a credential that
names nobody is refused like a stranger's, and the check reads that as the restriction working.
`tryBinding(file, { workspace, baseCommit, policy })` tries a binding on a commit as it stands,
with the same checkout, target and driver, and says what real requests showed is wrong with it.
A case a binding cannot make is kept as `unobserved` with the reason, never dropped: a token
binding with no `expiresAfterMs` leaves "an expired token is refused" unsent, and the token
requirement unverified until the target is started with a short lifetime the application reads
(`target.env`) and `expiresAfterMs` says how long to wait. Where the application has no such
setting, expiry is not observable in a bounded check and stays unverified.
These three checks are what this version makes; they are not a security review.

## Conventions

A requirement's evidence may hold `conventions`: rules with the value the project holds each to
(`exports: named`, `function-names: camelCase`, `explicit-any: forbidden` and others in
`conventionValues`). Each becomes one piece of evidence of kind `convention`. It is `observed`
where no JavaScript or TypeScript file the candidate adds or changes breaks the rule more often
than its base version did, and `fail` with the file, line and text where one does. Rules are
read from the syntax tree; comments and strings are not consulted.

## Containing a caller's commands

`openWorker` (`swarm-verify/execution`) runs a caller's untrusted commands in the sandbox the
checks use. The caller names the workspace, a private HOME, paths to mount read-only and
stand-ins to mount in place of others. Each command gets a fresh container with no network; a
run that asks for the dependency stage gets the network and the dependency cache, and the caller
decides which commands those are. The container does not hold the caller's home, environment,
credentials or docker socket. It bounds the commands; it is no defense against a compromised
daemon or host.

## Mutation

One mutant of a changed source line runs against the test checks, preferring covered lines.
Operators inside string literals and comments are not mutated, including those that span lines (a
docstring, a template literal, a block comment). It is syntax-checked first (`node --check` for
JavaScript, Node's TypeScript transform for TypeScript, `ast.parse` with the host's `python3`), and
a mutant that does not parse is refused and the next tried. `killed` means a test that passed with the candidate fails under the mutant;
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

## What evidence keeps of what a check printed

A check's output is redacted as it is captured, before it is hashed, cut into tails and reasons,
written as a log or signed: values in shapes that name themselves (private key blocks, including
one cut off by the 4 MiB output cap, and GitHub, AWS, Google, Slack, OpenAI and Anthropic keys,
bearer tokens and JWTs) and values assigned to a credential name (`API_KEY=`, `"password": `),
using the names `src/evidence/credential-names.ts` defines, which exempt metrics by name. Each
becomes `[redacted:<label>]`. The test outcomes are read from what was printed before redaction,
so redaction never turns a failure into a pass or moves a test. The statement records the rules
(`policy.redaction.policy`, `swarm-verify.redaction/v1`) and how many markers the logs carry, never
a value or anything derived from one.

What is published as measured is never edited: the candidate's patch, test ids, sealed sources,
lockfiles. Where one of them still holds a value in a known shape, nothing is published: the
delivery fails (exit 7) whether signing was required or optional, the problem names where and
which shape, and the result keeps the candidate's patch digest. This is known-pattern scrubbing:
a credential in a shape or under a name nobody listed passes through, so keep real credentials out
of what checks print.

## Replaying a result

`swarm-verify replay <evidence-dir> (--key <pem> | --certificate-identity <id> --certificate-oidc-issuer <url>) [--allow-host] [--workspace <repo>]`
first authenticates the bundle: it is read once with a size bound and no link followed, and its
envelope must verify against a key you name or, keyless, through cosign against the identity and
issuer you name. A key beside the bundle authorizes nothing by itself. Only then is the statement
read. It runs the same base, patch, requirements and request checks again under the recorded
execution with dependencies installed fresh from the lockfiles in the tree, judges "latest"
constraints from the registry answers the recording kept (`inputs/latest.json`), and compares
both runs' complete observation records (`observations.json`, every test of every check and of
the sealed set) in both directions, together with the state, execution mode, network, image and
dependency preparation, held-out results, every check's result, every requirement's status and
evidence, and the lockfile digests. Toolchain, platform and dependency-tree differences are
reported as environment drift, apart from divergences. A recording made before 3.0.0 has no
observation record and is compared by its test lists, which hold at most 100 ids each; the
replay says so. It exits 0 when everything agrees, 1 on any divergence (each named), 5 when it
could not run, 6 when the bundle was not authenticated, in which case nothing in it ran. An
isolated recording replays in a container from the recorded image; a host recording replays on
the host only with `--allow-host`, and only on the platform it recorded
(`environment.platform`, such as `darwin-arm64`). A recording on linked dependencies is refused:
the installed tree it ran on is not reproducible.

## Checking a result offline

`verify.mjs` checks the signature and the subjects, and with `--evidence <dir>` every log the
statement lists, with `--ledger <file>` that a producer's command ledger still begins with the
records the statement bound (`producer.ledgerRecords` lines hashing to `producer.ledgerSha256`),
and with `--report <file>` that a producer's report states the signed patch digest, state and
requirement statuses. It re-derives the recorded state from the recorded evidence by the same
acceptance rule the verifier applies (`src/verify/acceptance.ts`, carried into `verify.mjs` by
`scripts/sync-offline.mjs`), refuses a record it cannot judge, and fails a requirement recorded
satisfied that its evidence does not support. Integrity failures exit 6; a signed result that
is not complete exits 1.

```sh
node verify.mjs attestation.sigstore.json --key attestation.pub.pem --patch change.patch
```

`--integrity-only` skips the acceptance answer. cosign checks the same key-signed bundle:
`cosign verify-blob-attestation --key attestation.pub.pem --bundle attestation.sigstore.json --type https://github.com/moonrunnerkc/swarm-verify/result/v1 --insecure-ignore-tlog change.patch`
(the bundle carries no transparency-log entry, hence the flag). A keylessly signed bundle is
checked with `--certificate-identity` and `--certificate-oidc-issuer` instead of `--key`.

## Exit codes

`verify` and `ci`:

| Code | Meaning |
| --- | --- |
| 0 | complete |
| 1 | incomplete: something failed (a regression, a failing requirement, a change that does not apply) |
| 2 | a command line it cannot read |
| 3 | cancelled; nothing is published |
| 4 | incomplete: something stayed unverified or unresolved, and nothing failed |
| 5 | blocked: no checks, dependencies that would not prepare, or an execution policy it cannot meet |
| 7 | the evidence was not delivered as required: a required signature or the publication failed, whatever the state |

Precedence: 2, then 3, then 7, then the state's own code.

`verify.mjs`:

| Code | Meaning |
| --- | --- |
| 0 | integrity holds and the task is accepted |
| 1 | integrity holds and the task is not accepted |
| 2 | a command line it cannot read |
| 6 | integrity fails, including a recorded state the recorded evidence does not support |

`replay`: 0 everything agrees, 1 a divergence, 5 it could not run, 6 the bundle was not
authenticated (nothing in it ran).

## Limitations

- In a container, code under test still runs in the same process as its test framework and can
  manipulate the in-process oracle: rewrite the runner's report, patch an assertion helper the
  judge does not watch, or skip itself. The judge is a tripwire for in-process assertion
  patching, not a sandbox; test helpers loaded with `require` are not watched, and a runner that
  is neither Node nor Python runs its held-out checks unjudged. Decisive behavior is best checked
  from outside the process (a black-box acceptance check the request supplies).
- On the host (`--isolation host`), checks run as the invoking user and can reach the judge, the
  base-run cache, the sealed store and the installed verifier. The result says so.
- Dependency preparation is not offline. Packages are fetched with the network open; npm, pnpm
  and classic yarn run no install script while it is, but Yarn 2 and later, bun and Python
  builds (a build backend, a source distribution) do run in that stage, as does a `[verify]
  setup` command the base declares. On the host nothing separates the two. The stage's output
  is digested, not inspected.
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
