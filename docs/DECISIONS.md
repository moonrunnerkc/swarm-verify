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
