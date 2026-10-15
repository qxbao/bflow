# Integration Test Infrastructure Specification (`TEST_INFRA.md`)

## 1. Overview & Mission

`@bflow/runtime` is the composition engine of the bflow architecture, integrating `@bflow/contracts`, `@bflow/core`, `@bflow/persistence`, `@bflow/artifact-store`, `@bflow/agent-registry`, `@bflow/herdr-adapter`, and `@bflow/quality-gates`.

This document establishes the comprehensive test architecture, philosophy, tier-based coverage mapping, execution procedures, and scenario catalog for Milestone 2 (`M2`).

---

## 2. Test Philosophy & Design Principles

### 2.1 Zero-Mock Storage & State Realism
- **Real SQLite Database (`SqliteRunStore`)**: Every integration test runs against a real temporary SQLite database on disk (`run-store.db`) using native `node:sqlite`. Tests verify actual transactional isolation, `SQLITE_BUSY` contention handling, atomic multi-event batch commits, and versioned aggregate checkpointing.
- **Real POSIX Filesystem (`FilesystemArtifactStore`)**: Artifact storage operates against real filesystem directories with SHA-256 integrity digest verification, atomic renaming, and strict POSIX permission compliance.
- **Real File-backed Agent Registry (`FileAgentRegistry`)**: Agent resolution, lease acquisition, capacity constraints, and monotonic fencing tokens run against real JSON state files with cross-instance file-locking semantics.
- **Deterministic Workflow Engine (`DeterministicWorkflowEngine`)**: State transitions, DAG dependency validation, bounded rework generation tracking, and recovery codecs are executed by the real Core engine.

### 2.2 Deterministic Transport Simulation (`FakeAgentTransport`)
- External network/subprocess transports are simulated via a deterministic, in-memory `FakeAgentTransport` implementing `@bflow/contracts` `AgentTransport`.
- Supports configurable handlers for:
  - Immediate prompt acceptance (`status: "accepted"`) with unique `AgentExecutionHandle` values.
  - Ambiguous transport delivery (`status: "unknown_delivery"`).
  - Explicit agent rejection (`status: "rejected"`).
  - In-flight execution reconciliation (`transport.reconcile(...)`).
  - 3-stage cancellation (`transport.cancel(...)`).

### 2.3 Strict Schema & Error Invariants
- All data entering runtime ports must pass exported Zod schemas at ingress boundaries.
- Storage, engine, and transport errors must surface as typed `ContractError` values (`conflict`, `corruption`, `validation`, `timeout`, `cancelled`, `not_found`).
- Zero tolerance for untyped exceptions or silent failures.

### 2.4 Resource Isolation & Deterministic Cleanup
- Each test runs within an isolated temporary directory created via `mkdtemp(join(tmpdir(), "bflow-runtime-test-"))`.
- Complete teardown in `finally` blocks: SQLite databases closed, artifact streams closed, temporary directories recursively purged.

---

## 3. Four-Tier Testing Pyramid (Tier 1 to Tier 4)

| Tier | Name | Target Scope | Key Invariants Verified |
|---|---|---|---|
| **Tier 1** | **Ingress Safety & Schemas** | `@bflow/contracts` | Zod validation of all inputs, commands, event batches, options, and error shapes at ingress. |
| **Tier 2** | **Unit & Engine Invariants** | `@bflow/core`, `service.ts`, `dispatcher.ts`, `recovery.ts` | Deterministic DAG transitions, legal status progression, retry delays, lease ttl, optimistic versions. |
| **Tier 3** | **Port Composition & Storage** | `test/unit/`, `test/helpers/test-harness.ts` | Inter-module contracts: SQLite event append atomicity, filesystem artifact hashing, lease fencing tokens. |
| **Tier 4** | **End-to-End SDLC Scenarios** | `test/scenarios/01` to `08` | Full lifecycle workflows, rework loops, failure recovery, transport reconciliation, diamond DAG concurrency. |
| *(Tier 5)* | *(Adversarial Hardening)* | *Milestone 3 (Challengers)* | *Chaos injection, hostile agent payloads, race conditions, edge timeouts.* |

---

## 4. Master Index of the 8 Integration Scenarios

The Tier 4 test suite comprises 8 core end-to-end integration scenarios located in `packages/runtime/test/scenarios/`:

| # | Scenario File | Primary Focus | Key Invariants & Capabilities Verified |
|---|---|---|---|
| **1** | `01-happy-path.test.ts` | Complete 11-Step SDLC Workflow | Full flow: Planner → Developer → Quality Gate → Reviewer → QA → Handoff report persisted in `ArtifactStore` (`report-<runId>-handoff`) → Pre-merge approval hold (`waiting_for_approval`) → Operator sign-off via `approve()` → Terminal `succeeded`. |
| **2** | `02-reviewer-rework.test.ts` | Bounded Rework & Exhaustion | Reviewer returns `changes_requested`. Routes feedback back to Developer; generation increments (gen 0 → 1 → 2). Up to `maxReworks: 2`. On rework exhaustion, halts immediately at `blocked` (`manual_intervention`) without infinite spin. |
| **3** | `03-qa-failure.test.ts` | QA Failure & Retry Policy | QA task execution failure (exitCode 1, failure summary). Verifies retry policy up to `maxAttempts: 2`. Under `fail-fast`, transitions run to `failed` with persisted failure evidence; under `block`, transitions to `blocked` for operator diagnosis. |
| **4** | `04-blocked-agent.test.ts` | Blocked Agent Observation | Agent reports `status: "blocked"` via transport observation (`missing_dependency` or `manual_intervention`). Task and run transition to `blocked` without consuming retry attempts. Operator `resume()` unblocks execution to completion. |
| **5** | `05-timeout-reconciliation.test.ts` | Timeout & Ambiguous Delivery | Transport returns `unknown_delivery` or times out. Invariant: NEVER blindly resend prompt. Calls `transport.reconcile`: if `not_delivered`, retries safely; if `delivered`, binds handle and awaits observation without duplicate tasks. |
| **6** | `06-restart-recovery.test.ts` | Restart Recovery & Aggregate Replay | Process crash simulation. A brand new `RuntimeService` instance reconstructs state from SQLite `RunStore` using aggregate checkpoint (`bflow.workflow-aggregate+json` codec) + event tail replay from `eventTailCursor`. Reconciles bound executions and resumes to completion. |
| **7** | `07-persistence-failure.test.ts` | Persistence Failure & Invariant Safety | Simulated persistence write failures during event append, checkpoint save, or artifact put. Verifies failures surface as typed `ContractError` (`conflict` or `corruption`). Invariants: Zero run state corruption, zero false task success claims. |
| **8** | `08-dag-concurrency.test.ts` | DAG Topological Ordering & Concurrency | Diamond DAG with concurrent siblings (`implement_frontend` and `implement_backend`) joining into `integrate`. Verifies topological ordering, workflow `maxConcurrency` limits, and registry capacity constraints with monotonic fencing tokens. |

---

## 5. Detailed Architecture: Scenarios 6, 7, and 8

### 5.1 Scenario 6 (`06-restart-recovery.test.ts`)
- **Objective**: Ensure that a fresh `RuntimeService` instance can recover in-memory aggregate state after an abrupt shutdown or crash and continue executing the workflow to completion without duplicate task execution or state corruption.
- **Recovery Pipeline**:
  ```
  1. ports.runStore.get(runId) -> validates stored run envelope
  2. ports.engine.validateDefinition(storedRun.definition)
  3. ports.runStore.loadLatestCheckpoint(runId)
     ├── If Checkpoint Exists:
     │   ├── Validate codec: name === "bflow.workflow-aggregate+json" && version === 1
     │   ├── Decode aggregate state
     │   ├── Read event tail: sequence > checkpoint.eventSequence via eventTailCursor()
     │   └── engine.recover({ runId, checkpoint, events: tailEvents, expectedVersion })
     └── If No Checkpoint:
         ├── Read complete event history from sequence 1 (run.created)
         └── engine.recover({ runId, events: allEvents, expectedVersion })
  4. Reconcile in-flight bound executions:
     For each task in ["running", "cancelling"] with agentExecution !== undefined:
     ├── ports.transport.reconcile(handle)
     ├── engine.recordDeliveryReconciliation(reconcileResult)
     └── ports.runStore.appendEvents(reconciliationEvents)
  5. orchestrator.driveRun(runId) resumes execution loop to completion
  ```
- **Test Cases**:
  - `6.1`: Standard recovery with aggregate checkpoint + event tail + bound execution reconciliation + resumption to terminal `succeeded`.
  - `6.2`: Fallback recovery from complete event history when no checkpoint exists.
  - `6.3`: Fail-closed validation rejection on invalid or foreign checkpoint codecs.

### 5.2 Scenario 7 (`07-persistence-failure.test.ts`)
- **Objective**: Guarantee absolute data integrity and safety under hostile storage conditions (disk full, lock timeout, constraint violation, uncommitted writes).
- **Two Immutable Safety Invariants**:
  - **Invariant 1 (Zero State Corruption)**: Any failed `appendEvents`, `saveCheckpoint`, or `put` must abort cleanly, leaving the durable store in a consistent, uncorrupted state matching the previous committed version.
  - **Invariant 2 (Zero False Task Success Claims)**: An agent or task must NEVER be recorded as `succeeded` or allowed to advance dependent tasks if its domain events or artifact proposals failed to persist.
- **Test Cases**:
  - `7.1`: Simulated SQLite writer busy failure surfaces typed `{ code: "conflict", retryable: true }` without corrupting durable state; once resolved, retrying succeeds cleanly.
  - `7.2`: Simulated `ArtifactStore.put` I/O error surfaces `{ code: "corruption" }` and blocks task completion; task remains non-succeeded and no `task.succeeded` event is appended.
  - `7.3`: Checkpoint save conflict surfaces typed error without invalidating domain event history.
  - `7.4`: Optimistic concurrency conflicts on parallel event appends enforce linear history.

### 5.3 Scenario 8 (`08-dag-concurrency.test.ts`)
- **Objective**: Verify execution semantics of complex Directed Acyclic Graphs with concurrent branches, shared agent resources, and join barriers.
- **Topological Structure (Diamond DAG)**:
  ```
               ┌────────────────┐
               │      plan      │ (role: planner)
               └───────┬────────┘
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
    ┌─────────────────┐ ┌────────────────┐
    │implement_frontend│ │implement_backend│ (role: developer)
    └────────┬────────┘ └────────┬───────┘
             │                   │
             └─────────┬─────────┘
                       ▼
               ┌────────────────┐
               │   integrate    │ (role: qa)
               └────────────────┘
  ```
- **Test Cases**:
  - `8.1`: Strict topological dependency ordering: `integrate` remains `pending` when only one sibling has completed; only becomes runnable when BOTH siblings succeed.
  - `8.2`: Workflow concurrency limits: `definition.maxConcurrency: 1` serializes sibling execution; `maxConcurrency: 2` allows parallel execution.
  - `8.3`: Registry capacity limits: agent configured with `maxConcurrentTasks: 1` rejects concurrent lease requests with `{ code: "conflict" }`. When first lease is released, second lease acquires slot with incremented monotonic `fencingToken` (`fencingToken: 2 > 1`).
  - `8.4`: Upstream sibling failure under `fail-fast` safely halts downstream join branch.

---

## 6. Execution Instructions & Validation Commands

### 6.1 Prerequisites
- **Node.js**: `>= 22.13.0` (required for native unflagged `node:sqlite`).
- **Package Manager**: `pnpm` (pinned workspace version).
- **Operating System**: Linux / POSIX with temporary directory support.

### 6.2 Running Integration Tests
To execute all scenario integration tests:
```bash
pnpm --filter @bflow/runtime test test/scenarios/
```

To run individual scenario test files:
```bash
# Scenario 6: Restart Recovery
pnpm --filter @bflow/runtime test test/scenarios/06-restart-recovery.test.ts

# Scenario 7: Persistence Failure
pnpm --filter @bflow/runtime test test/scenarios/07-persistence-failure.test.ts

# Scenario 8: DAG Concurrency
pnpm --filter @bflow/runtime test test/scenarios/08-dag-concurrency.test.ts
```

### 6.3 Full Workspace Verification
Before finalizing any milestone or git handoff, execute the full validation suite from the workspace root:
```bash
pnpm check:deps     # Verify zero circular dependencies or illegal cross-package imports
pnpm typecheck      # TypeScript compiler check across all packages
pnpm test           # Full Vitest suite across all 6 packages
git diff --check    # Check for whitespace and formatting issues
git status --short  # Verify clean working tree (no untracked databases, logs, or artifacts)
```
