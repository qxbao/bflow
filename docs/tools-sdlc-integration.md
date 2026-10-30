# Tools in the SDLC execution path

This implements the additive D-TOOLS-01 decision approved by the project owner.
The accepted specification and acceptance criteria are in
[the design](superpowers/specs/2026-10-24-tools-sdlc-design.md).
Source integration, package tests, real prerequisite probes and completed live
workflow acceptance are distinct evidence levels. Full live acceptance is not closed by the checked-in evidence. See the
[current implementation status](implementation-status.md) and the
[configuration reference](guide/configuration-reference.md).

## Authority and execution

1. Machine setup owns exact installer pins, executable receipts, service definitions
   and installed skill bundles. Installation requires an approved setup plan.
2. Repository `environment.toolPolicy` names permitted tools, kinds, operations,
   roles, triggers and scope. Its digest binds the canonical policy contents to
   the machine and repository identity.
3. CLI composition resolves that policy against current executable identity and
   Gateway observations. A configured service alone does not establish a verified
   local installation. Required unavailable tools block; optional tools report a
   degraded reason.
4. Approved role bindings select exact skill pins. Absent `role.skills` uses the
   bundled defaults; an explicit empty selection removes those defaults, while
   repository `requiredSkills` remains mandatory. Conditional tool skills require
   an independently resolved grant. Skill dependencies never create permission.
5. Runtime prepares role manifests and launch material. Policy-mediated roles
   access tools through Runtime, without receiving a raw Gateway bearer token.
   Gateway registrations bind one service and the role's exact operation set.
6. Runtime authenticates the calling pane and current assignment, checks approval,
   lease and fence authority, records invocation intent, then calls the Gateway or
   the authorized CLI runner. Unknown delivery is reconciled, never resent.
7. Results, trusted artifacts and usage metadata are separate from business
   acceptance. Result delivery or tool completion alone does not prove that a
   result affected an accepted task output.

Tool IDs identify catalog tools; capability IDs describe verified capabilities;
service IDs identify configured Gateway connections; operation names are the
actual negotiated upstream names. These are not interchangeable.

Integration compatibility ruling: content-only MCP responses retain their existing
Gateway output shape. A response that also supplies `structuredContent` preserves
both fields in the existing JSON-valued result. Output schema validation must not
discard the structured data that it validated. This needs no contract or storage
migration; it adds no field to legacy content-only responses.

## CLI output and repository memory

The RTK runner executes the original command once and captures its raw output and
exit disposition. The verification parser consumes that raw capture. RTK receives
the capture afterward through its verified executable in the command sandbox.
The runner profile authorizes the command; it is not an arbitrary RTK filter name.
`auto` invokes `rtk pipe`. Unchanged or longer output is labelled `passthrough`,
not token reduction. Optional formatting failures retain raw output with a reason;
required failures retain the original evidence and report a blocker.

Repository memory grants require an explicit read-only wing mapping. The Gateway
enforces the scope independently; Runtime validates returned provenance before
putting memory in context. Native MemPalace drawer/source/timestamp fields remain
source evidence. The repository relation is explicitly labelled as an approved
wing-policy binding when the upstream does not supply that relation. Historical
memory cannot replace the specification, current tests, journal or artifacts.
Writing memory requires separate permission. The CLI default wing is the repository ID;
a configured `environment.tools.mempalace.wing` must bind a reviewed alternative. An empty
wing is not an excuse to search the whole palace or manufacture retrieval evidence.

GitNexus and browser MCP (`chrome-devtools-mcp`) now use Runtime-managed Gateway resource
acquire/renew/release with generation-bound registration, fencing and unknown/quarantine
handling (`GitNexusResourceTransactions` and `BrowserResourceTransactions`). Each authenticated
assignment attempt may hold at most one exclusive browser lease (max 5-minute TTL, persisted in
`gen-N/browser-resource-transactions.json`); concurrent browser calls on the same task fail
closed with `browser_lease_busy`, and restarted hosts preserve `quarantined`/`release_uncertain`
entries for observation-only reconciliation without auto-replaying uncertain mutations. Evidence
is source plus local tests; full live Chrome/provider SDLC acceptance remains open. The owner
real-app gate (`appChecks`) runs its own sandboxed Chrome under a host-local fenced lease instead of the
Gateway profile.

GitNexus, DeepWiki and browser operations require their own policy requirements,
task triggers and current readiness. A small arithmetic task does not itself
justify indexing, external documentation or browser access. Missing or unsupported
optional services must remain visible as degraded; skills cannot enable them.

## Compatibility and migration

The new strict version-3 schemas are additive exports. Existing RoleMessage,
SessionManifest, Core checkpoints and SQL formats retain their contracts. New
host fields are optional. CLI composition now derives optional requirements for DeepWiki, RTK, GitNexus,
MemPalace and Chrome when their toggles are absent or enabled. Set `enabled: false`
to omit one. An explicit `toolPolicy` uses its own strict scope/digest and requirements.
Derived requirements still need independently resolved machine inventory, service mapping,
role/operation/scope authority and readiness before becoming grants. Direct legacy host
compositions without a policy do not acquire new grants.

Legacy `environment.context7` (the service DeepWiki replaced) is read as `environment.deepwiki`
and migrated with a backup; `bflow init --update` rewrites it. `environment.deepwiki` is translated to its explicit service, operations
and role set; conflicting explicit policy is rejected. Ambiguous legacy
`requiredTools`/`requiredMcpServices` requires migration to role requirements.
Custom `skills.catalogDir`/`bindingsPath` is explicitly unsupported by this startup
composition: remove the overrides and select approved bundled pins, rather than
assuming the paths were loaded.

Quiesce before downgrading a session with new invocation ledgers. Preserve its
receipts, artifacts and unknown calls; deleting state is not reconciliation.
The CLI default policy change and `init --update` are implemented after the original design
in `apps/cli/src/{environment-config,platform-options}.ts`. Existing sessions retain their
pinned policy; use the lifecycle to apply reviewed changes.
Tool-policy resolution does not install prerequisites or expand permissions to make
preflight pass. Separately, CLI startup may apply the explicitly configured Claude
per-project trust write described in the [configuration reference](guide/configuration-reference.md#policy-và-ngân-sách); do not describe that as launch-local-only state.

## Evidence and acceptance

Usage records identify session/run/task/role, tool/service/operation, disposition,
reason and trusted evidence references. They omit invocation bodies, credentials
and memory text. Installation, repository allowance, grant, readiness, invocation
and consumption are separate observations.

The acceptance procedure requires a temporary repository, Codex personal, task
input through Conversation, real scoped MCP retrieval and downstream use, real
RTK command/status parity, unavailable/degraded cases and owned-process restart
checks. Herdr `idle`/`done`, `tools/list`, a setup receipt and an agent's report
cannot close those criteria. The original acceptance plan required full root validation and independent review before its
local integration. That plan is historical; it does not grant a later task remote push/merge
authority. The current code is integrated, while full live acceptance still needs its own evidence.
