# Task handover — internal specification and implementation plan

Authority: project-owner request (2026-10-26), its eight acceptance criteria and explicit implementation authorization. No public contract or shared document change is authorized. Baseline: bc29647917b0f8a32b6172cb4b277ab81d393361.

Conditional TDD decision: required. Deterministic recovery, persisted input validation and generation fencing are security-sensitive behavior; failing tests precede implementation. Tests use local Runtime/host fixtures, not live-provider acceptance.

Acceptance criteria:
- H1: strict version-1 private proposal has nextAction, decisions, disprovedHypotheses, untestedAngles and references (source locations or evidence identifiers). Empty lists mean no recorded items, never fabricated history.
- H2: host binds run/task, assignment message, attempt number/ID, Core generation and rework generation, worktree path/HEAD, accepted spec ID/version/fingerprint and requirement fingerprint. No agent-supplied identity is trusted without exact comparison.
- H3: canonical envelope <=16 KiB UTF-8, each list <=8 entries, text <=768 characters, <=16 references. Bounded nonblocking regular-file reads; malformed/unknown fields/oversize produce diagnostic codes.
- H4: only authenticated current Developer with renewed lease may propose. Store outside Git worktree under Runtime state, serialized by existing journal transaction, atomically replaced. One latest envelope per run/task, no log copy.
- H5: on context reads host selects exact current binding or a host-recorded earlier attempt in the same Core and rework generation, with matching current HEAD/spec/requirement. A generation change fails closed. Retry retains explicit source attempt, never relabels history. Missing legacy data returns absent; corruption/staleness returns withheld diagnostic, recovery continues.
- H6: handover is an untrusted JSON data field with explicit warning. Never approval, verification evidence, grant, specification or policy mutation. References are navigation hints, never trusted ArtifactReference claims.
- H7: full/compact/active-only assignment context retain authoritative current requirements, approval requests/decisions, pending user decisions/blockers, task criteria and policy receipts separately from handover. No handover content is inserted into system instructions.
- H8: restart reuses durable handover through the same host read path; existing Core checkpoint/rework/memory behavior and missing handover remain compatible. No provider switching, checkpoint redesign, migration, commits, push or PR.

Implementation plan (inline):
1. RED private store/admission/selection tests: roundtrip + new instance restart; missing; malformed/oversize/count limits/special files; binding mismatches; prior attempt; policy injection remains data.
2. GREEN private task-handover.ts; reuse rework source-location schema and journal digest/locking conventions.
3. RED Runtime/host integration tests using existing real local workflow fixture, including restart/retry/stale generation/spec/revision and pending decisions; context compaction test.
4. GREEN Runtime read/propose guarded operation, host tools and assignment/workspace integration, preserve mandatory context in compaction. Update package README only.
5. Review ownership and security boundaries; run targeted tests then required check:deps/typecheck/test/diff/status; record exact evidence. No generated files committed.

Design rulings: same generation required even on retry, because a new generation changes authority; carry across generations is withheld explicitly. Prior attempt path may differ only through recorded assignment provenance, revision must remain exact. References are bounded hints and never dereferenced automatically. Absence or rejection cannot block existing recovery. User-provided requirements are the accepted scope; this file does not claim a Bflow run approved itself.

Review ruling: Core generation and rework generation are separate domains. Real rework test demonstrated a new rework cycle can keep Core generation unchanged; bind both and withhold prior repair-cycle context explicitly. Canonical byte limit is rechecked after source-location normalization. Read-only retired assignments retain authority while their handover is withheld.

Transport ruling: Agy's 8500-byte inline budget is smaller than the 16-KiB canonical handover. Automatic context uses an explicit deferred read; the private read tool pages exact JSON (UTF-8 boundaries, state-fingerprint cursor, offset continuation), including full host obligations and task ownership. Stale cursors reject mixed snapshots. Acknowledgements omit bodies. Tests assert bounded pages and exact reassembly, not silent truncation. No provider switch or checkpoint change.
