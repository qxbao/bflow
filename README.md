# bflow

**bflow** is a modular TypeScript platform and CLI for orchestrating AI coding agents across software delivery (SDLC) workflows. It coordinates multi-step engineering tasks (`plan` → `implement` → `qa` → `review`) with deterministic state transitions, durable SQLite execution records, content-addressed artifacts, automated quality gates, and human approval checkpoints.

---

## Features

- **Deterministic Workflow Engine (`@bflow/core`)** — Evaluates task DAGs, enforces state transitions, manages bounded retry and rework loops, and supports full recovery from event logs and aggregate checkpoints.
- **Durable Local Persistence (`@bflow/persistence` & `@bflow/artifact-store`)** — Stores workflow events, execution receipts, and run projections in SQLite (`node:sqlite`) alongside checksum-verified immutable artifacts on disk.
- **Role & Lease Registry (`@bflow/agent-registry`)** — Resolves SDLC roles (`pm`, `architect`, `coder`, `qa`, `reviewer`) to configured agents with lease acquisition, fencing tokens, and structured output validation.
- **Independent Quality Gates (`@bflow/quality-gates`)** — Runs verification commands (`typecheck`, `lint`, `unit_test`, `build`, or custom checks) in the target workspace independently of agent self-reports.
- **Human-in-the-Loop Governance** — Enforces human actor verification on approval gates (`approved`, `changes_requested`, `rejected`) before advancing gated tasks.
- **CLI & Programmatic Runtime (`@bflow/cli` & `@bflow/runtime`)** — Manage workflows from the terminal via `bflow` (human-readable or `--json` output) or embed `createRuntimeService` directly in Node.js applications.

---

## Requirements

- **Node.js `>= 22.13`** (required for unflagged built-in `node:sqlite`)
- **pnpm `12.5.1`** (pinned via `packageManager` in `package.json`)

---

## Installation & Quick Start

```bash
git clone https://github.com/qxbao/bflow.git
cd bflow
pnpm install --frozen-lockfile
pnpm build
```

Verify the workspace build and run the demo workflow:

```bash
node examples/runtime-demo/run-demo.mjs
```

---

## CLI Usage

After running `pnpm build`, invoke the CLI via `node apps/cli/dist/bin.js` (or link it globally via `pnpm --filter @bflow/cli link --global` to use `bflow` directly):

```bash
# 1. Initialize bflow configuration (.bflow/config.json) in a repository
bflow init --name my-project

# 2. Start a workflow run with a requirement
bflow run "Add user authentication and session management"

# 3. Inspect active runs or a specific run
bflow status
bflow status <run-id>

# 4. Record a human approval decision (approved | changes_requested | rejected)
bflow approve qa --run <run-id> --decision approved --by alice
bflow approve review --run <run-id> --decision changes_requested --reason "Add edge-case tests"

# 5. Resume a waiting or recovered workflow run
bflow resume <run-id>

# 6. Cancel an active workflow run or task
bflow cancel <run-id> --reason "Scope updated"
```

All commands support `-j, --json` for structured JSON output and `-h, --help` for detailed command options.

---

## Workspace Packages

| Package | Description |
| --- | --- |
| [`@bflow/cli`](apps/cli) | Command-line interface (`bflow`) for initializing configs and managing workflow runs |
| [`@bflow/runtime`](packages/runtime) | High-level orchestration service composing engine, storage, registry, transport, and gates |
| [`@bflow/core`](packages/core) | Pure deterministic workflow engine (DAG scheduling, transitions, retry/rework, replay) |
| [`@bflow/contracts`](packages/contracts) | Shared Zod schemas, public port interfaces, and transition/event validators |
| [`@bflow/agent-registry`](packages/agent-registry) | File-backed role-to-agent registry, leases, fencing tokens, and workflow templates |
| [`@bflow/herdr-adapter`](packages/herdr-adapter) | CLI-backed `AgentTransport` adapter for Herdr agent sessions |
| [`@bflow/persistence`](packages/persistence) | SQLite `RunStore` for atomic event batches, execution receipts, and checkpoints |
| [`@bflow/artifact-store`](packages/artifact-store) | Filesystem `ArtifactStore` with SQLite catalog and SHA-256 stream verification |
| [`@bflow/conversation`](packages/conversation) | Conversation Agent (`chat`) gateway, intent classification, structured `DelegationRequest` builder, and Herdr Coordinator bridge (P14); Runtime composition is scheduled for P19 |
| [`@bflow/specification`](packages/specification) | Adaptive specification classification, validation, versioning, traceability and approval policy (P15); Runtime composition is scheduled for P19 |
| [`@bflow/quality-gates`](packages/quality-gates) | Preset command evaluators, workspace security policies, and RBAC governance |

---

## Development & Testing

| Command | Description |
| --- | --- |
| `pnpm build` | Compile all workspace packages and CLI (`tsc -b`) |
| `pnpm lint` | Validate dependency boundaries (`check:deps`) and TypeScript types across workspace & E2E suites |
| `pnpm test` | Build packages and run all unit & integration tests (Vitest) |
| `pnpm test:e2e` | Build packages and run end-to-end scenario tests (`tests/e2e`) |
| `pnpm check` | Run dependency checks, typecheck, and the test suite |

### Running Sharded or Targeted Tests

Subprocess and worker tests load compiled modules from `dist/`, so run `pnpm build` before invoking `vitest` directly:

```bash
pnpm build

# Run unit tests in shards (e.g. shard 1 of 4)
pnpm exec vitest run --shard=1/4

# Run E2E tests in shards (e.g. shard 1 of 2)
pnpm exec vitest run --config tests/e2e/vitest.config.ts --shard=1/2

# Run tests for a single package
pnpm exec vitest run packages/runtime/test

# Run Conversation Gateway tests
pnpm --filter @bflow/conversation test

# Run Specification Engine tests
pnpm --filter @bflow/specification test
```

---

## CI/CD Pipeline

GitHub Actions workflows are configured under [`.github/workflows/`](.github/workflows):

- **CI ([`ci.yml`](.github/workflows/ci.yml))** — Runs on every push and pull request:
  1. **Lint & Build**: Validates package dependency boundaries (`pnpm lint`), compiles all packages (`pnpm build`), and uploads compiled `dist/` artifacts.
  2. **Sharded Unit & Package Tests**: Runs the unit/package test suite in parallel across **4 shards** (`--shard=1/4` .. `4/4`).
  3. **Sharded E2E Scenarios**: Runs the end-to-end test suite in parallel across **2 shards** (`--shard=1/2` .. `2/2`).
- **CD ([`cd.yml`](.github/workflows/cd.yml))** — Triggers on version tags (`v*`) or manual dispatch:
  - Runs lint and build verification, packs all `@bflow/*` workspace packages (`.tgz`), bundles the compiled distribution archive (`bflow-<tag>-dist.tar.gz`) with `SHA256SUMS.txt`, and publishes them to **GitHub Releases**.

---

## Documentation

- [User Guide (Vietnamese)](docs/guide/README.md)
- [Architecture Overview](docs/architecture.md)
- [Public Contracts](docs/contracts.md)
- [Architecture Decision Records (ADRs)](docs/adr)
- [Examples & Runtime Demo](examples/README.md)
