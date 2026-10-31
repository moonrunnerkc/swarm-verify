# Migrating from swarm-verify 1.x to 2.0

2.0 is the lean verifier that moved here from Swarm Orchestrator, with a versioned request and
result. The 1.x line (last release 1.3.1) stays installable at its exact versions and its `v1`
Action tag does not move. Nothing below changes a 1.x release.

## Commands

| 1.x | 2.0 |
| --- | --- |
| `swarm-verify` / `swarm-verify check [--explain] [--json]` | `swarm-verify verify` (the working tree against `HEAD`), `--json` for the result |
| `swarm-verify ci --patch <file>` | `swarm-verify verify --patch <file> [--base <ref>]` |
| `swarm-verify ci --branch <ref>` | `swarm-verify verify --range <base>..<ref>` |
| `swarm-verify ci --pr <owner/repo#n>` | `swarm-verify ci --base <ref>` inside the pull request's checkout |
| `--goal-contract <file>` | `--requirements <file>`: a JSON array of requirements (see the README) |
| `--challenges off\|report\|required` | removed; requirement evidence is judged from executed checks |
| `swarm-verify verify <bundle> [--signer <fp>]` | `node verify.mjs <attestation> --key <public.pem>` |
| `swarm-verify verdict <verdict.json>` | removed with the Action-signed verdict document |
| `swarm-verify gates`, `hook`, `mcp`, `pre-commit` | `swarm-verify-mcp` stays; the others are plain commands in [integrations.md](integrations.md) |
| | `swarm-verify init [--seal <glob>]` writes `swarm.toml` or seals held-out checks |

## Exit codes

| Code | 1.x | 2.0 `verify` and `ci` |
| --- | --- | --- |
| 0 | acceptable | complete |
| 1 | not acceptable | incomplete: something failed |
| 2 | unreadable command line | unreadable command line |
| 3 | cancelled | cancelled |
| 4 | incomplete or refused | incomplete: something unverified or unresolved, nothing failed |
| 5 | | blocked |

The offline checker's codes are new: 0 integrity holds and the task is accepted, 1 integrity
holds and the task is not, 6 integrity fails. In 1.x a signed failing verdict exited 0 from
bundle verification; in 2.0 it exits 1.

## Evidence format

1.x wrote a hash-chained evidence bundle and a canonical verdict document signed by a GitHub
artifact attestation. 2.0 writes an in-toto Statement v1 in a DSSE envelope inside a Sigstore
bundle, with subjects for the tree and the patch and the predicate type
`https://github.com/moonrunnerkc/swarm-verify/result/v1`. The predicate is the result: state,
requirement outcomes, regression, checks with their authority, execution assurance and
diagnostics. `cosign verify-blob-attestation` checks the same bundle. 1.x bundles are read by
1.x only.

## Action inputs

| 1.x input | 2.0 |
| --- | --- |
| `target`, `workspace`, `head`, `source-url` | removed: the Action verifies the checked-out `HEAD` against the base |
| `base` | `base` |
| `isolation`, `image` | `isolation` (`host` or `isolated`) |
| `install` | `dependencies` (`prepare` or `none`) |
| `goal-contract`, `require-task`, `challenges`, `oracle` | `requirements` |
| `packages`, `comment`, `attest`, `github-token`, `allow-self-hosted` | removed |

The 1.x outputs are removed; the result is in the job summary and in `.swarm/verify/`.
