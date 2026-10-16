# ADR 0003 — Release-independent Herdr compatibility and authenticated binding receipts

Status: accepted by the project owner in this conversation on 2026-10-16:
“Bỏ cái chặn cứng mọi phiên bản ngoài 0.9.1 đi. Đừng để lần sau tái diễn. Proposal: duyệt”.
This is the integration decision required by AGENTS.md; it approves the receipt
proposal in packages/runtime/P19-RECEIPT-DECISION-PROPOSAL.md.

CLI release strings are diagnostics. Protocol/schema and actual operations determine
compatibility. Regression coverage must include older and newer compatible release
labels and actual incompatible wire schemas. The installed binary is tested without
requiring an upgrade solely because its release label differs from a previously tested one.

The authenticated binding capability extends WorkflowEngine through a separate
AuthenticatedWorkflowEngine.verifyAgentBinding port. It preserves the original
immutable handle, accepts only Ed25519 receipts from host-configured trusted issuers,
checks the exact original identity/target/session and a content-bound ArtifactStore
receipt reference, and persists a separate agent.binding_verified event. Neither
Herdr done nor agent-written text can manufacture this proof. The signing key stays
in the trusted native host, outside prompts and agent-facing tool arguments.

Affected owners: Contracts/integration, Herdr Adapter/native host, Core/Runtime,
Conversation agent host and CLI lifecycle. Native ingress still uses Herdr; no direct
model API, artifact polling mailbox or unrelated approval bypass is introduced.

Compatibility/migration: existing commands, v0/v1 events and codec-v1 aggregate
checkpoints retain their shapes and behavior. The new proof event uses envelope
schema version 2; receipt-free events stay v1. The new operation's command receipt
also uses event envelope v2 so old readers reject it. Aggregates containing proof
or proof command history use aggregate codec v2. The envelope/checkpoint schema and
SQLite storage schema are unchanged; no SQL migration or fabricated upcaster is
needed. New readers accept codec v1 without proof and codec v2 with validated proof;
old readers fail closed on new event/codec versions. The maintained query projection
also retains optional bindingVerification; old strict snapshot readers reject that
new field. Enable receipts only after upgrading all readers of the affected RunStore. Unverified historical bindings
remain unverified unless explicit valid proof arrives. Keys must remain configured
for historical receipt verification; rotation requires retaining old verification keys.

Late, mismatched, stale, conflicting or unsigned receipts are rejected. Proof cannot
reopen cancellation or terminal execution, nor replace an existing binding. Runtime
checks lease authority, ingests the immutable receipt, then records the Core event
before accepting a conclusive result. Independent quality/verification gates remain
mandatory. This decision does not authorize protected merges, production deployment,
destructive cleanup, secret/access mutation or remote publication.
