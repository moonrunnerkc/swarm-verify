# Moving from 2.x to 3.0

3.0.0 closes trust-boundary defects found in a review of 2.1.0 (2026-11-17). Most callers change
three things: how they replay, how they read where evidence went, and the exit code they treat as
a delivery failure.

## Replay authenticates first

`replay` (API and CLI) needs the signer you trust. Nothing in a bundle is read before its
envelope verifies against it.

```ts
await replay(bundle, {
  repository,
  out,
  verifierVersion,
  signer: { kind: "key", publicKeys: [trustedPem] },
  // or { kind: "keyless", identity, issuer }, checked by cosign
  allowHost: true, // only where the recording ran on the host and you accept that
});
```

The CLI takes `--key <pem>` (repeatable) or `--certificate-identity` with
`--certificate-oidc-issuer`, and `--allow-host`. An unauthenticated bundle exits 6. A key that
travels beside the bundle is not trusted unless you pass it.

## Evidence has a run identity and is never overwritten

- The result is `swarm-verify.result/v2`: `evidence` gains `runId` and `manifest`, and a new
  `delivery` field says `signed`, `unsigned` or `failed`.
- `artifacts.directory` must be absent or empty. A run is staged beside it and moved into place
  with one rename; a directory that already holds a run is left as it is and the run's delivery
  is `failed`. Give each run its own directory; the CLI's default is now
  `.swarm/verify/<timestamp>-<random>`.
- Read the run you asked for through the returned `evidence.runId` or the directory's
  `manifest.json`, not by assuming what is at a path.

## Signing is required unless you say otherwise

A run whose signature fails is delivered as `failed` and the CLI exits 7, whatever the task's
state. Pass `signing: "optional"` (API) or `--allow-unsigned` (CLI, Action input
`allow-unsigned`) to accept unsigned evidence; it is then `unsigned`.

## Acceptance is stricter, and the same everywhere

- `complete` now also needs at least one check that ran against a measured base, and no test
  check that collected zero tests. `verify.mjs` applies the same rule (generated from
  `src/verify/acceptance.ts`) and fails integrity (exit 6) on a record it cannot judge or a
  requirement recorded satisfied without supporting evidence. A 2.x statement recorded complete
  with no checks or an unmeasured base now fails `verify.mjs`; that record was never supported.
- Statements record `policy.acceptance: "swarm-verify.acceptance/v1"`. A 2.x statement has none
  and is judged under v1.
- With several requirements asking for tests (`testsAsked`), an added test counts only for the
  requirement that maps it in `evidence.tests`.
- A request naming a requirement ID or a trusted check twice no longer parses.
- A Python `provides` claim behind `__getattr__`, a conditional or type-only name, an unread
  re-export, or a path that is a directory, link or unreadable is `unverified`, never satisfied.
- PyPI versions are judged by PEP 440; a version or range PEP 440 cannot judge is unverified.

## Execution

- Isolation that is requested and unavailable blocks the run before any setup or check.
- Host runs no longer read or write the base cache.
- Ctrl-C, SIGTERM and SIGHUP cancel the run, stop its processes and containers, publish nothing
  and exit 3.
- The runtime floor is Node 22.13.

## Replay comparison

Replays compare `observations.json`, every test both runs observed, in both directions, plus
execution policy, held-out results and requirement evidence. `Replay.environmentDrift` lists
toolchain and platform differences apart from divergences, and `comparedBy` says whether a 2.x
recording (no observations) was compared by its capped summaries.
