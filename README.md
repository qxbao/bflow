# bflow

[![CI](https://github.com/qxbao/bflow/actions/workflows/ci.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/ci.yml)
[![CD — Build & Release](https://github.com/qxbao/bflow/actions/workflows/cd.yml/badge.svg)](https://github.com/qxbao/bflow/actions/workflows/cd.yml)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm 12.5.1](https://img.shields.io/badge/pnpm-12.5.1-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**bflow** is a modular TypeScript platform and CLI for orchestrating AI coding agents across software delivery (SDLC) workflows. It coordinates multi-step engineering tasks (`plan` → `implement` → `qa` → `review`) with deterministic state transitions, durable SQLite execution records, content-addressed artifacts, automated quality gates, and human approval checkpoints.

---

## Features

- **Deterministic Workflow Engine (`@bflow/core`)** — Evaluates task DAGs, enforces state transitions, manages bounded retry and rework loops, and supports full recovery from event logs and aggregate checkpoints.
- **Durable Local Persistence (`@bflow/persistence` & `@bflow/artifact-store`)** — Stores workflow events, execution receipts, and run projections in SQLite (`node:sqlite`) alongside checksum-verified immutable artifacts on disk.
- **Role & Lease Registry (`@bflow/agent-registry`)** — Resolves configured SDLC roles to agents with lease acquisition, fencing tokens, and structured output validation.
- **Independent Quality Gates (`@bflow/quality-gates`)** — Runs verification commands (`typecheck`, `lint`, `unit_test`, `build`, or custom checks) in the target workspace independently of agent self-reports.
- **Human-in-the-Loop Governance** — Enforces human actor verification on approval gates (`approved`, `changes_requested`, `rejected`) before advancing gated tasks.
- **CLI & Programmatic Runtime (`@bflow/cli` & `@bflow/runtime`)** — Manage workflows from the terminal via `bflow` (human-readable or `--json` output) or embed `createRuntimeService` directly in Node.js applications.

---

## Requirements

- **Node.js `>= 22.13`** (required for unflagged built-in `node:sqlite`)
- **pnpm `12.5.1`** (pinned via `packageManager` in `package.json`)
- Default persistent Claude host: Linux/local filesystems, Unix sockets and `flock`; other platforms have not been verified.

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

Build from source, set `BFLOW_HOME` to this checkout's absolute path, then run
from the target Git repository (including a different Node.js/TypeScript project):

```bash
node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name my-project --provider claude
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json
# Requires installed/authenticated Herdr agent integrations:
node "$BFLOW_HOME/apps/cli/dist/bin.js" up --timeout 60000
node "$BFLOW_HOME/apps/cli/dist/bin.js" attach
```

Init writes **JSON-formatted `.bflow/config.yaml`** with checkout-specific identity;
run it separately in each repository/worktree. Plain repeated init preserves the
file; explicit `--force`/`--yes` overwrites it. Track portable templates rather than copying a bound config across clones.

`up` now starts a persistent P19 host, registers scoped Claude MCP tools and
launch-local native session/user-input hooks, then requires host activation before
reporting readiness. The default host supports Claude documentation/manual review
and owner-configured Node TAP or Vitest 2.1 behavioral verification, including
independent Red–Green–Refactor. Configure [.bflow/verification.json](docs/verification-runners.md)
before startup; automated checks require the Linux Bubblewrap sandbox. Codex launch helpers remain available, but the default
host refuses unverified provider hooks. Use `init --provider claude` for this path.
SDD/conditional-TDD/verification/concurrency policies are forwarded to the host.
`down` drains the host, persists authoritative checkpoints and closes only the
repository's panes/server; `--yes` never bypasses the barrier. Live smoke has
verified `up → down → up → down` without workflow/model turns. Full AI SDLC
acceptance remains unverified; see [release readiness](docs/release-readiness.md).

Legacy workflow commands (`run`, `status <run-id>`, `approve`, `resume`, `cancel`)
remain available through the older workspace Runtime. They do not launch P19.
Use `--help` for syntax, and the [current guide](docs/guide/README.md) for behavior
and integration limits. Start with [Getting Started](docs/guide/getting-started.md),
[portable templates](templates/node-typescript/README.md) and the
[standalone TypeScript example](examples/portable-node/README.md).

---

## Workspace Packages

| Package | Description |
| --- | --- |
| [`@bflow/cli`](apps/cli) | Command-line interface (`bflow`) for initializing configs and managing workflow runs |
| [`@bflow/runtime`](packages/runtime) | High-level orchestration service composing engine, storage, registry, transport, and gates |
| [`@bflow/core`](packages/core) | Pure deterministic workflow engine (DAG scheduling, transitions, retry/rework, replay) |
| [`@bflow/contracts`](packages/contracts) | Shared Zod schemas, public port interfaces, and transition/event validators |
| [`@bflow/agent-registry`](packages/agent-registry) | File-backed role-to-agent registry, leases, fencing tokens, and workflow templates |
| [`@bflow/herdr-adapter`](packages/herdr-adapter) | CLI-backed `AgentTransport`; protocol/schema negotiation without a CLI version allowlist |
| [`@bflow/persistence`](packages/persistence) | SQLite `RunStore` for atomic event batches, execution receipts, and checkpoints |
| [`@bflow/artifact-store`](packages/artifact-store) | Filesystem `ArtifactStore` with SQLite catalog and SHA-256 stream verification |
| [`@bflow/conversation`](packages/conversation) | Conversation Agent (`chat`) gateway, intent classification, structured `DelegationRequest` builder, and Herdr Coordinator bridge (P14); P19 host composition and authenticated native-message ingress are available through `@bflow/runtime`; live AI delivery requires separate verification |
| [`@bflow/specification`](packages/specification) | Adaptive specification classification, validation, versioning, traceability and approval policy (P15); P19 host composition and authenticated native-message ingress are available through `@bflow/runtime`; live AI delivery requires separate verification |
| [`@bflow/test-strategy`](packages/test-strategy) | Conditional TDD policy, criterion mappings and Red/Green/refactor evidence checks (P16); enforced by the implemented P19 host composition |
| [`@bflow/verification`](packages/verification) | Independent task/workflow verification, criterion evidence, Reviewer/QA checks, bounded rework and escalation (P17); composed by P19 with trusted host gates and authenticated evidence |
| [`@bflow/git-orchestrator`](packages/git-orchestrator) | Parallel task worktrees, ownership checks, stored patches, recoverable dependency-ordered integration, conflict handoff, workflow verification and provider PR support (P18); composed by P19; requires Linux/local Git |
| [`@bflow/mcp-gateway`](packages/mcp-gateway) | Shared MCP service registry, loopback Streamable HTTP server, stdio-to-HTTP bridge, sharing/isolation policy enforcement, exclusive resource leases with fencing tokens, and process/memory/latency metrics (P27); P30 Runtime composition pending |
| [`@bflow/mcp-services`](packages/mcp-services) | User-session OS service manager (`systemd --user`, `launchd`, Windows startup), lazy/eager backend resource pooling, memory RSS & process limits, and dedicated isolated Chrome browser runtime with page ownership gates (P27) |
| [`@bflow/skills`](packages/skills) | Pinned instruction-only skill catalog, role manifests, private storage and provider-neutral references (P28); setup/init/Runtime activation remains P26/P29/P30 integration work |
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

# Build and test the independent P17 Verification Engine
pnpm --filter @bflow/verification test

# Run Conversation Gateway tests
pnpm --filter @bflow/conversation test

# Run Specification Engine tests
pnpm --filter @bflow/specification test

# Run Conditional TDD Policy Engine tests
pnpm --filter @bflow/test-strategy test

# Run Git Integration Engine tests (real temporary repositories and SIGKILL recovery)
pnpm --filter @bflow/git-orchestrator test

# Run Shared MCP Gateway tests
pnpm --filter @bflow/mcp-gateway test

# Run OS Services & Dedicated Browser Runtime tests
pnpm --filter @bflow/mcp-services test
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
