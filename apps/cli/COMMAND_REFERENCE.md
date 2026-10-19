# Bflow CLI Command Reference

Autonomous SDLC workflow orchestration command reference for agents, skills, and human operators.

## Supported Commands Overview

All commands listed below comply with `@bflow/skills` `SupportedCommandsSchema` and provide predictable exit codes, structured JSON output (`--json`), and idempotent operation ledger tracking.

| Command | Syntax | Purpose | Reused Engines | Skills |
| --- | --- | --- | --- | --- |
| `config-migrate` | `bflow config-migrate [--json]` | Validate and migrate one legacy repository config to the canonical YAML file, retaining a byte-for-byte backup. | RepositoryIdentity, RepositoryConfigCodec | using-bflow |
| `help` | `bflow help [command] [options]` | Show global CLI usage or detailed help for a specific command. | HelpFormatter | using-bflow |
| `version` | `bflow version [options] / bflow --version / bflow -v` | Display the current version and build information for the bflow CLI. | PackageMetadata | using-bflow |
| `init` | `bflow init [options]` | Initialize bflow repository configuration and default workflow definition at the repository root. | RepositoryConfigService, DefaultWorkflowDefinition | using-bflow |
| `setup` | `bflow setup [options] | bflow setup --codex-hooks (--check|--plan|--apply)` | Review and approve Codex global hooks explicitly; choose exact snapshot approval or explicit all-hook policy; never runs normal tool/service setup. | CodexHookInventory, CodexHookApprovalStore | using-bflow |
| `up` | `bflow up [options]` | Start or reconcile the repository headless named session and wait for required role panes. | PaneManager, EnvironmentDependencies, HerdrSessionAdapter | using-bflow |
| `down` | `bflow down [options]` | Checkpoint active workflow runs and gracefully stop this repository's named session. | PaneManager, RuntimeService, LifecycleLock | using-bflow |
| `attach` | `bflow attach [options]` | Attach interactive terminal to the Conversation pane of the active session. | PaneManager, HerdrSessionAdapter | using-bflow |
| `status` | `bflow status [run-id] [options]` | Query environment status or inspect specific workflow run states and history. | EnvironmentService, RuntimeService | using-bflow |
| `doctor` | `bflow doctor [options]` | Diagnose environment health, configuration integrity, Herdr integration, and tool dependencies. | EnvironmentDoctor, ToolDependencyInspector, PaneManager | using-bflow |
| `recover` | `bflow recover --yes [options]` | Recover from stale lifecycle locks without modifying or deleting project state. | LifecycleLockRecovery, SessionManifestStore | using-bflow |
| `run` | `bflow run <requirement> [options]` | Start a new autonomous SDLC workflow run for a specified user requirement. | RuntimeService, WorkflowEngine, CoordinatorAgent | using-bflow |
| `approve` | `bflow approve <task-id> [options]` | Record a human approval, rejection, or changes_requested decision for a waiting task gate. | RuntimeService, QualityGates, HumanDecisionGate | using-bflow |
| `resume` | `bflow resume <run-id> [options]` | Resume an active or waiting workflow run that paused on approval or crash. | RuntimeService, WorkflowEngine | using-bflow |
| `cancel` | `bflow cancel <run-id> [options]` | Cancel an active workflow run or specific task within a run. | RuntimeService, WorkflowEngine | using-bflow |
| `repo inspect` | `bflow repo inspect [options]` | Inspect repository structure, conventions, configuration, and file tree for agent intake. | RepositoryInspectionEngine, OperationLedger | inspect-repository, using-bflow |
| `task plan` | `bflow task plan [spec-path] [options]` | Decompose a specification document into an actionable workflow task DAG with acceptance criteria. | SpecificationEngine, PlannerAgent, OperationLedger | plan-tasks, using-bflow |
| `task implement` | `bflow task implement <task-id> [options]` | Execute implementation for a task in an isolated worktree with conditional TDD enforcement. | DeveloperAgent, TestStrategyResolver, GitOrchestrator, OperationLedger | implement-task, conditional-tdd, using-bflow |
| `verify` | `bflow verify [task-id] [options]` | Execute task-level or workflow-level verification against specification acceptance criteria. | VerificationEngine, QualityGates, OperationLedger | run-verification, conditional-tdd, using-bflow |
| `git prepare` | `bflow git prepare [options]` | Reconcile Git branches, prepare dependency-ordered integration, and validate worktrees. | GitOrchestrator, OperationLedger | implement-task, using-bflow |
| `docs` | `bflow docs search <library> [options] | bflow docs lookup [<library>] --query <text> [options] | bflow docs status [options]` | Look up current, version-specific library documentation through the shared Gateway's Context7 service; status reports whether it is reachable, authenticated and usable. | DocsClient, McpGateway | use-context7, using-bflow |
| `mcp status` | `bflow mcp status [options]` | Inspect status and health of registered Model Context Protocol (MCP) services and bridges. | McpGateway, OperationLedger | use-gitnexus, use-mempalace, browser-inspection, using-bflow |
| `tool status` | `bflow tool status [options] / bflow tools status [options]` | Inspect availability, version, and health of pinned machine and repo tools (e.g. RTK). | ToolInstaller, OperationLedger | use-rtk, using-bflow |
| `tools status` | `bflow tools status [options]` | Alias for 'bflow tool status'. Inspect availability and health of pinned tools. | ToolInstaller, OperationLedger | use-rtk, using-bflow |
| `skills sync` | `bflow skills sync [options]` | Synchronize approved skills from catalog to agent provider storage environments. | SkillManager, OperationLedger | using-bflow |
| `skills list` | `bflow skills list [options]` | List available skills from the catalog without synchronizing them. | SkillManager, OperationLedger | using-bflow |
| `agent check` | `bflow agent check [provider] [options]` | Check provider readiness and activated health against platform contracts. | AgentProviderRegistry, OperationLedger | using-bflow |

## Detailed Command Specifications

### `bflow config-migrate`

- **Syntax**: `bflow config-migrate [--json]`
- **Purpose**: Validate and migrate one legacy repository config to the canonical YAML file, retaining a byte-for-byte backup.
- **Reused Engines**: `RepositoryIdentity`, `RepositoryConfigCodec`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent when the canonical target matches its migration backup. Conflicting or edited configs are left untouched.
- **Permission Requirements**: Requires local filesystem access to the repository .bflow directory.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow help`

- **Syntax**: `bflow help [command] [options]`
- **Purpose**: Show global CLI usage or detailed help for a specific command.
- **Reused Engines**: `HelpFormatter`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`
- **Idempotency & Retry**: Read-only, purely deterministic. Safe to call repeatedly without state mutation.
- **Permission Requirements**: None. Available to all actors in all environments.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow version`

- **Syntax**: `bflow version [options] / bflow --version / bflow -v`
- **Purpose**: Display the current version and build information for the bflow CLI.
- **Reused Engines**: `PackageMetadata`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`
- **Idempotency & Retry**: Read-only. Safe to call repeatedly without state mutation.
- **Permission Requirements**: None. Available to all actors.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow init`

- **Syntax**: `bflow init [options]`
- **Purpose**: Initialize bflow repository configuration and default workflow definition at the repository root.
- **Reused Engines**: `RepositoryConfigService`, `DefaultWorkflowDefinition`
- **Required Flags**: None
- **Optional Flags**: `--dir <path>`, `--config <path>`, `--name <name>`, `--provider <claude|codex>`, `-f, --force`, `-y, --yes`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Re-running without --force verifies existing configuration without modifying it.
- **Permission Requirements**: Requires filesystem write access to the repository directory.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow setup`

- **Syntax**: `bflow setup [options] | bflow setup --codex-hooks (--check|--plan|--apply)`
- **Purpose**: Review and approve Codex global hooks explicitly; choose exact snapshot approval or explicit all-hook policy; never runs normal tool/service setup.
- **Reused Engines**: `CodexHookInventory`, `CodexHookApprovalStore`
- **Required Flags**: None
- **Optional Flags**: `--check`, `--dry-run, --plan`, `--apply`, `--yes`, `--codex-hooks`, `--hook-digest <sha256>`, `--trust-all`, `--revoke-trust-all`, `--dir <path>`, `--catalog-dir <path>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Inspection is read-only. Snapshot approval binds the reviewed digest. Explicit --trust-all trusts current/future hooks for the selected Codex home until --revoke-trust-all.
- **Permission Requirements**: Approval store is private and user-owned. Only the explicit Codex hook apply path can write hook approval state.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow up`

- **Syntax**: `bflow up [options]`
- **Purpose**: Start or reconcile the repository headless named session and wait for required role panes.
- **Reused Engines**: `PaneManager`, `EnvironmentDependencies`, `HerdrSessionAdapter`
- **Required Flags**: None
- **Optional Flags**: `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Reconnects to an existing healthy session or reconciles missing panes.
- **Permission Requirements**: Requires local process execution privileges and Herdr runtime access.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow down`

- **Syntax**: `bflow down [options]`
- **Purpose**: Checkpoint active workflow runs and gracefully stop this repository's named session.
- **Reused Engines**: `PaneManager`, `RuntimeService`, `LifecycleLock`
- **Required Flags**: None
- **Optional Flags**: `-y, --yes`, `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Safely stops only the owned named session; no-op if session already stopped.
- **Permission Requirements**: Requires repository lifecycle lock ownership.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow attach`

- **Syntax**: `bflow attach [options]`
- **Purpose**: Attach interactive terminal to the Conversation pane of the active session.
- **Reused Engines**: `PaneManager`, `HerdrSessionAdapter`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Interactive connection. Can be re-attached whenever session is running.
- **Permission Requirements**: Requires interactive TTY terminal and active repository session.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow status`

- **Syntax**: `bflow status [run-id] [options]`
- **Purpose**: Query environment status or inspect specific workflow run states and history.
- **Reused Engines**: `EnvironmentService`, `RuntimeService`
- **Required Flags**: None
- **Optional Flags**: `--status <filter>`, `--workflow-id <id>`, `--limit <n>`, `--cursor <c>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only query. Safe to execute at any time.
- **Permission Requirements**: None. Open status inspection.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow doctor`

- **Syntax**: `bflow doctor [options]`
- **Purpose**: Diagnose environment health, configuration integrity, Herdr integration, and tool dependencies.
- **Reused Engines**: `EnvironmentDoctor`, `ToolDependencyInspector`, `PaneManager`
- **Required Flags**: None
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only diagnostics. Safe to run repeatedly.
- **Permission Requirements**: Read access to repository configuration and system tools.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow recover`

- **Syntax**: `bflow recover --yes [options]`
- **Purpose**: Recover from stale lifecycle locks without modifying or deleting project state.
- **Reused Engines**: `LifecycleLockRecovery`, `SessionManifestStore`
- **Required Flags**: `-y, --yes`
- **Optional Flags**: `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Reclaims orphaned lock files after verifying process death.
- **Permission Requirements**: Requires explicit operator confirmation (--yes) and repository lock write access.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow run`

- **Syntax**: `bflow run <requirement> [options]`
- **Purpose**: Start a new autonomous SDLC workflow run for a specified user requirement.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`, `CoordinatorAgent`
- **Required Flags**: `<requirement>`
- **Optional Flags**: `--run-id <id>`, `-w, --workflow <path>`, `--config <path>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent when supplied with --idempotency-key; returns existing run record if key matches.
- **Permission Requirements**: Operator privilege. Initiates background autonomous agent orchestration.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow approve`

- **Syntax**: `bflow approve <task-id> [options]`
- **Purpose**: Record a human approval, rejection, or changes_requested decision for a waiting task gate.
- **Reused Engines**: `RuntimeService`, `QualityGates`, `HumanDecisionGate`
- **Required Flags**: `<task-id>`
- **Optional Flags**: `--run, --run-id <id>`, `--by, --actor <actor>`, `--decision <decision>`, `--reason <text>`, `--approval-id <id>`, `--revision <n>`, `--generation <n>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent under idempotency key. Superseded decisions are rejected with conflict error.
- **Permission Requirements**: Human operator only. Actor must qualify as human approver.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow resume`

- **Syntax**: `bflow resume <run-id> [options]`
- **Purpose**: Resume an active or waiting workflow run that paused on approval or crash.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`
- **Required Flags**: `<run-id>`
- **Optional Flags**: `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Safe to retry if transient error occurs during resumption.
- **Permission Requirements**: Operator privilege.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow cancel`

- **Syntax**: `bflow cancel <run-id> [options]`
- **Purpose**: Cancel an active workflow run or specific task within a run.
- **Reused Engines**: `RuntimeService`, `WorkflowEngine`
- **Required Flags**: `<run-id>`
- **Optional Flags**: `--reason <text>`, `--by, --requested-by <actor>`, `--task, --task-id <id>`, `--expected-version <n>`, `--idempotency-key <key>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent. Cancelling an already cancelled run succeeds cleanly.
- **Permission Requirements**: Operator privilege.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow repo inspect`

- **Syntax**: `bflow repo inspect [options]`
- **Purpose**: Inspect repository structure, conventions, configuration, and file tree for agent intake.
- **Reused Engines**: `RepositoryInspectionEngine`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--dir <path>`, `--include-files`, `--max-files <n>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only inspection recorded in OperationLedger. Supports --resume from prior step.
- **Permission Requirements**: Requires read access to target repository.
- **Associated Skills**: `inspect-repository`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow task plan`

- **Syntax**: `bflow task plan [spec-path] [options]`
- **Purpose**: Decompose a specification document into an actionable workflow task DAG with acceptance criteria.
- **Reused Engines**: `SpecificationEngine`, `PlannerAgent`, `OperationLedger`
- **Required Flags**: `--spec <path> (or positional [spec-path])`
- **Optional Flags**: `-w, --workflow <path>`, `--run-id <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Reuses cached plan receipt when matching idempotency key is supplied.
- **Permission Requirements**: Planner role or operator. Read access to specification.
- **Associated Skills**: `plan-tasks`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow task implement`

- **Syntax**: `bflow task implement <task-id> [options]`
- **Purpose**: Execute implementation for a task in an isolated worktree with conditional TDD enforcement.
- **Reused Engines**: `DeveloperAgent`, `TestStrategyResolver`, `GitOrchestrator`, `OperationLedger`
- **Required Flags**: `<task-id>`, `--run-id <id>`
- **Optional Flags**: `--spec <path>`, `-w, --workflow <path>`, `--attempt-id <id>`, `--base-revision <sha>`, `--owned-path <path>`, `--forbidden-path <path>`, `--developer-id <id>`, `--require-red-evidence`, `--target-branch <branch>`, `--environment <env>`, `--auto-approve`, `--approved-by <actor>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Supports resuming across bounded rework iterations via attemptId and OperationLedger steps.
- **Permission Requirements**: Developer agent execution in designated worktree. Bounded path modification permissions.
- **Associated Skills**: `implement-task`, `conditional-tdd`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow verify`

- **Syntax**: `bflow verify [task-id] [options]`
- **Purpose**: Execute task-level or workflow-level verification against specification acceptance criteria.
- **Reused Engines**: `VerificationEngine`, `QualityGates`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--run-id <id>`, `--task-id <id>`, `--scope <task|workflow>`, `--spec <path>`, `--plan <path>`, `--change-set <path>`, `--cycle <path>`, `--max-iterations <n>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Produces verifiable VerificationResult receipts. Max rework cycles bounded (default: 3).
- **Permission Requirements**: Verifier/Tester role. Read-only checks with test execution sandbox.
- **Associated Skills**: `run-verification`, `conditional-tdd`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow git prepare`

- **Syntax**: `bflow git prepare [options]`
- **Purpose**: Reconcile Git branches, prepare dependency-ordered integration, and validate worktrees.
- **Reused Engines**: `GitOrchestrator`, `OperationLedger`
- **Required Flags**: `--run-id <id>`
- **Optional Flags**: `--integration-id <id>`, `--base-revision <sha>`, `--task <taskKey[:deps]>`, `--target-branch <branch>`, `--environment <env>`, `--auto-approve`, `--approved-by <actor>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Atomic branch preparation and merge dry-run. Idempotent under integration receipt.
- **Permission Requirements**: Git repository branch management permissions.
- **Associated Skills**: `implement-task`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow docs`

- **Syntax**: `bflow docs search <library> [options] | bflow docs lookup [<library>] --query <text> [options] | bflow docs status [options]`
- **Purpose**: Look up current, version-specific library documentation through the shared Gateway's Context7 service; status reports whether it is reachable, authenticated and usable.
- **Reused Engines**: `DocsClient`, `McpGateway`
- **Required Flags**: `--query <text> (lookup)`
- **Optional Flags**: `--library-id <id>`, `--version <version>`, `--language <name>`, `--no-cache`, `--role <role>`, `--timeout <ms>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only and safe to repeat. Transient failures (network, timeout, rate limit) are retried by the Gateway only for read-only calls; results may be served from an optional local cache.
- **Permission Requirements**: Needs a Gateway registration that grants the context7 service. Inside an agent pane the agent's own registration is used; an operator outside a pane acts under the role given by --role. Queries are sent to the hosted Context7 service.
- **Associated Skills**: `use-context7`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow mcp status`

- **Syntax**: `bflow mcp status [options]`
- **Purpose**: Inspect status and health of registered Model Context Protocol (MCP) services and bridges.
- **Reused Engines**: `McpGateway`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--service <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only probe. Safe to execute periodically without side effects.
- **Permission Requirements**: MCP gateway inspection privilege.
- **Associated Skills**: `use-gitnexus`, `use-mempalace`, `browser-inspection`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow tool status`

- **Syntax**: `bflow tool status [options] / bflow tools status [options]`
- **Purpose**: Inspect availability, version, and health of pinned machine and repo tools (e.g. RTK).
- **Reused Engines**: `ToolInstaller`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--tool <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only status probe. Safe to execute repeatedly.
- **Permission Requirements**: Tool registry read access.
- **Associated Skills**: `use-rtk`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow tools status`

- **Syntax**: `bflow tools status [options]`
- **Purpose**: Alias for 'bflow tool status'. Inspect availability and health of pinned tools.
- **Reused Engines**: `ToolInstaller`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--tool <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only status probe.
- **Permission Requirements**: Tool registry read access.
- **Associated Skills**: `use-rtk`, `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow skills sync`

- **Syntax**: `bflow skills sync [options]`
- **Purpose**: Synchronize approved skills from catalog to agent provider storage environments.
- **Reused Engines**: `SkillManager`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--list`, `--provider <claude|codex|agy>`, `--manifest-id <id>`, `--environment-id <id>`, `--catalog-dir <path>`, `--store-dir <path>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Idempotent sync based on skill manifest digests. Reused receipts avoid redundant disk writes.
- **Permission Requirements**: Skill directory write access.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow skills list`

- **Syntax**: `bflow skills list [options]`
- **Purpose**: List available skills from the catalog without synchronizing them.
- **Reused Engines**: `SkillManager`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--provider <claude|codex|agy>`, `--manifest-id <id>`, `--environment-id <id>`, `--catalog-dir <path>`, `--store-dir <path>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Read-only listing. Safe to call anytime.
- **Permission Requirements**: None.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.

### `bflow agent check`

- **Syntax**: `bflow agent check [provider] [options]`
- **Purpose**: Check provider readiness and activated health against platform contracts.
- **Reused Engines**: `AgentProviderRegistry`, `OperationLedger`
- **Required Flags**: None
- **Optional Flags**: `--provider <claude|codex|agy>`, `--stage <preflight|activated>`, `--environment-id <id>`, `--correlation-id <id>`, `--idempotency-key <key>`, `--resume`, `--actor <id>`, `--role <role>`, `--permission-mode <mode>`, `--session-id <id>`, `--isolation <kind>`, `-j, --json`, `-h, --help`
- **Idempotency & Retry**: Health probe. Safe to execute periodically without state mutation.
- **Permission Requirements**: Provider probe execution privilege.
- **Associated Skills**: `using-bflow`
- **Exit Codes**:
  - `0`: Command succeeded without errors.
  - `1`: Runtime or execution failure.
  - `2`: CLI argument or option validation error.
