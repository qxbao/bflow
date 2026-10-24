# Tools in the SDLC execution path

This implements the additive D-TOOLS-01 decision approved by the project owner.
The accepted specification and acceptance criteria are in
[the design](superpowers/specs/2026-10-24-tools-sdlc-design.md).
Source integration, package tests, real prerequisite probes and completed live
workflow acceptance are distinct evidence levels. Live acceptance is in progress.

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
Writing memory requires separate permission.

GitNexus, Context7 and browser operations require their own policy requirements,
task triggers and current readiness. A small arithmetic task does not itself
justify indexing, external documentation or browser access. Missing or unsupported
optional services must remain visible as degraded; skills cannot enable them.

## Compatibility and migration

The new strict version-3 schemas are additive exports. Existing RoleMessage,
SessionManifest, Core checkpoints and SQL formats retain their contracts. New
host fields are optional. Configurations without tool policy do not acquire
implicit tool grants.

Legacy `environment.context7` is translated to its explicit service, operations
and role set; conflicting explicit policy is rejected. Ambiguous legacy
`requiredTools`/`requiredMcpServices` requires migration to role requirements.
Custom `skills.catalogDir`/`bindingsPath` is explicitly unsupported by this startup
composition: remove the overrides and select approved bundled pins, rather than
assuming the paths were loaded.

Quiesce before downgrading a session with new invocation ledgers. Preserve its
receipts, artifacts and unknown calls; deleting state is not reconciliation.
No installer, global provider configuration change or permission expansion is
performed to make preflight pass.

## Evidence and acceptance

Usage records identify session/run/task/role, tool/service/operation, disposition,
reason and trusted evidence references. They omit invocation bodies, credentials
and memory text. Installation, repository allowance, grant, readiness, invocation
and consumption are separate observations.

The acceptance procedure requires a temporary repository, Codex personal, task
input through Conversation, real scoped MCP retrieval and downstream use, real
RTK command/status parity, unavailable/degraded cases and owned-process restart
checks. Herdr `idle`/`done`, `tools/list`, a setup receipt and an agent's report
cannot close those criteria. The full root validation and independent review must
finish before local merge into `main`; no remote merge or push is authorized.
