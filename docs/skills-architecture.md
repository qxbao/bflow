# Kiến trúc skill theo role v3

Thiết kế chuẩn tắc P24; P28 sở hữu `packages/skills/**` và `skills/**`. Contract được export
từ `packages/contracts/src/skills.ts`. P24 không tạo skill pack hay loader đã cài đặt.

## Implementation status (2026-10-25)

Canonical catalog ở `skills/**`; P28 resolver/store và P26/P29 setup/skills commands đã được tích hợp với session manifests của P30. CLI dùng approved role bindings và exact pins: absent `role.skills` lấy defaults, `[]` bỏ defaults nhưng không bỏ `requiredSkills`; tool-dependent skill chỉ active khi grant đã resolve. Custom `catalogDir`/`bindingsPath` hiện bị startup composition từ chối.

Provider nhận instruction đã pin và đọc qua host `read_pinned_instructions`; không bật global native discovery chỉ để tìm plugin. D-TOOLS-01 tách catalog tool ID khỏi upstream operation. [Implementation status](implementation-status.md), [catalog](../skills/README.md) và [package README](../packages/skills/README.md) là nguồn hiện tại. Rendering/load không chứng minh agent tuân thủ hoặc full SDLC pass.

## Giữ nguyên thẩm quyền role và prompt hiện có

Các asset Chat, Coordinator, Analyst, Architect và Verifier hiện có cùng các role profile
trong Registry đã định nghĩa personality, routing và chính sách làm việc. Pane Manager đã
nạp đầy đủ các file role prompt. Skill bổ sung các chỉ dẫn kỹ thuật có phạm vi; chúng không
bao giờ thay thế các prompt này, cấp permission, dispatch Developer, chấp nhận specification,
tắt TDD, vượt Quality Gate hay tạo ra human approval giả.

Resolve chỉ dẫn hiệu lực theo thứ tự: chính sách system/host và chính sách project đã chấp
nhận, personality/prompt của role hiện có, rồi đến chỉ dẫn skill đã pin và duyệt cùng ngữ
cảnh task. Nội dung skill không thể ghi đè thẩm quyền ở các tầng trước. Chỉ dẫn là nội dung
không tin cậy cho đến khi xác minh được nguồn gốc approval/catalog của operator; ghi
"trusted" trong SKILL.md không có tác dụng. Plugin/hook native của provider, chỉ dẫn và
tool thực thi thực tế là các khái niệm khác nhau và phải được ủy quyền riêng.

## Public contract

| Contract | Ý nghĩa |
| --- | --- |
| `SkillDefinition` | schemaVersion 3; ID ổn định, version/digest nội dung, nguồn (builtin/operator/repository), entrypoint, mô tả, role/provider được phép, capability/tool bắt buộc và dependency đã pin; instructionOnly là literal true |
| `SkillManifest` | schemaVersion 3; lựa chọn environment/role/provider/session đã resolve và bất biến, digest, các definition và binding chính xác |
| `RoleSkillBinding` | schemaVersion 3; binding ID, skill pin chính xác, role/provider/session, cờ required và approval receipt ID tùy chọn |
| `SkillPin` | Value object lồng `{skillId, version, digest}` dưới envelope có version; dependency không được trôi sang latest |

`SkillDefinitionSchema`, `SkillManifestSchema` và `RoleSkillBindingSchema` từ chối field/version
không biết. Việc parse manifest từ chối binding/definition trùng lặp, role/provider không tương
thích, scope không khớp, skill đã resolve nhưng chưa bind, dependency thiếu/không khớp, chu trình/thứ tự
không topological và binding skill của repository không có approval reference. Việc validate
schema đối với digest/approval ID không xác minh byte file hay thẩm quyền của con người; resolver
tin cậy phải làm cả hai trước khi readiness.

## Catalog, toàn vẹn nội dung và thứ tự ưu tiên

Machine setup sở hữu một skill catalog content-addressed trong thư mục dữ liệu được quản lý
của nó. Builtin đi kèm bản phân phối Bflow đã được review. Catalog của operator pin chính xác
nguồn và digest. Cấu hình repository có thể yêu cầu skill ID/pin và đề xuất skill cục bộ,
nhưng không thể chèn plugin global thực thi được hay mở rộng chính sách machine. Approval
tường minh gắn với digest nguồn, role/provider, scope và dependency; nội dung thay đổi làm
approval hết hạn và đòi hỏi manifest mới. Không âm thầm nhận skill từ thư mục home của provider.

Resolution mang tính xác định: chọn các pin đã duyệt tường minh, validate đồ thị dependency,
sắp xếp dependency theo topological với tie-breaker là ID ổn định, thực thi role/provider và
capability/tool tương thích, xác minh byte, tạo manifest và tính digest canonical. Pin cùng ID
mâu thuẫn sẽ fail; không có last-file-wins. Skill tùy chọn không khả dụng có thể bị bỏ qua kèm
chẩn đoán trước khi manifest bị đóng băng. Skill bắt buộc không khả dụng chặn role và do đó chặn
`up`; không có placeholder rỗng tuyên bố skill bắt buộc đã thành công.

`digest` định danh một content bundle canonical gồm SKILL.md và mọi resource được tham chiếu,
dùng inventory relative-path/content-digest đã sắp xếp; resolver từ chối path traversal, link
thoát khỏi root, file đặc biệt, resource quá lớn và tham chiếu remote chưa được fetch. Xác minh
toàn bộ byte tại ingress và trước khi render. Không chỉ duyệt SKILL.md trong khi script/resource
chưa pin có thể thay đổi bên dưới. Catalog cục bộ có quyền owned/private và cập nhật generation
theo kiểu atomic; session đang chạy giữ generation đã resolve bất biến thay vì chấp nhận thay đổi
giữa task.

`instructionOnly: true` cố ý loại trừ hook install/postinstall thực thi được khỏi contract của
skill. Một skill có thể mô tả việc dùng tool ID đã được ủy quyền qua ToolInstaller/Gateway/Runtime,
nhưng script đi kèm chỉ là nội dung và không thực thi chỉ vì skill được nạp. Tính năng
executable-skill trong tương lai đòi hỏi một quyết định contract riêng và review sandbox/approval.
Không chỉ dẫn nào được gọi CLI thô để né Runtime.

## Binding role và catalog hiện tại

Bảng dưới mô tả trách nhiệm capability; lựa chọn skill thực tế nằm trong
[`skills/roles/bindings.json`](../skills/roles/bindings.json), sau đó phải resolve thành pin/manifest.
"Analyst" ánh xạ `specifier`, Chat ánh xạ `conversation`; Reviewer/QA độc lập với implementer.

| Role | Skill cần resolve | Ranh giới |
| --- | --- | --- |
| conversation | intake/clarification, tiến độ, trình bày quyết định của con người | Giao diện người dùng duy nhất; không sửa source hay dispatch specialist |
| coordinator | phân rã/DAG, phân loại SDD, quyết định TDD, escalation | Chỉ dùng tool Runtime hiện có; không spawn process trực tiếp hay vượt chính sách |
| specifier / architect | tiêu chí/traceability, rủi ro thiết kế và chuẩn bị approval | Đề xuất đi vào luồng approval/versioning P15 hiện có |
| planner | lập kế hoạch dependency/scope | Không thể tự ủy quyền implementation |
| developer | implementation có phạm vi, RGR có điều kiện, bằng chứng Git | Worktree/path task và ủy quyền P16 được thực thi độc lập |
| tester / qa | verification khách quan, bằng chứng đúng revision | Không thể tự duyệt implementation của mình hay sửa tiêu chí đã chấp nhận |
| reviewer | review độc lập và phát hiện sửa chữa có giới hạn | Verdict là bằng chứng đã xác thực, không phải transition thành công trực tiếp |
| security | phân tích mối đe dọa, phát hiện về chính sách | Role không ngầm cấp thêm quyền filesystem/network/secret |

`use-deepwiki` (replaced the legacy `use-context7`) áp dụng cho specifier, architect, planner, developer, reviewer và qa khi đủ grant tài liệu ngoài repo. Catalog tool ID, service ID và upstream operation là namespace riêng theo [D-TOOLS-01](tools-sdlc-integration.md); không còn dùng workaround overload `toolIds` làm thiết kế hiện tại. Conversation không nhận tool Gateway. `docs status` chỉ probe service/config, không chứng minh provider consumption.

## Provider rendering và readiness

Resolver trước hết tạo ra manifest text/resource trung lập với provider. P25 render chúng
bằng các input prompt/config cục bộ của launch đã validate; P30 nối chúng vào bootstrap Pane
Manager hiện tại. Launch hiện tại của Claude tắt slash command/native skill discovery;
v3 có thể render chỉ dẫn skill đã kiểm duyệt vào các prompt asset tường minh mà không bật
cơ chế discovery global chưa được review. Codex và Agy tương tự chỉ nhận manifest đã resolve
qua một bề mặt cấu hình đã xác minh cho CLI họ cài. Không giả định mọi CLI hỗ trợ cùng ngữ
nghĩa thư mục SKILL.md hay tên tham số.

P28 export phần triển khai của mình theo các contract này; tích hợp P25/P28 dùng port và dữ
liệu đã render qua Runtime composition, không có leaf package nào import leaf khác. Prompt role
gốc đầy đủ vẫn được nạp kể cả khi không chọn skill nào. Thiếu hỗ trợ provider rendering cho một
skill bắt buộc sinh ra readiness unsupported kèm remediation cụ thể, không cắt xén văn bản âm
thầm hay giả vờ cài đặt thành công.

Environment bao gồm digest skill-manifest; launch fingerprint cũng ràng buộc các file chỉ dẫn
đã render. Mọi thay đổi pin/nội dung/role/provider/policy/tool làm mất hiệu lực readiness.
Startup validate các file hiện tại và host binding đã activated. Health là bằng chứng vận hành;
một skill nạp thành công không chứng minh agent đã tuân theo nó hay đã vượt các gate
SDD/TDD/verification.

## Câu hỏi, approval và recovery

Skill của mọi role không phải Conversation phải định tuyến yêu cầu còn thiếu, yêu cầu
permission, quyết định thiết kế và nhu cầu approval qua Runtime → Herdr → Conversation. Tắt
AskUserQuestion/elicitation trực tiếp native. Lời khuyên của skill không thể tự trả lời thay
người dùng hay tái sử dụng approval cũ. Giữ nguyên ngữ nghĩa request/correlation/causation/
target/revision/generation và hết hạn hiện có. Khi chưa có câu trả lời, persist trạng thái
waiting/blocked và chỉ resume sau quyết định đã xác thực; không có vòng lặp unattended poll
artifact để chờ phản hồi.

Persist manifest ID/digest/pin đã duyệt cùng với session generation, nằm ngoài source và được
bảo vệ khỏi việc ghi từ role. Restart nạp lại cùng manifest và xác minh byte; không resolve
`latest` rồi âm thầm đổi task đang chạy. Nếu nội dung bắt buộc bị thiếu hoặc hỏng, chặn và báo
qua chẩn đoán Conversation/operator; không bịa nội dung thay thế. Cleanup chỉ xóa nội dung owned
không còn được tham chiếu sau chính sách retention của session/run, giữ lại bằng chứng artifact
và các manifest có thể resume.

Test P28/P31 bao phủ resolution xác định, pin mâu thuẫn, chu trình, approval cũ, lạm dụng
chéo role/provider, resource thiếu, symlink traversal, chỉ dẫn ghi đè độc hại, secret reference
và restart khi catalog đã đổi. Test Runtime/Quality Gate vẫn phải chứng minh một skill không thể
vượt qua spec đã chấp nhận, bằng chứng Red-first bắt buộc, Reviewer/QA độc lập, human delivery
hay giới hạn verification có bound.
