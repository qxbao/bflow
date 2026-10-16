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
