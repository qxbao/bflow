# Bflow tools trong SDLC — đặc tả và kế hoạch nghiệm thu

Ngày: 2026-10-24. Owner thiết kế/nghiệm thu/tích hợp: root. Implementer: Luna.
Baseline: `1c7954267aab7b45e0bf5679a591862a126176e7`, main = origin/main lúc audit;
P24 `8dbb056` là ancestor. Worktree tích hợp: `/tmp/bflow-tools-sdlc`, branch
`integration/tools-sdlc`. Trạng thái: chủ dự án đã duyệt thiết kế và D-TOOLS-01 trong conversation ngày 2026-10-24; memory scope vẫn chờ xác định, không cấp setup/memory write.

## Vấn đề đã kiểm chứng

- CLI không áp dụng `skills/roles/bindings.json`; config mặc định không chọn skills/tools/services.
- Catalog resolve selection rỗng thành `[]`; `skills.required` không bảo đảm role có manifest hữu ích.
- `roleOption` để capabilityIds rỗng và cấp requiredTools/requiredMcpServices toàn cục.
- Context7 có đường riêng theo enabled/readiness/role; đường đó không tự chọn `use-context7` vào skillIds.
- Runtime chỉ đăng ký Gateway nếu mcpServiceIds khác rỗng; chuyển nguyên toolIds thành allowedTools.
  Catalog tool ID và upstream operation name đang bị dùng chung một trường.
- MemPalace có skill nhưng không có binding mặc định. RTK có helper nhưng không có caller workflow production.
- Gateway có call/reconcile và enforcement; chưa có liên kết usage bền vững với task/result consumption.
- Con số 177 manifest và calculator completed do người dùng cung cấp chưa được tái kiểm chứng từ session cũ.

## Phạm vi và invariants

Sửa đường production setup → config → launch → invocation → evidence, không xây engine mới.
Giữ SDD, Conditional TDD, independent QA, lease/fence, approval, bounded loops, cancellation,
aggregate recovery. Không sửa journal bằng tay; không dùng mock làm live evidence.
Không tự cài hoặc đổi global config. Chỉ Codex personal cho live; đầu vào bắt buộc qua Conversation.
Không gửi dữ liệu ra Context7 hay đọc memory ngoài policy chỉ vì tool đã cài.
Không push/PR/remote merge. Merge main cục bộ sau nghiệm thu theo ủy quyền người dùng.

## Thiết kế

1. Machine inventory dùng receipt/pin/digest đã có, cộng service definitions từ control catalog đã xác thực.
   Executable CLI phải canonical, đúng digest/version và không lấy binary tùy ý từ repo/PATH agent.
   Inventory là fact; không phải quyền repo hoặc readiness hiện tại.
2. Repository policy chọn tool ID, required/optional, role allowlist, operation allowlist, trigger và scope.
   Policy chỉ thu hẹp machine authority. Thiếu allowlist nghĩa là không được cấp.
   Cấu hình mới không tự cấp mọi tool đang cài. Setup preview/doctor trình bày các bước riêng biệt.
3. Resolver giao repository policy với role requirement, machine approval và actual capability.
   Dùng các namespace tách biệt: catalog toolId; capabilityId; serviceId; upstream operation.
   Không dùng fuzzy match/alias ngầm; alias `browser` → `chrome-devtools-mcp` phải được khai báo trong catalog.
   Service được chọn từ definition cùng tool/scope; nhiều candidate không rõ ràng phải block.
4. Skill resolver dùng approved bindings và exact pins. Bản sửa bindings thêm use-mempalace cho
   các role tương thích, nhưng skill không cấp tool. Skill phụ thuộc tool chỉ active khi role có grant ready.
   Required skill thiếu dependency block. Optional skill chưa đủ điều kiện được ghi skipped/degraded.
   Luôn giữ các skill quy trình không phụ thuộc tool; không âm thầm để required manifest rỗng.
5. MCP qua Gateway: registration tách theo service khi cần để tránh cross-product service/operation grants.
   Negotiate protocol, definition/input schema, operation allowlist và scope trước ready; không bịa schema
   permissive cho một required production operation. Kiểm tra input ở ingress và trước upstream call.
   Tool readiness cần probe không mutation phù hợp, không dùng tools/list làm invocation evidence.
6. CLI qua Runtime-controlled runner, không giả MCP service. Host tool `bflow` có thể vận chuyển yêu cầu
   chạy CLI đã ràng buộc; nó không biến executable thành MCP upstream. Kiểm tra assignment/lease/fence,
   command/cwd/output policy, binary identity trước side effect. Agent không nhận shell tùy ý để lách policy.
   Interface cụ thể mới: `invoke_tool_action({actionId, toolId, operation, input})` trong role MCP host
   (`agentic/host.ts` roleCall/roleTools/toolSchemas); request parse bằng `ToolActionRequestSchema`.
   Host derive principal/pane/native session/generation từ binding xác thực; run/task phải thuộc active
   assignment của binding, không tin role/fence do agent truyền. Action descriptor host chọn argv/cwd;
   không nhận command string tùy ý. Runtime recheck cancellation/approval/lease/fence trước side effect.
   CLI v1 chỉ hỗ trợ host-authorized runner commands; RTK tích hợp ngay trong measureBehavior runner,
   không cần generic shell endpoint. Operation khác chưa có descriptor trả unsupported, không exec.
   MCP actions qua cùng broker, server gọi Gateway bằng client grant được ràng buộc role/task. Không
   publish token raw upstream cho provider khi policy cần host-controlled scope/usage mediation.
7. Tool actions có descriptor chung: kind, trigger, scope validator, approved operations, requiredness,
   readiness probe và evidence policy. Adapter cụ thể chỉ xử lý protocol semantics của tool; không thêm
   chuỗi if theo tên MemPalace/RTK trong scheduler. Task classification/context hiện có quyết định trigger.
8. Invocation có ID ổn định theo run/task/role/generation/action, persist intent trước side effect.
   Lifecycle: planned → denied/skipped/degraded/blocked hoặc started → completed/failed/unknown.
   Result consumption là record riêng: consumed / rejected / not_used với reason và artifact reference.
   Không suy consumed từ call completed hoặc agent nói đã dùng; phải liên kết result vào host context,
   accepted artifact/spec input hoặc action tiếp theo đã xác minh. Điều này chứng minh dataflow, không
   tuyên bố đọc được suy nghĩ model.
9. Usage log chứa identity, tool/service/operation, reason code, timestamps, invocation và evidence refs;
   không chứa token, secret, query nguyên văn hoặc memory body. Payload cần giữ làm evidence nằm trong
   artifact có policy phù hợp; log chỉ giữ checksum/reference. Journal private versioned, atomic/locked.
10. Restart giữ pins/policy digest/intent/result và disposition. Nếu intent chưa có result xác thực,
    disposition là unknown và reconcile; không gọi lại để tạo evidence. Nếu không thể reconcile an toàn
    sau Gateway restart thì blocked rõ ràng. Không giả exactly-once với external service không hỗ trợ nó.
    Generation/token cũ bị revoke; generation mới không mở rộng quyền hoặc quên uncertain invocation.

## Quy tắc config và migration

- Không đổi schemaVersion config v1. Thêm field optional được parse strict bằng exported schema mới.
- `skills` thiếu: dùng approved built-in bindings theo role. `role.skills` có mặt: override danh sách
  mặc định role; `[]` là opt-out rõ ràng, bị từ chối nếu repository yêu cầu skill/manifest tối thiểu.
  `environment.skills.requiredSkills` tiếp tục là bổ sung bắt buộc, chỉ áp dụng role được definition cho phép.
  Opt-out chỉ xóa defaults, tuyệt đối không xóa requiredSkills. Với skills.required=true, tối thiểu phải
  có using-bflow cùng workflow skills của role đã được policy đánh required; Conversation không cần
  tool grant nhưng vẫn phải có using-bflow/understand-task/report-progress/request-approval mặc định.
  Built-in bindings hiện tại chỉ chứa ID: giữ file cũ tương thích, overlay metadata conditional/required
  trong catalog được review; không suy requiredness từ dependencies hoặc sự hiện diện của tên tool.
- `bindingsPath`/`catalogDir` không được tin vì nằm trong repo: xác minh approval/digest bằng đường P28.
  Required pin bị thiếu/hỏng phải fail; không fallback về một catalog khác.
- Default bindings có skill quy trình bắt buộc; skill tool là conditional/optional trừ khi policy yêu cầu.
  Dùng selection.required hiện có, không biến tất cả tool dependency thành required machine prerequisite.
- Legacy requiredTools giữ nghĩa required catalog IDs, requiredMcpServices giữ nghĩa required service IDs;
  exact legacy operation names chỉ được nâng thành grant khi xác minh service mapping duy nhất và authority.
  Ambiguous legacy mapping yêu cầu migrate, không tự cấp mọi operation hoặc phát tán cho mọi role.
  Mapping cụ thể: legacy all-role scope chỉ được bảo toàn nếu machine approval xác nhận từng role và
  exact operation allowlist hiện hữu; thiếu bằng chứng này thì fail kèm config patch role-local, không
  âm thầm tiếp tục với grant rộng hoặc hạ required thành optional. Catalog tool ID chỉ map sang service
  có definition.tool.toolId trùng và scope phù hợp; capability operation list không tự là authority.
- Legacy Context7 enabled/required vẫn được hỗ trợ và dịch thành policy chung; disabled không tạo grant.
- Config legacy không có tool policy vẫn nhận workflow skills, nhưng không được tự cấp tool mới.
  Doctor báo rõ tool đã cài nhưng repo chưa cho phép; cung cấp config patch/preview để người dùng duyệt.
- Snapshot config/policy digest theo session. Thay policy làm mất readiness; không đổi quyền giữa run ngầm.

## RTK

Chạy original command đúng một lần qua raw-preserving route trong sandbox runner hiện hữu.
Nếu RTK proxy đã được probe là bảo toàn argv/cwd/signal/status/raw thì có thể dùng proxy để chạy.
Nén trên raw stream/file đã capture qua RTK pipe hoặc formatter capability đã probe, không chạy lại test.
Nếu version không hỗ trợ raw-preserving route thì chạy command trực tiếp và báo degraded/required-blocked
theo policy, trước execution nếu required. Không tự chạy RTK init hoặc bật project TOML/hook không duyệt.
Parser TAP/Vitest/RGR và gate luôn nhận raw/report gốc; compressed output chỉ trả context cho agent.
Lưu original executable/argv/cwd, effective wrapper/digest, exit/signal và raw/compressed artifact refs.
Compression lỗi sau command không được che exit code hay kích hoạt fallback chạy lại command.
Đã quan sát installed RTK 0.42.4 `pipe --help`: có stdin filter và --passthrough; đây là candidate adapter,
không phải readiness proof. Production phải probe pinned binary trong machine inventory; không thay
pin đã duyệt bằng binary PATH 0.42.4 chỉ vì nó có tính năng cần thiết.

## Memory và tool triggers

| Tool | Trigger | Điều kiện / phạm vi | Skip/degraded |
| --- | --- | --- | --- |
| MemPalace | Cần prior engineering context hoặc yêu cầu rõ | Repo identity + approved wing/scope bắt buộc; search read-only, provenance và timestamp | Không có scope: denied/blocked nếu required; không gọi search toàn palace |
| RTK | Routine output phù hợp / runner được chọn | CLI grant + binary probe + raw retention | Command không phù hợp: skipped; optional thiếu binary: degraded |
| GitNexus | Quan hệ kiến trúc, impact analysis | Repo index đúng và fresh; read operations | Repo chưa index/không phù hợp: reason rõ, không tự rebuild |
| Context7 | Cần docs framework/API ngoài repo | Repo opt-in/network policy; exact approved ops | Không cần docs: skipped; optional outage: degraded |
| Browser | Task UI cần quan sát/behavior browser | URL/resource policy, task profile, lease/fence | Task CLI: skipped; không tự mở network/profile cá nhân |

Memory result chỉ được đưa vào context sau scope/provenance validation, đánh dấu historical/untrusted.
Không dùng memory chứng minh approval/spec/current code/test. Write mặc định denied; write permission
là quyết định riêng, không nằm trong duyệt thiết kế này. Live ưu tiên note đã tồn tại trong wing được duyệt;
nếu không có dữ liệu phù hợp thì xin riêng quyền tạo fixture trong wing riêng, không giả retrieval pass.

## D-TOOLS-01 — quyết định integration cần chủ dự án duyệt

Motivation: field toolIds hiện bị overload; usage/provenance/policy đi qua CLI/Runtime/Gateway cần
exported ingress schemas, không chỉ TypeScript assertions hoặc model private dùng xuyên package.

Đề xuất thêm module `packages/contracts/src/tool-policy.ts` và `tool-usage.ts`, export từ index:
`RepositoryToolPolicySchema`, `RoleToolRequirementSchema`, `ResolvedToolGrantSchema`,
`ToolActionRequestSchema`, `ToolUsageRecordSchema` (schemaVersion 3; strict; identity và ArtifactReference schemas hiện có).
Phân biệt catalog ID, operation, CLI identity, memory scope; usage record có run/role/task và
invocation/consumption disposition. Bổ sung optional tool policy vào wire CLI↔host dùng schemas này.
Không sửa shape bắt buộc RoleMessage, AgentCapability, SessionManifest, Core events/checkpoint,
RuntimeService, QualityGate, MCPToolCall hoặc SQL schema. Các optional fields dùng default deny.
Không thêm usage vào public event union để tránh upcast Core journal. Dùng Runtime private usage ledger
và Gateway private receipt ledger có version độc lập, lưu artifacts qua ArtifactStore hiện hữu.
Resolved grant giữ `toolId` cho skill eligibility/inventory; giữ `serviceId` riêng; `operations` chứa
exact upstream names. `MCPClientRegistration.allowedTools` chỉ lấy operations; `MCPToolCall.tool` là
đúng operation được gọi, tuyệt đối không lấy catalog toolId. Gateway kiểm per-service registration,
definition schema digest đã negotiated/pinned và input trước side effect; schema drift invalidates ready.
Gateway control extension cho call dùng `MCPToolCallSchema`/result hiện có, không tạo transport riêng
cho inter-role messages. Capability IDs chỉ lấy từ verified inventory mapping, không tự sinh từ tool ID.

Affected owners: Contracts/integration; CLI; Runtime; Gateway; Skills; Machine Setup/Tool Installer;
Provider chỉ đổi nếu launch cần field mới qua integration review. Leaf không import leaf khác.
Old binary không được đọc config có fields mới: fail closed và hướng dẫn upgrade; config cũ vẫn parse.
Downgrade session có ledger mới phải down/quiesce và giữ evidence, không xóa state để chạy tiếp.
Approval requested: chủ dự án duyệt D-TOOLS-01 và shared design/acceptance documents do root tích hợp;
không phải quyền setup/global config/memory write hoặc miễn human gates.

## Acceptance criteria (tất cả bắt buộc, không miễn bằng mock)

AC01 Production config → options → prepare → provider launch nhận đúng bindings/pins cho từng role,
override/legacy deterministic; required manifest không rỗng. Verify regression integration + launch evidence.
AC02 Skill/dependency không tạo grant; wrong tool/service/operation, scope, symlink/binary drift bị từ chối.
Verify negative integration tests và actual denied calls có host evidence.
AC03 Required unavailable block trước launch/dispatch; optional degraded vẫn giữ reason ở status/usage.
AC04 MCP thực gọi qua Gateway, input/output schema thật; result đi vào task output/context được kiểm chứng.
AC05 RTK thực chạy trên integrated runner; raw argv/cwd/status và failure/skip counts trùng parser gốc;
fallback không rerun side effect, timeout/abort giữ disposition đúng.
AC06 MemPalace retrieval thật chỉ trong scope đã duyệt, có provenance; write/out-of-scope bị deny.
AC07 GitNexus/Context7/browser mỗi tool có trigger và authorized action hoặc skip/degraded reason;
không bắt run calculator gọi browser/docs/index nếu không liên quan.
AC08 Usage phân biệt installed/allowed/granted/ready/invoked/consumed theo run/role/task; không lộ secret/memory.
AC09 Restart tại intent/inflight/completed/consumed không tăng quyền hay nhân đôi call; unknown bị reconcile/block.
AC10 Existing policy/recovery tests giữ nguyên; full validation và ownership diff được review trước merge main.
AC11 Live Codex personal từ Conversation hoàn thành task nhỏ với artifacts/receipts độc lập;
Herdr done/idle và agent report không được dùng thay success evidence.

## Kế hoạch giao Luna và thứ tự gate

TDD decision: required cho bugfix/wiring, schema, authorization, runner và recovery. Mỗi task có regression
Red trên baseline trước code, Green sau sửa, rồi Refactor nếu cần. Docs/config thuần: not_applicable,
thay bằng schema validation và review. Adapter integration: test hành vi qua production composition.

Wave 0 — root chốt thiết kế/D-TOOLS-01; Luna Contracts trên branch agent/contracts/tools-sdlc chỉ sửa
contracts module mới/tests; root review compatibility và freeze integration commit trước Wave 1.

Wave 1 — 3 Luna, mỗi agent worktree/branch riêng từ cùng baseline tích hợp đã freeze:
A. agent/cli/tool-policy: apps/cli/** — config/parser/render/doctor, catalog/bindings selection,
inventory + service mapping, legacy migration diagnostics, buildHostPlatformOptions production tests.
B. agent/runtime/tool-actions: packages/runtime/** — role grants/readiness, task trigger resolver,
controlled invocation, RTK raw-preserving runner, usage/consumption/recovery và package tests/README.
C. agent/platform/tool-capabilities: packages/skills/**, skills/**, packages/mcp-gateway/**,
packages/tool-installer/**, packages/machine-setup/** — approved conditional bindings, catalog identity,
scope/input enforcement, Gateway durable uncertain receipt handling và machine capability projection.
Nếu cần chia tiếp, chạy tuần tự theo owner trong cùng nhánh; không để hai agent sửa cùng package.

Mỗi agent: đọc manifests → viết regression → build → chạy Red và giữ log → implementation tối thiểu →
build → targeted Green → scope diff/README → commit; báo tested HEAD, counts, exit, unresolved issues.
Public boundary mới chỉ dùng frozen schemas; contract mismatch trả root, không tự sửa.

Wave 2 — root review từng ownership diff, cherry-pick tuần tự và chạy compatibility/composition tests.
Luna reviewer độc lập đọc implementation/security/recovery, root quyết định sửa và nghiệm thu.
Wiring/root config/lockfile chỉ root làm sau review, không thêm dependency để phá leaf boundaries.

Wave 3 — repo mẫu tạm riêng (Linux/POSIX), config Codex personal, không dùng Claude/Agy:
1. Inspect setup/inventory/policy chỉ đọc. Trình setup plan nếu thiếu prerequisite; chờ quyền riêng.
2. Test required-unavailable và optional-degraded bằng config repo riêng, không phá service dùng chung.
3. Qua Conversation yêu cầu task nhỏ có prior context trong memory scope đã được duyệt; spec/approval
   do luồng hiện hữu thực hiện. Lưu call/result scope metadata, artifact hash và liên kết consumed.
4. Task routine command/test tạo output + nonzero fixture cho RTK; đối chiếu raw/compressed/status.
5. Task index/docs/browser chỉ khi có policy và phù hợp; còn lại ghi skip cụ thể, không claim live probe.
6. Restart host/Gateway sở hữu riêng ở fault boundaries; đối chiếu invocation IDs/counter/grants/receipts;
   không kill daemon ngoài quyền hoặc daemon đang phục vụ repo khác.
7. Theo dõi completion bằng accepted evidence, independent gate và Git output; dừng riêng tại human gate
   cần approval mới. Cleanup chỉ owned sessions/resources sau khi giữ evidence.

Wave 4 — pnpm check:deps; pnpm typecheck; pnpm test; package tests; git diff --check; git status --short.
CI: chỉ đọc nếu có auth; hiện gh auth status báo chưa đăng nhập. Phân biệt baseline/environment failures.
Root review lại spec-to-AC/evidence matrix. Chỉ merge main cục bộ khi AC đạt, không push.
Giữ worktree/evidence nếu live blocker; báo chính xác hạng mục chưa đạt, không tuyên bố completed.

## Rollback và bàn giao

Rollback source bằng revert các scoped commits, không reset lịch sử/main, không xóa receipts/artifacts.
Quiesce trước downgrade, giữ unknown calls; config backup byte-exact qua cơ chế migrate hiện có.
Bàn giao gồm nguyên nhân, final design/decisions, commits, tested HEAD, ownership diff, config migration,
test exit/pass/fail/skip, live evidence matrix per tool, skip/degraded reasons, limits, CI và Git status.

### D-TOOLS-01 implementation clarification — executable ingress

The approved identity verification path needs an exported ingress schema rather than a new
package-local inspection response passed to CLI. Integration owner selects the additive
`VerifiedToolExecutableIdentitySchema` (v3, toolId, version, approved artifactIntegrity,
desiredStateDigest, canonical executablePath and executableDigest). Tool Installer returns
this within existing OperationResult/ContractError; unverified installs return an error.
CLI parses it before constructing a ResolvedToolGrant. This implements D-TOOLS-01's
inventory-to-grant requirement, keeps all existing exports/shapes compatible and adds no
SQL/checkpoint migration, authority, installer behavior or global configuration change.
The project owner approved D-TOOLS-01 in conversation; root reviews this supporting schema
before merging. Affected owners remain Contracts, Tool Installer and CLI.
