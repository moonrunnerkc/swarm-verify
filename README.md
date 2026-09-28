# swarm-verify GitHub Action

Independently verify what an AI-written pull request actually ran, in a network-disabled
container, and post one signed comment bound to the exact head. This repository holds only
the Action manifest and a lockfile pinning the published `swarm-verify` package at
`1.0.3`; the implementation is
[moonrunnerkc/swarm-orchestrator](https://github.com/moonrunnerkc/swarm-orchestrator) at
`857e0e87bf6b3c3a7eaea385bae1be19dead8adc`, under `src/action/`.

```yaml
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
      - uses: moonrunnerkc/swarm-verify@v1
```

Pin by full commit SHA where immutability matters. Inputs, outputs, the fork route and how to
verify a signed verdict with `gh attestation verify` are documented in
[the broad-use guide](https://github.com/moonrunnerkc/swarm-orchestrator/blob/v13-main/docs/broad-use.md#github-action).

A regression pass says nothing broke. Only a requirement contract can say the work was done,
and the comment says which of the two it is reporting.
