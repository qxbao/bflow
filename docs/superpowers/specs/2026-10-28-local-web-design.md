# Bflow Local Web — Design baseline

Ngày: 2026-10-28. Phạm vi do owner chọn: web localhost trên máy từng người; form/nút và chat tùy chọn trên cùng workflow. Kiến trúc đã được owner đồng ý trong hội thoại. Đây là mô tả để lập kế hoạch, không phải chứng nhận contract hay live acceptance.

## 1. Mục tiêu và phạm vi

- Người dùng phổ thông, PM và khách hàng sử dụng trình duyệt, không cần mở terminal để tạo việc, đọc kế hoạch, trả lời câu hỏi, duyệt, yêu cầu sửa, tiếp tục hoặc hủy.
- Một tiến trình Bflow Local Server phục vụ nhiều repository đã đăng ký trên cùng máy; mỗi repository giữ host/session riêng theo lifecycle hiện có.
- Dùng lại Core, Runtime, Conversation intake, Coordinator, verification, persistence và ArtifactStore. Herdr tiếp tục sở hữu process/pane/transport.
- Không có tài khoản cloud, tenant, remote execution, collaboration nhiều người, billing hay sửa code trực tiếp trên web ở phiên bản này.
- Local web không biến provider/OS chưa được hỗ trợ thành được hỗ trợ. Linux là nền tảng nghiệm thu live đầu tiên; các nền tảng khác chỉ công bố sau khi có bằng chứng.

## 2. Nền tảng đã kiểm tra

Source baseline khi lập kế hoạch: 7b158c4. Phải kiểm tra ancestry/equivalent patches và chọn approved integration descendant trước khi implement, không reset repo về hash này.

| Source | Ý nghĩa |
| --- | --- |
| packages/contracts/src/ports.ts — RuntimeService | API Runtime truyền thống có start/resume/cancel/decide/query/watch; không chứng minh có mutation API cho agentic host |
| packages/runtime/src/agentic/host-controller.ts — AgenticHostController | Public controller hiện chỉ expose getRun/findRuns qua runtime |
| apps/cli/src/bin.ts, runtime.ts | Business commands truyền thống compose openWorkspaceRuntime |
| apps/cli/src/high-level/commands/task-implement.ts | Chuẩn bị assignment, không dispatch |
| packages/runtime/src/agentic/host.ts | user_prompt kiểm tra provider hook/session; human decision yêu cầu humanHookProvenance; resume kiểm tra trusted user turn |
| packages/runtime/src/agentic/host-receipts.ts | Receipt human/turn, replay và resume authority hiện gắn native binding |
| packages/runtime/src/agentic/host-conversation.ts | HostConversationIntake nhận turn và quản lý intent/result |
| packages/conversation/src/types.ts | channel hiện chỉ herdr_attach/cli/internal/untrusted; chưa có web |
| apps/cli/src/environment.ts | EnvironmentLifecycle là composition hiện có để reuse init/up/down/status/doctor |
| scripts/check-dependency-graph.mjs | Leaf packages chỉ phụ thuộc contracts; không tạo package application mới phụ thuộc runtime |

Herdr 0.9.5 bundled schema: protocol 22; có session.snapshot, agent.prompt/read, pane.read, events.subscribe/wait. Chỉ kiểm tra schema/help, chưa chạy live chat web hoặc live workflow. graphify-out không có ở baseline; khảo sát dựa trên source trực tiếp.

## 3. Thành phần và dependency

~~~text
apps/web (@bflow/web) -> @bflow/contracts (chỉ browser-safe web subpath)
apps/cli -> @bflow/local-server -> @bflow/runtime -> existing packages
apps/local-server -> @bflow/contracts
apps/cli -> @bflow/contracts, existing lifecycle composition
~~~

- apps/web: Vite + React + TypeScript, React Router, semantic HTML/CSS; visual design, design tokens và UI conventions theo [docs/DESIGN.md](../../DESIGN.md), triển khai bằng ui-ux-pro-max-skill. Không dùng SDK provider hoặc Node API trong bundle.
- apps/local-server: Node HTTP server, static frontend, security middleware, route handlers, SSE. Chưa cần framework server ngoài Node; Zod/contracts dùng validation hiện có.
- packages/runtime/src/interaction: facade và client của agentic host, projection có giới hạn, trusted command ingress, event feed, operation reconciliation.
- CLI inject LocalWorkspaceServices vào server để reuse EnvironmentLifecycle và execution preview. local-server không import CLI; CLI không được import ngược từ server. Không load code sibling bằng đường dẫn.
- CLI locate built web assets bằng exported package resolver; asset directory là dữ liệu, không dynamic module import vào sibling dist. @bflow/web export resolver Node nhỏ riêng, không kéo frontend vào CLI.
- Root TypeScript references chỉ build phần TS phù hợp; Vite build frontend là bước riêng được integrator nối vào build/package scripts. React .tsx tests có Vitest config riêng và được root integration chạy rõ ràng.

## 4. Interaction và authority

- Form/nút đi qua Conversation-owned interaction boundary, sau đó Runtime/Coordinator; không cần model diễn giải thao tác approval/resume/cancel có cấu trúc.
- Chat dùng Conversation Agent. Structured request không cần chờ Conversation model rảnh; vẫn cần phiên host/Coordinator đã activated và ready.
- Form tạo RequirementDraft/DelegationRequest qua cùng admission như Conversation; không tự tạo approved Specification và không tự dispatch Developer.
- Một Công việc trên UI là lineage của run. changes_requested ở design/delivery có thể tạo follow-up run theo Runtime hiện có, parent thành superseded; không ép sửa lại terminal parent. View trả originRunId, parentRunId, continuedAsRunId và currentRunId; UI giữ lịch sử và dẫn người dùng tới run hiện hành.
- Quyết định mang exact approvalId/target/revision/generation; resume mang exact pendingAction/actionId; host kiểm tra lại trong serialized mutation boundary.
- User identity, timestamp và provenance do server/host tạo từ phiên local đã xác thực, không nhận authenticatedUser/decidedBy/binding từ browser hoặc model.
- Thêm provenance web có version/migration additive. Giữ parser/replay của native receipts cũ. Không gán web thành UserPromptSubmit/PreInvocation.
- Role credentials không được gọi trusted web ingress. Web credential chỉ có scope tương tác người dùng, không gọi coordinator/specialist tools. Private host token không đến browser.
- Replay cùng commandId + body hash trả cùng operation/result; cùng key khác body trả conflict. Native và web trả lời cùng approval: chỉ một quyết định được commit; quyết định trái ngược về sau bị từ chối.
- Giữ limits, independent verdicts, test integrity, approval, fencing, unknown_delivery và cancellation semantics hiện có.

## 5. Local server và session

- Lệnh đề xuất: bflow web [--port <port>] [--no-open]; chạy foreground, mặc định bind 127.0.0.1:4317. Port bận thì báo lỗi cụ thể; không kill process khác hoặc tự đổi origin.
- Một instance theo user/BFLOW_HOME, có locator private 0600 và owner lock theo pattern hiện có; invocation sau reuse instance đã xác minh. Không tin PID một mình.
- Mở browser qua URL có bootstrap secret trong fragment; đổi secret một lần bằng POST /api/v1/session/bootstrap. TTL bootstrap 60 giây, không lưu URL đầy đủ/log secret. Người dùng có thể chạy lại bflow web để mở phiên mới.
- Backend cấp cookie host-only HttpOnly SameSite=Strict, session TTL 12 giờ, không kéo dài tự động; session mất khi server restart. Trả CSRF token vào memory của UI; mọi authenticated mutation cần header X-Bflow-CSRF.
- GET /api/v1/session dùng cookie hợp lệ trả safe session summary, expiresAt và CSRF token hiện tại để refresh/tab mới hoạt động; same-origin read protection và Cache-Control: no-store. Không cần dùng lại bootstrap secret và không tạo approval/session mới qua GET.
- Kiểm tra Host = địa chỉ/port server được chọn; Origin chính xác cho bootstrap/mutation, từ chối null hoặc cross-origin. Read APIs/SSE cần cookie; fetch metadata cross-site bị từ chối. Không wildcard CORS.
- Production UI/API cùng origin. Dev Vite proxy /api, bind loopback, allowlist origin dev rõ ràng; không tắt CSRF/cookie validation.
- Không dùng token localStorage, không làm HTTP GET có mutation. Same-UID hostile process vẫn ngoài guarantee hiện tại.
- Ctrl-C chỉ đóng Local Server/connections, không quiesce/cancel/down host của project. Stop session và cancel run là thao tác riêng có xác nhận.

## 6. Dữ liệu và thao tác

- Registry project chỉ giữ canonical repository identity, display name và path trong BFLOW_HOME web state; không giữ workflow state thứ hai. Đăng ký path là read-only, không tự init/install/index/trust repository.
- Browser không có native directory picker đáng tin cậy cho backend path: dùng form đường dẫn tuyệt đối; lỗi path/git được giải thích. Không lộ filesystem browser tổng quát.
- availableActions có action token/version và lý do disabled; chỉ host tính. UI không suy luận quyền từ tên phase. Token không thay thế xác thực server-side.
- Operation: accepted, running, applied, failed, reconciliation_required. applied nghĩa thao tác đã áp dụng, không phải workflow completed. HTTP timeout không khẳng định chưa thực hiện.
- Interaction operation receipts thuộc host; lifecycle start/stop operation receipts thuộc Local Server private state để truy vấn được ngay cả khi host chưa tồn tại hoặc đã dừng. Lookup phân loại owner; lifecycle reconciliation đọc existing manifests/receipts/locks, không tạo workflow store thứ hai và không tự chạy lại uncertain start/stop.
- Command body tối đa 256 KiB, page size mặc định 25/tối đa 100, chat text tối đa 16 KiB UTF-8. Unsupported query/unknown schema fields bị từ chối.
- Artifact mở bằng project/run/artifact ID; kiểm tra trusted reference và scope. Không nhận arbitrary filesystem path hay fetch tùy ý artifact URI. Inline chỉ plain text/JSON/Markdown đã sanitize; HTML/SVG/script là download attachment. Preview tối đa 1 MiB, phần còn lại tải qua stream có giới hạn/quota theo size metadata và policy ArtifactStore hiện có.
- Events: SSE có server epoch + sequence, ring buffer tối đa 1000 events/project; reconnect đọc bù khi còn buffer, hết buffer/restart nhận reset và tải lại snapshot. Feed là projection invalidation/notification, không event log có authority. Queue tối đa 100 events/slow client rồi reset/disconnect; heartbeat 15 giây, cleanup khi disconnect.
- Chat không được dựng lịch sử từ screen scraping ANSI. Lưu message có ID, role, run/session, delivery và source. Diagnostic pane output là vùng riêng read-only/untrusted. Không hứa token streaming khi provider chưa có adapter verified.

## 7. UX và acceptance criteria

| ID | Tiêu chí chấp nhận | Owner task |
| --- | --- | --- |
| AC01 | bflow web mở UI localhost; CLI lifecycle cũ vẫn hoạt động; đóng tab/server không dừng workflow | W03/W04/W09 |
| AC02 | Thêm/chọn nhiều project, readiness rõ ràng; không tự install/init/index | W04/W06 |
| AC03 | Dashboard có phase, tasks, blocker và trạng thái pending decision đúng project | W01/W05/W06 |
| AC04 | Form tạo một yêu cầu duy nhất, clarification trả bằng UI, không cần gõ chat | W02/W07 |
| AC05 | Đọc gói thiết kế/kết quả và duyệt/reject/changes_requested bằng nút, exact revision; gói mới làm review cũ stale | W02/W07 |
| AC06 | Resume đúng pendingAction; cancel phân biệt accepted/cancelling/stopped/uncertain; không tự retry mutation bất định | W02/W07 |
| AC07 | Chat và form/nút dùng cùng run; native terminal và web không duplicate authority; nudge không thành user input | W08 |
| AC08 | Reconnect/restart, double-click, hai tab và browser back không replay mutation sai | W02/W03/W05/W07/W09 |
| AC09 | Origin/Host/CSRF, project scope, secret redaction và artifact rendering được kiểm tra ở HTTP/browser boundary | W03/W05/W09 |
| AC10 | UI tiếng Việt, keyboard accessible, focus/error states, desktop 1440/1280 và tablet 768; không chỉ dùng màu thể hiện status | W06/W07/W08 |
| AC11 | Live smoke Herdr/provider cô lập chứng minh chat + direct approval/resume; full workflow nghiệm thu riêng có evidence | W08/W09 |
| AC12 | CLI run/approve/resume truyền thống không bị đổi semantics hoặc quảng cáo là host API | W00/W04/W09 |

## 8. Quyết định cần integration trước implementation

D-WEB-01 là decision cần owner/integrator chốt ở W00: additive web contracts, web provenance/receipt version và recovery, Conversation boundary extension, package exports/dependency/build wiring, exact command/DTO semantics. Owner đã duyệt hướng kiến trúc, chưa có schema/ADR được đóng băng. W00 phải lập decision có motivation, affected owners, compatibility/migration và approving owner; không tự ghi "approved".

Phạm vi docs: spec này và plan cùng ngày. Owner quyết định dùng docs/DESIGN.md và ui-ux-pro-max-skill để thiết kế UI trực tiếp; không cần prototype bên ngoài. docs/DESIGN.md do owner cung cấp, không tự ghi đè hoặc điền nội dung khi cập nhật plan. Không coi đây là quyền cho từng leaf agent sửa contracts/root files/shared docs khi implementation.


## 9. UX inventory và nguồn thiết kế

Visual design theo docs/DESIGN.md; agent UI đọc/áp dụng ui-ux-pro-max-skill thực tế có trong môi trường lúc implementation. Không coi chỉ nhắc tên skill là đã áp dụng. Nếu file design trống hoặc skill cần thiết chưa có, báo rõ gap, tiếp tục phần functional/backend độc lập và giữ visual acceptance pending; không tự điền design hay tuyên bố làm đúng tài liệu chưa có nội dung. Không cần chờ prototype/export ngoài.

Các màn hình và behavior sau thuộc scope sản phẩm, không phụ thuộc phong cách visual:

| Nhóm màn hình | Nội dung bắt buộc |
| --- | --- |
| Projects/first launch | Empty state, đăng ký absolute local Git path, duplicate/path/access errors, chọn project, readiness; không auto init/install/index |
| Project overview | Việc đang chạy, quyết định đang chờ, recent activity, session start/stop; tách browser connection khỏi host/provider readiness |
| Create/revise request | Title, request kind, objective, acceptance criteria, constraints, draft và submit; revise giữ current work context/criteria |
| Work list/detail | Search/filter/pagination, phase/tasks/blockers, plan, change summary/diff, verification evidence, artifacts, timeline, next action |
| Decision inbox/review | Clarification với options/free text, design/task/delivery review, version/evidence, approve/reject/changes_requested, reason; stale/expired/superseded states |
| Blocker/actions | Targeted remediation, resume đúng pendingAction, cancel confirmation, operation accepted/running/applied/failed/reconciliation_required |
| Optional chat | Conversation duy nhất, composer/draft, delivery state, cùng logical work lineage, decision cards link cùng review; pane output riêng read-only diagnostics |
| Project settings/diagnostics | Readiness/config summary, inspect/start/stop, external native-login remediation khi cần, sanitized technical detail; không secret dump/arbitrary shell/editor |

Navigation dùng tiếng Việt: Tổng quan, Công việc, Cần bạn quyết định, Trò chuyện, Cài đặt dự án; project switcher có Quản lý dự án. Không cloud login, team/billing UI hoặc nhiều tài khoản/role giả trong local single-user v1. Không hiển thị percent/ETA/cost chưa có bằng chứng. Gói review là phiên bản thiết kế/kết quả, không mặc định là gói cài đặt.

State coverage: loading, empty, session stopped, prerequisite missing, chat unsupported, disconnected/reconnecting, session expired, API unavailable, stale review, expired/superseded decision, verification failed/blocked/not_run, uncertain delivery/cancellation và completed có evidence. Khi offline giữ snapshot với nhãn stale và khóa mutation; reconnect không tự submit lại. Draft không bị runtime notices ghi đè. Main flow không đòi đọc raw IDs/JSON/tools/terminal.

Các luồng browser cần kiểm thử:
1. Thêm project -> readiness/start -> form request -> clarification -> design review/approve -> implementation/checks -> delivery review -> completed evidence.
2. Changes requested -> follow-up run trong cùng logical work -> old review stale -> review version hiện hành, giữ history.
3. Blocked -> remediation -> resume exact action -> operation acknowledgement -> trạng thái thực.
4. Cancel -> confirmation -> accepted -> stopping -> confirmed hoặc uncertain, không đồng nhất các trạng thái.
5. Chat cùng công việc -> decision card -> trả lời bằng review UI -> chat/detail đồng bộ trạng thái đã trả lời.
6. Mất kết nối giữa mutation và ACK -> reconnect/read operation -> hiển thị kết quả thực, không duplicate submission.
