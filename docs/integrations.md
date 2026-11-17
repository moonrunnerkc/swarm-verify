# Integrations

Every surface runs the same verifier through its command line or its API; there is no second
implementation behind any of them. Each run writes `attestation.sigstore.json` (a DSSE envelope
in a Sigstore bundle), `statement.json`, `change.patch`, `attestation.pub.pem`, its logs,
`observations.json` and a `manifest.json` binding them all to a directory of its own
(`.swarm/verify/<run>`, or `--out`, which must be absent or empty), prints the result, and exits
with the codes in the README.

## Command line

```sh
npx swarm-verify verify                          # the working tree against HEAD
npx swarm-verify verify --range main..feature    # a ref range
npx swarm-verify verify --patch change.diff      # a patch file against HEAD (or --base)
npx swarm-verify verify --requirements reqs.json # judge declared requirements too
```

## GitHub Action

`action.yml` at this repository's root builds the verifier from source and runs `ci`, which
verifies `HEAD` against the merge base with the pull request's base branch and adds the result
to the job summary. Check out the full history so the base is present; see
[examples/swarm-verification.yml](../examples/swarm-verification.yml).

## Any other CI system

```sh
npx --yes swarm-verify ci --base origin/main --dependencies prepare
```

## pre-commit

A local hook in `.pre-commit-config.yaml` verifies the staged change against `HEAD`:

```yaml
repos:
  - repo: local
    hooks:
      - id: swarm-verify
        name: swarm-verify
        entry: sh -c 'git diff --cached --binary > .git/swarm-staged.patch && npx --yes swarm-verify verify --patch .git/swarm-staged.patch'
        language: system
        pass_filenames: false
```

## MCP

`mcp.mjs` (the `swarm-verify-mcp` command) is a Model Context Protocol server over stdio with one
tool, `verify`. It takes `workspace`, `base`, `patch` or `range` and `isolation` (`isolated` by
default, `host` only by name), runs `swarm-verify verify --json` and returns the result, its
summary naming the state, delivery, run and manifest. It speaks protocol revisions 2025-06-18,
2025-03-26 and 2024-11-05 (another is answered with the newest), runs two verifications at a
time, stops one that prints more than 32 MiB, stops the one a `notifications/cancelled` names
(nothing is published), and gives each call its own evidence directory. A cancelled call or
failed delivery is a tool error; an incomplete task is the answer. A client configuration:

```json
{ "mcpServers": { "swarm-verify": { "command": "npx", "args": ["--yes", "--package=swarm-verify", "swarm-verify-mcp"] } } }
```

## Agent hooks

A coding agent runs the same command through the command tool it already has. A Claude Code
`Stop` hook in `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx --yes swarm-verify verify" }] }
    ]
  }
}
```

Swarm Orchestrator calls the API directly, on an immutable snapshot of its managed workspace.
