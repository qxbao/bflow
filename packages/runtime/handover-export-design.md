# Handover export (HX-01) — specification and implementation decision

Status: requested by the project owner on 2026-10-28; the request's mechanism, acceptance and test list are normative.
This document records the implementation choices. No commit, push or PR is authorized.
Baseline: `ae866899dff673f0917e80efe4293c5db0b4e43d` (local `main` equals `origin/main`; P24 `8dbb056` is an ancestor).
Worktree: `/mnt/01DCE9A4D6522BD0/Project/AI/wt-handover-export`, branch `agent/runtime/handover-export`.

## Source findings

- Authoritative run state is the Runtime-private agentic journal `<private state>/agentic/journal/state.json`, written by
  `AgenticJournal` (flock + fsync/rename). `readAcceptedExecutionPlanInput` already reads it lock-free, with owner/mode checks and
  `parseAgenticJournalState`; the exporter reuses that pattern. One read of the file is one snapshot.
- `RunRecord` carries the accepted `workflowSpec` (specification, approval request/decision, test strategy), `definition`
  (tasks with `acceptanceCriteria` ids), per-task `changeSet`/`cycle` (`VerificationCycle` with `VerificationResult` history),
  the integrated `workflowChange` and the workflow-level `workflowCycle`, the delivery `approval`/`decision`,
  `userDecisions` (including Reviewer test-integrity exceptions), `supersededApprovals` and `fastPath`.
- The delivery approval is created only after a passed workflow verification of a verified integration. Its identity is
  deterministic: `delivery-${digest([runId, verificationId])}`, idempotency key `delivery:${runId}:${verificationId}`, evidence
  equal to that result's `evidenceArtifacts`. `status: "completed"` follows only an authenticated approved delivery decision.
- Workflow `VerificationResult.changeSet.headCommitHash` and each gate's `metadata.verification.sourceRevision` equal the
  integrated revision `workflowChange.headCommitHash`. Specification acceptance-criterion `status` is not updated by the Runtime
  (it stays `pending`), so verdicts come from verification results, never from that field. `waived` + `waiverReason` in the
  approved specification is the only criterion waiver.
- Trusted evidence is an `ArtifactReference` in the filesystem ArtifactStore `<private state>/agentic/artifacts`
  (store id = URI authority). `get` checks the reference against the catalog and yields bytes only after size/checksum
  verification (`not_found`, `corruption` errors). Opening a missing store root would create it, so the exporter opens it only
  when its catalog exists. `get` uses private read snapshots inside the store root; it never changes catalog, run, approval or
  delivery state.
- `WorkflowTelemetryReportSchema` is a Runtime-exported schema the CLI parses; the handover schemas follow that precedent.

## Decision: no shared contract change in this version

The package format is a Runtime-owned, strictly versioned output schema (`HandoverDocumentSchema`, `HandoverManifestSchema`,
`HandoverExportResultSchema`, exported from `@bflow/runtime`) parsed by the CLI at ingress, like the telemetry report. Nothing
is added to `@bflow/contracts`, root config, lockfile, root README/AGENTS/docs.

Promotion to `@bflow/contracts` was reconsidered (HX-01 follow-up) and is **deferred**, not proposed now:

- The only producer and consumer are Runtime and the CLI, which already share the Runtime export; no package or external
  verifier needs the schema without Runtime.
- The format changed during this follow-up (evidence `packaging`, `journal_file` source, evidence paths). Freezing it in the
  review-gated contracts package before it has been used would make each such change a cross-owner contract amendment.
- Contracts changes require an integration decision with an approving owner (AGENTS.md); there is no consumer to justify one.

Revisit when an independent verifier (another package, CI job or third-party tool) must read packages without depending on
`@bflow/runtime`, or once the format has been stable across a release. The migration would then be additive: the same
`schemaVersion: 1` / exporter version 1 shapes moved under a contracts export, with Runtime re-exporting them; affected owners
Contracts, Runtime and CLI.

The format has not been released, so the follow-up changed version 1 in place rather than adding version 2. From now on a
shape or rendering change bumps `HANDOVER_EXPORTER_VERSION`.

## Mechanism

1. Input: run id plus `--revision <integrated 40-hex commit>` and/or `--snapshot <sha256>`; at least one is required. The
   snapshot id is `digest({format, journalVersion, repository, run})` over the canonical, publicly projected run record. A
   requested snapshot that differs from the current one, or a revision that differs from the integrated revision (or a revision
   for a run without one), is a conflict and nothing is written. `bflow handover inspect` reports both identities read-only.
2. Collected from that single snapshot: specification id/version/level/status, criteria, task definitions and outcomes,
   integrated change, task and workflow verification results, findings, approvals (spec, task, delivery, user decisions),
   exceptions/waivers, and every referenced `ArtifactReference`.
3. Validation before use: journal schema (`parseAgenticJournalState`), run/delegation identity, reference run/task ownership,
   ArtifactStore integrity, specification artifact binding (stored JSON `specId` matches), verification revision binding.
4. Matrix row per criterion: tasks that trace it → integrated revision → checks (task scope at the task revision, workflow scope
   at the integrated revision) with status/command/exit code → evidence with integrity. Verdict precedence: `failed` (a bound
   check failed) → `blocked` (a bound result or cycle blocked/escalated) → `passed` (a passed workflow-scope check bound to the
   integrated revision with verified evidence) → `waived` (approved-spec waiver) → `inconclusive` (checks exist but evidence is
   missing/corrupt/unbound or only task scope) → `not_verified` (no check).
5. Open findings: error/warning findings of the latest result of each cycle. Exceptions: approved-spec criterion waivers,
   answered Reviewer test-integrity exceptions (valid only with an authenticated approved decision), fast-path state.
   Unverified: criteria without bound passing evidence, `manual_review`-only criteria, evidence integrity failures, not-checked
   items.
6. Instructions: run/verification commands only from the accepted test strategy `targetCommands` and recorded check commands;
   rollback only from the accepted specification `rollbackPlan`. A missing source is rendered as missing with its expected source.
7. Package: `index.html`, `handover.md` (selectable with `--format`), `handover.json` (document), optional `evidence/<sha256>.txt`
   and `manifest.json` (files with SHA-256/bytes/media type, content digest, source references with digests — the run
   snapshot, the sha256 of the exact journal bytes read, and every artifact — snapshot identity, status, exporter version,
   `exportedAt`). The content digest covers the exporter version and every listed file.
8. Output safety: every free text is `redactString`-ed and length-bounded; HTML escapes all text, has a restrictive CSP and no
   script or external resource; Markdown escapes HTML and link/table syntax. Artifact bytes, raw logs, worktree paths,
   prompts, environment and credentials are never packaged; references are listed as `artifact://` text with the reason they
   were not packaged. With `--include-evidence`, an artifact is copied only when its kind is `test-result`, `report`, `patch` or
   `document`, its integrity is verified, it is valid UTF-8 without NUL bytes, it is at most 1 MiB and the package total stays
   within 16 MiB (budget applied in artifact-id order, so it is deterministic). The copy goes through the same redaction and
   repository-path replacement as report text (line structure kept), is stored as `evidence/<sha256 of the copy>.txt` with
   media type `text/plain` (never rendered as HTML), and records whether redaction changed it; the original store checksum
   stays on the reference. `log` and `agent-output` are never copied. The only links are relative links between package
   files; `verify` checks that packaged evidence named by `handover.json` and evidence files in the manifest are the same set.
9. Export has no Runtime side effects: no journal lock or write, no host/daemon connection, no approval, status or delivery
   change. The exporter writes only the lock file, staging and final output directories beside the target.
10. Content files are a pure function of the snapshot and integrity observations (no timestamps); `exportedAt` lives only in
    the manifest. Exporting the same snapshot twice yields byte-identical content files and the same content digest; exporting
    into an existing identical package reports `reused` without rewriting.
11. Publication: the exporter holds a Linux `flock` on `.<name>.handover.lock` beside the target for the whole export (a second
    export to the same target fails `conflict`; a crash releases the lock; the file is unlinked while held and a waiter that
    locked an unlinked inode retries). Under the lock it removes staging directories of this target left by a crash. Files
    are written and fsynced in `.<name>.handover-staging-<uuid>`, the manifest last, then the directory is renamed to the
    absent target and the parent fsynced; the published directory must have the staging directory's inode. Any failure
    removes this staging directory. A staging directory left by a crash fails `bflow handover verify` by name.
    `--replace` (same run only, no unlisted files) moves the old package to `.<name>.handover-replaced-<uuid>`, renames the
    new one in, fsyncs and removes the old one; a crash between the two renames leaves the target absent and the old package
    beside it (removed by the next export once a target exists), never a partial package at the target name.
    The output parent must be a non-symlink directory not writable by group/other unless it has the sticky bit.
    Writing the manifest after the rename was rejected: a crash would leave `index.html` with an "eligible" banner at the
    real target name without a manifest, which a reader opening the HTML would not notice.
12. Source safety: the journal is opened with `O_NOFOLLOW` below non-symlink ancestors, and owner/mode (owned by the user, no
    group/other bits) are checked on the opened descriptor, so a path swap between check and read is not accepted. An
    ArtifactStore whose root or catalog is group/other-writable or owned by another user is not opened; its evidence is
    `unavailable`.
13. Versioning: verify and export name an existing package's exporter version when it is not this bflow's. A different
    snapshot, run or version is a conflict that says what the directory holds; `--replace` replaces a same-run package.

Eligibility: `eligible` only when the run is completed through a valid delivery approval bound to the final passed workflow
verification at the integrated revision, the accepted specification is approved with verified artifact binding, every
required criterion is `passed` or validly `waived`, no open error finding remains, every referenced evidence artifact is
verified, and the run is not cancelled/superseded. A run that is not completed is `draft`; a completed run failing any other
condition is `partial`. Both are still published, clearly labelled, and the command exits `NOT_READY` (3).

## CLI

- `bflow handover inspect --run <id> [--json]` — read-only identity/eligibility preview; writes nothing.
- `bflow handover export --run <id> (--revision <sha> | --snapshot <sha256>) --out <dir> [--format html|md]
  [--include-evidence] [--replace] [--json]` — exit 0 `ready` (eligible), 3 `not_ready` (draft/partial published), 4 not
  found, 6 conflict (stale snapshot, revision mismatch, export in progress, different existing output).
- `bflow handover verify <dir> [--json]` — offline integrity, package-name, link and status check; exit 0 only for an intact
  eligible package.

## Conditional TDD and tests

Security/evidence-sensitive change: TddDecision `required`. Failing tests are written first for: completed run (eligible),
incomplete run (draft), corrupted artifact (inconclusive/partial), stale approval (partial), repeated export (stable content,
reuse), interrupted publication (no published target, staging rejected), revision/snapshot mismatch, HTML/secret escaping,
link validity, no journal/state mutation, and the built binary. The follow-up (evidence packaging, target lock, empty-directory
race, stale-staging cleanup, replace, exporter version, shared-writable store/parent, journal byte digest) added its failing
tests before implementation. The completed run comes from the real P19 integration
fixture (Core, SQLite RunStore, filesystem ArtifactStore, Git, policies); stale-approval and corruption cases mutate copies of
that real state. Local tests are not live provider/Herdr or full SDLC acceptance.

## Limitations

- Office/PDF output is out of scope. Task-scope evidence is not upgraded to integrated-revision evidence.
- Packaged evidence is pattern-redacted (`redactString`); a secret in an unknown format can remain. Non-text, oversize and
  disallowed kinds stay references.
- A non-bflow process can still create an empty directory at the target between the existence check and `rename`; the
  rename then replaces it (Node has no `RENAME_NOREPLACE`). The package is complete and the inode check confirms it is ours.
- The lock is local `flock`; it requires the `flock` binary (as the journal does) and does not cover network filesystems.
- A process of the same user can still rewrite the journal and the ArtifactStore catalog consistently; the checks raise the
  cost of path swaps but do not isolate same-UID adversaries. Hostile same-UID, network filesystems and power-loss
  durability remain NOT VERIFIED, as for the stores.
- Changing rendering or shape without bumping `HANDOVER_EXPORTER_VERSION` is not detected automatically.
