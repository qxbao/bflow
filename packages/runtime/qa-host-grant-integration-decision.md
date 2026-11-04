# D-EXT-QA-HTTP — Owner integration decision

Approved option: **1 — additive Runtime HTTP policy and grant contracts**.

The project owner explicitly approved with “Sử dụng phương án 1 đi” on 2026-11-02 after receiving the recommendation
and reviewing the linked proposal. The approved proposal is [qa-host-grant-integration-proposal.md](qa-host-grant-integration-proposal.md),
SHA-256 `c3f4edfb16b80b1afb2779c5b96cd0e4e1f2cc05f395b080735579d184387f66`. Its proposal header is preserved to retain that digest.
The original owner response is recorded in the local audit evidence `extension-runtime-http-owner-decision.json`.
This records project authorization; it is not a Runtime ApprovalDecision or a live workflow receipt.

Motivation: existing tool contracts model CLI executables and MCP services; direct HTTP executed by Runtime requires
its own honest authorization. The new `RuntimeHttpPolicySchema`/`RuntimeHttpGrantSchema` exports are additive version-3
contracts. Existing ToolKind/ResolvedToolGrant, Core, RoleMessage, events, storage and approval signatures stay unchanged.
No historical grant or logical SDK handle is upcast into new authority.

Affected owners: contracts/integration, CLI, Runtime/host. Owner authorization covers the shared contract additions,
their CLI/Runtime consumers and necessary shared integration documentation. Gateway and Machine Setup receive no
new grant kind or protocol. Native providers retain no HTTP/shell/write authority for extension assignments.

Compatibility: old repository configurations receive no new authority; absent policy remains denied. Existing CLI/MCP
policies and local SDK behavior remain readable. New config fields are explicit and unsupported by old binaries;
they must fail config validation, never silently grant rights. Startup grants pin repository policy and actual host
session; target effects additionally require approved intake/design and current policy/fence checks. Policy drift
revokes the active snapshot; elevation requires re-resolution through normal lifecycle.

No installation/global settings mutation or remote Git delivery is authorized. First live probe is anonymous loopback
`http_read` only. Parent Tasks5–7, independent whole-branch review, local/full checks and real human workflow approvals
still apply. This decision does not certify source correctness or live acceptance.
