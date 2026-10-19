# Conversation MCP Gateway investigation

Source audited: `d82ff21fa8037f4bbcfbafc785b022b3e60fb0df`.
Evidence: source and local launch configuration for session
`conv-bf-c1695ccd3f2b994f91bd`. No live Gateway/provider conformance test was performed.

## Why GitNexus is absent

The repository configuration does not select `environment.requiredMcpServices`
or `environment.requiredTools`. `apps/cli/src/platform-options.ts` derives every
role's service/tool requirements from those environment-wide lists, defaulting
to empty lists. `packages/runtime/src/platform/service.ts` does not create a
Gateway client registration when a role has no required MCP services.

The local host configuration confirms empty service/tool requirements for all
roles. Generated Conversation and Coordinator MCP configurations contain only
the internal `bflow` server, supplied independently by the Runtime host.
Installing a tool through machine setup does not select it for a repository or
grant access to its panes.

Explicit repository selection and scoped Gateway registration are intentional
design. There is no special prohibition on Conversation receiving Gateway MCP
tools. The present omission is a repository configuration and command-UX gap,
separate from the missing Claude permission grant for the already configured
internal `bflow` server.

## Recommendation

Give Conversation repository-scoped read access to GitNexus operations such as
`query`, `context` and `impact` to support questions and scope assessment. Keep
workflow dispatch, inter-role messages and user approval authority in the
existing Runtime/Herdr path. The managed GitNexus launcher already sets
`GITNEXUS_MCP_READ_ONLY=1` and restricts allowed repositories; Gateway must still
enforce the exact service/tool allowlist for the client registration.

Current YAML role entries have no service/tool override fields. Their existing
environment-wide lists apply to every role. A Conversation-only grant therefore
needs a separately reviewed configuration enhancement, rather than enabling
environment-wide tools or inheriting provider-global MCP settings.

This report does not enable Gateway services, alter machine/provider settings,
or authorize code changes to MCP Gateway. The project owner decides whether to
implement the proposed Conversation access.
