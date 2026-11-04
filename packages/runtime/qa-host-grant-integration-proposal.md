# D-EXT-QA-HTTP — Quyền HTTP do Runtime thực thi

Trạng thái: đề xuất quyết định tích hợp của chủ dự án, chưa cho phép sửa public contracts.

## Vấn đề đã tái hiện

Task 4 của thiết kế live extension đã lưu tại `d49bd6b`. Task 5 có regression local cho native binding,
approval nguyên bản, session cấp quyền, quyền trước từng request và review/adjudication độc lập. Transport của các
test đó là fixture; HTTP fixture là server thật. Grant trong test được cấp ở test harness, không phải producer live.

`QaWorkflowRuntime` yêu cầu `qa-http:http_read`, trong khi `createHttpQaTool` thực thi Node fetch ngay trong Runtime.
`ToolKindSchema` và `ResolvedToolGrantSchema` hiện chỉ biểu diễn CLI hoặc MCP. CLI grant cần trusted executable
identity; MCP grant cần approved service và Gateway readiness. `apps/cli/src/platform-options.ts:resolveToolGrants`
không thể cấp grant cho HTTP tích hợp sẵn khi không có executable/service đó. Session cấp quyền của platform là
Herdr session; intake dùng Conversation session, nên không được đổi ID trên grant để làm khớp.

Fixture và probe read-only: `support/qa-host-grant-fixture.json`; bằng chứng đầy đủ nằm tại
`/tmp/bflow-live-20261029T064532Z-cadf31/evidence/extension-task5-grant-admission.json`.
Không đổi `kind` sang MCP/CLI rồi gọi fetch trực tiếp để tự nhận đã có quyền tool live.

## Các phương án

1. **Đề nghị: thêm schema riêng `RuntimeHttpGrantSchema`**, không mở rộng `ToolKindSchema` hay thay semantics của
   `ResolvedToolGrantSchema`. CLI resolve quyền HTTP của Runtime từ policy repository đã được chủ dự án chấp thuận;
   host xác thực lại grant cho đúng session, repository, origin và hành động trước mỗi request.
2. Giữ nguyên public contracts và xây `qa-http` thành MCP service thật, admission/readiness qua Gateway, Runtime
   gọi service thật. Phải mở rộng thiết kế sang lifecycle/cấu hình service, Gateway invocation của internal execution
   và setup plan riêng; không được dựng service/readiness hay bỏ Gateway rồi gọi fetch thay thế.

Phương án 1 tránh biến tool do host thực thi thành service bên ngoài giả. Đây là đề nghị kỹ thuật của người thực hiện,
chưa phải lựa chọn của chủ dự án. Không triển khai bất kỳ phương án nào trước quyết định tích hợp này.

## Phạm vi đề nghị phê duyệt cho phương án 1

- Contract mới, additive: version 3, `grantId`, `policyDigest`, `kind: runtime_http`, `toolId: qa-http`,
  `role: qa`, session `scope`, exact `origins`, `operations` giới hạn `http_read | http_mutate`.
  Không mang CLI identity, MCP service/token, credential hoặc quyền mạng của provider.
- `operations` không vượt policy đã pin và origin không vượt intake đã duyệt. Policy repository mong muốn và
  grant session được resolve là hai đối tượng khác nhau. Không suy quyền từ capabilities, pack selector hay lời của role.
- CLI đọc policy riêng của Runtime, resolve grant mới với Herdr session thật và exact repository root; private
  host options mang nguyên grant. Conversation session chỉ dùng để correlate intake/approval, không đổi scope grant.
- Nguồn policy cụ thể: `environment.runtimeHttpPolicy`, validate bằng schema additive `RuntimeHttpPolicySchema`
  (version 3, repository scope/identity, digest, tool/role cố định và exact origins/operations). Policy là giới hạn do
  repository owner cấu hình, giống ranh giới tin cậy của `environment.toolPolicy`; role không được tạo/sửa nó.
  CLI cấp startup grant từ policy này trước intake. Startup grant không cho phép target activity: Runtime còn phải
  lấy giao của origins/actions trong grant với intake đã gắn human design approval đúng digest. Không đòi grant startup
  biết trước intake, không cấp grant mới từ nội dung do Coordinator tự viết.
- Revocation: host pin digest/source của repository config/policy vào execution resolution. Trước mỗi target operation
  đọc lại chính các nguồn policy đã pin; đổi nội dung, xóa file/field hoặc lỗi parse đều chặn request, gồm redirect,
  readiness và reconcile. Không tự reload policy để tăng quyền. Muốn dùng policy digest mới phải re-resolve/restart
  session theo đường lifecycle hiện có; run cũ giữ pin của nó và cần gate thích hợp, không tự adopt grant mới.
  File output BA/QA của Runtime không phải policy source; Task 6 phải kiểm tra output hợp lệ không bị coi là policy drift,
  đồng thời không miễn trừ thay đổi source/config khác. Không bỏ source drift protection để làm probe pass.
- Runtime chỉ thực thi sau human approval đúng design digest, role output đã qua gates; kiểm grant/policy còn hiện hành,
  allowed method/origin, fence ngay trước mỗi request, gồm readiness, redirect, reconcile và cleanup. Mutation giữ WAL
  intent/unknown delivery, không replay. Native role vẫn không có shell/write/network tool authority.
- Ghi usage/evidence bằng các contract hiện có; không phát hành MCP/CLI usage giả. Endpoint/response bounded,
  credential được giữ ngoài design/logs. Live smoke đầu tiên chỉ `http_read`, anonymous loopback fixture; không cấp
  `http_mutate` mặc định, không thay đổi global config hay cài tool mới.
- Chỉ HTTP tích hợp sẵn trong quyết định này. Browser vẫn yêu cầu adapter, grant và resource transaction thật;
  chưa có wiring thì báo prerequisite gap.

## Ownership và tương thích

Cho phép integration owner sửa additive `packages/contracts/**`, các consumer liên quan trong `apps/cli/**`,
`packages/runtime/**` và shared docs mô tả đúng quyết định này. Không sửa lockfile/root build config nếu không cần;
không đổi public Core/RunStore/Registry/RoleMessage/approval signatures hoặc event codec.

Các nhóm bị ảnh hưởng: contracts/integration, Runtime/host và CLI. Gateway/Machine Setup không được nhận grant loại mới
hay tự chuyển nó sang CLI/MCP; không cần thay protocol của chúng. Tool policy CLI/MCP hiện có và SDK local vẫn tương thích.
Schema mới đứng riêng; caller cũ không tự có quyền HTTP. Repository chưa khai báo policy mới bị blocked với thiếu grant,
không được mở quyền mặc định. Binary cũ gặp trường config mới phải báo unsupported config, không âm thầm bỏ qua.
Không upcast lịch sử/grant cũ thành grant mới, không migrate receipt và không đổi bằng chứng local thành live.

## Kiểm chứng bắt buộc

Red/Green cho schema ingress, producer CLI, session/repository/origin/action mismatch, revocation giữa hai request,
lease loss sau ghi mutation intent, approval stale/replay và cấm provider gọi target trực tiếp. Giữ regression SDK/CLI
và selection GitNexus; review độc lập toàn branch trước live. Chạy full checks trước local integration. Sau đó tiếp tục
Tasks 5–7 theo thiết kế gốc, giữ nguyên completed run/handover và toàn bộ human gates.

Chủ dự án phê duyệt bằng câu trả lời cho tài liệu này. Quyết định tích hợp không phải Runtime business approval,
không thay approval live của BA/QA/failover run. Không push hoặc merge remote.
