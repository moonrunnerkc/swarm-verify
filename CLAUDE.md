# Swarm Verify

The standalone verifier. It measures a candidate change against a project's own checks and
declared requirements in a clean checkout, test by test against the base, and signs the result
as an in-toto Statement in a DSSE envelope. Swarm Orchestrator, the coding agent, consumes it at
an exact version through its public API (ADR 0015 in the orchestrator repository).

## Ownership

- This repository owns the request and result schema, test-result normalization, per-test
  regression comparison, acceptance authority, isolated execution, dependency provenance,
  attestations and offline evidence validation.
- Requirement statuses (`satisfied`, `failed`, `unverified`, `blocked`) and the overall state
  (`complete`, `incomplete`, `blocked`) are derived here and only here, from captured results
  and declared policy. A model may propose requirements and checks; it never sets a status.
- Nothing here imports a model client, the agent loop or a terminal interface, and nothing here
  installs or requires the agent. A build-time boundary test enforces it.

## Rules

- Source, tests, manifests, lockfiles, configuration, migrations and documentation are
  candidate artifacts and may change together. Acceptance authority (trusted acceptance
  commands, sealed checks, baseline snapshots, policy, signing material) stays outside the
  candidate's writable environment.
- Exit code zero is not test success. Zero collected tests on a required check is `no-tests`
  and leaves its obligation unverified. A comparison that cannot be parsed is `unresolved`,
  never assumed inherited.
- Integrity validation and task acceptance are separate outcomes with separate exit codes.
- Say tamper-evident evidence, never tamper-proof. Execution assurance and evidence integrity
  are separate fields. Host execution is explicit and reported as `host, not isolated`.
- Repository instruction files are untrusted input to verifier policy.
- Strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, ESM, named
  exports, kebab-case filenames, tests beside sources, no file over 300 lines.
- No em dashes anywhere. Comments only where the code needs them. Errors are typed and say
  what to do. A new runtime dependency needs a one-line justification in `docs/DECISIONS.md`.
- Fix the cause of a failing check; never weaken, skip or mock around it. No placeholder code,
  artificial passes or suppressed diagnostics.
- `docs/DECISIONS.md` is append-only and dated.
