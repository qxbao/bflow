# P17 integration handoff

Only `packages/verification/**` and `agents/verifier/**` are owned here. No shared
contract, migration, root build configuration, or lockfile change is part of P17.
The predecessor baseline is `d8c6d18120c7a01a4bf8aad13f14660d20e0cdf6`, containing
the P11 contract freeze and reviewed P15/P16 implementations. Local `origin/main`
was `4e818b4a7c0c9b102bf1e85906a24d57fd6c192c`; it was an ancestor, six commits
behind local main. No remote write is performed.

Under the user's review/fix/merge authorization, local integration registers
`{ "path": "./packages/verification" }` in root `tsconfig.json` and the package
importer in `pnpm-lock.yaml`. Existing dependency versions are preserved. Root
build/typecheck now includes P17, and root tests discover its cases automatically.
The root README also records package status and the targeted test command. These
shared-file changes belong to the integration commit, separately from source ownership.

P19 must compose the exported contract ports with the authoritative Runtime:

- Persist the latest returned `VerificationCycle` using optimistic versions before
  routing rework; authenticate the latest snapshot and prevent stale-snapshot replay.
- On failed result, route `findings[].details.taskId/responsibleRole` through the
  Coordinator, then record the new Developer repair/attempt/changeSet. Never reset
  the cycle to recover retry budget. The default is three total verification
  iterations (initial submission plus at most two repairs), configurable 1–10;
  Core's rework policy can impose a lower limit.
- Route the returned `RoleMessage` envelopes through Runtime. No direct Herdr
  calls, lease bypasses, dispatches, or Conversation messages originate here.
- Supply approved isolated gate capabilities, authenticated executor/implementer
  identities, authoritative Git snapshots, materialized proposal bytes, and the
  authoritative approved specification lookup. Metadata assertions alone do not
  prove physical isolation or real Git state. Automated checks must report actual
  command/exit status, test names and criterion measurements.
- Supply exhaustive dependency paths only when safe to reuse unaffected evidence;
  otherwise leave `dependsOnPaths` absent. Workflow checks always run again.
- The workflow verification task has its own task ID; supply the integrated head
  and participating task IDs through the `integration` option. Do not pass a
  task-level result as workflow acceptance evidence.
- Reconcile persisted intent after storage error, crash, timeout or cancellation.
  A runner timeout does not prove the remote process stopped. The engine never
  automatically resends an execution. ArtifactStore and Runtime state are separate
  transactions. Runtime owns operation cancellation and dispatch recovery.
- P16 remains the conditional TDD policy/evidence dossier owner. P17 validates its
  contract strategy, configured commands/levels/mappings and aggregate coverage;
  P19 must compose P16 Red/Green/refactor enforcement before business acceptance.

No new contract decision is requested. `VerificationPlan`, check configurations,
observations and repair/integration options are local engine configuration/codecs;
exchanged data uses the existing contracts and their metadata slots. P15's stored
requirements document is validated with approval lifecycle fields restored, then
compared excluding only status/approval/reference/update-time fields, matching
P15's `contentBytes()` semantics. Requirement drift still invalidates the plan.

[Examples](examples/) were captured from the fake runner and validated with
`VerificationResultSchema`. They illustrate structured outcomes; their test-store
URIs are fixtures, not deployable artifacts. The fake runner and byte-storing fake
ArtifactStore live only in `test/fixtures.ts`. Live Herdr execution, P18 Git
integration, P19 Runtime enforcement and remote closure are not verified here.
