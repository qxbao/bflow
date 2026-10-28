# Custom specialist profiles — Specification và integration decision RP-01

Trạng thái: **OWNER APPROVED RP-01 / Specification / TDD required / integration scope**. Owner duyệt toàn bộ trong conversation ngày 2026-10-28: “tôi duyệt hết, cứ triển khai đến khi hoàn thành tất cả đi xong báo tôi sau”. Chỉ thị không commit/push/PR giữ nguyên. Implementation và evidence được theo dõi riêng; approval không phải bằng chứng tính năng đã chạy.
Ngày khảo sát: 2026-10-28. Baseline: `e73dca70cb91bdd53fbe1fe9dfb69ccba8b6f8ff`.
Branch: `agent/runtime/custom-role-profiles`. Worktree: a private integration worktree.
HEAD trùng `origin/main` và `origin/duc` trong refs hiện có; local `main` chậm hơn. Baseline chứa P24 `8dbb056`; không fetch remote trong khảo sát này.
Giai đoạn proposal không sửa public schema/config. Owner sau đó duyệt implementation và integration; chỉ thị không commit/push/PR vẫn áp dụng.

## 1. Mục tiêu và ranh giới

Giữ `AgentRoleSchema` và tất cả governance role hiện có. Thêm profile có identity riêng để chuyên môn hóa một specialist role: ví dụ `backend-developer` và `data-engineer` đều có `baseRole: developer`. Profile không phải role mới, không phải principal mới, không phải grant và không phải ai-isolator authentication profile.

Mỗi profile kế thừa trực tiếp đúng một trong `planner`, `architect`, `specifier`, `developer`, `tester`, `reviewer`, `qa`, `security`. Cấm base Conversation/Coordinator, cấm profile kế thừa profile, cấm role alias tùy ý. Chỉ dispatch base role đã có topology, provider, capability và readiness thật; không tạo support giả cho specialist chưa có launch path.

Instructions chỉ được nối sau prompt chuẩn và policy host. Skill/tool requirements không cấp quyền. Routing, approvals, independent verification, TDD, lease/fence, bounded rework và ArtifactStore tiếp tục dùng governance role và các gate hiện có. Không có fallback âm thầm từ profile đã chọn sang base/default profile.

## 2. Bản đồ ảnh hưởng từ source tại baseline

| Owner / khu vực | Source hiện tại và giới hạn | Thay đổi cần thiết sau duyệt |
| --- | --- | --- |
| Contracts / integration | `packages/contracts/src/session.ts`: `AgentRoleProfileSchema` là policy role chuẩn; `AgentAssignmentSchema`, `PaneBindingSchema`, `SessionManifestSchema` đều strict v2, không có profile pin | Schema profile v3 mới; typed pin trên assignment/pane/manifest, giữ role enum và routing v2 |
| Contracts / provider | `packages/contracts/src/provider.ts`: `AgentEnvironmentSchema`, permission profile, health, launch/attestation ràng buộc config fingerprint | Environment chứa pin typed; config/launch fingerprint phải bao phủ profile snapshot và effective permissions |
| CLI / repository config | `apps/cli/src/environment-config.ts`, `platform-options.ts`, `platform-resolution.ts`: role entry duy nhất, `profile-name` chọn ai-isolator; provider/model/effort resolve theo role | Catalog profile local có exact pin; profile selection tách khỏi `profile-name`; render/parse round trip và binary ingress thật |
| Execution preview / pack | `packages/contracts/src/execution-plan.ts`; `apps/cli/src/execution-preview.ts`, `execution-expectation.ts`; `packages/runtime/src/agentic/runtime.ts:dispatch` có `assertRunExecutionPlan` | Chung resolver giữa execution và preview; pin/scope/provenance vào plan fingerprint; drift trước side effect, không nhầm native profile với specialist profile |
| Runtime / scheduler | `packages/runtime/src/agentic/runtime.ts`: `requestSpecialist`, `dispatch`, allocation Developer và verification jobs; `journal.ts`, `outbox.ts` giữ assignment/lease/history | Coordinator chọn pin trong task/specialist request; kiểm tra role/capability/scope trước worktree/launch và trước gửi; persist snapshot + assignment history trước dispatch |
| Runtime / platform | `packages/runtime/src/platform/host-options.ts`: roles unique; `environment.ts`: environment/state path theo role + task; `service.ts`: preflight/prepare/activate; `launch-journal.ts`: strict intent | Giữ template base role, thêm catalog/snapshot typed; khóa launch theo role + pin + assignment; intent/recovery kiểm tra pin; không đổi template đang chạy |
| Pane Manager / P13-P30 | `packages/pane-manager/src/types.ts`: topology alias chat→conversation, analyst→specifier, qa-verifier→qa; `role-pane-manager.ts`, `role-prompts.ts`, `manifest-store.ts` | Profile không thêm topology role. Allocation/reuse kiểm tra pin; pane labels hiển thị cả profile/base; nhiều profile cùng base không dùng chung native session/context |
| Skills / P28 | `packages/contracts/src/skills.ts`: `SkillPin`, role/provider compatibility; `packages/runtime/src/platform/skills-session.ts`: sync/recover, record path theo role/task; `packages/skills/src/manager.ts` | Union skill bắt buộc của base/project với profile exact pins; conflict chặn; approval theo pin như cũ; manifest/environment identity tránh collision profile |
| Provider permissions / P25 | `packages/agent-providers/src/permissions.ts`: compile permissions theo role, writable roots, native hooks; Runtime environment hiện cấp writable cwd theo mode | Biên dịch quyền sau intersection; provider/native hooks/OS backend phải thực thi scope thật hoặc trả unsupported; không chỉ thêm prompt |
| Runtime workspace và tools / P27-P30 | `packages/runtime/src/agentic/host.ts`: workspace read/write, role tools; `workspace.ts`, native adapters, `host-platform.ts`, tool policy/grants và browser transactions | Một effective-policy resolver dùng ở MCP write/commit, native edit/shell, Git changeset validation, Gateway tool calls và browser lease. Profile chỉ thu hẹp grant, không tạo grant |
| Registry / P02 | `packages/agent-registry/src/registry.ts`: resolve theo role/capabilities/preferredAgentId, lease theo agentId; `roles.ts`: MVP settings/policy riêng | Registry vẫn resolve governance role; không dùng custom ID làm role. Runtime filter compatible candidate/pin và recheck lease; chỉ sửa Registry nếu thêm typed selection thật sự cần thiết |
| Verification / P17 + Runtime | `packages/verification/src/engine.ts`: reject executorId trong plan.implementerIds; Runtime tạo implementerIds từ handle và kiểm tra lại toàn lịch sử task.assignment | Giữ check hiện có, thêm host-authenticated stable executor lineage trên các allocation/attempt/profile; profile rename hay pane mới không xóa lịch sử implementation |
| Evidence / recovery / data | `packages/contracts/src/recovery.ts` lồng manifest/assignments; Runtime journal/outbox/launch receipts; ArtifactStore trusted references | Parse typed pins ở replay, snapshot immutable; labels/provenance trên evidence envelope; không đổi bytes/digest trusted artifact để thêm label; không migration giả dữ liệu đã mất |

Registry legacy có `AgentConfiguration.role: string` và `settings: JsonValue`; đây không phải bằng chứng agentic scheduler chấp nhận role tùy ý. Không mở rộng hay khai thác đường legacy để vượt `AgentRoleSchema`. Cũng không dùng `MvpRoleProfile` hay metadata làm custom-profile contract.

## 3. Integration decision RP-01 cần owner duyệt

### Motivation

Profile đi qua CLI → Runtime → Pane Manager → provider, persisted assignment và recovery. Các boundary này cần exported Zod schema từ `@bflow/contracts`; metadata không cho scheduler hay permission compiler biết semantics. Contract mới phải ràng buộc profile với role, scope và launch identity, không chỉ phục vụ hiển thị.

### Contract bổ sung được đề xuất

Tên/shape dưới đây là đề xuất cụ thể cho integrator, chưa có export thực thi:

- `SpecialistRoleSchema`: tập con cố định tám governance role ở mục 1; không sửa `AgentRoleSchema`.
- `CustomRoleProfileSchema`, strict `schemaVersion: 3`: `profileId` (identifier local, không URL/path), `version` (exact), `displayName` (text có bound), `baseRole` (`SpecialistRoleSchema`), `additionalInstructions` (UTF-8 tối đa 64 KiB, không secret), `skillPins: SkillPin[]`, `toolRequirements: { toolId, operations: string[] }[]`, `preferences?: { provider?: AgentProviderId, model?: string, effort?: existingEffortEnum }`, `restrictions: RoleProfileRestrictions`.
- `RoleProfilePinSchema`: `{ profileId, version, digest }`, digest SHA-256 canonical validated definition; từ chối selector floating (`latest`, range, tag động) cho profile/skills dù primitive `SkillPin.version` hiện chỉ nonempty. Dùng validator exact-version chung ở ingress/resolver, không giả định primitive đủ.
- `RoleProfileRestrictionsSchema`: optional `readablePaths`, `writablePaths`, `deniedPaths` là repository-relative **directory-prefix/file scopes**, không glob; optional allowlists `capabilityIds`, `tools: { toolId, operations }[]`, `networkHosts`. Omitted = không thu hẹp thêm, `[]` = deny all; deny luôn thắng. Không có field grant/approval/delegation/permissionMode/readOnly=false. Unknown keys bị reject.
- `ResolvedRoleProfileSnapshotSchema`, strict v3: pin + definition + `baseRolePolicyDigest` + `resolutionPolicyVersion`; host recompute digest, không tin digest khai báo. Snapshot không chứa token/env/credential. Builtin policy digest giúp recovery phát hiện host policy thay đổi.
- Thêm optional **typed** `roleProfile: RoleProfilePin` vào `AgentAssignmentSchema`, `PaneBindingSchema`, `AgentEnvironmentSchema`; kiểm tra `baseRole === role` khi join snapshot, assignment và launch. Không dùng `metadata.profileId`.
- Thêm optional **typed** `roleProfiles: ResolvedRoleProfileSnapshot[]` vào `SessionManifestSchema`; enforce unique pins, không hai nội dung khác nhau cùng ID/version; mọi pane pin resolve được trong manifest. Snapshot nằm ngoài writable workspace; session manifest pin cả version và digest. Runtime run/assignment journal giữ snapshot ref cho allocation đã cleanup.
- Thêm strict v3 `SpecialistProfileSelection` cho Coordinator task/request ingress: `role: SpecialistRole`, `profile: RoleProfilePin`; add typed optional selection vào accepted workflow task/host request schema thay vì unconstrained task metadata. Assignment, pane, environment phải khớp selection; loại bỏ mọi profile override do specialist tự gửi.
- Thêm strict `ExecutorLineage` document (v3), host-owned: stable `executorId`, authenticated native session/launch/binding identities, predecessor links khi restart/rebind, assignment IDs và revision/attempt/run. Không nhận executorId tự khai của model làm bằng chứng. Runtime giữ union implementer lineage xuyên các attempt/rework và kiểm tra gate observation trước settle.

Không đổi RoleMessage routing envelope, `AgentCapability`, RuntimeService hay QualityGate method signatures. Không thay global provider config. Private host RPC/types vẫn phải consume contract mới tại boundary. `SkillManifest` hiện có giữ nguyên shape: environmentId/config fingerprint bind pin, exact skill manifest digest được snapshot launch tham chiếu; cần test chống swap cross-profile.

### Compatibility và migration

Đây là additive schema amendment cần owner chấp thuận, không phải tuyên bố tương thích hai chiều với binary cũ. Unprofiled v2 manifest/assignment và v3 environment vẫn parse như cũ khi optional fields vắng; không tự gán custom profile khi đọc run cũ. Governance semantics, receipt correlation và event/checkpoint codec v1/v2 giữ nguyên.

Binary cũ dùng strict schema sẽ **reject** profiled document có field mới. Host/CLI/Pane Manager/provider phải nâng cấp đồng bộ cho session có profile; negotiate feature `custom-specialist-profiles-v1` trước launch/dispatch. Unsupported hoặc mixed version thì block với remediation, không strip field hay downgrade sang unprofiled. Session cũ đang chạy không được hot-convert; muốn profile phải tạo assignment/session generation mới qua governance hiện có. Không restore profiled session bằng binary cũ. Snapshot thiếu/corrupt không được suy ra lại từ catalog hiện tại.

Journal bổ sung phải có version/feature marker và strict parsing rõ ràng; intent cũ không có pin chỉ đại diện launch unprofiled. Codec persisted hiện hữu không được silently reinterpret. Nếu integrator chọn thay envelope version thay vì additive fields, phải xin decision thay thế trước sửa source; không để implementer tự chọn migration khác.

### Affected owners và approval

Owner cần duyệt **RP-01 + Specification + TddDecision**, đồng thời ủy quyền integration thay đổi Contracts, Runtime, CLI/config schema, Pane Manager, Skills, Agent Providers, agent prompts và Verification. Registry/data chỉ đổi khi integration review chứng minh cần thiết; không tự mở scope sang migration storage/lockfile/root config. Integrator review package edges, public schema exports và compatibility fixtures. Không yêu cầu owner cấp quyền commit/push/PR.

Approving owner: project owner trong conversation ngày 2026-10-28. Approval record: “tôi duyệt hết, cứ triển khai đến khi hoàn thành tất cả đi xong báo tôi sau”. Phạm vi bao gồm RP-01, Specification, TddDecision required và cross-owner integration; không bao gồm commit/push/PR.

## 4. Resolver và quyền hiệu lực

Một resolver dùng chung cho preview, plan acceptance, allocation, launch, dispatch và recovery; output chứa governance role, exact snapshot/pin, effective policy và provenance. Mọi input/output ở package boundary parse bằng exported schema. Catalog chỉ đọc local bằng reader bounded/no-follow/regular-file; cấm traversal/special file/symlink escape, không fetch/install tự động.

`effective = baseRolePolicy ∩ projectPolicy ∩ taskAssignment ∩ profileRestrictions`.

Intersection thực thi theo hành động và canonical path, **không** giao chuỗi glob. Normalize path segment, từ chối absolute/`..`/NUL, bind repo-relative prefixes vào đúng worktree canonical root; resolve existing parent cho file mới, chống symlink và recheck ngay trước write. Ví dụ task `packages/api/**` và profile prefix `packages/api/src` chỉ cho phép subtree src; việc test vẫn phải được phép trong intersection, nếu không đủ scope thì block trước allocation và yêu cầu replan, không nới profile. `deniedPaths` trừ khỏi cả read/write; paths .git, host state, approval/signing secret giữ deny hiện có. NFR same-UID và OS isolation vẫn theo mức evidence thật của backend.

Read restriction bao phủ cả Git history/object access và Developer feedback runner, không chỉ API đọc file. Native `git show`, `cat-file`, compiler imports, test code hay child process có thể đọc file cấm nên không được miễn intersection. Bản đầu chỉ cho đường broker đã filter path/revision/output hoặc backend sandbox chứng minh enforce được toàn process tree; nếu không thì profile có read restriction là `unsupported` trên launch đó. Không đánh đồng `restricted`/read-only với read isolation. Developer `check_work` dùng đúng quyền đã thu hẹp, nếu dependency/test cần quyền ngoài scope thì blocked/replan. Independent host verification runner giữ policy riêng của owner, không nhận lệnh tùy ý hay trả nội dung file bị cấm cho Developer; chỉ công bố kết quả/evidence đã qua bounded safe view theo quyền caller. Test phải thử rò nội dung qua Git blob, import, child process và log runner.

Capability allowlist chỉ hạn chế eligible capabilities của base/project. Nếu assignment/skill/tool cần capability bị loại, trả incompatible, không xóa requirement để giả đủ điều kiện. Không cho profile khai báo capability mới. Tool requirements là nhu cầu, phải có grant đúng operation + readiness/service/resource lease hiện có; profile tool allowlist chỉ giảm grant. Lệnh shell/Git/native, host MCP và Gateway đều phải dùng quyền hiệu lực; thiếu enforcement ở backend nào thì selected profile unsupported trên backend đó. Required verification runner giữ quyền riêng theo owner policy, không lấy quyền Developer để tự mở runner.

Provider/model/effort là preferences: explicit assignment choice (nếu project cho phép) → profile preference → base role config/default, luôn qua project allowlist/pack locks, provider capability và preflight. Candidate không hợp lệ hoặc preference không đáp ứng thì báo blocker có source; không chọn provider/model khác âm thầm. `profile-name` ai-isolator tiếp tục resolve theo provider config hiện có; custom profile không mang credential/native login selector. Agy effort vẫn theo model naming rule hiện có.

Skills giữ mandatory base/project selections; thêm exact profile pins, dedupe pin giống nhau, reject cùng skill ID khác version/digest. Approval của custom skill và dependency vẫn qua store hiện có. Skill không gỡ policy/TDD/gates và không cấp tool grant. Không cho profile thay system prompt path, shell argv/env, hooks, MCP endpoint, credentials, grant receipts hay approval state.

Prompt = builtin role prompt + host governance instructions + append-only specialization block (display name, base role, pin, additional instructions). Không dựa vào thứ tự prompt hoặc regex để bảo đảm authority: instructions xung đột dù model làm theo vẫn bị deterministic host policy chặn. Tất cả prompts/config material sinh ra nằm trong fingerprint, snapshot bytes pin lúc launch. Test giữ nguyên builtin prefix/policy, không chỉ test có tên profile.

## 5. Coordinator, dispatch và lifecycle

1. Repository config đề xuất thêm `environment.specialistProfiles: [{ path, pin }]` và optional role-default `specialistProfile: pin`; không dùng lại `profile-name`. Config chỉ catalog/default, Coordinator mới chọn profile cho từng task/request. Các field này được triển khai theo RP-01; kết quả kiểm chứng ghi tại custom-role-profiles-evidence.md.
2. Coordinator đọc catalog safe summary qua Runtime (ID/base role/pin/restrictions/compatibility); khi propose workflow hoặc request specialist, gửi typed role + pin. Runtime chỉ nhận từ authenticated Coordinator, bind selection với accepted spec/DAG/plan revision. Specialist không tự đổi pin. Defaults không thay accepted selection đã pin.
3. Resolve và kiểm tra intersection trước worktree creation, allocation và launch. Validate lại sau await, trước dispatch; giữ lease/fence hiện tại và `agent.execution_bound` ordering. Persist snapshot, pin, effective-policy digest, executor lineage/assignment intent trước transport; profile pin tham gia idempotency fingerprint.
4. Developer profile dùng dynamic Developer path hiện có. Non-developer profile dùng allocation theo base topology với native context riêng; không thay prompt của permanent reviewer/QA pane đang dùng. Bản đầu serialize trên base specialist slot và dùng dedicated per-assignment profiled launch; không tăng concurrency bằng cách thêm tên profile. Nếu không có capacity/launch support thì blocked, không route vào pane base khác profile.
5. State/cache/reuse keys chứa session generation, base role, pin digest và assignment/attempt identity. Environment ID, state dir, skill record, launch material và native pane context không được collide giữa `backend-developer` và `data-engineer`. Mọi join pin↔manifest↔assignment↔environment↔attestation phải khớp trước activate/dispatch.
6. Pane title/status/log hiển thị ví dụ `backend-developer · developer · 1.0.0 · <digest prefix>`. Artifact presentation/audit envelope chứa pin + governance role + assignment/executor identity. Trusted ArtifactReference chỉ do store cấp; không thêm label bằng cách sửa content-addressed bytes cũ. Transport sender/recipient vẫn role chuẩn; chỉ Conversation nhận human decisions.
7. Retry/rework giữ pin của accepted assignment; thay profile là thay accepted execution input, cần replan và approval nào bị ảnh hưởng theo policy, không tự refresh live session. Cancel/down release đúng launch/Gateway/browser resources, giữ snapshot/history còn run tham chiếu.

## 6. Recovery, drift và independence

Persist immutable normalized definition + exact raw instruction bytes, pin, builtin policy digest, effective policy digest, skill manifest digest và launch fingerprint dưới host-owned session generation. Digest trên canonical validated definition, bao gồm instructions và exact skill pins; thay đổi instructions dù cùng ID/version phải conflict. Publish thay đổi yêu cầu version mới, không overwrite snapshot.

Recovery từ manifest/journal/outbox đã pin, không resolve lại `latest` hay đọc catalog rồi thay nội dung. Source catalog đổi được báo `profile_source_drift`; running session giữ snapshot cũ. **Giữ nguyên EP-01**: `packages/runtime/src/agentic/execution-binding.ts:assertRunExecutionPlan` vẫn so mọi private source digest với accepted binding. Snapshot cũ hợp lệ chỉ cho phép tái dựng đúng identity, không miễn drift gate. Source đổi/thiếu vẫn chặn resume/redispatch/launch kế tiếp; phải khôi phục source đúng pin hoặc replan một generation mới với approval bị ảnh hưởng. Không tự rebind source digest hay tạo ngoại lệ snapshot cho EP-01. Active native session không hot-reload instructions; mọi host side effect tiếp tục qua checks/policy hiện có, không cho drift cập nhật quyền. Current policy thu hẹp/revoke, builtin policy đổi, snapshot/instruction/skill bytes mất hoặc digest không khớp thì block trước dispatch/activation; không tái tạo proof. Profile mới chỉ áp dụng cho assignment/generation mới. Phân biệt source drift với snapshot corruption trong diagnostics dù cả hai đều chặn thực thi mới. Việc cho phép resume độc lập catalog trong tương lai cần integration decision riêng.

Reconcile interrupted launch/unknown delivery trước retry, không tự resend khi chưa chứng minh not_delivered. Pin nằm trong durable intent trước launch; mismatch receipt/pane/session/assignment/pin thì quarantine/block. Giữ legacy recovery path khi field vắng, không gán pin hồi tố.

Independence dựa trên executor lineage và **toàn bộ assignment history**, kể cả rework/conflict-resolution/restarted allocations. Đổi profile ID, base-role label, agent alias, pane hoặc resume session không xóa implementer lineage. Reviewer/QA observation của implementer bị reject ở allocation và trước gate settle. Lineage phải bind host/native session thực, không chỉ so tên profile hoặc provider/model. Hai process độc lập cùng provider/model có thể hợp lệ; fresh reviewer launch cần host proof là executor độc lập, không kế thừa implementation context. Không claim xác định được danh tính con người/provider account hay hostile same-UID từ cơ chế này.

Quy tắc lineage cụ thể: host tạo root chỉ trong luồng **fresh launch** do Runtime chủ động yêu cầu, với native session mới được startup attestation xác thực, instruction home/context riêng và không resume/fork/import transcript. Host ghi launch intent + purpose + root trước launch rồi join native binding receipt sau launch; UUID/agentId mới tự nó không đủ. Rebind/restart/resume/fork của worker được ghi successor receipt tham chiếu launch/native-binding predecessor và kế thừa cùng executor root; lookup index trên native session, launch, binding và allocation history để chống alias. Reviewer allocation tái sử dụng lineage từng implement trong run luôn bị loại. Fork/resume chưa có predecessor proof hoặc provider không chứng minh được fresh context thì blocked, không tạo root mới. Root không xóa khi pane cleanup hoặc lease hết hạn; lưu ít nhất suốt retention của run/verification/recovery. Termination receipt chỉ chứng minh process cũ đã dừng, không reset implementation history. Một reviewer mới được phép cùng provider/model chỉ khi host chứng minh fresh launch độc lập theo các điều kiện trên, không phải đổi tên worker implementation.

## 7. Specification / AcceptanceCriterion đề xuất

SDD level: **full**, vì thay governance/permissions và nhiều package boundary. Các AC cần được owner chấp nhận cùng RP-01 trước implementation.

| ID | Tiêu chí pass | Evidence bắt buộc |
| --- | --- | --- |
| RP-AC01 | Tạo `backend-developer`, `data-engineer` trên base developer, Coordinator chọn từng pin, Runtime dispatch/launch đúng | Contract ingress + scheduler/platform/pane integration, assertion không collision context/state |
| RP-AC02 | Reject arbitrary role, base conversation/coordinator, profile chain, malformed/duplicate/conflicting pin/unknown fields | Schema tests ở config/RPC/replay; không có side effects khi reject |
| RP-AC03 | Read/write/tool/network/capability hiệu lực chỉ thu hẹp; delegation/approval không tăng | Allow/deny matrix, property subset tests, traversal/symlink/new-file tests; native + host MCP + Gateway enforcement |
| RP-AC04 | Instructions nối prompt gốc; exact skill pins/approval giữ nguyên; tool thiếu grant/readiness bị block | Prompt bytes/prefix, conflicting skill pin, revoked approval, guessed tool/operation, unsupported permission backend |
| RP-AC05 | Reviewer profile không review việc cùng executor lineage từng implement, dù rename/rebind/restart | Allocation và gate-settle regressions với lịch sử rework + negative control reviewer độc lập cùng provider/model |
| RP-AC06 | Routing/human approvals/TDD/verifier authority giữ governance role | Envelope recipient assertions; native direct question denied; required Red-first và host-test-integrity vẫn enforced |
| RP-AC07 | Manifest/assignment/environment/launch/evidence trình bày và bind cả pin + role | Parse tampered joins; swap cross-profile receipts/skills; pane/log/artifact view assertions không token/env |
| RP-AC08 | Recovery dùng snapshot đúng pin; EP-01 chặn source drift, corruption/revocation | Restart giữa từng durable/side-effect boundary, same version changed bytes, missing snapshot, policy narrowing; snapshot đúng không miễn source-digest gate |
| RP-AC09 | Legacy unprofiled data hoạt động; mixed/old binary fail closed với profiled session | Old fixtures round trip, feature negotiation denied trước launch; không strip pin và không migrate tùy tiện |
| RP-AC10 | Preview và execution dùng cùng profile resolver, pin vào accepted plan; drift qua await chặn side effect kế tiếp | Parity + changed file/policy/skill/pin sau preview/acceptance và giữa allocation/dispatch; sentinels cho forbidden effects |

NFR đề xuất: deterministic pin/permission fingerprint cho input tương đương; file profile tối đa 64 KiB instructions và 256 KiB document, catalog tối đa 128 profiles; validation không gọi network/model/setup; lỗi chỉ hiển thị safe ID/source/rule, không raw prompt/env/token; filesystem reader không block special files. Các bounds là lựa chọn thiết kế cần duyệt, không phải hỗ trợ đã có.

## 8. Conditional TDD và kế hoạch implementation sau approval

TddDecision đề xuất: `mode: required`, `requiresFailingTestFirst: true`, vì role selection, permission và recovery là security-sensitive. Owner đã chấp nhận TddDecision required cùng RP-01 trong conversation được ghi ở đầu tài liệu. Giai đoạn proposal chỉ tài liệu: `not_applicable`, alternative verification = source cross-check, builder review, Markdown/diff checks. Không viết product code hay test giả khi contract còn pending.

Sau owner duyệt, integrator chia task theo ownership; không một leaf agent tự sửa mọi package:

1. Contracts/config integration: failing ingress/legacy/mixed-version tests → schemas exports và safe catalog/config parser. Freeze RP-01 shapes trước downstream wiring.
2. Runtime policy: failing subset/scope/compatibility tests → shared resolver, snapshot store và plan fingerprint/provenance. Kiểm tra không side effect trước rejection.
3. Platform + Pane Manager + Providers: failing cross-profile isolation, prompt, permission enforcement và unsupported backend tests → launch/attestation/material/state paths và profiled specialist lifecycle.
4. Coordinator/Runtime scheduler + Skills: failing typed selection/dispatch/skill approval tests → accepted assignment pins, immutable manifests và grants/readiness. Không bypass spec acceptance.
5. Runtime + Verification: failing rename/rebind/history/self-review/recovery/unknown-delivery tests → lineage checks và exact snapshot replay. Recheck at settle để chặn late evidence.
6. CLI/preview/evidence integration và owned README docs sau review; build trước worker/subprocess tests. Không sửa root test config/lockfile nếu chưa có decision cần thiết.

Chạy `pnpm test:affected --base e73dca70cb91bdd53fbe1fe9dfb69ccba8b6f8ff` rồi `--run`; công bố index state và widening, không skip vì GitNexus thiếu. Do sửa contracts, integration validation bắt buộc thêm `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, E2E compatibility liên quan (e11–e16 và profile cases), `git diff --check`. Ghi actual commands/exit/counts/tested HEAD + uncommitted diff; test doubles không phải live Herdr/provider hoặc full SDLC acceptance. Live Herdr probes phải kiểm tra installed protocol bằng isolated named session trước thay Herdr operations; không release allowlist.

## 9. Builder review

Reviewer độc lập đã đọc proposal/source và nêu ba câu hỏi có ảnh hưởng implementation. Đã đối chiếu `execution-binding.ts` và giải quyết bằng lựa chọn thiết kế của tác giả: giữ nguyên EP-01 blocking semantics, định nghĩa host proof cho fresh/root/successor executor lineage, và áp dụng read restrictions cả vào Git/Developer runner hoặc trả unsupported. Owner đã duyệt các lựa chọn này cùng RP-01; design review không phải runtime acceptance.

## 10. Quyết định và phạm vi thực thi

Owner đã duyệt RP-01, Specification RP-AC01–10, TddDecision required và integration scope tại mục 3. Implementation giữ additive public fields và marker v7 cho private agentic journal có profile authority; unprofiled v1–v6 vẫn đọc được. Không commit, push hoặc PR. Xem evidence để phân biệt source/local tests với live acceptance.

Model/effort preferences được áp dụng trên base defaults nếu không trái exact pack locks. Một profile yêu cầu provider khác configured role template hiện trả unsupported: native login selector, Gateway grants và provider-specific ingress vẫn gắn template đó; không tự chọn provider khác hoặc bỏ preference. Backend không enforce được read/deny restrictions hay native write subtree vẫn trả unsupported như mục 4. Recovery giữ pin/snapshot nhưng không khôi phục live launch authority mà daemon cũ đã revoke theo lifecycle sẵn có; cần fresh up và reconciliation, không suy ra proof từ snapshot.
