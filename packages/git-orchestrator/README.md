# @bflow/git-orchestrator (P18)

Local Git integration mechanics for parallel Developer tasks. Depends only on
`@bflow/contracts` and Zod; does not call the Workflow scheduler, Herdr, Registry,
quality gates or a hosted provider automatically.

## API

```ts
import { GitIntegrationEngine } from "@bflow/git-orchestrator";

const git = await GitIntegrationEngine.open({
  repositoryPath: "/projects/app", // any directory inside a non-bare repository
  artifactStore,                   // contracts ArtifactStore, required
  // provider: configuredGitProvider
});
const repository = await git.inspect(); // root, commonDir, branch|null, head, dirty, status
const task = await git.prepareTask({
  runId: "run-42", taskId: "implement-api", attemptId: "attempt-1",
  developerId: "developer-1", baseRevision: repository.head,
  ownedPaths: ["packages/api"], forbiddenPaths: ["packages/api/secrets"]
});
// Runtime assigns this worktree to that Developer. Developer commits using Git.
// Caller must release the Developer's write access before collect/integrate/cleanup.
const changeSet = await git.collectTask(task.key);
const integration = await git.beginIntegration({
  runId: "run-42", integrationId: "integration-1", baseRevision: repository.head,
  tasks: [{ taskKey: task.key, dependsOn: [] }]
});
// integration.status === "awaiting_verification" does not mean task/workflow success.
// Runtime consumes integration.requests and executes independent workflow verification.
```

All methods return Promises; rejected mutations preserve changes and provide an error.
`GitOrchestrationError.code` describes policy failures; Git subprocess and Zod
validation errors retain their diagnostics. No engine method commits Developer
changes, resets a checkout, auto-stashes, resolves conflicts, deletes branches,
force-pushes, or merges a protected/main branch. Branch integration uses a dedicated
`integration/bflow/...` branch, even when `baseRevision` names `main`.

| Method | Behavior |
| --- | --- |
| `open({repositoryPath, artifactStore, provider?})` | Discover canonical repository/common Git directory; validate/load journal. Requires an initial SHA-1 commit. |
| `inspect()` | Observe root, current branch (null when detached), HEAD and NUL-delimited porcelain status without changing the checkout. |
| `prepareTask(request)` | Persist creation intent, create/lock a unique task worktree and deterministic `agent/bflow/<run>/<task>/<attempt>` branch; retry identical requests idempotently. Reject dirty source, collisions or changed inputs. |
| `taskBranchName(request)` | Return the same safe branch name before creation; readable truncated IDs plus hash suffixes preserve identity. |
| `getTask(key)`, `getIntegration(key)` | Read a detached copy of the persisted record. |
| `collectTask(taskKey)` | Require clean worktree, new linear commits descending from recorded base, net changes and ownership compliance in **every commit**, including changes later reverted. Store actual binary-capable patch via ArtifactStore; return parsed `GitChangeSet`, commits and summary in metadata. |
| `beginIntegration(request)` | Validate dependency DAG and all submissions/artifacts before creating an integration worktree. Pin task commits, then merge in topological order. Persist intent and receipts around every merge. Reuse of a plan ID with different input fails. |
| `resumeIntegration(key)` | Reconcile pending Git operations with pinned commits and exact expected merge parents. No duplicate merge/verification request on restart. A recorded conflict waits for explicit resolution acknowledgement. Dirty, unexpected or inconsistent state fails closed. |
| `acceptConflictResolution(key, {taskKey, resolutionCommitHash})` | Accept an externally resolved, committed merge only when clean, matching the pending task/HEAD, with exact merge parents and changes within that task's scope. Continue remaining merges, then request verification. |
| `recordVerification(key, result)` | Parse exported `VerificationResultSchema`. Require workflow scope, matching run and `metadata.integrationCommitHash` equal to the exact integration HEAD. Read/checksum all evidence and task patch artifacts. A `passed` result marks Git integration `verified`; other results retain `awaiting_verification`. |
| `cancelTask(key)` | Mark cancelled, preserving all committed/uncommitted work. Refuse while pinned by a live integration. |
| `cancelIntegration(key)` | Mark cancelled; retain any pending merge, conflict markers and edits. Cancellation never aborts Git. |
| `cleanupTask(key)` | Remove only a clean, released task worktree after cancellation or verified integration; reject pending integrations, untracked/ignored files and in-progress Git operations. Retain its branch and journal. |
| `cleanupIntegration(key)` | Remove only a clean verified/cancelled integration worktree. Retain its branch and receipts. Repeating cleanup, including after process death, is safe. |
| `requestPullRequest(key, {remote, baseBranch, title, body})` | Explicit publication request. Require configured provider, existing remote/base, provider permission, passing workflow verification and readable evidence. Push **pinned verified SHA** to the dedicated integration branch with ordinary non-force push, disabling automatic tag and submodule publication, then create/reconcile PR. Never merge the PR. |

`ownedPaths`/`forbiddenPaths` are literal repo-relative files or directory prefixes,
without glob syntax, trailing slash, `.` or `..`. Prefix matching respects directory
boundaries. Renames are represented as deletion plus addition so both paths are
checked. Generated/sensitive tracked paths (`node_modules`, `dist`, `coverage`,
`.git`, `.bflow`, `.env*`, private keys, databases and build metadata) are rejected.
Binary line counts are zero; their bytes remain in the stored Git binary patch.
Unsupported/non-UTF-8 filenames fail rather than changing their ownership meaning.
An uncommitted no-op task cannot produce the frozen `GitChangeSet` contract, which
requires at least one changed file and a stored patch.

## Runtime handoff and conflict ownership

`IntegrationRecord.requests` is a durable outbox of exported `RoleMessage` records:

- `task.status` with `reason: "merge_conflict"`, incoming task/commit, Developer ID,
  integration worktree, pre-merge tip and conflict paths; recipient Coordinator.
- `verification.requested` with `verificationScope: "workflow"`, exact integration
  commit, branch/worktree and source patch references; recipient Coordinator.

Runtime must deliver messages through Herdr with stable message/idempotency IDs,
reconcile transport delivery, and create the proper leased assignment for the
original Developer or another approved resolver. The engine never dispatches an
agent, treats Herdr `done` as success or uses artifact files for communication.
The resolver commits the pending merge in the **integration** worktree, retaining
its recorded two parents, and Runtime acknowledges that commit using
`acceptConflictResolution`. Do not allocate that worktree to another writer while
a resolver holds it. Complex or out-of-scope conflicts remain for the Coordinator
and human decision; there is no automatic ours/theirs or rebase fallback.

The engine checks the supplied verification receipt and its stored evidence.
Specification acceptance, independent execution, leases/fencing, SDLC/task state,
verification iteration limits and task-completion decisions remain Runtime/P17
responsibilities. Git integration status is a separate local state domain.

## Persistence, recovery and cleanup

The common Git directory contains `bflow-git/state.json`, a local versioned journal,
lock and managed worktrees. Atomic rename, file sync and directory sync preserve
creation/merge intents, pinned submissions, receipts, conflict/verification requests
and PR attempts across process restart. Corrupt/unsupported state is rejected.
There is no automatic journal upcaster and no change to shared RunStore contracts.

Operations across engine instances use Linux `flock`; a live operation returns
`busy` instead of interleaving another mutation. The lock file descriptor is inherited by every Git child: an orphan Git process
continues to exclude new engine mutations after its parent dies. The kernel releases
the lock only when all holders exit. Pending branch/worktree creation is reconciled against recorded base and
bindings. Pending merge recovery checks `MERGE_HEAD`, worktree state and exact
merge parents; it recognizes an already committed merge before advancing receipts.
A clean unchanged tip allows retry of the same pinned merge. Unresolved or
uncommitted merges request explicit reconciliation. Leftover Git lock files are
never deleted automatically. Git/filesystem/ArtifactStore/provider writes are not
one atomic transaction.

Cleanup checks Git status, ignored files, branch/repository bindings and pending
operations, then unlocks/removes the worktree without `--force`. Interrupted cleanup
can be repeated. Index flags `assume-unchanged` and `skip-worktree` can hide
tracked local edits from Git status and Git worktree removal. Operations requiring
a clean tree reject these flags with `unsupported_index_flags`; inspect the files
and clear the flags explicitly before retrying. Sparse checkouts using
`skip-worktree` are currently unsupported. The engine never clears these flags
or discards the hidden edits automatically. Branch deletion is a separate owner decision and is deliberately
absent from this API. Cancellation does not imply cleanup eligibility when data
or a pending Git operation remains.

## Provider adapter

Implement the exported `GitProvider` interface and inject it at `open`:

```ts
interface GitProvider {
  checkAccess(request: ProviderRequest): Promise<boolean>;
  find(request: ProviderRequest): Promise<{ url: string } | null>;
  create(request: ProviderRequest): Promise<{ url: string }>;
}
```

`ProviderRequest` includes remote URL, head branch, exact verified SHA, base branch,
title/body and stable `idempotencyKey`. The adapter must verify repository identity,
remote authorization and head SHA; `create` must be durably idempotent. `find`
reconciles a response lost after server-side creation. Do not return `null` when
access or lookup is inconclusive. Ambiguous delivery retains `pending` in the
journal and may be resumed with the exact same request. Changing a pending/created
PR's target or contents is rejected. Exactly one push URL is required for the
selected remote. No hosted-provider credentials are bundled. Tests use a local
bare remote and injected provider; live GitHub/GitLab access is **not verified**.

## Validation and integration notes

Requires Linux, local filesystems, `git`, `flock`, Node >=22.13 and pinned pnpm.
Inherited `GIT_*` repository/index overrides are removed; Git runs with literal
arguments, no shell, interactive credential prompts, hooks, signing, rerere,
autostash, external diff or textconv. Commands have a 60-second/64-MiB output bound.
Timeout/error leaves durable intent for reconciliation. The engine does not claim
network-filesystem, multi-host, hostile same-user or power-loss guarantees.

From repository root:

```sh
pnpm --filter @bflow/git-orchestrator build
pnpm --filter @bflow/artifact-store exec tsc -b
pnpm --filter @bflow/git-orchestrator test
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
```

Tests use real temporary repositories and the real filesystem ArtifactStore,
including independent tasks, successful/conflicting merges, dirty state, missing
commits/artifacts, duplicate branches, ownership/history checks, cancellation,
cleanup, provider publication/reconciliation, and SIGKILL before/during/after a merge, including an orphan Git process retaining the lock.
Crash subprocess tests import `dist`; build both packages first and after edits.

The shared frozen contracts have no Git orchestration port. This package exports
local validated configuration/journal APIs while all exchanged SDLC evidence,
artifact operations, verification results and role messages use contracts.
Integration owner must review any future shared Git port with its compatibility
plan; this implementation does not amend contracts or scheduler APIs. Root
TypeScript references and the lockfile importer include this package, so the root
build and test commands also cover P18. Runtime composition remains P19 work.
