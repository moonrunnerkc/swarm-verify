# The Swarm Verify GitHub Action

`moonrunnerkc/swarm-verify@v1` verifies a pull request's head in a network-disabled container,
signs the verdict as a GitHub artifact attestation, and posts one comment bound to the head.
It is a thin client of the published `swarm-verify` package: three steps of the same binary,
`action verify`, `action comment` and `action retain`, with GitHub's own attestation action
between them. The consumer's checkout is not used; the Action fetches the pull request's head
and base by commit id into a checkout it owns.

`v1` moves only to validated stable releases; `v1.x.y` tags and commit SHAs never move. Where
immutability matters, pin the SHA: `uses: moonrunnerkc/swarm-verify@<sha> # v1.x.y`.

## What one run does

1. `verify` reads the event, fetches the exact head and base (or GitHub's test merge, under
   `target: merge`), runs `swarm-verify ci --branch <head> --base <base>` with candidate
   commands behind `--isolation docker:<image> --require-isolation`, and writes `report.json`
   (`swarm.ci.v1`), `summary.md`, the evidence bundle with its own verifier, and
   `verdict.json`: the canonical `swarm-verify.verdict.v1` document binding repository, pull
   request, head, base, tree, patch digest, verifier version, policy, run identity, the digests
   of the report and the bundle's chain head, and the decision.
2. `actions/attest` signs the verdict document with predicate type
   `https://github.com/moonrunnerkc/swarm-verify/verdict/v1`, through the workflow's OIDC
   identity; no key is managed anywhere. It needs `id-token: write`, `attestations: write`
   and `artifact-metadata: write`.
3. `comment` posts one comment on the pull request and updates it in place on reruns. The
   comment is bound to the head it describes; a run for an older head finds a newer one and
   posts nothing, reporting `stale-head`. Needs `pull-requests: write`.
4. `retain` copies the report, summary, verdict, attestation bundle and evidence bundle
   within bounds (32 MB, 8 MB per file, 4096 files), uploaded as one artifact.
5. The final step returns the verification status: 0 for verified or a regression-only pass,
   1 for not verified (or a regression-only pass under `require-task: true`), 4 for an
   incomplete, refused or head-changed run. Attestation and comment status are separate
   outputs; a failed signature or publication is never reported as a delivered signed comment.

A regression pass says nothing broke. Only a requirement contract can say the work was done,
and the comment says which of the two it is reporting.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `target` | `head` | What to verify. `head` is the pull request head; `merge` is GitHub's test merge of it onto the base. |
| `isolation` | `docker` | `docker` runs candidate commands in a measured container; `host` is explicit and recorded as such. |
| `image` | `node:24-bookworm` | Prebuilt trusted test image for docker isolation, preferably pinned by digest. Nothing is installed into it. |
| `goal-contract` | none | Trusted requirement contract path in the base checkout. Absent leaves task correctness unmeasured. |
| `oracle` | none | Trusted acceptance command. Absent leaves task acceptance unjudged. |
| `packages` | none | Repository-relative package directories to check by name, comma or newline separated. |
| `install` | `false` | Install the candidate's dependencies from its lockfile inside the container, with registry access for that one command and install scripts off, then run the skipped install scripts (and a uv project's own install) offline in the same network-disabled container as the checks. |
| `require-task` | `false` | Treat a regression-only pass (no requirement contract) as a failure rather than a pass with limited scope. |
| `challenges` | `report` | With a goal contract, whether its requirement checks are challenged. `off`, `report` (record findings) or `required` (refuse on a gap). |
| `comment` | `true` | Post and update one comment on the pull request. |
| `attest` | `true` | Sign the verdict with a GitHub artifact attestation (needs id-token, attestations and artifact-metadata write). |
| `github-token` | `${{ github.token }}` | Token used to fetch a private repository's objects and to publish the comment. |
| `workspace` | none | A prepared checkout holding the objects, instead of fetching one. Needs head and base. |
| `head` | none | Commit to verify when the event carries no pull request. |
| `base` | none | Base commit when the event carries no pull request. |
| `source-url` | none | Where to fetch objects from. Defaults to the event repository on this server. |
| `allow-self-hosted` | `false` | State knowingly that a self-hosted runner is acceptable. |

## Outputs

| Output | What it holds |
| --- | --- |
| `status` | What the Action returns (0 verified or regression-only, 1 not verified, 4 incomplete or refused). The verifier's own status is in the verdict. |
| `result` | verified, not-verified, incomplete, head-changed or refused. |
| `head` | The commit that was verified. |
| `base` | The base it was verified against. |
| `tree` | The tree of the verified commit. |
| `report` | JSON report path (swarm.ci.v1). |
| `summary` | Markdown assessment path. |
| `verdict` | Canonical verdict document path, the signed subject. |
| `verdict-digest` | sha256 of the verdict document. |
| `evidence` | Evidence directory. |
| `artifact` | Uploaded artifact name for this invocation. |
| `attestation` | signed, unavailable or skipped. Separate from the verification status. |
| `comment` | created, updated, stale-head, unavailable or skipped. Separate from the verification status. |
| `comment-url` | The comment, where one was created or updated. |
| `retention` | Whether bounded evidence retention was complete. |

## Verifying a signed verdict from outside the run

`swarm-verify verdict` binds the document to the report, summary and bundle beside it by
digest, then hands the signer question to GitHub's own attestation verifier against Sigstore's
public trust root; it never reimplements that check, and without `gh` it prints the exact
command and leaves the signer unverified:

```sh
swarm-verify verdict retained/verdict.json --repo OWNER/REPO \
  --signer-workflow OWNER/REPO/.github/workflows/swarm-verify.yml
```

Exit 0 needs both: evidence bound and signer trusted. A verdict signed by a workflow at
another path or in another repository is refused by identity, whatever its contents say.

## Forks and Dependabot

Fork and Dependabot pull requests run under a read-only token with no OIDC identity, so on a
plain `pull_request` run their comment and signature report `unavailable` while the
verification and the artifact still happen. The supported route is the `pull_request_target`
workflow below, whose definition comes from the base branch and under which the Action
refuses to run candidate code anywhere but inside docker isolation. Candidate code never sees
the job's token, the runner's socket or the evidence directory.

## Example workflows

### swarm-verification-forks.yml

```yaml
# The trusted route for pull requests from forks and from Dependabot, whose `pull_request`
# runs hold a read-only token and no id-token. This workflow definition is read from the base
# branch, so a pull request cannot change it. The Action fetches the pull request's objects by
# commit id into a checkout it owns, and candidate commands run only inside a network-disabled
# container with no token in their environment; signing and the comment happen afterwards, on
# the runner, from what the container produced. Nothing checks the pull request's tree out onto
# the runner itself, and nothing runs code the pull request supplied with this job's token.
name: swarm-verify (forks)
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  id-token: write
  attestations: write
  artifact-metadata: write
jobs:
  verify:
    if: github.event.pull_request.head.repo.fork || github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      # `v1` moves only to validated stable releases; `v1.x.y` tags and commit SHAs never move.
      # This job holds a write token and an id-token under pull_request_target, which is where
      # immutability matters most: pin the SHA, moonrunnerkc/swarm-verify@<sha> # v1.x.y
      # nosemgrep: yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag - a template for other repositories, never run here; `v1` is the documented release channel and the pinned form is named above.
      - uses: moonrunnerkc/swarm-verify@v1
        with:
          isolation: docker
          # Install from the lockfile inside the container, install scripts off; omit it for a
          # project with no dependencies.
          install: true
```

### swarm-verification.yml

```yaml
# The complete minimal workflow for a new user: one job, one Action, the permissions the
# signed comment needs and nothing more. Same-repository pull requests get a signed, bound
# comment. A fork pull request runs the same verification under a read-only token; its comment
# and signature then report `unavailable`, and the trusted route for forks is
# docs/examples/swarm-verification-forks.yml.
name: swarm-verify
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
  id-token: write
  attestations: write
  artifact-metadata: write
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      # `v1` moves only to validated stable releases; `v1.x.y` tags and commit SHAs never move.
      # Where immutability matters, pin the SHA: moonrunnerkc/swarm-verify@<sha> # v1.x.y
      # nosemgrep: yaml.github-actions.security.github-actions-mutable-action-tag.github-actions-mutable-action-tag - a template for other repositories, never run here; `v1` is the documented release channel and the pinned form is named above.
      - uses: moonrunnerkc/swarm-verify@v1
        with:
          # Install from the lockfile inside the container, install scripts off; omit it for a
          # project with no dependencies, whose checks then run as the checkout stands.
          install: true
```
