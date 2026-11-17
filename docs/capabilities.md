# What swarm-verify supports

What each stage does per ecosystem, as of 3.0.0. Where a row says no, the verifier reports the
stage as unmeasured, unverified or blocked with the reason; it never guesses. Mixed projects
declare their checks explicitly in `swarm.toml` (`[checks]`, with `kind = "test"` where a check
runs tests) and their setup in `[verify] setup`; an image is named with the request's
`policy.execution.image`.

| Stage | Node (npm, pnpm, yarn, bun) | Python | Go | Anything else |
| --- | --- | --- | --- | --- |
| Check detection (`init`, no `swarm.toml`) | `package.json` scripts, run with the manager the lockfile names | `pytest -q`, through `uv run` with a `uv.lock`, `.venv/bin/python -m` with a `.venv`, else `python3 -m` | no | no: declare checks |
| Dependency install | `npm ci`; `pnpm`/`yarn` frozen through corepack in a container; `bun install --frozen-lockfile` | `uv sync --frozen`; in a container a project without `uv.lock` is resolved with `uv lock` first and the lock kept as evidence | no | `[verify] setup` |
| Default image (isolated) | `node:24` pinned by digest | `ghcr.io/astral-sh/uv:python3.12-bookworm` pinned by digest | no image: name one | name one |
| Test-by-test reports | `node --test`, vitest, jest, mocha | pytest | `go test -json` parsing; no Go runtime is provided | exit code and printed summary only |
| Changed-line coverage | `NODE_V8_COVERAGE` for test checks (Node 22.8 or newer) | coverage.py, where installed and the check is a pytest command | no | no |
| Mutation (one mutant, a diagnostic) | JS and TS, syntax-checked before it runs | Python, syntax-checked by the host's `python3` | no | no |
| Structure claims by symbol | TypeScript and JavaScript, by the TypeScript 6.0.3 parser | Python, by its own `ast`, isolated | no | text claims only |
| Version claims and constraints | npm SemVer against `package-lock.json` (every resolution of the name) | PEP 440 against `uv.lock` (every resolution) | no | no |

Version resolution is read only from `package-lock.json` and `uv.lock`. Installing from
`pnpm-lock.yaml`, `yarn.lock`, `bun.lock` or `poetry.lock` is supported; judging a version claim
against them is not, and such a claim stays unverified.

Coverage and the single mutant are diagnostics: they are recorded, and a skipped one is
`unmeasured`, but neither decides a requirement unless the trusted contract asks for it. One
mutant does not establish mutation strength.

## Where the measurement's reach ends

- In-process checks (the judge loaded into sealed checks' Node and Python processes) are a
  tripwire for patched assertions, not a sandbox: code under test runs in the same process.
  Where acceptance must not depend on the candidate's own process, use a sealed check whose
  command runs the candidate as a black box and compares its output with expected output the
  sealed set holds; the candidate never sees the expected values and cannot write the report the
  verdict is read from.
- Containers drop every capability, refuse new privileges and stop at 4096 processes. Memory and
  CPU are not bounded.
- A host run (`--isolation host`) runs the project's commands as you, with your filesystem and
  network. It is reported as `host, not isolated`, never reuses or writes the cached base, and
  replays only with `--allow-host`.
- macOS and Linux are tested. Windows is not tested; process-group cleanup, the sandbox and the
  keychain lookup assume POSIX.
