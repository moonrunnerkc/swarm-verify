# Regression corpus: real repositories

Real tasks from the acceptance runs and comparisons recorded in swarm-orchestrator's
the acceptance records of moonrunnerkc/swarm-orchestrator (its 2026-10-31 and 2026-11-04-comparison directories), each with the patches judged for it.
Every expected status is copied from a recorded judgment; nothing here was run to make it.

Each entry directory holds:

- `entry.json`: the repository (GitHub `owner/name`; `"local": true` where it is private), the full
  base commit, the setup command the acceptance scripts ran in a fresh clone, the isolation, the
  held-out seal glob and command (or null), the source documents, and the patches. Each patch has
  its file, sha256, origin, `expected` (`state`, per-requirement status, held-out result) and a
  one-line `why` citing the record.
- `requirements.json`: the requirement record the judgment used. For runs that recorded no
  separate file it is the run's own record from `result.json`, in the request's shape
  (`expected` renamed `evidence`, as `judge-with-fix.sh` did).
- `swarm.toml`: the declared checks the judgment ran.
- `held-out/`: the sealed files, at their paths, where the task has them.
- `patches/`: the patches, unchanged; human fixes are the fix commit less its held-out files.

`null` means the record does not establish the value: a whole `expected`, a `state`, a
requirement, or a held-out result for an entry that has a held-out check. Most nulls come from
the unreleased verifier's rule that a fix or feature is satisfied only on a witness its author did
not choose (swarm-verify CHANGELOG, Unreleased): a status recorded under 2.0.x on tests the patch
itself added is not carried over. Requirement statuses are kept only where the patch was judged
under the entry's own record.

`e-dossier` needs ironroot cloned beside it (`sibling` in its entry.json); depose entries run on
the host because the image has no Go (`hostReason`).

| Entry | Repository | Base | Isolation | Patches (expected state) | Source |
| --- | --- | --- | --- | --- | --- |
| `cmp-fix-claimcheck` | moonrunnerkc/claimcheck | `d381bec` | isolated | human (complete), claude (complete), swarm (complete) | 2026-11-04-comparison/README.md; 2026-11-04-comparison/fix-claimcheck/criteria.md |
| `cmp-feature-pubprep` | moonrunnerkc/pubprep | `99d8d05` | isolated | reference (null), reference-2 (complete), claude (complete), swarm (incomplete) | 2026-11-04-comparison/README.md; 2026-11-04-comparison/feature-pubprep/criteria.md |
| `cmp-refactor-ironroot` | Aftermath-Technologies-Ltd/ironroot | `1d325c2` | isolated | reference (complete), claude (complete), swarm (incomplete) | 2026-11-04-comparison/README.md; 2026-11-04-comparison/refactor-ironroot/criteria.md |
| `cmp-upgrade-claimcheck` | moonrunnerkc/claimcheck | `d93aea5` | isolated | reference (complete), claude (complete), swarm (complete) | 2026-11-04-comparison/README.md; 2026-11-04-comparison/upgrade-claimcheck/criteria.md |
| `t1-pubprep` | moonrunnerkc/pubprep | `99d8d05` | isolated | swarm-final (null) | 2026-10-31/README.md; 2026-10-31/t1-pubprep/final/ |
| `t5a-depose` | Aftermath-Technologies-Ltd/depose | `830f366` | host | swarm-final (incomplete) | 2026-10-31/README.md; 2026-10-31/t5a-depose/final/ |
| `t5b-ironroot` | Aftermath-Technologies-Ltd/ironroot | `1d325c2` | isolated | swarm-final (incomplete) | 2026-10-31/README.md; 2026-10-31/t5b-ironroot/judged-2.0.3/ |
| `t6-tracemantle` | moonrunnerkc/tracemantle | `47203d2` | isolated | claude (complete), gemma-closing-2 (incomplete), gemma-closing-3 (incomplete), first-round-final (null), gemma4-16.0.2-1 (incomplete), gemma4-16.0.2-2 (incomplete), qwen36 (incomplete), mistral (incomplete) | 2026-10-31/README.md; 2026-10-31/t6-comparison/README.md |
| `t7a-claimcheck` | moonrunnerkc/claimcheck | `d93aea5` | isolated | swarm-closing-3 (complete) | 2026-10-31/README.md; 2026-10-31/t7a-claimcheck/closing-attempt-3/ |
| `h2-ironroot` | Aftermath-Technologies-Ltd/ironroot | `1d325c2` | isolated | claude (null), swarm-closing-1 (incomplete) | 2026-10-31/README.md; 2026-10-31/comparison/h2/ |
| `e-dossier` | Aftermath-Technologies-Ltd/dossier (local) | `1baa9c6` | isolated | installed-16.0.4 (null), 16.0.4-candidate-1 (null), 16.0.4-candidate-2 (incomplete), 16.0.4-candidate-3 (null), 16.0.2 (null), installed-16.0.2 (null), installed-16.0.1 (incomplete), closing-2 (null) | 2026-10-31/README.md; docs/plans/2026-11-04-16.0.4-report.md |
| `fix-claimcheck-d2f136c` | moonrunnerkc/claimcheck | `8efdaa0` | isolated | human (incomplete), swarm-16.0.1 (incomplete), swarm-16.0.2-1 (incomplete), swarm-16.0.2-2 (incomplete) | 2026-10-31/f-fix-isolated/README.md; 2026-10-31/README.md |
| `fix-depose-09b01c1` | Aftermath-Technologies-Ltd/depose | `3429b76` | host | human (null), swarm-16.0.1 (null), swarm-16.0.2-1 (null) | 2026-10-31/f-fix-isolated/README.md; 2026-10-31/README.md |
| `fix-tracemantle-f69ad0c58` | moonrunnerkc/tracemantle | `c37c9d6` | isolated | human (null), swarm-attempt-1 (null) | 2026-10-31/README.md; 2026-10-31/f-fix-isolated/tracemantle-f69ad0c58/attempt-1/held-out-2/ |
| `fix-tracemantle-c4dc276c4` | moonrunnerkc/tracemantle | `07e3694` | isolated | human (null), swarm-attempt-1 (null) | 2026-10-31/README.md; 2026-10-31/f-fix-isolated/tracemantle-c4dc276c4/attempt-1/held-out-2/ |
