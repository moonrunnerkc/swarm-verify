# The feature was implemented. One requirement was still wrong.

A coding agent was asked to add a `--reviewers` option to
[pubprep](https://github.com/moonrunnerkc/pubprep), a command line tool that runs three reviewer
agents. The request said the chosen reviewers must come back in one fixed order (tech-debt, docs,
security) whatever order they were typed. The patch it delivered keeps the typed order instead.

Measured with the published `swarm-verify@3.1.0`:

- **The project's own checks all pass on that patch**: `npm run test` (the 98 existing tests and
  the 4 the patch added), `npm run typecheck` and `npm run build`.
- **One held-out check fails.** A held-out check is an acceptance test kept separate from the
  implementation, so the change's author can neither see nor edit it. 9 of its 10 tests pass; the
  one about ordering does not.
- **The result is `incomplete`, with requirement R1 `failed`.** A reference patch judged under the
  same criteria is `complete`, with R1 `satisfied`.

The patch was produced by the maintainer's own agent, Swarm Orchestrator. Its tests agree with
its code, so they pass.

## What was asked

From the [original requirement](../../corpus/cmp-feature-pubprep/requirements.json), which is the
task as it was typed:

> It takes a comma-separated list of short names: tech-debt, docs and security, for
> tech-debt-reviewer, readme-docs-reviewer and security-reviewer. parseArgs returns the choice as
> `reviewers`, **the full agent names in the order tech-debt, docs, security whatever order they
> were typed**, each once even when repeated.

## What the patch does

From the [unchanged Swarm patch](../../corpus/cmp-feature-pubprep/patches/swarm.patch), in
pubprep's argument parser:

```diff
+          const fullName = mapping[trimmed];
+          if (!selectedReviewers.includes(fullName)) {
+            selectedReviewers.push(fullName);
+          }
+        }
+        // The requirement says: "the full agent names in the order tech-debt, docs, security whatever order they were typed"
+        // Wait, "in the order tech-debt, docs, security whatever order they were typed" is ambiguous.
+        // "the full agent names in the order tech-debt, docs, security whatever order they were typed, each once even when repeated."
+        // Re-reading: "the full agent names in the order tech-debt, docs, security whatever order they were typed"
+        // Actually, it probably means: if they typed "docs,tech-debt", it should be ["readme-docs-reviewer", "tech-debt-reviewer"].
+        // But it also says "in the order tech-debt, docs, security".
+        args.reviewers = selectedReviewers;
```

Names are appended in the order typed. The comments are part of the delivered patch. Its own
test expects the same order:

```diff
+    expect(parseArgs(["--reviewers", "security,tech-debt,security"]).reviewers).toEqual(
+      ["security-reviewer", "tech-debt-reviewer"],
+    );
```

## What the held-out test checks

From the
[held-out test](../../corpus/cmp-feature-pubprep/held-out/test/reviewers.held-out.test.ts):

```ts
  it("maps short names to agent names in canonical order", () => {
    expect(parseArgs(["--reviewers", "security,tech-debt"]).reviewers).toEqual([
      "tech-debt-reviewer",
      "security-reviewer",
    ]);
```

Its output on the Swarm patch, from the
[full output](pubprep-reviewer-ordering/held-out-direct.txt):

```text
 FAIL  test/reviewers.held-out.test.ts > parseArgs --reviewers, held out > maps short names to agent names in canonical order
AssertionError: expected [ 'security-reviewer', …(1) ] to deeply equal [ 'tech-debt-reviewer', …(1) ]

- Expected
+ Received

  Array [
-   "tech-debt-reviewer",
    "security-reviewer",
+   "tech-debt-reviewer",
  ]
```

The signed bundle records each held-out test's outcome and a digest of the output, not its
text. This excerpt is the same test on the same patch, run directly in the same pinned image
(step 5 below).

## Both patches, same criteria

Same base, requirement, sealed test, declared checks, isolation and dependency policy for both.
Every value is read from the fresh signed results or the runner's record.

| | Swarm patch | `reference-2` |
| --- | --- | --- |
| Result | `incomplete`: a held-out check failed | `complete` |
| Requirement R1 | `failed` | `satisfied` |
| Held-out check (10 tests) | 9 pass, 1 fails | 10 pass |
| `npm run test` | pass: 98 existing tests preserved, 4 added tests pass | pass: 98 existing tests preserved, 1 added test passes |
| `npm run typecheck`, `npm run build` | pass, pass | pass, pass |
| Regression against the base | none | none |
| Execution | isolated container, network closed for checks | isolated container, network closed for checks |
| Evidence delivery | signed | signed |
| `verify` exit code | 1 | 0 |
| Offline validation | integrity holds, not accepted (exit 1) | integrity holds, accepted (exit 0) |

[`reference-2`](../../corpus/cmp-feature-pubprep/patches/reference-2.patch) is the recorded
reference patch with tests, not an independent customer's submission. The project checks ran
inside the verifier's container; they are not a GitHub CI run of pubprep.

## What ran, and where

- **On the host:** the runner cloned pubprep at `99d8d054753b4e8979431eb58792895c754fbdc9` and
  ran `npm ci`. Sealing then ran the held-out check at the base (it fails) and with the recorded
  reference patch without tests,
  [`reference.patch`](../../corpus/cmp-feature-pubprep/patches/reference.patch) (it passes), and
  moved the test out of the clone. That is a third patch execution, apart from the two verdicts.
- **In a container, once per candidate:** `swarm-verify verify` in a `node:24` image pinned by
  digest, dependencies installed from the lockfile, checks run with the network closed, 4096 MiB
  and 2 CPUs. The candidate is applied only inside that run's scratch checkout; the requirement,
  the sealed test and the signing key stay outside it.

## Recorded then, reproduced now

The case comes from Swarm Orchestrator's 2026-11-04 comparison
([summary](https://github.com/moonrunnerkc/swarm-orchestrator/blob/5d89342f919ac5faa1e3a98f705ea26854597478/docs/acceptance/2026-11-04-comparison/README.md),
[criteria](https://github.com/moonrunnerkc/swarm-orchestrator/blob/5d89342f919ac5faa1e3a98f705ea26854597478/docs/acceptance/2026-11-04-comparison/feature-pubprep/criteria.md)).
That record says, and this page does not independently prove, that the requirement and held-out
test were committed
([90afcf5](https://github.com/moonrunnerkc/swarm-orchestrator/commit/90afcf52b2bb54930bed7befb3dac2de6d7452e0))
before the agent started; that the agent reported its run complete; that swarm-verify 2.0.3
judged the patch `incomplete` with R1 `satisfied`; and that the held-out test and reference
patches were written by the comparison's author, an AI assistant working for the maintainer.

Reproduced now: the patch and held-out test are byte-identical to that record, the same single
test fails, and 3.1.0 reads R1 `failed`. The corpus leaves R1 unspecified for this patch, so the
status above comes from the signed result, not from the runner agreeing.

## Reproduce it

Needs Node.js 22.13.0 or newer, npm, Git, network access to GitHub and npm, and a Docker daemon
that enforces memory and CPU limits. No credentials. On macOS the directory must be under your
home, which Docker's VM shares. Measured on macOS arm64 (Node 24.15.0, Docker 29.5.2 in colima,
image already pulled): steps 1 to 4 took 108 seconds.

```sh
mkdir "$HOME/pubprep-case" && cd "$HOME/pubprep-case"

# 1. The case fixtures and the runner, at a pinned commit of this repository.
git clone -q https://github.com/moonrunnerkc/swarm-verify.git fixtures
git -C fixtures checkout -q --detach b0887244e4ad9e1dfdb25e5241b871564b395fa9

# 2. The published verifier, at an exact version. The last line prints 3.1.0.
npm install --prefix tools --no-audit --no-fund swarm-verify@3.1.0
CLI="$PWD/tools/node_modules/swarm-verify/dist/swarm-verify.js"
node "$CLI" --version

# 3. A throwaway signing key for this shell, so the run neither uses nor creates a keychain key.
export SWARM_SIGNING_KEY="$(node -e 'console.log(require("node:crypto").generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}))')"

# 4. Both patches against the same base, requirement and sealed test.
node fixtures/scripts/corpus.mjs --only cmp-feature-pubprep --patches swarm,reference-2 \
  --cli "$CLI" --work "$PWD/work" --out "$PWD/corpus-run.json"
```

The runner exits 0: both observations matched the recorded expectations, which is not both
patches being accepted. `corpus-run.json` records each `verify` exit code, 1 for `swarm`
(expected) and 0 for `reference-2`. The signed bundles are in
`work/cmp-feature-pubprep/verdicts/`, with statuses in each `statement.json`.

Validate both offline against the historical patch bytes:

```sh
for patch in swarm reference-2; do
  E="work/cmp-feature-pubprep/verdicts/$patch"
  node tools/node_modules/swarm-verify/verify.mjs "$E/attestation.sigstore.json" \
    --key "$E/attestation.pub.pem" --evidence "$E" \
    --patch "fixtures/corpus/cmp-feature-pubprep/patches/$patch.patch"
  echo "$patch: verify.mjs exit $?"
done
```

Exit 1 for `swarm` (integrity holds, task not accepted), 0 for `reference-2`; 6 would be an
integrity failure. You can trust this key because your own shell made it.

Step 5, optional, prints the assertion output quoted above and exits 1. It installs pubprep's
dependencies in a container with the network open:

```sh
git clone -q https://github.com/moonrunnerkc/pubprep.git direct
git -C direct checkout -q --detach 99d8d054753b4e8979431eb58792895c754fbdc9
git -C direct apply ../fixtures/corpus/cmp-feature-pubprep/patches/swarm.patch
cp fixtures/corpus/cmp-feature-pubprep/held-out/test/reviewers.held-out.test.ts direct/test/
docker run --rm -v "$PWD/direct:/w" -w /w \
  node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413 \
  sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && NO_COLOR=1 npx vitest run test/reviewers.held-out.test.ts'
```

## Evidence

This run is kept unchanged in [`pubprep-reviewer-ordering/`](pubprep-reviewer-ordering/):
[`run-summary.json`](pubprep-reviewer-ordering/run-summary.json) (versions, digests, results),
the runner's [record](pubprep-reviewer-ordering/corpus-run.json) and
[output](pubprep-reviewer-ordering/runner-output.txt), and the signed bundles for the
[Swarm patch](pubprep-reviewer-ordering/evidence/swarm/statement.json) and
[`reference-2`](pubprep-reviewer-ordering/evidence/reference-2/statement.json).

Verifier: npm `swarm-verify@3.1.0`, integrity
`sha512-xpAfXmNioZQVadKqldljIjLX6cAtLAqxqU08CFZ1Nu6Qt6Ha7saJBd0UZsTUksue5oTb/u2XnHcrhU95e8DlGw==`.
Its npm provenance names tag `v3.1.0` at commit `b0887244e4ad9e1dfdb25e5241b871564b395fa9`, where
the `v3` Action alias also points. The fixtures are pinned to that commit separately.

To validate the committed bundles, run this from the root of a checkout that has this page,
after step 2. The public key sits in the same repository as the bundles, so this shows they are
intact and consistent, not who signed them:

```sh
for patch in swarm reference-2; do
  E="docs/case-studies/pubprep-reviewer-ordering/evidence/$patch"
  node "$HOME/pubprep-case/tools/node_modules/swarm-verify/verify.mjs" \
    "$E/attestation.sigstore.json" --key "$E/attestation.pub.pem" --evidence "$E" \
    --patch "corpus/cmp-feature-pubprep/patches/$patch.patch"
  echo "$patch: verify.mjs exit $?"
done
```

## Limits

This is one attempt by one agent on one task, not a benchmark, and it supports no comparison
between agents. The detection belongs to the supplied acceptance test and to the verifier running
it: Swarm Verify did not understand the requirement or invent the missing test, and it catches a
missed requirement only where a supplied check exercises it. Passing tests are not complete
correctness, for `reference-2` as much as any patch, and a signature does not prove the checks
were sufficient. The evidence is tamper-evident: the signature shows a bundle has not changed
since it was signed. It was signed with a throwaway key, so the public key beside it shows
consistency, not a trusted signer. An Action run without declared requirements covers regressions
only.
