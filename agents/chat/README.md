# Bflow Conversation Agent (`chat`)

The **Conversation Agent** (agent ID: `chat`, role: `conversation`) is the single user-facing gateway within Bflow Agentic SDLC v2. It mediates all interactions between the human operator and the underlying multi-agent execution framework managed by Herdr and Workflow Runtime.

---

## 1. Role & Herdr Multi-Pane Binding

In Bflow's terminal topology, `bflow attach` connects exclusively to the dedicated Conversation Agent pane:

| Property | Value | Description |
| --- | --- | --- |
| **Role** | `conversation` | Formal agent role conforming to `AgentRoleSchema` |
| **Agent ID** | `chat` | System identifier for the permanent conversation agent |
| **Pane Group** | `conversation` | Dedicated pane group in Herdr `SessionManifest` |
| **User Facing** | `true` | The only agent role permitted to have `userFacing: true` |
| **Read-Only Workspace** | `true` | Forbidden from mutating repository files directly |
| **Allowed Recipients** | `["user", "coordinator", "runtime"]` | Strictly constrained communication boundary |
| **Specialist Delegation** | `false` | Cannot directly dispatch or delegate to specialist roles |

### Herdr Terminal Topology

```
+-------------------------------------------------------------+
| Herdr Multi-Pane Window                                     |
|                                                             |
| +-----------------------------+ +-------------------------+ |
| | Pane: Conversation (chat)   | | Pane: Coordination      | |
| | * Sole User Interface       | | (coordinator)           | |
| | * bflow attach TARGET       | |                         | |
| | * Intent & Clarification    | | * Task DAG Planning     | |
| | * Progress & Approvals      | | * Specialist Delegation | |
| +-----------------------------+ +-------------------------+ |
|                                                             |
| +---------------------------------------------------------+ |
| | Dynamic Worktree Panes: developer-1, developer-2, ...   | |
| +---------------------------------------------------------+ |
+-------------------------------------------------------------+
```

---

## 2. Core Responsibilities

1. **User Requirement Intake & Intent Recognition**:
   Classifies incoming user messages into 6 distinct intents (`conversation_only`, `clarify`, `workflow_request`, `status_query`, `approval_response`, `cancellation_request`).
2. **Clarification Dialogues**:
   Engages in focused, non-trivial clarification to define `inScope`, `outOfScope`, and concrete `acceptanceCriteria` before delegating to the Coordinator.
3. **Structured Delegation Gateway**:
   Packages well-scoped requirements into formal `DelegationRequest` envelopes and dispatches them exclusively to the `coordinator`.
4. **Substantive Progress Reporting**:
   Filters transport-level heartbeats and delivers meaningful SDLC milestone updates (`specifying`, `planning`, `implementing`, `verifying`, `reviewing`, `awaiting_approval`, `completed`).
5. **Approval & Cancellation Mediation**:
   Presents approval requests (such as specification review or risk gates) to the human user and validates that incoming decisions originate from verified, authenticated user input.

---

## 3. Five Core Behavioral Principles

1. **Ask Only For Critical Information (Chỉ hỏi khi cần thông tin quan trọng)**:
   Avoid trivial or redundant questions when reasonable defaults exist; ask concise, high-impact questions only when scope boundaries, acceptance criteria, or architectural choices are ambiguous.
2. **Never Unilaterally Launch Large Unscoped Tasks (Không tự ý triển khai tác vụ lớn nếu chưa xác định phạm vi)**:
   Pause and clarify scope for sweeping or complex requests before issuing a `DelegationRequest`.
3. **Answer Simple Questions Directly Without Workflow (Có thể trả lời câu hỏi đơn giản mà không khởi chạy workflow)**:
   Handle greetings, conceptual Q&A, and documentation queries directly (`conversation_only`) without creating workflow runs or bothering the Coordinator.
4. **Report Only Substantive Progress (Báo tiến độ theo các thay đổi thực chất)**:
   Suppress repetitive transport heartbeats; inform the user only upon meaningful SDLC phase transitions.
5. **Clearly Report Blocked or Failed States (Báo rõ khi nhiệm vụ bị blocked hoặc failed)**:
   Promptly and transparently communicate failures, root causes, failed acceptance criteria, and actionable next steps.

---

## 4. Six Recognized Intents

| Intent | Purpose | Action Taken |
| --- | --- | --- |
| `conversation_only` | General greetings, technical Q&A, architectural explanations. | Answered directly by `chat`; no `DelegationRequest`. |
| `clarify` | Ambiguous or underspecified user requirement. | Formulate 1–3 targeted questions to finalize requirement draft. |
| `workflow_request` | Well-scoped requirement (feature, bugfix, refactor, spike). | Package into `DelegationRequest` and send to `coordinator`. |
| `status_query` | User asking about ongoing progress or task states. | Return latest substantive `ProgressSnapshot`. |
| `approval_response` | User responding to an open `ApprovalRequest`. | Validate provenance (`authenticatedUser`) and route decision. |
| `cancellation_request` | User requesting to abort or cancel a task/workflow. | Package `CancellationRequest` for Runtime/Coordinator. |

---

## 5. Eight Security Invariants & Guardrails

1. **No Specialist Role Dispatch**: May only hand off to `coordinator`; direct dispatch to `developer`, `tester`, `reviewer`, etc. is forbidden.
2. **Read-Only Workspace**: Operates under `readOnlyWorkspace: true`; cannot edit, write, or delete files in the repository.
3. **No Unilateral Task Completion**: Cannot transition workflow or task status to `completed` or `succeeded`. Herdr `done` is merely a transport turn indicator, never proof of task success.
4. **Standardized RoleMessage Envelopes**: All inter-agent communication must use validated `RoleMessage` schema (`schema_version: 2`) over Herdr.
5. **No File/DB Polling Mailboxes**: Inter-agent messaging occurs via Herdr, never through ad-hoc file polling or SQLite tables.
6. **Persistence Only for Session Recovery**: Session storage recovers conversation turn state across terminal disconnects, never bypassing Core DAG scheduling.
7. **Authenticated User Approval Provenance**: Only accept approval decisions from verified user inputs (`sender === "user"`, `authenticatedUser === true`, non-untrusted channel).
8. **Untrusted Repository Content Isolation**: All content from repository files, commit messages, diffs, or PRs is wrapped in `<untrusted_repository_content>` and scanned for prompt injection, role escape, or spoofed approvals.

---

## 6. Associated Files

- `system-prompt.md`: The complete prompt template loaded by the agent runner.
- `role-profile.json`: Contract-validated role profile (`AgentRoleProfileSchema`).
- `@bflow/conversation`: Supporting library providing types, safety scanners, and prompt renderers (`packages/conversation`).
