# Role-based skills architecture v3

Normative P24 design; P28 owns `packages/skills/**` and `skills/**`. Contracts are exported
from `packages/contracts/src/skills.ts`. P24 creates no installed skill pack or loader.

## Implementation status (cập nhật 2026-10-17)

P28 đã có source: `packages/skills` (list/validate/install/sync/link/verify/update/recover, bundle
store private bất biến, pin/digest/dependency, role manifest, provider rendering,
`SkillsSetupSynchronizer`) và `skills/**` (20 shared skill, 12 role skill, ví dụ). P29 CLI có
`bflow skills list|sync` và validate skill trong `bflow up`/`doctor`; `bflow setup` dùng
synchronizer. **P30 (source + local test):** Runtime resolve/sync manifest theo role, persist theo session
generation, recover theo digest và cấp instruction text cho launch. **Chưa làm:** chưa có
live native skill discovery trên Claude/Codex/Agy. Test là local source/rendering; kỹ năng
đã load không chứng minh agent tuân thủ hay pass SDD/TDD/verification gates. Câu "P24 creates
no installed skill pack or loader" dưới đây mô tả baseline P24.

## Preserve role authority and existing prompts

Existing Chat, Coordinator, Analyst, Architect and Verifier assets and Registry role
profiles already define personality, routing and work policy. Pane Manager already
loads full role prompt files. Skills add scoped engineering instructions; they never
replace these prompts, grant permissions, dispatch Developers, accept specifications,
disable TDD, bypass Quality Gates or manufacture human approval.

Resolve effective instructions in order: system/host policy and accepted project policy,
existing role personality/prompt, then approved pinned skill instructions and task context.
Skill content cannot override earlier authority. Instructions are untrusted content until
the operator's approval/catalog provenance is verified; saying "trusted" inside SKILL.md
has no effect. Native provider plugins/hooks, instructions and actual executable tools are
different concepts and must remain separately authorized.

## Public contracts

| Contract | Meaning |
| --- | --- |
| `SkillDefinition` | schemaVersion 3; stable ID, content version/digest, source (builtin/operator/repository), entrypoint, description, allowed roles/providers, required capabilities/tools and pinned dependencies; instructionOnly is literal true |
| `SkillManifest` | schemaVersion 3; immutable resolved environment/role/provider/session selection, digest, exact definitions and bindings |
| `RoleSkillBinding` | schemaVersion 3; binding ID, exact skill pin, role/provider/session, required flag and optional approval receipt ID |
| `SkillPin` | Nested value object `{skillId, version, digest}` under versioned envelope; dependencies cannot float to latest |

`SkillDefinitionSchema`, `SkillManifestSchema` and `RoleSkillBindingSchema` reject unknown
fields/versions. Manifest parsing rejects duplicate bindings/definitions, incompatible
role/provider, scope mismatch, unbound resolved skills, missing/mismatched dependencies,
cycles/non-topological ordering and repository skill bindings without approval reference.
Schema validation of a digest/approval ID does not verify file bytes or human authority;
the trusted resolver must do both before readiness.

## Catalog, content integrity and precedence

Machine setup owns a content-addressed skill catalog in its managed data directory.
Builtins ship with reviewed Bflow distribution. Operator catalogs pin exact source and
digest. Repository configuration may request skill IDs/pins and propose local skills,
but cannot inject executable global plugins or widen machine policy. Explicit approval
is bound to source digest, role/provider, scope and dependencies; content change expires
the approval and requires a new manifest. Do not silently adopt provider-home skills.

Resolution is deterministic: choose explicit approved pins, validate dependency graph,
sort dependencies topologically with stable ID tie-breaker, enforce compatible roles/
provider and capabilities/tools, verify bytes, produce a manifest and compute canonical
digest. Conflicting same-ID pins fail; no last-file-wins. Optional unavailable skill can
be omitted with diagnostics before manifest freeze. Required unavailable skill blocks
the role and therefore `up`; no empty placeholder that claims required skill success.

`digest` identifies a canonical content bundle containing SKILL.md and every referenced
resource, using a sorted relative-path/content-digest inventory; the resolver rejects
path traversal, links escaping root, special files, oversized resources and remote
unfetched references. Verify all bytes at ingress and before rendering. Do not approve
only the SKILL.md while an unpinned script/resource can change under it. A local catalog
has owned/private permissions and atomic generation updates; live sessions keep their
immutable resolved generation rather than accepting mid-task changes.

`instructionOnly: true` deliberately excludes executable install/postinstall hooks from
the skill contract. A skill may document using a tool ID already authorized through
ToolInstaller/Gateway/Runtime, but bundled scripts are content and do not execute merely
because a skill loads. A future executable-skill feature requires a separate contract
decision and sandbox/approval review. No instruction can call raw CLI to evade Runtime.

## Suggested role bindings

These are capability recommendations for future packs, not installed defaults or changes
to the existing AgentRole enum. "Analyst" maps to existing `specifier`; Chat maps to
`conversation`. Bind Reviewer and QA independently from implementer, preserving gates.

| Role | Skills to resolve | Boundary |
| --- | --- | --- |
| conversation | intake/clarification, progress, human decision presentation | Sole user interface; no source mutation or specialist dispatch |
| coordinator | decomposition/DAG, SDD classification, TDD decision, escalation | Existing Runtime tools only; no direct process spawn or policy bypass |
| specifier / architect | criteria/traceability, design risk and approval preparation | Proposals enter existing P15 approval/versioning flow |
| planner | dependency/scope planning | Cannot authorize implementation itself |
| developer | scoped implementation, conditional RGR, Git evidence | Worktree/task paths and P16 authorization enforced independently |
| tester / qa | objective verification, exact-revision evidence | Cannot self-approve own implementation or alter accepted criteria |
| reviewer | independent review and bounded repair findings | Verdict is authenticated evidence, not direct success transition |
| security | threat analysis, policy findings | No wider filesystem/network/secret grants implied by role |

## Provider rendering and readiness

The resolver produces provider-neutral text/resource manifests first. P25 renders them
using validated launch-local prompt/config inputs; P30 joins them to the current Pane
Manager bootstrap. Claude's current launch disables slash commands/native skill discovery;
v3 may render vetted skill instructions into explicit prompt assets without enabling an
unreviewed global discovery mechanism. Codex and Agy similarly receive only the resolved
manifest through a configuration surface verified for their installed CLI. Do not assume
all CLIs support the same SKILL.md directory semantics or parameter names.

P28 exports its implementation against these contracts; P25/P28 integration uses ports
and rendered data via Runtime composition, no leaf-package import of another leaf. Full
original role prompts remain loaded even when no skills are selected. Missing provider
rendering support for a required skill produces unsupported readiness with a concrete
remediation, not silent text truncation or a fake successful install.

The environment includes skill-manifest digest; launch fingerprint also binds rendered
instruction files. Any pin/content/role/provider/policy/tool change invalidates readiness.
Startup validates current files and activated host binding. Health is operational
evidence; a successfully loaded skill does not prove the agent followed it or passed
SDD/TDD/verification gates.

## Questions, approvals and recovery

Skills for every non-Conversation role must route missing requirements, permission asks,
design decisions and approval needs through Runtime → Herdr → Conversation. Disable native
direct AskUserQuestion/elicitation. Skill advice cannot auto-answer for the user or reuse
a stale approval. Preserve existing request/correlation/causation/target/revision/generation
and expiry semantics. Without an answer, persist waiting/blocked state and resume only
after authenticated decision; no unattended loop polling artifacts for a reply.

Persist manifest ID/digest/approved pins alongside the session generation, outside source
and protected from role writes. Restart reloads the same manifest and verifies bytes;
do not resolve `latest` and silently change an in-flight task. If required content is
missing or corrupted, block and report through Conversation/operator diagnostics; do not
fabricate replacement content. Cleanup removes only unreferenced owned content after
session/run retention policy, preserving artifact evidence and resumable manifests.

P28/P31 tests cover deterministic resolution, conflicting pins, cycles, stale approval,
cross-role/provider misuse, missing resources, symlink traversal, malicious override
instructions, secret references and restart with changed catalog. Runtime/Quality Gate
tests must still prove a skill cannot bypass accepted spec, required Red-first evidence,
independent Reviewer/QA, human delivery or bounded verification limits.
