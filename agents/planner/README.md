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
