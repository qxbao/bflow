# Approved receipt implementation and compatibility evidence — 2026-10-16

Tested source commit: `728f706ca92c5ee9dfab7cc67eb0daed99ce24ad`.
Baseline: P19 `973a943` (including implementation `a44d2a1`).
Branch/worktree: `agent/runtime/p19-authenticated-receipts`, `/tmp/bflow-p19-receipts`.
Approval: project owner's “Proposal: duyệt”; integration/migration decision: ADR 0003.

## Release compatibility regression

The exact 0.9.1 CLI allowlist is removed. CLI versions are diagnostic metadata;
actual protocol/schema and operation responses determine compatibility. There is
no bypass flag. Project AGENTS.md now explicitly forbids reintroducing CLI release
allowlists or requiring an upgrade merely because a version is untested.

The test matrix accepts labels 0.9.0, 0.9.1, 0.9.5, 0.10.0, 1.0.0 and
99.0.0-dev with protocol 22/schema 1. Even the familiar 0.9.1 label is refused
when the actual protocol/schema is incompatible or malformed. These are runner
fixtures, not claims that all those binaries were installed and tested live.

The installed binary changed between the preceding task and this task: it now
reports `herdr 0.9.5`. This implementation did not upgrade or replace it. There
was no live 0.9.0 binary in this run. Actual Adapter initialization on 0.9.5
passes protocol/schema negotiation without weakening outcome verification.

## Validation results

Linux/local filesystems, Node 24.16.0, pinned pnpm 12.5.1.

| Command | Exit | Actual result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Isolated worktree dependencies |
| `pnpm build` | 0 | All packages built before worker/native plugin tests |
| `pnpm check:deps` | 0 | 15 packages, 22 internal edges; boundaries/cycles pass |
| `pnpm typecheck` | 0 | Full monorepo |
| `TMPDIR=/tmp pnpm exec vitest run packages/herdr-adapter/test --maxWorkers=2 --minWorkers=1` | 0 | 68 passed, including release-independent regression matrix |
| `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts -t 'binding proof\|binding receipts' --maxWorkers=1 --minWorkers=1` | 0 | 5 receipt cases passed, 21 unrelated cases filtered out |
| `TMPDIR=/tmp pnpm test --maxWorkers=2 --minWorkers=1` | 0 | 1,209 passed, 2 skipped; 52 files passed, 2 skipped |
| `BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 1 actual native Herdr transport smoke passed |
| `TMPDIR=/tmp pnpm test:e2e --maxWorkers=2 --minWorkers=1` | 1 | 61 passed, same 2 pre-existing E09 CLI failures |
| `git diff --check`, staged diff check, `git status --short` | 0 | No whitespace errors; source commit worktree clean |

The E09 failures remain the baseline legacy expectations for `init` in a non-Git
empty directory producing `.bflow/config.json`, and legacy uninitialized `status`
error behavior. Their baseline reproduction is recorded in P19-VALIDATION.md.
No fixture was rewritten to conceal those CLI discrepancies.

## What is implemented and what was actually exercised

- An additive `AuthenticatedWorkflowEngine.verifyAgentBinding` capability;
  Ed25519 issuer verification over canonical receipt bytes; immutable raw handle;
  exact request/execution/attempt/target/session checks; proof-bound ArtifactStore
  reference; cancellation and conflicting-proof rejection.
- Separate `agent.binding_verified` and proof command-receipt event envelopes v2.
  Aggregate codec v2 retains proof/command history, while receipt-free v0/v1 data
  remains readable. No SQL migration. No upcaster manufactures missing proof.
- Core live validation and replay, signed-result acceptance, SQLite projection,
  checkpoint/tail recovery and rejection without the configured issuer keys.
  Positive tests retain `agentExecution.correlation.verified: false` while storing
  the independent binding proof. Negative cases cover bad signatures, unknown
  issuer, wrong execution and receipts arriving after cancellation.
- Runtime ingress validates the sender, causation, original binding and current
  Registry lease, ingests actual immutable receipt bytes, and persists the proof
  before accepting an authenticated result. Existing independent gates remain.
- A native Herdr plugin action signs structured messages, checks the host role
  manifest, and checks actual Herdr pane/session identity before binding attestation.
  Its local ingress verifies the entire message signature before installing scoped
  authentication context. `openAgenticWorkspace` can own that ingress endpoint.

The live smoke starts its own headless named Herdr session, workspace and native
custom process, initializes the actual Adapter, and invokes the actual Herdr
`plugin.action.invoke` API. Herdr launches the actual plugin entrypoint, which
forwards a signed RoleMessage to the host ingress. The signature and scoped
authentication are checked; no snapshot text is treated as a message or proof.
Only test-owned sessions, short XDG/socket paths and a private ZDOTDIR are used;
no normal user session, home shell configuration or installed binary is changed.
All test signing keys are ephemeral and are removed with the test directory.

The custom process is deliberately not an AI provider. On this installed version
it exposes no native `agent_session`, and a normal prompt submission is observed
as `unknown_delivery`/not ready. That operation is not blindly resent or upgraded
to accepted business output. The test verifies signed RoleMessage delivery, not
live binding attestation for a session-less actor. The installed source documents
this distinction in `session_ref_from_report`, which accepts native session refs
only from official integration sources:
https://github.com/herdrdev/herdr/blob/v0.9.5/src/agent_resume.rs

Official provider hooks must expose their actual native session before receipt
attestation. End-to-end AI-generated implementation/review, provider-native tool
registration, and automatic CLI host boot/shutdown are not claimed live-verified.
Private keys must remain in the trusted native host, outside prompts/agent tools;
keep historical public keys for replay. Hostile same-user isolation, multi-host,
network filesystem and power-loss guarantees are not added.

## Scope and generated files

Changes span the owner-approved Adapter/Contracts/Core/Persistence/Runtime boundary,
project compatibility instructions, native Coordinator host plugin and documentation.
Legacy WorkflowEngine method signatures and receipt-free event/checkpoint behavior
remain unchanged. New readers are required before enabling receipts for a RunStore;
old strict readers reject the new proof/event/codec, as required by ADR 0003.
No generated dist, coverage, database, artifact, private key or process log is committed.
Existing P02-RA01/P03-RA01 follow-ups remain unchanged with their original owners.
