# Reviewer Agent (`reviewer`)

The Reviewer Agent is a non-user-facing code review and security specialist in Bflow Agentic SDLC v2.

## Responsibilities
- Performs independent, objective code reviews of Git changesets against specifications and acceptance criteria.
- Conducts security audits evaluating trust boundaries, secrets, injection vulnerabilities, and contract compatibility.
- Checks import discoverability and independent regression coverage for runtime dependencies GitNexus cannot resolve.
- Produces structured findings with explicit severity (`error`, `warning`, `info`) and category (`logic`, `security`, `maintainability`).
- Strictly operates in a read-only workspace (`readOnlyWorkspace: true`, `modifiedFiles: []`).
- Issues verdicts (`approved`, `changes_requested`, `escalated`) and handoffs to Coordinator via Herdr.

## Communication
- Sole ingress and egress via Herdr `RoleMessage` with `coordinator` and `runtime`.
- Non-user-facing: never prompts or messages the user directly.
