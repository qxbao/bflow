# Provider contracts v3

Thiết kế chuẩn tắc P24; owner triển khai là P25. Public export:
`packages/contracts/src/{platform,provider}.ts`. [Runtime v3](runtime-architecture-v3.md)
ghi lại kết quả audit source, ủy quyền D24-01, migration và quyền sở hữu theo phase.

## Implementation status (cập nhật 2026-10-17)

P25 đã có source tại `packages/agent-providers` (adapter Claude Code, Codex, Agy; `checkHealth`
preflight/activated; compile permission profile; `prepareLaunch`; ký/kiểm chứng
`AgentLaunchAttestation` Ed25519; `buildHerdrAgentStartCommand`; registry mặc định). Agy
báo `unsupported` cho `unattended_isolated` và chưa certify native attestation, đúng yêu cầu
bên dưới. CLI P29 gọi registry qua `bflow agent check`, `bflow setup` và các bước validate của
`bflow up`/`doctor`. **P30 (source + local test):** Runtime host gọi preflight/`prepareLaunch`, ký attestation và
yêu cầu activated health; adapter render MCP server của host, Gateway HTTP (token qua tên env var)
và đủ 4 native hook; `provider-launch.ts` chỉ còn là đường legacy. Mức bằng chứng: source + local
test; không có hồ sơ live provider login/launch/permission enforcement cho P25/P30.
Chi tiết ở [package README](../packages/agent-providers/README.md) và
[hồ sơ P25–P29](acceptance/2026-10-17-p25-p29.md). Nội dung dưới đây là thiết kế đóng băng.

## Danh mục contract

| Contract | Schema / ý nghĩa |
| --- | --- |
| `AgentProviderAdapter` | Port TypeScript; descriptor đã validate cùng `checkHealth(AgentHealthRequest, OperationOptions?) → OperationResult<AgentHealthResult>` and `prepareLaunch(AgentEnvironment, OperationOptions?) → OperationResult<AgentLaunchProfile>` |
| `AgentCapability` | `AgentCapabilitySchema` hiện có trong `session.ts`, không đổi. Năng lực nghiệp vụ như implementation/review; không chứng minh đã đăng nhập, kết nối MCP hay được ủy quyền |
| `AgentProviderDescriptor` | Catalog provider có version, bọc các capability hiện có; tên CLI, version adapter, MCP transport, hỗ trợ unattended/native-binding |
| `AgentLaunchProfile` | Đường dẫn/digest executable chính xác, version provider, mảng argv, digest các file config được sinh, environment, interaction mode, launch fingerprint và thời điểm hết hạn |
| `AgentEnvironment` | Provider/role/session đã resolve, cwd/thư mục state riêng, config fingerprint, permission profile, giá trị env không bí mật, secret reference, capability/service bắt buộc và digest skill-manifest |
| `PermissionProfile` | Ba permission mode, root/tool/network/isolation tường minh, hành vi deny và literal `allowGlobalPermissionBypass: false` |
| `TrustScope` | Định danh machine/repository/session dạng discriminated; lồng trong document có version. `isTrustScopeWithin` kiểm tra containment logic; host kiểm tra containment filesystem canonical riêng |
| `AgentHealthRequest` / `AgentHealthResult` | Các check theo từng stage và quan sát readiness có hạn, gắn với định danh environment/provider/role/config |
| `AgentLaunchAttestation` | Startup receipt mới gắn với launch ID/fingerprint, Bflow session, Herdr pane và native provider session; được trusted host ký |

Mọi giá trị trao đổi phải được parse bằng schema đã export ở cả input lẫn output.
Port object/function và `AbortSignal` trong tiến trình không được serialize; request/result
của method dùng schema và `OperationResultSchema(TSchema)` hiện có. Versioning dùng
literal 3 ở envelope mới; không diễn giải lại record v1/v2.

## Giao thức probe và launch

`checkHealth` là một quan sát, không phải trình cài đặt hay lệnh đăng nhập. Mọi preflight
check bắt buộc phải `passed`; bằng chứng thiếu/unknown/hết hạn/unsupported sẽ chặn. Code và
remediation phải an toàn để hiển thị trong CLI JSON và Conversation, không chứa output terminal
thô của provider, email, token hay stderr tùy ý. Deadline/AbortSignal lan truyền qua
`OperationOptions` hiện có; probe có giới hạn về output, subprocess và thời gian.

| Check | Bằng chứng bắt buộc / hành vi khi âm tính |
| --- | --- |
| `binary` | Resolve executable canonical từ chính sách install/PATH tin cậy, xác minh ownership/digest, từ chối binary bị đổi/thiếu/không thực thi được |
| `version` | Parse output version thực tế và kiểm tra các cờ/hành vi CLI bắt buộc; release label đơn thuần không phải allowlist tương thích |
| `authentication` | Trạng thái native của provider hoặc probe readiness có xác thực an toàn dưới đúng credential binding; phân biệt missing, expired, unauthorized và unknown. Chỉ có file hoặc Herdr idle là chưa đủ |
| `environment` | Định danh cwd/worktree, mount writable/read-only, quyền của state riêng, socket realm/độ dài path, sandbox OS/process, tool/runtime bắt buộc và env allowlist tường minh |
| `mcp` | Client transport được hỗ trợ và cấu hình sinh ra chính xác; initialize/negotiate/tools-list và ủy quyền tool bắt buộc. Không có service bắt buộc chỉ là MCP check thành công theo nghĩa rỗng sau khi đã xác minh tập bắt buộc là rỗng |
| `launch_arguments` | CLI chính xác hỗ trợ profile, file prompt/config là file thường/riêng tư/có giới hạn và khớp digest, lệnh hook tin cậy được pin, không kế thừa settings/plugin/hook không an toàn |
| `permissions` | Quyền hiệu lực không rộng hơn profile; native tool deny, ủy quyền Gateway, OS isolation và network policy được thực thi. Cờ permission bị bỏ qua/không biết sẽ fail |
| `skills` | Manifest role/provider chính xác được resolve với nội dung/dependency đã pin và capability/tool bắt buộc khả dụng; thiếu binding bắt buộc sẽ fail |
| `native_binding` | Chỉ ở stage activated: xác minh chữ ký issuer tin cậy và binding launch/session/pane/native chính xác. Preflight kiểm tra riêng khả năng adapter tạo ra bằng chứng này |

`prepareLaunch` biên dịch cấu hình đã resolve và tin cậy; nó không bao giờ khởi chạy agent,
nhận lệnh shell do model cung cấp, cài đặt global hay cấp thêm quyền mới. Resolve lặp lại
cùng một environment generation phải trả về nội dung profile tương đương; caller lưu launch
ID/fingerprint trước các side effect của Herdr. Secret được host resolve ngay trước khi
launch, không nhúng vào argv hay profile có thể serialize. Secret reference là locator mờ,
không chứng minh credential tồn tại hay hợp lệ. `environmentVariables` chỉ cho phép giá trị
không bí mật; host phải từ chối env key bí mật, loader injection/ghi đè PATH và việc kế thừa
cấu hình provider chưa được duyệt.

Host tính SHA-256 trên config canonical không bí mật đã resolve và các generation ID của
secret-binding. Không băm byte của secret vào fingerprint công khai. Launch fingerprint còn
ràng buộc digest/version executable, role/prompt/skill manifest, permission policy, MCP
registration, nguồn native hook và session generation. Đọc file an toàn, pin định danh đã
quan sát và kiểm tra lại ngay trước khi launch; không tin chuỗi digest do repository/model
cung cấp. Mọi thay đổi làm mất hiệu lực profile và health cache.

`checkHealth` ở stage activated yêu cầu profile + attestation. Schema từ chối launch
ID/fingerprint/session không khớp và trạng thái ready khi có check unknown/thiếu; host kiểm
tra thêm chữ ký, issuer đã cấu hình, occupant hiện tại chính xác, role/provider/environment
bằng nhau, clock/hết hạn và không replay từ generation trước. Health TTL > 0 và <= 5 phút;
verifier kiểm tra thời gian hiện tại, không bao giờ chỉ dựa vào việc parse schema. Một chuỗi
Ed25519 giả mạo nhưng hợp lệ về schema không phải bằng chứng đã xác thực.

Byte chữ ký startup là UTF-8 `bflow.agent-launch-attestation.v3\n` theo sau là
`canonicalReceiptJson` đã export hiện có của attestation body đã parse, loại trừ
`signature`. Issuer key được chọn từ cấu hình host tin cậy, không bao giờ từ chính receipt.
P25 ký tại ranh giới native-host tin cậy; P30 xác minh trước khi dùng quan sát đó. Prefix
ngăn tái sử dụng chéo giữa các receipt domain khác. Lưu chính xác các byte đã ký và launch
generation trước khi đưa activated health cho consumer.

Startup attestation khác với `AgentBindingReceipt` của ADR 0003, vốn gắn với execution
handle của một task thực tế. Không bịa run/task cho startup và không viết lại task handle.
Giữ nguyên việc persist execution-bound hiện có, tương quan task đã xác thực và acceptance
gating sau khi sẵn sàng. P30 điều chỉnh ledger launch-receipt riêng hiện tại của host thông
qua validation tường minh mà không bịa chữ ký lịch sử còn thiếu; một session live cũ thiếu
bằng chứng bắt buộc vẫn ở trạng thái unresolved cho đến khi reconcile an toàn.

## Ma trận permission

| Profile | File/tool | Tương tác người dùng | Ranh giới bắt buộc |
| --- | --- | --- | --- |
| `restricted` | Chỉ đọc các root được chọn và đúng các tool được phép; không có root ghi được | Từ chối hoặc yêu cầu qua Conversation | Chính sách tool của provider, ủy quyền host/Gateway; không tuyên bố cô lập process thù địch |
| `workspace_auto` | Chỉ ghi vào root worktree và path task được ủy quyền; state được bảo vệ vẫn bị deny | Thao tác đã duyệt trước chạy không cần native prompt; các quyết định khác qua Conversation | Chính sách provider + các gate hiện có của host; worktree chỉ cung cấp cô lập Git |
| `unattended_isolated` | Filesystem task/session theo least-privilege, egress được phép, ngân sách tool và tài nguyên; không mount home/secret/state của host | Không có prompt trực tiếp từ specialist; tạm dừng/escalate khi cần quyết định | OS sandbox/container đã xác minh cho toàn bộ process provider, session scope, fail nếu không khả dụng |

`PermissionProfile` không được dùng machine scope, kể cả khi cài đặt toàn máy. Profile
repository chỉ được ủy quyền cho repository canonical đó; session thu hẹp thêm. `restricted`
phải là read-only. `unattended_isolated` từ chối isolation `provider_policy` và yêu cầu
session scope. Host từ chối `/`, root phạm vi toàn home, path traversal, symlink escape,
mount secret/socket chưa duyệt và quyền network/tool rộng hơn. Profile mode không bao giờ
ghi đè spec đã chấp nhận, task scope, lease/fence hay các phê duyệt của con người.

Không adapter nào được ánh xạ unattended sang settings không giới hạn ở phạm vi machine.
Các cờ CLI bỏ qua mọi approval/sandbox không phải ánh xạ chuẩn. Nếu provider không thể đáp
ứng quyền hiệu lực được yêu cầu, trả về unsupported hoặc blocked. Sandbox chỉ dùng cho
subprocess của test không thỏa mãn yêu cầu cô lập process provider cho unattended.

## Ánh xạ provider và tương thích đã quan sát

Code launch hiện có là `packages/pane-manager/src/provider-launch.ts`; P25 trích xuất hoặc
bọc lại hành vi đã xác minh của nó và P30 nối ngược vào Pane Manager. Không duy trì chính
sách launch thứ hai mâu thuẫn. Prompt role gốc đầy đủ được giữ nguyên, bổ sung bằng chính
sách host tin cậy và skill instruction đã resolve. Không rút gọn personality của
Chat/Coordinator thành một tên role chung chung.

| Provider | Kiểm soát hiện có/đã quan sát | Yêu cầu nghiệm thu P25 |
| --- | --- | --- |
| Claude Code | Đã cài 2.1.301. Launch hiện có dùng strict MCP config, tool bị hạn chế, settings/hook có scope và `dontAsk`; có launch bằng prompt-file | Giữ nguyên wiring native SessionStart/UserPromptSubmit/PreToolUse đã xác minh; chứng minh capability của role và hành vi deny trong config cục bộ của launch. `dontAsk` từ chối các lời gọi cần prompt; nó không cung cấp OS sandboxing. [Tài liệu permissions chính thức](https://code.claude.com/docs/en/permissions) |
| Codex | Đã cài 0.162.0. Helper hiện có dùng sandbox read-only/workspace-write, approval never, MCP tường minh, `model_instructions_file`, không daemon; việc opt-in tin cậy hook chỉ áp dụng cho các hook sinh ra đã được kiểm duyệt | Xác minh parser/cờ đã cài, auth, native session/nguồn gốc human và host tool trước khi hỗ trợ default-host. Approval `never` không tắt workspace sandbox; không chọn danger-full-access. MCP hỗ trợ stdio và Streamable HTTP với config có scope. [Cấu hình MCP chính thức](https://developers.openai.com/codex/mcp), [tham chiếu cấu hình](https://developers.openai.com/codex/config-reference) |
| Agy | Đã cài 1.4.0. Help cục bộ có `--sandbox`, print/stream-json, cấu hình MCP stdio/http; đồng thời có cờ bỏ qua permission | Xác minh hỗ trợ auth/status thực tế, role injection, agent kind của Herdr/định danh native session, hook tương đương, config scope và sandbox được thực thi. Help text chỉ là bằng chứng khám phá. Không tuyên bố hỗ trợ unattended hay tích hợp P19 cho đến khi các mục này pass |

Không dùng `codex exec`, Claude background mode, Agy remote-control hay daemon khác để
vượt qua quyền sở hữu pane/process của Herdr. Thực thi không tương tác vẫn phải được launch
và quan sát qua vòng đời Herdr. Một probe print-mode là probe conformance có giới hạn,
không phải hệ thống orchestration thay thế hay bằng chứng workflow hoàn tất.

P24 đã kiểm tra version/help và chạy một test vòng đời Herdr transport cô lập mà không có
lượt model; nó không test đăng nhập provider, không cài skill, không sửa config MCP và không
chứng nhận lại smoke native/model trước đó. Provider không được hỗ trợ vẫn là chẩn đoán hạng
nhất; Bflow không được âm thầm fallback sang provider khác.

## Lỗi, readiness và quyết định của người dùng

Dùng các ContractError code hiện có: `validation`, `unsupported_version`, `not_found`,
`conflict`, `transport_unavailable`, `timeout` an toàn với deadline, `cancelled`, `corruption`,
và `unknown_delivery` cho side effect transport không chắc chắn. Capability không được hỗ trợ
là một quan sát thành công với health `unsupported`; điều kiện tiên quyết về auth/trust/policy
là health `blocked`. Lỗi probe vận hành có thể dùng OperationResult failure; không kết quả
nào trong số này được coi là ready.

Specialist không bao giờ chấp nhận câu hỏi native từ người dùng. Tắt UI elicitation/approval
trực tiếp; chuyển hành động bị chặn thành request Runtime có cấu trúc, dùng các RoleMessage
type và correlation hiện có. Runtime định tuyến qua Herdr tới Conversation; hook human tin
cậy xác thực câu trả lời. Request bị từ chối hoặc hết hạn vẫn là bị từ chối. Setup/login có
thể yêu cầu lệnh của operator trước session, nhưng startup không bao giờ tự động chấp nhận
màn hình trust/update/login của provider. Unattended nghĩa là công việc đã được ủy quyền tiến
triển mà không cần gõ phím thủ công; các quyết định bắt buộc của con người vẫn ở trạng thái
chờ, có giới hạn và có thể phục hồi.
