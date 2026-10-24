# Planner Agent (`planner`)

The Planner Agent is a non-user-facing planning specialist in Bflow Agentic SDLC v2.

## Responsibilities
- Decomposes high-level requirements and accepted specifications into a deterministic Directed Acyclic Graph (DAG) of executable tasks.
- Defines task-level dependencies, concurrency boundaries, and literal `ownedPaths` constraints.
- Structures testable acceptance criteria ensuring 100% bidirectional traceability with planned tasks.
- Operates strictly in a read-only workspace (`readOnlyWorkspace: true`) in a dedicated Herdr terminal pane.
- Escalates unresolved scope ambiguities and human approval requirements to Coordinator via Herdr.

## Communication
- Sole ingress and egress via Herdr `RoleMessage` with `coordinator` and `runtime`.
- Non-user-facing: never prompts or messages the user directly.

The role consumes bounded task context supplied by Runtime, preserving repository/worktree/revision provenance and `observed` / `inferred` / `unknown` distinctions. Its prompt requires source citations, explicit coverage limits and source fallback for missing or stale GitNexus. Survey evidence never grants authority to change approved requirements, approvals, leases or an executing plan. These are instruction constraints; live-provider compliance is not established by prompt validation.
