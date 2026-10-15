# Filesystem ArtifactStore

`await openFilesystemArtifactStore({ root, storeId, busyTimeoutMs?, clock? })` returns an `OperationResult<FilesystemArtifactStore>` implementing all approved `ArtifactStore` methods. Call `close()` after active streams finish. The root is configured by the operator, never supplied by an agent/URI. New roots are private directories; existing roots must be canonical, without symlink ancestors, and not writable by other users.

```ts
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
const opened = await openFilesystemArtifactStore({ root: "/configured/artifacts", storeId: "local" });
if (!opened.ok) throw new Error(opened.error.message);
const store = opened.value;
try { const references = await store.find({ runId: "run-1" }); /* inspect OperationResult */ }
finally { store.close(); }
```

## Layout and publication

The root contains `catalog.sqlite` (WAL + FULL synchronous), `stage-<uuid>`, `blob-<uuid>` and transient `read-<uuid>` files. The versioned SQLite catalog stores validated references, metadata, tombstones and immutable idempotency receipts. Its persisted store identity prevents accidentally reopening another store under a different URI namespace. Native SQLite uses the same dependency-free Node >=22.13 requirement as persistence; tested on 22.23.2. No import/dependency between these leaf packages is introduced.

`put` streams bytes in at most 64 KiB owned write buffers, computes SHA-256 or SHA-512, verifies expected size/checksum, fsyncs the file, renames inside the same root, and fsyncs the directory. Only then does a BEGIN IMMEDIATE transaction publish catalog metadata and the receipt. All operations share one deadline budget; expiration before catalog commit rolls back and cleans this operation's temporary/published orphan. A committed outcome is returned without a false timeout. Timeout/not_started describes the public catalog operation, not absence of private temporary file I/O.

Each producer chunk is consumed synchronously in one JavaScript turn: copy at most 64 KiB into an owned buffer, completely write it (including short-write handling), then hash/count those same bytes. No mutable caller view survives an await. This supports large chunks with bounded additional memory, without cloning a whole large chunk or queueing unbounded asynchronous writes. Resizing/reusing a producer buffer later cannot change the stored bytes; a checksum/size describing different bytes is rejected. Final file size/type/nlink are checked before publication. Open, fsync, close and publication remain asynchronous. The tradeoff is event-loop blocking during chunk ingest: budget checks happen between segments, but native regular-file I/O cannot be forcibly interrupted. Producers should yield moderate chunks for responsiveness; this is a local store, not a non-blocking I/O worker service.

Filesystem publication and SQLite commit are NOT one atomic transaction. A crash before catalog commit may leave an unindexed stage/blob; it is never discoverable through references/queries. Crash recovery is fail-closed: do not automatically adopt orphans. Normal failures, checksum mismatch, cancellation, receipt collision and duplicate writes remove this operation's unused files. Offline orphan/retention cleanup must coordinate with live writers/readers; no unsafe automatic sweep is performed.

Concurrent connections/processes use the SQLite writer lock and unique identity/receipt constraints, not an in-memory reservation map. Duplicate keys require identical parsed write options AND verified incoming bytes; the stored blob is also reverified before returning the original receipt. Different payloads conflict. Artifact IDs are immutable; a different key cannot overwrite an existing ID. Receipt identity persists after reopen and deletion. Only URI-representable artifact IDs (`[A-Za-z0-9._-]+`, excluding `.`/`..`) can be published: the approved Reference schema does not permit arbitrary Unicode/space IDs even though WriteOptions can parse them. Those inputs return validation, not a forged reference.

## Integrity and safety

`get` parses and matches the entire reference against the trusted catalog, rejects non-regular/symlink/hard-linked paths before opening, then opens the catalog-selected blob with O_NOFOLLOW and O_NONBLOCK where supported. Descriptor/path inode and device identities are checked after open, and a failed check closes the descriptor. FIFO/socket/device files are not valid blobs; a FIFO cannot trap the operation in a blocking read open. It copies to a private bounded-buffer read snapshot while hashing and validating size, then yields bytes only after the whole snapshot passes integrity checks. Old/corrupt/forged/outside-store references cannot yield successful bytes. A streaming consumer's early return cleans the snapshot. Cleanup attempts all descriptors and temporary-file removal even when one close fails, returning a typed failure. The additional disk copy is intentional: hashing while already yielding bytes would expose corrupt data before detecting it. `resolve`/`find` return catalog metadata; they are not assertions that an external process has left the blob intact since publication.

`resolve` and `find` run their queries and materialization inside a single BEGIN DEFERRED read transaction. Concurrent tombstone commits in another WAL connection do not change that response's snapshot; pagination across separate calls is still not a long-lived snapshot. Budget/cancellation checks bracket each observation, including after materialization. Post-query expiry is timeout/observation_only, while invalid deadlines are validation errors. These checks are intentionally separate from mutation handling: put/delete return their committed outcome even if the clock/AbortSignal changes after COMMIT.

All filesystem names are generated UUID names or fixed catalog names, never raw artifact IDs or URI paths. Root inode/device/canonical identity is rechecked, catalog symlinks/hard links are rejected, and blob opens are no-follow. This defends untrusted artifact references and pre-existing path attacks. It is not protection against a hostile process with the same filesystem authority continuously swapping paths between syscalls: Node does not expose a complete openat-style directory-handle API here. Store roots and ancestor directories must be operator-controlled. No file content, prompts or sensitive metadata are logged.

`delete` atomically tombstones catalog visibility and retains receipts/blobs for audit and active-reader safety. Repeated deletion returns false; old keys/IDs stay reserved, preventing silent resurrection. This is logical deletion, NOT secure physical erasure. Offline retention cleanup is a separate operator policy. Missing references return null; missing reads return not_found. Every stream failure is a structured OperationResult.

AbortSignal/timeout bound stalled upstream `next()` calls as well as normal streaming. Timeout zero expires immediately; timers are chunked/re-armed for large delays. A producer that ignores cancellation cannot be forcibly stopped by the store; its iterator.return is requested, and local resources are cleaned without awaiting a permanently blocked producer.

## Verification and handoff

From root: `pnpm exec vitest run packages/artifact-store/test/artifact-store.test.ts` (build first for subprocess tests). Temporary real files/catalogs cover binary/empty/large streams, concurrency across instances/processes, restart receipts, corruption, unsafe paths/symlinks, cancellation, lock deadlines, rollback and verified read snapshots.

P06 owns authorization, proposal ingestion, retention policy and orchestration between RunStore, ArtifactStore and transport. Publishing an artifact does not mean an agent task succeeded. Runtime must durably record trusted references and separately handle uncertain Herdr delivery; no cross-resource or distributed exactly-once guarantee is claimed. Power-loss testing, network filesystem behavior, hostile same-user path replacement and multi-host storage are NOT VERIFIED. Physical disk usage grows with retained tombstones/orphans until a coordinated retention policy is adopted.
