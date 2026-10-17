# Coordinator host integration

Load `system-prompt.md` into the Coordinator process configured for the P13
Coordinator pane. `role-profile.json` is validated by `AgentRoleProfileSchema` and
matches `COORDINATOR_ROLE_PROFILE` exported from `@bflow/runtime`.

The trusted host exposes `CoordinatorTools.invoke(name, input, principal)` with
its authenticated principal injected out of band. Tools request Runtime actions;
source mutation and direct AI-provider calls are absent. `receiveHerdr` is a host
ingress, not an agent tool. Specialist results and approvals reach that ingress
only after physical delivery through Herdr and host authentication.

See `packages/runtime/README.md` for composition, verification runners, recovery
and the limits of the currently available Herdr transport.

`system-prompt.md` includes the "Non-User-Facing Execution Policy" verbatim: the
Coordinator never asks the user questions from its pane. Specialist notices
(`escalation.notice`, `task.blocked`, `clarification.needed`) are resolved within
technical-lead authority where possible; only genuine human approval or
clarification needs are forwarded to `conversation` over Herdr. Specialist results
use the structured-result fields `status`, `summary`, `evidence`, `artifacts`,
`blockers`, `requested_action`, `next_role` and optional `assumptions`.
`role-profile.json` sets `userFacing: false`, `readOnlyWorkspace: true`,
`canDelegateToSpecialist: true` and may address conversation, runtime and the
specialist roles. The Runtime host loads this prompt through the shared builtin
prompt loader (see `packages/runtime/README.md`).
