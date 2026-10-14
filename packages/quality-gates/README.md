# Quality Gates & Security Enforcement (`@ai-flow/quality-gates`)

Independent quality control, command evaluation, and application-layer security enforcement that never trusts subjective AI agent claims.

Run tests from the repository root:
```bash
pnpm exec vitest run packages/quality-gates/test/quality-gates.test.ts
```

---

## 1. Purpose & Core Philosophy

In an automated AI software development lifecycle (SDLC), autonomous agents generate code, execute steps, and claim success. However, an agent's self-reported success cannot be treated as authoritative evidence:
- **Zero Trust for Agent Claims**: Self-reported success (`agentResult.status: "succeeded"`) or claim of "all tests passed" is never sufficient to pass a quality gate.
- **Independent Execution & Evidence**: Quality gates re-execute deterministic commands (`typecheck`, `lint`, `test`, `build`, or allowlisted `custom`) in an isolated subprocess (`shell: false`), verifying exit codes, stdout/stderr streams, test counts, and cryptographic evidence artifacts.
- **Application-Layer Security Guardrails**: Execution is tightly governed by static security policies that block shell injection, arbitrary agent-provided commands, destructive disk/database operations, credential access, and production deployments.
- **Strict Role-Based Access Control (RBAC) & Human Governance**: Autonomous roles are constrained by least-privilege boundaries (e.g. read-only reviewers, worktree-confined developers, sandbox-confined QA), and delivery operations (`merge_branch`, `deploy_release`) strictly require both 100% passing automated quality gates AND unforgeable human approval.

---

## 2. Quality Gate Evaluator

The evaluation engine executes checks and translates runtime outcomes into `@ai-flow/contracts` `QualityGateResult` structures.

### Supported Check Kinds

| Kind | Purpose | Default Command | Required Evidence |
| --- | --- | --- | --- |
| `typecheck` | Static TypeScript / compiler verification | `pnpm typecheck` | Exit code 0, non-empty output |
| `lint` | Static code style and rule enforcement | `pnpm lint` | Exit code 0, no error findings |
| `unit_test` | Automated test suite execution | `pnpm test` | Exit code 0, non-zero passing tests, zero failures |
| `build` | Project artifact compilation / bundling | `pnpm build` | Exit code 0, non-empty output |
| `custom` | Statically allowlisted verification tasks | Configured `CommandSpec` | Exit code 0, custom output assertions |

### Key Evaluator Components

- **`CommandQualityGate`**: Implementation of `@ai-flow/contracts` `QualityGate`. Evaluates a `QualityCheckSpec` against an injected `QualitySecurityPolicy` and `QualityCommandRunner`.
- **`createQualityGate(options)`**: Instantiates a `CommandQualityGate` with custom specifications, security policy, and runner.
- **`createPresetQualityGate(input)`**: Convenience factory for the 5 standard check kinds with preset commands, path validation, and security policies.
- **`evaluateQualityCheckSuite(gates, context, options?)`**: Sequentially executes an array of quality gates for a workflow run/task, producing a consolidated `QualityCheckSuiteReport`.

### Outcome Status & Contract Mapping

Each quality check produces an internal `QualityCheckStatus` mapped to `@ai-flow/contracts` `QualityGateResult`:

| Internal Status | Contract Status | Criteria |
| --- | --- | --- |
| `passed` | `"passed"` | Exit code 0, all output expectations met, verifiable evidence collected |
| `failed` | `"failed"` | Exit code != 0, forbidden output patterns, or failed test counts detected |
| `skipped` | `"passed"` | Optional check (`required: false`, `skip: true`) with `CHECK_SKIPPED` info finding |
| `error` | `"error"` | Process spawn error, abort signal triggered, timeout exceeded, or security violation |

*Note*: If a check is marked `required: true` (or omitted default) and `skip: true` is requested, it fails with finding `REQUIRED_CHECK_SKIPPED_OR_MISSING_EVIDENCE` and contract status `"failed"`.

### Verifiable Evidence Collection (`ArtifactProposal`)

When a check passes, verifiable evidence is generated:
- Serialized execution record including command line, working directory, exit code, execution duration, and stdout/stderr.
- Generated `ArtifactProposal` conforming to `ArtifactProposalSchema`, containing SHA-256 checksum and exact byte size (`expectedIntegrity`).
- Proposal ID and checksum recorded in `QualityGateResult.metadata` for correlation with downstream `ArtifactStore` ingestion.

### Explicit Failed-Task Reporting

When executing a suite of checks via `evaluateQualityCheckSuite`, failed gates are aggregated into `failedTasks` (`QualitySuiteFailedTaskReport`), detailing:
- `taskId`: Associated workflow task ID.
- `gateId`: Identifier of the failing gate.
- `checkKind`: The kind of check (`typecheck`, `lint`, `unit_test`, `build`, `custom`).
- `status`: `"failed"` or `"error"`.
- `exitCode`: Process exit code (or `null` if spawn error / timeout).
- `timedOut`: Boolean indicating if process exceeded timeout.
- `summary` & `findings`: Detailed error messages and diagnostic findings.

---

## 3. Security Policy & Guardrails

The `QualitySecurityPolicy` provides defensive, multi-layered application-level security checks before any subprocess is spawned.

### Execution Invariants

1. **`shell: false` Always**: All subprocesses are invoked directly via `child_process.spawn` with `shell: false` and arguments passed as an array of discrete tokens. Shell interpreters (`sh`, `bash`, `zsh`, `cmd`, `powershell`) are strictly blocked.
2. **Rejection of Arbitrary Agent Commands**: Directives from agent output attempting to specify shell commands, override commands, or set `skipQualityGates: true` are blocked and rejected with finding `UNTRUSTED_AGENT_COMMAND_REJECTED`.
3. **Executable & Argument Allowlisting**: Only pre-approved executables (`pnpm`, `npm`, `npx`, `tsc`, `vitest`, `eslint`, `git`) matching specific argument prefixes are permitted.
4. **Blocking Destructive Commands**:
   - Filesystem destruction: `rm`, `rmdir`, `shred`, `unlink`, `mkfs`, `fdisk`, `dd`, `truncate`.
   - Destructive Git operations: `git reset --hard`, `git clean`, `git push --force`, `git branch -D`, `git checkout --`.
   - Database destruction: `dropdb`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`, `prisma migrate reset`, `db:drop`, `db:reset`.
5. **Blocking Secret Access & Network Exfiltration**:
   - Secret file patterns: `.env`, `.ssh`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.aws/credentials`, `/etc/shadow`, `/etc/passwd`, `/proc/self/environ`.
   - Exfiltration binaries: `curl`, `wget`, `nc`, `netcat`, `ncat`, `scp`, `sftp`, `ssh`, `ftp`, `socat`.
   - Environment scrubbing: `sanitizeExecutionEnvironment` strips all sensitive API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, etc.).
6. **Blocking Unauthorized Production Deployments**:
   - Blocked deployment tools: `kubectl`, `helm`, `terraform`, `pulumi`, `ansible-playbook`.
   - Blocked publishing commands: `npm publish`, `pnpm publish`, `git push`, `docker push`, `fly deploy`, `vercel --prod`, `netlify deploy --prod`, `serverless deploy`.
7. **Directory Scope Confinement**:
   - Validates that execution targets are valid directories without `..` traversal segments or NUL bytes.
   - Resolves canonical paths using `fs.realpath` to ensure target paths reside strictly inside `allowedRootDirs` and within `assignedWorktreePath`.
   - Rejects sensitive system paths (`/etc`, `/proc`, `/sys`, `/root`, `/dev`).
   - Detects symlink escapes pointing outside authorized directory trees.
8. **Timeout Budget Validation**:
   - Validates timeout integer bounds (`100ms <= timeoutMs <= 2,147,483,647ms`) preventing 32-bit signed integer overflow.
   - Enforces `maxExecutionTimeoutMs` policy ceiling.

---

## 4. Role-Based Access Control (RBAC) & Human Governance

Quality policies define strict separation of duties across the four SDLC roles:

### Role Authorization Matrix

| Role | Read-Only | Allowed Actions | Constraints |
| --- | --- | --- | --- |
| `reviewer` | **Yes** | `read_code`, `analyze_code` | Strictly forbidden from modifying files (`modifiedFiles` must be empty). |
| `developer` | **No** | `read_code`, `analyze_code`, `modify_code`, `run_local_check` | File modifications and checks must remain strictly inside `assignedWorktreePath`. Cannot merge or deploy. |
| `qa` | **Yes** | `read_code`, `analyze_code`, `execute_test_suite`, `evaluate_quality_gate` | Allowed only in authorized non-production environments (`test`, `ci`, `qa-sandbox`). Forbidden from modifying files. |
| `delivery` | **No** | `read_code`, `merge_branch`, `deploy_release` | Requires 100% passed automated quality gates AND valid human approval decision. |

### Strict Separation Between Automated Checks & Human Governance

The function `evaluateAutomatedVsHumanGovernance` enforces that:
- **No Agent Self-Approval**: Mandatory human approval cannot be granted by an AI agent or automated bot (identified via `isHumanApprover`, which rejects identifiers with prefixes `agent:`, `ai:`, `bot:`, `llm:`, etc., or `metadata.automatedOnly: true`).
- **Dual Condition for Delivery**: `canProceedToDelivery: true` strictly requires:
  1. `allAutomatedGatesPassed: true` (no automated gates failed or errored).
  2. If human approval is required, `humanApprovalStatus === "approved"` signed by a verified human actor.
- **Fail-Safe Invariant**: Human approval alone cannot override or mask failing automated quality gates. Both conditions must be satisfied.

---

## 5. Application-Layer Security Limitations

> [!WARNING]
> Application-layer policy validation is **NOT** an operating system kernel sandbox, container (Docker/Podman), virtual machine, or seccomp/AppArmor/cgroup isolation mechanism.

As reported by `getSecurityControlLimitationsReport()` and defined in `APPLICATION_SECURITY_LIMITATIONS`:

1. **Host Process Privileges**: Once an allowlisted binary (`node`, `pnpm`, `vitest`, `tsc`) starts executing, the child process runs with the same OS user permissions as the host process. It can access any files or sockets that the OS user account has permission to read or write.
2. **Untrusted Code Execution within Tools**: Test files, project scripts, compiler plugins, or build scripts executed by an allowlisted runner may contain arbitrary code executed by the underlying runtime.
3. **Time-of-Check to Time-of-Use (TOCTOU)**: Pre-execution path canonicalization (`fs.realpath`) verifies that paths are within allowed directories prior to launch, but cannot prevent race conditions where a concurrently running process alters symlinks during execution.
4. **Filesystem vs Environment Scrubbing**: Scrubbing `process.env` prevents API keys from being inherited via environment variables, but does not prevent child processes from reading unencrypted configuration files on the local filesystem if readable by the user.
5. **Grandchild Process Lifecycle**: If a spawned process detaches and creates grandchild processes without OS process group or cgroup containment, those grandchildren may outlive the parent process after timeout termination.

**Recommended Defense-in-Depth**:
In production and untrusted CI environments, this application-layer quality gate package must be layered inside OS-level sandboxes (e.g., non-root unprivileged container, rootless Podman, Linux namespaces, or isolated VMs).
