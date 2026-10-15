# SQLite RunStore

`openSqliteRunStore({ filename, busyTimeoutMs?, clock? })` returns an `OperationResult<SqliteRunStore>` implementing every approved `RunStore` method. Call `close()` at shutdown. The parent directory is operator-configured and must already exist. There is no singleton or in-memory fallback.

```ts
import { openSqliteRunStore } from "@bflow/persistence";
const opened = openSqliteRunStore({ filename: "/configured/data/runs.sqlite" });
if (!opened.ok) throw new Error(opened.error.message);
const store = opened.value;
try { const run = await store.get("run-1"); /* inspect OperationResult */ }
finally { store.close(); }
```

## Driver and schema

The implementation uses real `node:sqlite`, available without a flag on Node >=22.13; verified here on Node 22.23.2. The native API remains experimental in Node 22. The small `sqlite.ts` loader uses `createRequire` because the workspace's Vite 5 built-in list predates this module. No additional dependency or lockfile change is required. DatabaseSync executes synchronously: short local transactions are supported, not a non-blocking database worker service.

Migration 1 in `src/migrations.ts` creates STRICT run, event, operation receipt, command receipt and checkpoint tables. `PRAGMA user_version` is updated in the same migration transaction; a future schema is rejected, never downgraded. Foreign keys are enabled on every store connection. Unique indexes protect event IDs globally, per-run sequence/version/event idempotency keys, and per-run command IDs/keys. Query indexes cover workflow/status, creation time and checkpoint position.

Connections use WAL, synchronous FULL and a configurable busy timeout (default 5000 ms). Every mutation uses BEGIN IMMEDIATE; its budget is checked before acquiring the writer lock, immediately after acquisition, during batches and before COMMIT. Failed validation, stale versions, SQL constraints, cancellation or pre-commit expiry roll back all events, receipts and run index updates. After COMMIT the committed outcome is returned, not a retry-safe timeout. SQLite busy errors map to conflict; expiry while waiting maps to timeout/not_started. `timeoutMs: 0` expires immediately. An omitted timeout has no operation deadline, but lock waits remain bounded by busyTimeoutMs. DatabaseSync cannot be interrupted during a native statement; checks prevent its uncommitted effects from becoming durable after expiry.

## Events, receipts and checkpoints

Parsed event batches use exported compatibility and batch validators. Original events (including complete `command.completed` receipts) remain authoritative for Core replay. Operation receipts retain canonical SHA-256 fingerprints and original create/append results across reopen. Same key/different content conflicts; duplicate append returns the original position and all duplicate event IDs without writing again. Command receipts are indexed in the event transaction, preventing duplicate command identities from acquiring new effects under a new append key.

The maintained snapshot is a storage/query projection of explicit event fields, not Core's aggregate/recovery state. It does not generate attempt IDs from Core's private algorithm: an ID appears when dispatch/binding supplies it. It never derives success from agent output, gates or approvals. Consumers reconstruct the complete aggregate through Core from authoritative events or a Core-generated aggregate checkpoint. Do not use `get().snapshot` as a tail-recovery checkpoint or dispatch decision.

`create` preserves the supplied initial snapshot position. For a new complete history, Runtime must create a version/sequence-zero seed before appending the entire initial Core event batch. A nonzero imported seed declares an incomplete history baseline; no earlier events or command outcomes are fabricated. Such an import needs an authoritative aggregate checkpoint for recovery, or full history supplied separately.

Checkpoint writes require the current expected aggregate version and matching stream position. Both approved codecs are decoded with exported validators; state/envelope/run/workflow/task identity mismatches fail closed. Snapshot-only checkpoints remain accepted as storage records but cannot independently recover auxiliary state. Full aggregate state (approval/gate/cancellation/retry/receipt data) is stored unchanged, not re-created. Corrupt/unsupported latest checkpoints return typed failure; no silent fallback or recovery success is claimed. Stored JSON has a checksum plus schema/index validation. Checksums detect corruption, not malicious database edits by its trusted operator.

Read methods use consistent SQLite read transactions. Pages are keyset ordered (runs by run ID, events by sequence); cursors are versioned and scoped to query/run. `eventTailCursor(runId, afterSequence)` creates an exclusive tail cursor compatible with `readEvents`. Pagination is not a point-in-time snapshot across separate calls.

## Verification and handoff

From root: `pnpm exec vitest run packages/persistence/test/run-store.test.ts` (build first for the subprocess tests). Tests use temporary real databases, reopen, concurrent connections/processes, rollback, lock deadlines, history gaps, codec corruption and idempotency collisions.

P06 must persist complete dispatch-intent events before transport, persist execution binding/receipts, preserve unknown_delivery after restart and never blindly resend. Lease/fencing checks and Core replay belong to their owners. There is no atomic transaction across RunStore, artifact filesystem/catalog and Herdr. Power-loss behavior, network filesystems, multi-host guarantees and deployment on other Node versions are NOT VERIFIED. No prototype database migration invents missing command receipts. Back up SQLite consistently (including live WAL semantics), not by copying only the main file during writes.
