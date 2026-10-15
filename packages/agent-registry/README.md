# File-backed Agent Registry

`createAgentRegistry({ stateFile, clock? })` implements `AgentRegistry` with an explicit single-host state file. `AgentConfiguration.settings` preserves provider, kind and execution settings as contract-defined JSON; transport-specific validation belongs to the transport/runtime using them. `resolve` is deterministic configuration lookup only; `null` means no role/capability match, and it does not reserve capacity.

Every operation uses a process-shared exclusive lock file. Mutations write a temporary file, fsync it, atomically rename it and fsync the containing directory. The versioned state retains lease IDs, idempotency receipts and per-agent fencing watermarks across process restarts. Acquisitions respect `maxConcurrentTasks` and reject a second active lease for the same run/task/attempt. Active leases prevent configuration replacement or removal. Renew/release require the current fencing token and version; expiry uses a trusted injected clock, not caller-supplied timestamps. Duplicate keys with different payloads conflict.

Scope: one machine and one local filesystem shared by all registry processes. This is not a network/distributed lease service and does not claim safety on filesystems without reliable exclusive-create and atomic rename. A process crash while holding the `.lock` file can leave a stale lock; operations time out closed, and an operator must establish that the owner is dead before removing that specific lock. The receipt/history file grows until an explicit future migration/compaction policy is designed. Runtime must hold and verify a current lease/fence immediately before dispatch; Herdr working state is not a lease. This does not implement SQLite or the P03 persistence port.

Run tests with `pnpm exec vitest run packages/agent-registry/test/agent-registry.test.ts` from the repository root.

Operation deadlines are separate from lease expiry time. `operationClock` can be injected for deterministic deadline tests; the default is `Date.now`. A single budget is checked before lock acquisition, after acquiring the lock, before applying a mutation, and before the atomic rename. `timeoutMs: 0` expires immediately; malformed options are validation errors. If the budget expires before commit, temporary state is removed and durable state/fencing remain unchanged. Once rename has begun, the operation completes durability work and reports its committed outcome rather than reporting a retry-safe timeout after mutation.

## MVP SDLC Roles & Configuration

The package provides deterministic role profiles and configurations for the four core SDLC agents:

| Role | Responsibility | Workspace Confinement | Output Requirements |
| --- | --- | --- | --- |
| `planner` | Decomposes high-level requirements into deterministic DAG tasks | `readOnlyWorkspace: true` | DAG tasks, dependencies, criteria; no code changes |
| `developer` | Implements task changes within an isolated worktree branch | `readOnlyWorkspace: false` (confined to assigned worktree) | Git commit, relative changed files, self-reported test summary, patch proposal |
| `reviewer` | Read-only code review, security audits, and criteria verification | `readOnlyWorkspace: true` (`modifiedFiles: []`) | Approval decision (`approved` / `changes_requested`), findings, criteria evaluation |
| `qa` | Independent quality assurance and automated test verification | `readOnlyWorkspace: true` | Independent test execution evidence, passed/failed verdict; agent self-claims never trusted |

### Multi-Provider / Multi-Model Configuration

Agents can be configured across multiple providers (Anthropic Claude, OpenAI Codex, Google Gemini, local runners) without hardcoding a single model:

- `createMvpRoleConfiguration(input)`: Validates and constructs an `AgentConfiguration` enforcing role invariant policies (`readOnlyWorkspace`, `allowTaskDelegation: false`, `requiresIndependentTestVerification: true`, positive integer `maxTokens`, finite `temperature` in `[0, 2]`, and NUL-free execution arguments).
- `createDefaultMvpConfigurations(overrides?)`: Generates standard configurations for all 4 roles, optionally accepting per-role overrides for provider, kind, model, priority, or execution parameters.
- `seedMvpAgentRegistry(registry, overrides?, options?)`: Seeds an `AgentRegistry` with the 4 MVP role configurations via idempotent upserts.
- `resolveMvpRoleAgent(registry, role, context, options?)`: Deterministically resolves a configured agent for a role and context, returning the `configuration`, validated `settings`, and `MvpRoleProfile`.

## Workflow Definitions & Loader

The workflow module provides templates and validation for three core SDLC workflow types:

- **`feature`** (`createFeatureWorkflowDefinition`): Standard implementation flow `plan -> implement -> review -> qa`. Requires approval on review and a quality gate binding on QA.
- **`bugfix`** (`createBugfixWorkflowDefinition`): Root cause analysis, fix with regression tests, review, and regression verification gate.
- **`refactor`** (`createRefactorWorkflowDefinition`): Modular decomposition and invariant documentation, behavior-preserving code refactoring, review, and invariant verification gate.

### Workflow Validation & Verification

- `validateMvpWorkflowConventions(workflow)`: Enforces that:
  - All tasks use valid MVP roles (`planner`, `developer`, `reviewer`, `qa`). Arbitrary delegation or out-of-scope roles are rejected.
  - Every task specifies non-empty acceptance criteria.
  - Reviewer tasks have `requiresApproval: true`.
  - QA tasks have at least one required `qualityGates` binding.
- `loadWorkflowDefinition(source, options?)`: Loads and validates workflow definitions from a `WorkflowKind` string (`feature`, `bugfix`, `refactor`), raw JSON string, or object.
- `verifyWorkflowRolesRegistered(workflow, registry, runId, options?)`: Resolves and verifies that every role required by tasks in the workflow is registered and active in the provided `AgentRegistry`.

## Parameterized Prompt Rendering & Safety Guardrails

- `renderRolePrompt(role, params, options?)`: Generates structured, deterministic system and task prompts for each MVP role. Prompts incorporate:
  - Role definition, mission, and constraints.
  - `UNTRUSTED_CONTENT_SAFETY_RULES` (6 inviolable rules).
  - Trusted input artifact links and URIs (`ArtifactReference`).
  - Strict JSON schema for required structured output.
  - Role-specific parameter validation (e.g., rejecting `..` traversal in developer `worktreePath`, ensuring input artifact `runId` matches prompt `runId`, and checking allowed input artifact kinds).

### Prompt-Injection & Untrusted Content Guardrails

All repository content, issue descriptions, diffs, and test logs are treated as untrusted data:

- `wrapUntrustedRepositoryContent(label, content)`: Escapes delimiter breakout tags and wraps untrusted data inside `<UNTRUSTED_REPOSITORY_CONTENT label="..." trust="untrusted_data_only">` XML fences.
- `detectDangerousInstructions(content)`: Scans content for dangerous prompt injections across 7 categories:
  1. `prompt_override`: Directives attempting to ignore or override prior system instructions or prompts.
  2. `role_escape`: Attempts to change role, act as admin/root, or enter jailbreak modes (e.g. DAN).
  3. `approval_or_test_bypass`: Instructions to auto-approve reviews, fake test passes, or skip quality gates.
  4. `arbitrary_delegation`: Unauthorized delegation to external agents, spawning processes, or piping downloads to shells.
  5. `dangerous_command`: Destructive commands (`rm -rf /`, `mkfs`, fork bombs, raw device writes, root permissions).
  6. `secret_exfiltration`: Attempts to read or exfiltrate environment variables, credentials, `.env`, or private keys.
  7. `delimiter_breakout`: Closing tags (`</UNTRUSTED_REPOSITORY_CONTENT>`), fake system fences, or raw LLM special tokens.
- `validateUntrustedContentPolicy(content, options?)`: Evaluates content safety and returns a validation error if dangerous instructions are detected when strict policy enforcement is active.

## Structured Output Validation & Contract Mappers

Each role must respond with a strictly formatted JSON payload conforming to its role contract:

- **`planner`** (`PlannerOutput`): High-level summary, list of planned tasks with acceptance criteria, and explicit task dependencies. Validates unique task IDs, MVP roles only, and absence of dependency cycles.
- **`developer`** (`DeveloperOutput`): `taskId`, `worktreePath` (matching assigned path, no `..`), `commit` (valid 7-40 hex SHA), relative `changedFiles` (no absolute paths or `..`), and `testReport` (`selfReportedOnly: true`, exitCode/failure consistency).
- **`reviewer`** (`ReviewerOutput`): `taskId`, `decision` (`approved` or `changes_requested`), `summary`, `criteriaEvaluation`, `findings`, and `modifiedFiles: []` (strictly empty array; reviewer cannot edit code). `approved` requires all criteria met and no error findings; `changes_requested` requires at least one unmet criterion or finding.
- **`qa`** (`QaOutput`): `taskId`, `verdict` (`passed` or `failed`), `summary`, `criteriaVerification`, and `testVerification` containing `independentRunVerified: true`, integer `exitCode`, non-negative test counts, and non-empty `evidenceArtifactIds`. A `passed` verdict strictly requires `independentRunVerified === true`, `exitCode === 0`, `failedCount === 0`, `passedCount > 0`, and all criteria verified.

### Validation & Mapping Functions

- `validateRoleOutput(role, rawOutput, context?)`: Validates and parses raw output (string or object), rejecting unauthorized delegation fields (`delegatedTasks`, `subagents`) and role mismatches.
- `toContractAgentResult(output, envelope)`: Maps validated output to an `@bflow/contracts` `AgentResult`. QA failed verdicts are mapped to `status: "failed"` with code `qa_verification_failed`.
- `toContractApprovalDecision(output, envelope)`: Maps `ReviewerOutput` to an `@bflow/contracts` `ApprovalDecision`.
- `toContractQualityGateResult(output, envelope)`: Maps `QaOutput` to an `@bflow/contracts` `QualityGateResult` with structured quality findings.

## Trusted Artifact Reference Handoff

Direct sharing of unverified `ArtifactProposal` values across roles is strictly prohibited. Artifacts must be ingested into an `ArtifactStore` before being passed to downstream roles:

- `ROLE_ARTIFACT_HANDOFF_RULES`: Defines legal handoff paths and allowed/required artifact kinds:
  - `planner -> developer`: documents, reports, agent-outputs (default required: `document`).
  - `developer -> reviewer`: patches, test-results, reports, agent-outputs, logs (default required: `patch`).
  - `reviewer -> developer` (rework): reports, documents, agent-outputs (default required: `report`).
  - `developer -> qa`: patches, test-results, logs, reports, agent-outputs (default required: `test-result`).
  - `reviewer -> qa`: reports, documents, patches, test-results, logs, agent-outputs (default required: `report`).
- `createRoleArtifactHandoff(request)`: Validates that handoff follows role rules, all artifacts are stored `ArtifactReference` objects matching the run ID, without duplicate IDs, and containing all required kinds.
- `ingestRoleArtifactProposals(store, proposals, contentByProposalId, options?)`: Ingests proposals into an `ArtifactStore` after verifying byte size and cryptographic checksums, returning trusted `ArtifactReference` records.

## End-to-End Feature Workflow Example

- `buildCompleteFeatureWorkflowExample(store)`: Demonstrates the complete 4-stage SDLC execution lifecycle using a required `ArtifactStore` (trusted `ArtifactReference` records with `trust: "stored"` can only originate from `ArtifactStore` ingestion; omitting `store` returns a validation error):
  1. **Planner**: Renders prompt, produces specification artifact proposal, ingests into store, generates planned DAG, and produces contract `AgentResult`.
  2. **Developer**: Receives stored specification reference via handoff, renders prompt with isolated worktree path, produces patch and unit test proposals, stores them, and produces contract `AgentResult`.
  3. **Reviewer**: Receives patch and test references via handoff, renders review prompt with diff, generates review report proposal, validates `approved` decision, and produces contract `AgentResult` and `ApprovalDecision`.
  4. **QA**: Receives review report and independent test log references, renders QA prompt, verifies independent test execution evidence, validates `passed` verdict, and produces contract `AgentResult` and `QualityGateResult`.
