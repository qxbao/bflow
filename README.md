# AI Flow SDLC

AI Flow SDLC is a module-first TypeScript platform for coordinating AI coding agents across a software delivery workflow. Herdr operates the agents; this project owns workflow decisions, durable execution records, artifacts, and integration boundaries.

Contracts, the P01-P03 modules, quality-gate evaluators and the Runtime library (`createRuntimeService`) are implemented as libraries. The executable CLI is not implemented. There is no web server or `start`/`dev` command, and Runtime has not been verified end-to-end with live Herdr agents. A runnable library demo on a sample repository is in [`examples/`](examples/README.md); the user guide (Vietnamese) is in [`docs/guide`](docs/guide/README.md).

## Module status

| Package | Current implementation | Entry point / details |
| --- | --- | --- |
| `packages/contracts` | Shared Zod schemas, public ports, transition/batch validators, event/checkpoint compatibility | [Public contracts](docs/contracts.md) |
| `packages/core` | Deterministic workflow engine: DAG readiness, concurrency decisions, transitions, retry/rework, approvals/gates, event replay and aggregate checkpoints; no agent or storage I/O | [`DeterministicWorkflowEngine`](packages/core/src/index.ts) |
| `packages/herdr-adapter` | CLI-backed AgentTransport, reconciliation and conservative execution observations | [`createHerdrAdapter`](packages/herdr-adapter/README.md) |
| `packages/agent-registry` | File-backed role/capability resolution, durable leases, fencing and idempotency; MVP roles, workflow templates, prompts and output validation | [`createAgentRegistry`](packages/agent-registry/README.md) |
| `packages/persistence` | SQLite RunStore: migrations, atomic event/receipt/projection writes, history and versioned checkpoints | [`openSqliteRunStore`](packages/persistence/README.md) |
| `packages/artifact-store` | Filesystem ArtifactStore with SQLite catalog, verified streams, safe references, durable receipts and tombstones | [`openFilesystemArtifactStore`](packages/artifact-store/README.md) |
| `packages/quality-gates` | Command quality gates (`typecheck`/`lint`/`unit_test`/`build`/`custom`), security policy, RBAC and human-governance checks | [`createPresetQualityGate`](packages/quality-gates/README.md) |
| `packages/runtime` | RuntimeService composition: dispatch with leases, proposal ingestion, gates, approvals, cancellation, recovery/resume, event watch. Task results are reported by the caller (`orchestrator.completeTaskExecution`) | [`createRuntimeService`](packages/runtime/src/index.ts) |
| `apps/cli` | Type exports only; no executable commands | [Source](apps/cli/src/index.ts) |

This table describes source availability, not a claim of live Herdr integration or production readiness. Keep it aligned with public entry points when a phase is integrated.

## Requirements

- Node.js **22.13+** for P03's unflagged built-in `node:sqlite`; verified on **22.23.2**. The root `engines` currently declares `>=22`, which is broader than this storage requirement. SQLite is experimental on the verified Node 22 runtime.
- pnpm **12.5.1**, as pinned in `package.json`.
- The verified test environment is Linux/local filesystem. Storage/security tests include POSIX fixtures such as `mkfifo`, Unix sockets, symlinks and hardlinks; other platforms are not verified.
- Herdr is not needed for the standard test suite. Real transport use requires the supported CLI/server and an existing pane/session; the adapter checks CLI **0.9.1**, protocol **22**, schema **1**. Do not control real sessions without explicit authorization.

## Quick start

From the repository root:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` verifies the dependency graph, typechecks, builds and runs all tests. Tests use temporary storage and injected Herdr runners, not live agent execution. Read actual pass/fail counts from the current run rather than treating a historical count as a release guarantee.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Compile workspace packages to ignored `dist/` output |
| `pnpm typecheck` | Run the configured TypeScript project build/check (`tsc -b`) |
| `pnpm test` | Build, then run all Vitest tests |
| `pnpm test:watch` | Start Vitest watch mode |
| `pnpm check:deps` | Check workspace dependency boundaries and cycles |
| `pnpm check` | Run dependency checks, typecheck and the full test suite |

### Targeted tests

Build first: subprocess/worker tests load compiled modules from `dist/`. Rebuild after source changes before rerunning those tests, including during watch-mode development.

```bash
pnpm build

# P01: workflow engine
pnpm exec vitest run packages/core/test

# P02: Herdr adapter and agent registry
pnpm exec vitest run packages/herdr-adapter/test packages/agent-registry/test

# P03: SQLite persistence and filesystem artifacts
pnpm exec vitest run packages/persistence/test/run-store.test.ts packages/artifact-store/test/artifact-store.test.ts

# Quality gates and Runtime
pnpm exec vitest run packages/quality-gates/test packages/runtime/test
```

For watch mode, run `pnpm build` followed by `pnpm test:watch`. No API key or live Herdr server is required for these tests. Passing tests do not establish live integration or full SDLC execution.

## Reliability boundaries and known follow-ups

- Core emits decisions/events; the caller must persist complete event batches before external side effects. RunStore's query projection is not a complete Core aggregate checkpoint. Runtime provides this composition.
- Runtime + Herdr is not end-to-end: Core accepts a task result only for a bound handle with verified correlation, and the Herdr adapter's handles are unverified. See [known limitations](docs/guide/09-blocked-timeout-retry-resume.md#giới-hạn-đã-biết).
- Registry resolution does not reserve capacity. Dispatch requires a current lease/fencing token. Registry durability is single-host/local-filesystem scoped; stale crash locks need operator review.
- Herdr `done` and terminal snapshots are not verified business success. Unknown delivery forbids blind resend; adapter deduplication is instance-local, not cross-process exactly-once execution.
- SQLite and artifact chunk ingest use synchronous operations that can block the event loop. A 64 KiB write buffer is not a 64 KiB total-RAM guarantee; native filesystem calls are not instantly cancellable.
- SQLite, artifact publication and Herdr do not share an atomic transaction. Tombstones and orphan blobs require coordinated retention/cleanup. Power-loss, network filesystems, multi-host storage and hostile same-user continuous path swapping are **NOT VERIFIED**.

Known open non-blocking P2 follow-ups from accepted audits:

| ID | Owner / source | Remaining behavior |
| --- | --- | --- |
| P02-RA01 | Herdr adapter — [`runner.ts`](packages/herdr-adapter/src/runner.ts) | Native timer delays above 2,147,483,647 ms can overflow and time out too early; add chunked timers or explicit limit validation. |
| P03-RA01 | ArtifactStore — [`filesystem-artifact-store.ts`](packages/artifact-store/src/filesystem-artifact-store.ts) | `get()` checks budget before awaited snapshot read, not immediately before yield; deadline/abort can lag one final output chunk (at most 64 KiB). Add a post-read check and boundary tests. |

These are OPEN, not FIXED. Consult package READMEs for storage/transport guarantees and limitations.

## Architecture and contributing

Read [architecture](docs/architecture.md), [public contracts](docs/contracts.md), [accepted ADRs](docs/adr/) and [AGENTS.md](AGENTS.md) before changing a package. Use the latest approved integration baseline and actual exported contracts, not the original P00 bootstrap or an old phase prompt. Leaf modules depend on contracts; Runtime composes them through ports.

Update this README, relevant package documentation and agent guidance alongside approved implementation changes. Shared documentation and contracts remain review-gated; do not change them silently to bypass an implementation blocker.
