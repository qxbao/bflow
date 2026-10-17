# Provider contracts v3

Normative P24 design; implementation owner P25. Public exports:
`packages/contracts/src/{platform,provider}.ts`. [Runtime v3](runtime-architecture-v3.md)
records source audit, authorization D24-01, migration and phase ownership.

## Implementation status (cập nhật 2026-10-17)

P25 đã có source tại `packages/agent-providers` (adapter Claude Code, Codex, Agy; `checkHealth`
preflight/activated; compile permission profile; `prepareLaunch`; ký/kiểm chứng
`AgentLaunchAttestation` Ed25519; `buildHerdrAgentStartCommand`; registry mặc định). Agy
báo `unsupported` cho `unattended_isolated` và chưa certify native attestation, đúng yêu cầu
bên dưới. CLI P29 gọi registry qua `bflow agent check`, `bflow setup` và các bước validate của
`bflow up`/`doctor`. **Chưa làm (P30):** `pane-manager`/`runtime` chưa dùng `prepareLaunch` hay
attestation; `provider-launch.ts` hiện có vẫn là đường launch thực của host. Mức bằng chứng:
source + local test; không có hồ sơ live provider login/launch/permission enforcement cho P25.
Chi tiết ở [package README](../packages/agent-providers/README.md) và
[hồ sơ P25–P29](acceptance/2026-10-17-p25-p29.md). Nội dung dưới đây là thiết kế đóng băng.

## Contract inventory

| Contract | Schema / meaning |
| --- | --- |
| `AgentProviderAdapter` | TypeScript port; validated descriptor plus `checkHealth(AgentHealthRequest, OperationOptions?) → OperationResult<AgentHealthResult>` and `prepareLaunch(AgentEnvironment, OperationOptions?) → OperationResult<AgentLaunchProfile>` |
| `AgentCapability` | Existing `AgentCapabilitySchema` in `session.ts`, unchanged. Business ability such as implementation/review; not proof of login, MCP connectivity or authorization |
| `AgentProviderDescriptor` | Versioned provider catalog wrapping existing capabilities; CLI name, adapter version, MCP transports, unattended/native-binding support |
| `AgentLaunchProfile` | Exact executable path/digest, provider version, argv array, generated config file digests, environment, interaction mode, launch fingerprint and expiry |
| `AgentEnvironment` | Resolved provider/role/session, cwd/private state directory, config fingerprint, permission profile, non-secret env values, secret references, required capabilities/services and skill-manifest digest |
| `PermissionProfile` | Three permission modes, explicit roots/tools/network/isolation, deny behavior and literal `allowGlobalPermissionBypass: false` |
| `TrustScope` | Discriminated machine/repository/session identity; nested within a versioned document. `isTrustScopeWithin` checks logical containment; host checks canonical filesystem containment separately |
| `AgentHealthRequest` / `AgentHealthResult` | Stage-specific checks and expiring readiness observation, bound to environment/provider/role/config identity |
| `AgentLaunchAttestation` | New startup receipt pinned to launch ID/fingerprint, Bflow session, Herdr pane and native provider session; signed by trusted host |

All exchanged values must be parsed with the exported schema on both input and output.
Port objects/functions and in-process `AbortSignal` are not serialized; their method
requests/results use schemas and existing `OperationResultSchema(TSchema)`. Versioning
uses literal 3 at the new envelope; no new interpretation of v1/v2 records.

## Probe and launch protocol

`checkHealth` is an observation, not an installer or a login command. Every required
preflight check must be `passed`; missing/unknown/expired/unsupported evidence blocks.
Codes/remediation must be safe for CLI JSON and Conversation display, without raw provider
terminal output, email, tokens or arbitrary stderr. Deadlines/AbortSignal propagate via
existing `OperationOptions`; probes have bounded output, subprocess and time budgets.

| Check | Required evidence / negative behavior |
| --- | --- |
| `binary` | Resolve canonical executable from trusted install/PATH policy, verify ownership/digest, reject changed/missing/unexecutable binary |
| `version` | Parse actual version output and inspect required CLI flags/behavior; release label alone is not a compatibility allowlist |
| `authentication` | Provider-native status or safe authenticated readiness probe under the exact credential binding; distinguish missing, expired, unauthorized and unknown. File presence or Herdr idle is insufficient |
| `environment` | Cwd/worktree identity, writable/read-only mounts, private state permissions, socket realm/path length, OS/process sandbox, required tools/runtime and explicit env allowlist |
| `mcp` | Supported client transport and exact generated configuration; initialize/negotiate/tools-list and required-tool authorization. No required service is a vacuously successful MCP check only after verifying the empty required set |
| `launch_arguments` | Exact CLI supports the profile, prompt/config files are regular/private/bounded and digest-matching, trusted hook commands pinned, no inherited unsafe settings/plugins/hooks |
| `permissions` | Effective rights are no wider than profile; native tool denies, Gateway authorization, OS isolation and network policy enforced. An ignored/unknown permission flag fails |
| `skills` | Exact role/provider manifest resolved with pinned content/dependencies and required capabilities/tools available; missing required binding fails |
| `native_binding` | Activated stage only: verify trusted issuer signature and exact launch/session/pane/native binding. Preflight separately checks the adapter's ability to produce this proof |

`prepareLaunch` compiles trusted, resolved configuration; it never starts an agent,
accepts a model-supplied shell command, performs global install or grants new rights.
Repeated resolution of identical environment generation returns equivalent profile
content; caller persists launch ID/fingerprint before Herdr side effects. Secrets are
resolved by host just before launch, not embedded in argv or serializable profile.
Secret references are opaque locators, not proof that credentials exist or are valid.
`environmentVariables` permits non-secret values only; host must reject secret env keys,
loader injection/PATH overrides and unapproved provider config inheritance.

The host computes SHA-256 over canonical resolved non-secret config and secret-binding
generation IDs. Do not hash secret bytes into a public fingerprint. Launch fingerprint
also binds executable digest/version, role/prompt/skill manifest, permission policy,
MCP registrations, native hook source and session generation. Read files safely, pin
observed identity and recheck immediately before launch; do not trust digest strings
supplied by a repository/model. Changes invalidate the profile and health cache.

Activated `checkHealth` requires profile + attestation. Schemas reject mismatched launch
IDs/fingerprints/session and ready with unknown/missing checks; host additionally checks
signature, configured issuer, exact current occupant, role/provider/environment equality,
clock/expiry and no replay from a previous generation. Health TTL is >0 and <=5 minutes;
the verifier checks current time, never schema parsing alone. A forged but schema-valid
Ed25519 string is not authenticated evidence.

Startup signature bytes are UTF-8 `bflow.agent-launch-attestation.v3\n` followed by the
existing exported `canonicalReceiptJson` of the parsed attestation body excluding
`signature`. The issuer key is selected from trusted host configuration, never from the
receipt itself. P25 signs at the trusted native-host boundary; P30 verifies before using
the observation. The prefix prevents reuse across other receipt domains. Persist exact
signed bytes and launch generation before exposing activated health to consumers.

The startup attestation differs from ADR 0003 `AgentBindingReceipt`, which is tied to an
actual task execution handle. Do not fabricate a run/task for startup or rewrite a task
handle. Preserve existing execution-bound persistence, authenticated task correlation
and acceptance gating after readiness. P30 adapts the current private host launch-receipt
ledger through explicit validation without inventing missing historical signatures;
an old live session lacking required proof stays unresolved until safe reconciliation.

## Permission matrix

| Profile | Files/tools | User interaction | Required boundary |
| --- | --- | --- | --- |
| `restricted` | Read-only selected roots and exact allowed tools; no writable roots | Deny or request through Conversation | Provider tool policy, host/Gateway authorization; no claim of hostile-process isolation |
| `workspace_auto` | Writes only authorized worktree roots and task paths; protected state remains denied | Preapproved operations run without a native prompt; other decisions via Conversation | Provider policy + existing host gates; worktree supplies Git isolation only |
| `unattended_isolated` | Least-privilege task/session filesystem, allowed egress, tool and resource budgets; no host home/secrets/state mounts | No direct specialist prompts; pause/escalate for decisions | Verified OS sandbox/container for entire provider process, session scope, fail if unavailable |

`PermissionProfile` cannot use machine scope, even when installed machine-wide. A
repository profile may only authorize that canonical repository; a session narrows it
further. `restricted` must be read-only. `unattended_isolated` rejects `provider_policy`
isolation and requires session scope. Host rejects `/`, home-wide roots, path traversal,
symlink escape, unapproved secret/socket mounts and wider network/tool permissions.
Profile mode never overrides accepted spec, task scope, lease/fence or human approvals.

No adapter maps unattended to machine-global unrestricted settings. CLI flags that skip
all approvals/sandbox are not the standard mapping. If the provider cannot honor the
requested effective rights, return unsupported or blocked. A sandbox used only by test
subprocesses does not satisfy unattended provider-process isolation.

## Provider mapping and observed compatibility

Existing launch code is `packages/pane-manager/src/provider-launch.ts`; P25 extracts or
wraps its verified behavior and P30 wires it back into Pane Manager. Do not maintain a
second, conflicting launch policy. Full original role prompts remain intact, augmented
by trusted host policy and resolved skill instructions. Do not reduce Chat/Coordinator
personality to a boilerplate role name.

| Provider | Existing/observed controls | P25 acceptance requirement |
| --- | --- | --- |
| Claude Code | Installed 2.1.301. Existing launch uses strict MCP config, restricted tools, scoped settings/hooks and `dontAsk`; prompt-file launch exists | Preserve verified native SessionStart/UserPromptSubmit/PreToolUse wiring; prove role capabilities and deny behavior in launch-local config. `dontAsk` denies calls that would require a prompt; it does not provide OS sandboxing. [Official permissions](https://code.claude.com/docs/en/permissions) |
| Codex | Installed 0.162.0. Existing helper uses read-only/workspace-write sandbox, approval never, explicit MCP, `model_instructions_file`, no daemon; hook trust opt-in is scoped to vetted generated hooks | Verify installed parser/flags, auth, native session/human origin and host tools before default-host support. Approval `never` does not turn off workspace sandbox; do not choose danger-full-access. MCP supports stdio and Streamable HTTP with scoped config. [Official MCP configuration](https://developers.openai.com/codex/mcp), [configuration reference](https://developers.openai.com/codex/config-reference) |
| Agy | Installed 1.4.0. Local help offers `--sandbox`, print/stream-json, MCP stdio/http configuration; also exposes a permission-skip flag | Verify actual auth/status support, role injection, Herdr agent kind/native session identity, hook equivalent, config scope and enforced sandbox. Help text is discovery evidence only. No supported unattended or P19 integration claim until these pass |

Do not use `codex exec`, Claude background mode, Agy remote-control or another daemon
to bypass Herdr pane/process ownership. Noninteractive execution must still be launched
and observed through the Herdr lifecycle. A print-mode probe is a bounded conformance
probe, not a replacement orchestration system or proof of full workflow success.

P24 inspected versions/help and ran an isolated Herdr transport lifecycle test without
model turns; it did not test provider login, install skills, modify MCP configs or
re-certify previous native/model smoke. Unsupported providers remain first-class
diagnostics; Bflow must not silently fall back to another provider.

## Errors, readiness and user decisions

Use existing ContractError codes: `validation`, `unsupported_version`, `not_found`,
`conflict`, `transport_unavailable`, deadline-safe `timeout`, `cancelled`, `corruption`,
and `unknown_delivery` for uncertain transport side effects. Unsupported capabilities
are a successful observation with health `unsupported`; auth/trust/policy prerequisites
are health `blocked`. An operational probe failure may use OperationResult failure;
none of these outcomes may be treated as ready.

Specialists never accept native user questions. Disable direct elicitation/approval UI;
translate blocked action to a structured Runtime request using existing RoleMessage
types and correlation. Runtime routes it via Herdr to Conversation; the trusted human
hook authenticates the answer. A denied or expired request remains denied. Setup/login
can require an operator command before the session, but startup never auto-accepts
provider trust/update/login screens. Unattended means authorized work progresses without
manual keystrokes; mandatory human decisions remain waiting, bounded and recoverable.
