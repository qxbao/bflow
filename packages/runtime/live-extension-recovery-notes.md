# Native extension recovery follow-up, 2026-11-04

This is a scoped repair under ext-2, ext-6 and ext-9 of the owner-approved
`live-extensions-design.md`. It does not change the public contracts or grant
business approvals. The owner requested continuation and approved the currently
presented gates on 2026-11-04; later document/delivery gates keep their authority.

Live diagnosis on `db97e1e8` found three distinct blockers before any injected fault:

- After a provider failure, Analysis/QA attempted the same Core bind command at a
  different aggregate version. Its immutable idempotency key correctly collided.
- Native Codex startup appended screen-reader detection and model-introduction
  counters to the private profile. Their bytes changed a pinned source despite
  leaving model, permissions, hooks, skills and Trust unchanged.
- An accepted extension execution could outlive its lease after a provider turn
  failed. Cancellation could neither renew that lease nor finish resource cleanup.

## Required behavior

1. Read authoritative Core state before repeating bind or binding verification.
   Reuse only an identical handle/proof; reject any mismatch. Do not send again,
   substitute logical handles, or invent a receipt. A lost persistence
   acknowledgement must recover through event replay.
2. Ignore only Codex's exact generated trailing presentation tables with the
   supported Boolean screen-reader flag and integer introduction counters 0–4.
   Unknown keys, malformed syntax, multiline-string fragments, permission/model
   changes and unrelated Trust entries remain guarded. CLI capture and host
   revalidation share the projection. An unchanged legacy source digest remains
   valid byte-for-byte; a mismatched legacy digest is not silently migrated.
3. An expired lease never authorizes an interrupt. Require a fresh observation of
   the exact old handle in an idle/finished/cancelled transport state, correlated
   by the transport and observed after the cancellation request. A finished turn
   is only stop evidence, never task-success evidence.
4. Before retiring expired capacity, acquire a separate, fresh fenced Registry
   cleanup lease for the same run/task/attempt. The Registry must refuse it while
   that attempt has an active reservation. It cannot dispatch work or admit an
   output. Preserve the original execution and lease in the WAL.
5. Persist cleanup acquisition and release intents before side effects. Preserve
   uncertainty after a missing acknowledgement and recover using the same
   idempotency keys. The cleanup lease is never renewed, so its eventual expiry
   can also settle an interrupted cleanup. Do not return Core stop confirmation
   while an active cleanup reservation has no release acknowledgement.

## Verification and evidence boundary

Filesystem/SQLite/Registry/Core tests reproduce the bind and verification replay
collisions, the UI-only source change, and expired cancellation. Negative cases
cover unrelated profile authority, invalid correlation and a newer reservation;
fault cuts cover lost cleanup acquisition/release acknowledgements. These are
local tests with a fake transport, not live Herdr/provider acceptance.

The completed `db97e1e8` baseline checks remain historical evidence: 7,501 unit
passes, 434 Web passes and 85 E2E passes. The follow-up source requires its own
verification and live recovery. No injected-fault failover or BA publication is
claimed by this note. Runtime journals, approvals, old provider errors and failed
test logs are retained without rewriting.
