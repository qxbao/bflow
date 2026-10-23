# @bflow/runtime

`RuntimeServiceImpl`, dispatcher, MVP orchestrator và workspace factory hiện có vẫn khả dụng.
P19 bổ sung `AgenticWorkflowRuntime`, `CoordinatorTools`,
`createAgenticConversationHost` và `openAgenticWorkspace` cho luồng SDLC v2.
Đây là các API composition cho host. `bflow up` vẫn quản lý môi trường P12/P13;
nó không tự động cài đặt tool plugin của model-provider hay khởi động daemon P19.

## Composition và thực thi

`openAgenticWorkspace(options)` mở một session P12/P13 hiện có đang chạy (up), xác thực
repository binding của nó, dùng RolePaneManager thực tế và Herdr CLI adapter,
rồi ghép Core, file Registry, SQLite RunStore, filesystem
ArtifactStore và các engine P14–P18 đã triển khai. Nó không tạo các permanent role trùng lặp.
Các lệnh Herdr dùng `HERDR_SESSION` riêng cho từng repository, xóa các ghi đè
định tuyến pane/socket được kế thừa theo cách giống P12. Preflight CLI/protocol chạy
trước khi mở tài nguyên bền vững hay cấp phát Developer.

Developer dùng platform launch phải có native session thực tế được lưu trong manifest và
đã kết thúc lượt startup trước khi cấp phát thành công, kể cả khi không có Gateway registration.
Runtime đối soát quan sát Herdr rồi trả binding hiện tại; outbox giữ assignment ở hàng đợi
trước khi lấy lease hoặc gọi transport nếu platform binding chưa có session. Handle đã được
chấp nhận mà thiếu session từ bản cũ vẫn bất biến và không được tự gắn session hay gửi lại;
trường hợp đó cần đối soát riêng, không phải bằng chứng tác vụ hoàn tất.

Với Node TAP hoàn chỉnh và đúng danh tính test, exception trong thân test không phải
assertion được lưu thành quan sát không được chấp nhận và gửi lại Developer để sửa test
theo giới hạn rework hiện có. Nó không phải bằng chứng Red và không cấp quyền sửa mã sản phẩm.
Output thiếu/sai danh tính, lỗi hook, timeout hoặc sandbox vẫn là lỗi hạ tầng cần đối soát.

Sau một explicit resume cho phase bị lỗi hạ tầng, Runtime gửi notice retry về đúng Developer
đang giữ execution; không yêu cầu Coordinator gọi công cụ chỉ dành cho Developer. Nếu host
ngừng quá TTL lease, Runtime chỉ cấp lease tiếp nối qua Registry sau khi đối chiếu native session,
worktree, capability và Core execution hiện tại. Fence phải tăng; assignment, request và handle
gốc giữ nguyên. Intent cấp lease và lịch sử lease riêng được lưu để replay đúng idempotency key
sau crash; tối đa ba lần tiếp nối cho một assignment. Human gate, cancellation, unknown delivery,
session bị thay hoặc không có native binding đều chặn đường này. Không có SQL/public-contract migration;
bản cũ không hỗ trợ tiếp nối phải đối soát thay vì gửi lại assignment.

Continuation tường minh sau một auto-resume có message ID riêng: receipt tự động không được
nuốt yêu cầu tiếp tục qua Conversation. Wake cũ và trạng thái delivery của nó giữ nguyên;
retry tường minh cùng blocker trả về receipt riêng, tính một lượt manual và giữ trạng thái
business đang chạy. Các fence diagnostic hiện hữu được đưa vào wake để đối soát; chúng
không phải ACK, phê duyệt hoặc quyền bỏ qua bằng chứng TDD. Không thay public contracts.

Quyết định tích hợp riêng cho lần live 2026-10-23: chủ dự án chọn giữ run và thêm fence cho
diagnostic cũ thay vì hủy run. Chỉ lệnh người dùng vật lý qua Conversation
`fence diagnostic <operation-id>` có thể hủy một `task.status: blocked` từ pane Coordinator
đã nghỉ, gửi tới Conversation, còn unknown và chưa có inbox/ACK. Không có model tool thực hiện
thao tác này. Intent gốc vẫn unknown, không được gửi lại; tombstone lưu người quyết định và
message ID của lượt người dùng, đồng thời từ chối mọi bản đến muộn trước khi đổi business state.
Assignment, result, approval và diagnostic từ pane hiện tại không được fence theo đường này.

Owner/compatibility: lựa chọn của chủ dự án trong vòng live này cho phép thêm fence diagnostic.
Chỉ Runtime host, Conversation intake và journal riêng của Runtime bị ảnh hưởng; callback
host tùy chọn mặc định từ chối, nên composition cũ không được cấp quyền fence ngầm.
Journal riêng của Runtime vẫn đọc v1; lần fence đầu tiên ghi v2 trong cùng
lần lưu tombstone. Binary cũ từ chối v2. Không upcast v1 thành bằng chứng fence; v1 có fence
bị từ chối. Shared `@bflow/contracts`, `RuntimeService`, Core event/checkpoint codecs và SQLite schema không đổi.
Không downgrade một session đã fence về binary cũ; giữ journal và dùng Runtime có hỗ trợ v2.

Retire một policy phase là quyết định riêng qua lệnh vật lý Conversation
`retire policy phase <request-id>`, không được suy diễn từ fence diagnostic, resume hoặc duyệt thiết kế.
Host chỉ chấp nhận request đã có blocker xác thực đúng verifier/correlation/causation, pane/native session verifier
đã thay, lease hết hạn và không có receipt kết quả cần đối soát hoặc phép đo đang chạy trong host.
Thiếu receipt không chứng minh phép đo chưa chạy: disposition là `retired_without_measurement_claim`.
Giữ nguyên request, handle, blocker và grant lease cũ; Registry không hỗ trợ release lease hết hạn,
nên không tạo receipt release giả. Tombstone được lưu trước khi loại request khỏi dispatch/renewal.
Mọi verification.result cũ, kể cả inbox received replay, bị từ chối. Chỉ sau resume vật lý được host xác thực qua Conversation (lưu đúng user message ID), Runtime thông báo
Developer hiện hữu yêu cầu đo cùng phase/revision bằng request ID mới; không gửi lại assignment.

Quyết định compatibility riêng cho sửa lỗi live: chỉ Runtime host/intake/outbox/journal thay đổi;
public contracts/Core codec/SQLite giữ nguyên. Journal đọc v1/v2 như trước, và ghi v3 khi retire phase.
Binary v1/v2 từ chối v3; không downgrade session đã retire. Fence diagnostic sau đó không hạ version.
Retirement được chặn bởi approval/user-decision/unknown delivery/cancellation và giới hạn riêng
`maxIterations` theo run/task/implementation-attempt/phase qua các revision. Replay không tiêu thêm lượt;
retirement không là measurement, Red hoặc repair failure, và không reset giới hạn verification/TDD.
Cancellation không release giả grant đã hết hạn của retirement; vẫn dừng Developer/Core bình thường và báo riêng outcome lịch sử chưa được xác nhận.
Quyền áp dụng từng retirement phải đến từ chủ dự án qua command vật lý chính xác; model không có tool cấp quyền.

Control client giới hạn phản hồi thông thường ở 4 MiB; riêng RPC `checkpoint` nhận tối đa
16 MiB để không mất acknowledgement của aggregate checkpoint đã lưu vượt 4 MiB.
Checkpoint lớn hơn vẫn bị từ chối và phải đối soát id/checksum đã lưu trước khi retry;
việc vượt giới hạn phản hồi không chứng minh thao tác ghi thất bại. Public checkpoint codec không đổi.

Khi phép đo bị từ chối, phản hồi QA trả đúng request/phase/revision, summary, loại repair và
ArtifactReference đã lưu nếu có, kể cả replay. `phaseRecorded: false` và `implementationAuthorized: false`
phân biệt outcome bị từ chối với bằng chứng TDD được chấp nhận; lifecycle status riêng không đủ
để kết luận thiếu output hoặc xin đo lại. Runtime vẫn giữ quyền điều phối repair/resume có giới hạn.

`assignment_context` đặt `policyEvidence` gọn trước dossier đầy đủ: receipt TDD đã được
Runtime chấp nhận tách khỏi outcome bị từ chối, giữ nguyên phase/revision/verification ID
và ArtifactReference/checksum. Chỉ xuất các run đã thuộc assignment hiện tại của pane;
không suy luận bằng chứng từ progress, transport state hay nội dung agent tự khai.

Sau resume vật lý qua Conversation, Runtime gửi một task notice tiếp nối riêng cho
Developer hiện hữu nếu cùng Core execution vẫn running, lease còn hiệu lực và required TDD
đã có đúng Red được chấp nhận. Notice không cấp Red hay approval mới và không sửa test;
retry cùng resume giữ nguyên ID. Các gate, cancellation, unknown delivery và giới hạn resume
được kiểm tra trước đó như cũ; resume tự động hoặc Coordinator không tạo notice này.

QA workflow sử dụng `inspect_review` để quan sát diff và chạy command do host đã cấu hình
trên đúng commit tích hợp. Kết quả test và ArtifactReference/checksum được lưu cùng observation
host bất biến, trả gọn qua `qaBehavioralObservation`; không dùng tool phase TDD cho gate này.
`complete_review` vẫn yêu cầu judgment độc lập cho từng criterion và không thể pass nếu test
thực tế thất bại. Observation diff-only cũ không được nâng thành bằng chứng test; phải inspect
lại qua host. Test tiếp tục chạy trong sandbox verification hiện hữu, không nhận argv/revision
hay output từ agent. Gate timeout/bounds/approval không đổi và không sinh thêm TDD receipt.
Tổng ngân sách setup/prepare/test được giới hạn theo thời gian gate còn lại, có margin cho ACK; chỉ giảm timeout tối đa, không đổi command/argv. Batch không còn đủ ngân sách bị từ chối trước execution. Completed submission replay xác thực receipt trước khi đọc worktree; completion đầu tiên vẫn kiểm tra source, kể cả sau restart.

Verification retry sau restart dựng plan bằng journal state được truyền tường minh trong
transaction, không phụ thuộc state tạm chỉ tồn tại trong `tick`. Implementer IDs được giữ
đúng từ execution gốc cho kiểm tra độc lập; commit tích hợp, task evidence và các giới hạn
retry/approval không đổi. Cùng đường này phục vụ explicit resume và `retry_verification`.

Gate retry tạo request ID mới sau một verdict đã áp dụng hoặc blocker `task.status: blocked`
được xác thực đúng request/run/correlation/agent/pane. Request cũ và outcome giữ nguyên;
không giả verdict hay ACK. Blocker có thể đến trước khi lease được release: lượt mới chỉ
được queue, còn Registry và kiểm tra pane vẫn chặn dispatch tới khi capacity sẵn sàng.
Sending/unknown delivery không được coi là một attempt đã đối soát; các giới hạn verification
và phê duyệt hiện hữu không đổi.

Các đầu vào host bắt buộc là tường minh: định danh repository/session, role capability,
định nghĩa check của task/workflow, deterministic gate runner, ingress thông điệp/result/evidence
Herdr có xác thực và phê duyệt của con người có xác thực. Không có
stub thành công cho production hay callback xác thực mặc định. Check ID của Review được
ghép thành `runtime.herdrQualityGate(id)`, hàm này gửi `verification.requested`
qua Herdr outbox bền vững và chờ một `review.verdict` có xác thực
chứa `QualityGateResult`. P17 xác minh quan sát của nó, revision chính xác,
ánh xạ criterion, tính độc lập và cửa sổ thực thi. Các deterministic gate phải là
host runner thật, được cô lập, cấu hình cho các check ID tương ứng.

Host dùng các interface được trả về như sau:

```ts
const host = await openAgenticWorkspace({
  repositoryPath, sessionId,
  taskChecks, workflowChecks, deterministicGates, roleCapabilities,
  authenticateMessage, authenticateResult, authenticateEvidence,
  authenticateGateResult, authorizeHuman,
  projectApprovalRequired
});

// Authenticated user interaction goes only to the actual P14 Conversation Gateway.
await host.conversation.handleUserTurn(userTurn);
await host.runtime.flushOutbound();

// A separate trusted inbound pump delivers envelopes AFTER physical Herdr receipt.
await host.runtime.receiveHerdr(coordinatorOrRuntimeEnvelope);
await host.conversation.receiveHerdr(conversationEnvelope);

// The Coordinator's provider host injects its principal; never read it from tool arguments.
await host.tools.invoke("propose_workflow", {
  runId, specification, definition, maxIterations: 3
}, { role: "coordinator" });
await host.tools.invoke("tick", {}, { role: "coordinator" });
```

Tool `tick` của Coordinator lên lịch công việc nền và trả về ngay lập tức.
Coordinator phải nhường lượt của mình thay vì polling khi pane của chính nó đang bận.
`tick_status` báo cáo lỗi scheduler của host; `CoordinatorTools.drain()` là một lần chờ
lifecycle của host, và `close()` drain các công việc do Coordinator lên lịch còn tồn đọng.
Inbound pump phải luôn khả dụng trong khi Runtime `tick()` chờ xác minh từ xa.
Không await một lượt agent từ bên trong mailbox handler của chính nó. Tiếp tục tick/drain
các thông điệp outbound độc lập với lượt của người dùng. Dừng lên lịch và hoàn tất các
thao tác host còn tồn đọng trước khi `host.close()` đóng các storage handle. Việc đăng ký prompt
và tool gốc của provider thuộc về trusted agent host; nạp
`agents/coordinator/system-prompt.md` vào pane Coordinator của nó.

Composition Conversation giữ nguyên việc lưu context của P14, correlation ID,
hàng đợi inbound bận, nguồn gốc phê duyệt và ủy quyền hủy. Trong persistent
host, Chat xác định ý định thông thường qua `conversation_decide`; Gateway
xác thực quyết định có cấu trúc và quản lý trạng thái bền vững cùng việc giao nhận.
Các phương thức delegation/approval outbound của nó xếp hàng qua P19. Lối tắt callback
progress/approval cục bộ của bridge cũ bị vô hiệu hóa trong composition này. Một
mục hàng đợi đã lưu chỉ xác nhận việc enqueue cục bộ, không phải việc nhận prompt từ xa.

Provider prompt ingress chấp nhận đúng một wrapper `pasted_content` hoàn chỉnh của provider
quanh một RoleMessage theo schema đã export. Nó vẫn yêu cầu đúng thông điệp Runtime outbox đã pin,
pane người nhận và native session trước khi có Herdr ingress đã ký; văn xuôi xung quanh,
nhiều wrapper và envelope bị thay đổi không thể tạo handoff đáng tin cậy.

Tool `send_role_message` công bố các trường của RoleMessage v2 và yêu cầu
`artifact_references` (dùng `[]` nếu chưa có artifact đã lưu). Native ingress còn yêu cầu
`idempotency_key` ổn định; host kiểm tra trước khi ghi native intent hoặc gọi plugin.
Host không tự thêm mảng artifact hoặc tạo khóa cho payload thiếu trường. Prompt của role
có ví dụ envelope đã được xác thực; `assess` và `propose_workflow` công bố các trường của
Specification v2, kể cả criterion `status`/`evidenceArtifactIds`. Các Zod contract vẫn xác
thực nghiêm ngặt và kiểm tra các ràng buộc giữa trường tại ingress.

Riêng `assess` yêu cầu impact assessment tường minh tại `specification.metadata.sdd.assessment`.
Một `Specification` hợp lệ theo shared contract vẫn có thể thiếu dữ liệu P15 này. Tool discovery
công bố các trường assessment; tool boundary và direct Runtime caller đều từ chối object thiếu
với schema path và hướng dẫn đọc `planning_reference(section="specification")`. Policy P15 được
nạp qua adapter vẫn xác thực các impact flags; Runtime không tự điền hoặc suy đoán chúng.
`assess` chỉ trả phân loại/gợi ý role, không sửa classification trong draft, duyệt spec, tạo DAG
hay dispatch. Khi chuẩn bị proposal, Coordinator phải cập nhật draft theo kết quả policy và giữ
nguyên các acceptance criteria đã được ủy quyền.

Native intent thiếu ACK giữ trạng thái uncertain và chặn gửi lại cùng operation.
`reconcile_delivery` chỉ đối soát Runtime outbox; chưa có API xác nhận `not_delivered`
cho native intent. ACK/application đến muộn có thể giải quyết trạng thái uncertain;
Runtime giữ riêng các native intent chưa xác nhận trong journal, kể cả khi run đã bị
schema blocker hoặc đang chờ phê duyệt. Host khôi phục các intent cũ trước khi tự resume;
resume, thay đổi yêu cầu và dispatch công việc mới phải chờ đối soát. Một ACK chỉ giải quyết
đúng intent của nó. Kết quả specialist đến muộn trong lúc pause chỉ được nhận nếu trùng
toàn bộ native intent và assignment đã bind; việc nhận này không resume hay phê duyệt run.
`resume_run` tiếp tục run hiện hữu, không xác nhận giao nhận hay cho phép resend.
`inspect_native_delivery(operationId)` của Coordinator/Conversation đối soát chỉ đọc native intent,
ACK, refusal trước admission và Runtime inbox. Tool này khác `reconcile_delivery` của transport outbox:
nó không gửi lại, resume, sửa criteria hoặc xác nhận task thành công. Intent cũ thiếu key nhưng không
có receipt từ chối vẫn là `unknown_delivery`; không tạo hồi tố bằng chứng `not_delivered` từ lỗi schema.
Signed native ingress lưu riêng refusal khi `idempotency_key` không hợp lệ trước khi gọi Runtime;
chữ ký sai và lỗi xảy ra sau admission không tạo loại bằng chứng này. Restart chỉ giải quyết intent
khớp refusal đã quan sát, giữ nguyên blocker nghiệp vụ và các human gate; không tự giao assignment mới.
Inbox `received` có xác thực là bằng chứng giao nhận bền vững, chưa phải kết quả nghiệp vụ được chấp nhận.
Khi run pause, outcome của execution đã bind được giữ ở `received` và phản hồi deferred; chỉ sau resume
mới chạy lại đầy đủ validator/gate để apply một lần. Báo cáo ACK cũ dùng cùng fingerprint cho phép thay
chữ ký binding của native host, nên không tạo lại intent đã nhận. Stop của specialist cũng được giữ riêng
theo execution ngay khi còn uncertainty; chỉ retry khi delivery đã rõ, capacity đã release và chưa có result.
`inspect` chỉ đọc journal, không tự restore Core hay chạy các thao tác recovery nghiệp vụ.
Inbox `rejected` sau admission cũng giải quyết đúng native intent đã nhận và bị từ chối; không giải quyết
nghĩa vụ trả kết quả của assignment hoặc cho phép gửi lại envelope đó. Native ingress vẫn kiểm tra đầy đủ
envelope, kể cả array `artifact_references` và key; producer mới có thể dùng `message_id` làm key ổn định
trước khi ghi intent. Không chuẩn hóa hoặc sửa lại intent cũ khi recovery. Retry verification tự động và
tường minh đều giữ guard đối với native uncertainty và outbox `sending`/`unknown_delivery`.
Watchdog phân biệt delivery `accepted`/`released`, thời điểm transport accepted và thời điểm
run ngừng có hoạt động; thông báo chứa role/pane/task/attempt. Cảnh báo hoặc resume không
phải bằng chứng cho phép tạo attempt mới. Stop phải khớp agent, native session và thời điểm.
Conversation nudge `[bflow]` không được dùng lại user turn trước đó để quyết định hoặc resume;
user turn thật tiếp theo có boundary riêng và vẫn phải được xử lý đúng một lần.
Các kiểm thử schema, host RPC và receipt ở đây là kiểm thử cục bộ, không phải nghiệm thu Herdr/provider live.

Host tương quan bền vững các quan sát prompt/Stop của Coordinator với đúng delegation
đó. Một lượt kết thúc mà không có phản hồi có cấu trúc tiếp theo sẽ xếp hàng một thông báo
tắc nghẽn có tương quan tới Conversation qua Herdr outbox hiện có. Điều này
cũng bao gồm một prompt đã giao mà Runtime ingress đã ký của nó chưa bao giờ được áp dụng.
Các baseline phản hồi riêng tư phân biệt các lượt trước đó; progress đã xếp hàng, phản hồi gốc
đang chờ và các quyết định bắt buộc của con người giữ nguyên trạng thái chờ hiện có. Thông báo
chỉ báo cáo phản hồi còn thiếu, không bao giờ là chẩn đoán provider hay kết quả task;
nó không tạo/replay ingress, không gửi lại delivery không chắc chắn, và không hoàn thành/làm fail một run.
Các đường này có test subprocess/fake-transport cục bộ và test Gateway thật, không có
bằng chứng nghiệm thu provider/Herdr live.

Các thông điệp outbox gửi tới Conversation không bao giờ được gõ vào ô nhập của Conversation. Lượt
outbox có khóa chỉ ghi chúng trước dưới dạng `sending` (không lease, không transport send); Runtime
sau đó áp dụng chúng trong cùng process vào Conversation Gateway (`deliverToConversation`) sau khi
nhả journal lock, vì Gateway có thể drain một lượt người dùng đang xếp hàng, và lượt đó enqueue ngược
vào Runtime. Gateway khử trùng lặp theo `message_id`, nên một lần giao bị lỗi hoặc gián đoạn được
xếp hàng lại và thử lại, kết thúc ở trạng thái terminal `delivered`. Mỗi thông điệp được áp dụng
được giữ như một notice bền vững (summary giới hạn 4096 ký tự) cho đến khi model đã
thấy nó: trong hook context của lượt người dùng kế tiếp, trong lý do `block` của Stop-hook, hoặc sau một
lần nhắc inbox `[bflow]` do host gõ. Inbox được kiểm tra mỗi 2 s (`BFLOW_INBOX_CHECK_MS`,
500 ms–30 s): nó hiển thị một thông báo Herdr và chỉ gửi lần nhắc khi Conversation
agent đang idle và ô nhập Claude của nó được xác minh là trống. Ô nhập được đọc dưới dạng ANSI để gợi ý
prompt kế tiếp mờ (SGR 2) của Claude được tính là trống trong khi bản nháp đã gõ thì không. Một
notice chưa hiển thị được nhắc lại sau 5/10/20/60 s; các provider khác và layout không nhận ra sẽ fail closed. Notice chỉ là bằng chứng
về việc giao nhận, không bao giờ là task thành công, và lần nhắc không bao giờ tạo lượt người dùng hay phê duyệt. Việc phát hiện
ô nhập trống, thông báo và tiếp tục Stop-hook chưa được xác minh live.

### Hiển thị notice của Conversation, notice từ chối và hang watchdog

- **Structured decision notices.** A user decision notice stores bounded fields (approval id, role,
  question up to 2000 characters, at most 10 options of 500 characters, deadline) beside the
  4096-character summary, so a long question stays answerable. Receipts written before this field
  still render from their summary, or degrade to a generic update that says it was cut short.
- **Display acknowledgement.** A surfaced user decision or block counts as displayed only when the
  final Conversation turn names it (its approval id). Undisplayed notices are re-blocked on Stop at
  most twice and re-shown with reminder backoff. Last assistant text is read back to the last
  genuine user prompt, skipping tool-result entries.
- **Rejected workflow proposals.** `propose_workflow` pre-checks (project policy, then verification
  support) return a structured error `{ code, reason, methods?, criteria?, options }` to the
  Coordinator. Runtime retains a validated private rejection record while allowing correction
  in the same turn. On Coordinator STOP, the rejection becomes a durable manual blocker;
  restart/watchdog do not retry the unchanged configuration. Explicit resumes retain the existing
  limits and delivery/approval fences, with a distinct idempotent action per recurrence.
  User-facing codes: `no_test_runner_detected` (unknown ecosystem found no
  supported runner; options: the Coordinator adds a setup task, or the run is cancelled), plus
  `unsupported_verification` and `policy_violation`; `missing_behavioral_runner` remains only for
  owner-configured runners. Coordinator-fixable codes are returned to the Coordinator as the tool error
  and are never sent to Conversation: `runner_setup_required` (a recognized ecosystem needs a reviewed runner/reporter setup task), `missing_test_paths` (no test file in `affectedPaths`),
  `missing_test_mapping` (missing or ambiguous identities, owned test scope, or task execution budget), `unknown_test_command` (a target
  command is not a detected label, or the label is missing from `infrastructure.commands`) and
  `unsupported_method` (no runner for the criterion's method) and `invalid_specification` (the specification,
  workflow definition or P16 `metadata.conditionalTdd` assessment fails its schema; the reason lists each invalid
  field by full path). The options are informational; nothing
  is applied automatically, and the specification and its criteria are never changed by Runtime.
  Whole-spec runner binding checks individual command budgets; before admitting a DAG, Runtime
  resolves each task's actual strategy and ownership, requires every automated criterion to bind,
  and enforces the aggregate 540s task budget. Detection and binding do not prove sandbox readiness
  or test success: independent execution and authenticated evidence remain required.
  Automatic detection is retried on each proposal while unsupported and refreshed after repository HEAD changes. Dynamic checks/gates use the same VerificationEngine when each plan is frozen, so no host restart is needed.
  An owner-configured runner (`.bflow/verification.json`, optional override) is pinned when the host is
  created (`docs/verification-runners.md`), so changing that file later requires quiescing the host.
- **Hang watchdog** (`src/agentic/run-watchdog.ts`, pure `evaluateWatchdog`; host timer every 15 s).
  It (a) recreates a pending user decision's notice receipt from the pending request when none exists,
  after 60 seconds, then re-registers with Conversation; (b) resurfaces a user decision that stays
  undisplayed for 60 seconds, at most three times, after which one `workflow_blocked` notice is emitted
  per approval; (c) reports a live run as `run_stalled` once per episode, when it has no pending
  decision, human gate or non-terminal handoff, every role pane is `idle`, `done` or `unknown`, and
  there has been no non-Conversation activity for 180 seconds. A Herdr `done` or `idle` means only
  "not working", never success. Activity is the `occurred_at` of non-Conversation messages for the run,
  falling back to the delegation time. Limits: an unreadable pane is treated as working, and a design
  approval that never reached Conversation is not reconciled by the watchdog. Resurfacing counts
  unsurfaced notices as well, so a busy Conversation pane can reach the blocked notice.
- **Not live-verified.** The host timer, the Herdr notifications and the Stop-hook display acknowledgement
  depend on a live Herdr and Claude Code session. Tests cover the pure logic, the receipt epochs, the Runtime
  reports and the Gateway wiring with a fake transport; the host closure itself is only type-checked.

## Policy và vòng đời

Coordinator có thể đánh giá yêu cầu, chỉ yêu cầu các specialist hữu ích, tự chuẩn bị
specification/DAG, hoặc yêu cầu chuyên môn Analyst/Architect/Planner qua
Herdr. Không có chuỗi role cố định. DAG triển khai hiện chứa các node
Developer; công việc chuẩn bị/chuyên gia chỉ đọc dùng `request_specialist`.
Không có tool thay đổi đồ thị tùy ý hay sửa source nào được expose cho Coordinator.

`proposeWorkflow` xác thực các schema Specification/WorkflowDefinition đã đóng băng thực tế,
chính sách tác động và traceability của P15, giữ nguyên các criterion được ủy quyền, kiểm tra
quyền sở hữu đường dẫn literal và yêu cầu các dependency thành công. P16 phân giải
workflow và các strategy theo từng task; P15 lưu/review các dossier bất biến. Các specification
đầu vào đầy đủ bao gồm các trường design, security, rollback, decision và
strategy bắt buộc. `metadata.conditionalTdd` của task có thể cung cấp một đánh giá cụ thể;
nếu không, đánh giá tổng thể được chuyên biệt hóa cho task ID đó. Việc chấp nhận spec rủi ro thấp
là tự động chỉ khi P15 và project policy cho phép. Design phức tạp
và các phê duyệt triển khai do dự án bắt buộc quay lại Conversation. Một approval
ràng buộc toàn bộ bundle dossier; các quyết định spec nội bộ giữ bundle ID đó.

Kết quả verification của các task song song chờ bền vững phía sau phê duyệt task của con người
đang hoạt động. Chúng tiếp tục sau quyết định đó, kể cả qua restart; một
outcome muộn hơn không thể thay thế approval đang hoạt động hay làm sống lại một run bị từ chối.

Mọi task Developer đều nêu `metadata.ownedPaths` (các prefix repository literal), với
`forbiddenPaths` và `requiredCapabilities` tùy chọn. Các định nghĩa gate do agent kiểm soát
bị từ chối: các check dự án đáng tin cậy được cấu hình qua `taskChecks` và
`workflowChecks`. `requiresApproval` của task cũng được thực thi trước khi các task phụ thuộc
được chạy. Việc người dùng từ chối dừng việc lên lịch tiếp. Các thao tác hủy hoại, merge
protected branch, deployment và thay đổi secret/quyền truy cập không có tool thực thi trong
Runtime này, nên một approval không liên quan không thể cấp các capability đó.

Core sở hữu DAG/concurrency và các chuyển đổi hợp lệ. Runtime ràng buộc pane ID thực tế,
capability, lease và fencing token, lưu transport intent, rồi dispatch
các assignment `RoleMessage` qua Herdr. Cần một lần gia hạn Registry hiện hành
ngay trước khi gửi và trước khi chấp nhận một implementation result mang tính kết luận.
Các lease Developer đã được chấp nhận được gia hạn ở các tick tiếp theo. Chạy scheduler thường xuyên hơn
TTL lease năm phút; một lease hết hạn/cũ đòi hỏi reconcile tường minh, không phải giả định đã gia hạn.

TDD bắt buộc cần Red độc lập trước `authorize_implementation`, tiếp theo là
bằng chứng Green/Refactor được P16 xác thực. `not_applicable` vẫn cần bằng chứng thay thế.
Thiếu bằng chứng policy sẽ giữ task lại và báo cáo nghĩa vụ còn thiếu.
Host phải thực thi ranh giới capability ghi và xác thực các phép đo;
chỉ prompt không thể ràng buộc quyền OS của agent. Việc chấp nhận P17 cũng yêu cầu
các check độc lập thực tế. Hoạt động terminal có xác thực không phải là nguồn gốc của phép đo,
và bằng chứng hợp lệ về schema không phải là chứng minh cô lập vật lý.

Một Developer result thành công đã xác minh chờ phía sau một completion gate độc lập bắt buộc.
Runtime chỉ nhả writer allocation của nó sau khi có pane sẵn sàng, khớp và các
kiểm tra clean-worktree của P13, rồi thu thập change set P18 thực tế. P17 xác minh
ngoài Runtime journal lock, cho phép phản hồi của Reviewer và việc hủy
đến được. Các lỗi check/review đã biết có thể kích hoạt các lần sửa Developer có phạm vi;
số iteration tối đa, outcome inconclusive/blocked và các lần thử triển khai đã cạn
sẽ escalate. Verification plan giữ đóng băng qua các lần sửa. Runtime cũng từ chối
bằng chứng gate nêu tên bất kỳ implementer workflow thực tế nào, kể cả các Developer
được cấp phát sau khi plan đã đóng băng. Trusted host phải xác thực các
định danh này và loại các alias của implementer khỏi thẩm quyền reviewer.

Metadata gate tùy chọn `boundedVerificationRetry: true` của Core chỉ bật retry
cho một gate `before_completion` độc lập bắt buộc bị fail trên một attempt thành công
đã được xác minh trước đó. Live execution và authoritative event replay thực thi cùng
các giới hạn và lịch retry. Các workflow thông thường giữ hành vi gate trước đây.
Không thay đổi shared schema, migration, event shape hay method signature nào. Retry triển khai
và sửa verification dùng chung ngân sách attempt hữu hạn của task, trong khi P17
giới hạn riêng các iteration verification thực tế.

Sau task verification, P18 tích hợp các branch đã pin theo thứ tự dependency vào một
integration branch riêng. Xung đột bảo toàn công việc và escalate; các giải quyết có phạm vi
đã commit có thể được xác nhận bằng `accept_conflict_resolution`. Runtime thu thập
Git diff tích hợp hoàn chỉnh thực tế, bao gồm các commit merge/resolution, lưu
patch của nó qua ArtifactStore, và gọi P17 với phạm vi workflow và nguồn gốc
tích hợp chính xác. Kết quả task không bao giờ thay thế kiểm tra này. Workflow-level
failure escalate để có một kế hoạch sửa có phạm vi tường minh/ủy quyền mới đã được chấp nhận;
Runtime không ngầm thay đổi một đồ thị đã duyệt để sửa một revision đã tích hợp.
Workflow verification thành công được ghi ngược lại vào P18. Delivery vẫn cần phê duyệt
của con người, bằng chứng đọc được và một lần kiểm tra mới revision tích hợp đã pin, sạch.
Progress envelope cuối cùng của Conversation mang completion và evidence đã xác minh.

## Độ bền và khôi phục

Trạng thái riêng tư của host/provider/runtime thông thường nằm dưới `.bflow/state`.
Trước khi tạo credential, Runtime thăm dò xem filesystem của repository đó có thực sự
thực thi được file `0600` và thư mục `0700` hay không. Trên các mount không thể (ví dụ
NTFS/FUSE với quyền cố định `0777`), nó tự động dùng
`$XDG_STATE_HOME/bflow/repositories/<sha256(canonical-repository-path)>/state`, hoặc
`~/.local/state/bflow/repositories/<hash>/state` khi `XDG_STATE_HOME` chưa đặt hoặc là
đường dẫn tương đối. Vị trí state của người dùng và các thư mục cha của nó phải qua kiểm tra
ownership, symlink và quyền. Runtime không bao giờ nới lỏng việc xác thực file riêng tư.

Credential của host, khóa ký, vật liệu launch của provider, platform state, SQLite,
artifact và journal P19 dùng vị trí đã chọn một cách nhất quán qua
khởi động, kích hoạt, truy vấn và shutdown/recovery. Một locator
`.bflow/state/private-runtime-state.json` không bí mật, được xác thực schema, pin thẩm quyền bên ngoài
trước khi credential được tạo, kể cả qua các thay đổi XDG và thay đổi hỗ trợ
quyền của repository. Storage được pin bị thiếu/không hợp lệ sẽ chặn khởi động thay vì
tạo state thay thế. Việc công bố locator và config host ban đầu là nguyên tử
và độc quyền; các reader khởi động đồng thời không bao giờ đọc JSON dở dang. Cấu hình repository,
lifecycle lock/receipt và manifest pane P13 giữ nguyên đường dẫn và định danh session hiện có.
`bflow doctor` báo cáo vị trí Runtime riêng tư đã chọn.
Một `host.json` cũ không dùng còn lại từ lỗi quyền riêng tư ban đầu được bảo tồn và
token bị lộ của nó không bao giờ được sao chép hay tái sử dụng. Quyền sở hữu host hiện có/các file host khác,
endpoint chưa ràng buộc, agentic storage hoặc platform state sẽ chặn việc tự động di dời và
đòi hỏi reconcile; Runtime không âm thầm migrate thẩm quyền recovery.
Một config không dùng được giữ lại có thể nêu tên cùng socket ổn định hiện do private host đã pin
phục vụ. Nó không chặn việc mở lại khi cả hai config khớp đúng
repository/session và socket, thư mục legacy khớp vị trí gốc của nó,
và private host dùng một credential khác. Các binding lạ, credential bị sao chép/lộ
và endpoint không có thẩm quyền riêng tư được pin vẫn chặn recovery.
Hành vi này không di dời cấu hình lưu trữ Runtime legacy tường minh và không
tuyên bố nghiệm thu provider/Herdr trên mọi filesystem.

Một workflow Reviewer đã nhận request chắc chắn nhưng chưa có verdict có thể được thay
bằng đúng một invocation read-only mới sau lệnh vật lý `replace workflow review <message-id>`
qua Conversation. Lệnh này cần quyền riêng của người dùng; resume/design/task/delivery approval
không cấp quyền đó. Chỉ áp dụng trên workflow có các task đã kiểm chứng, writer đã release,
Core task succeeded, TDD evidence đầy đủ và commit/spec tích hợp không đổi. Các gate và
unknown delivery vẫn chặn; số lần thay bị giới hạn theo maxIterations, không reset counter.

Quyết định lưu marker private journal **v4** trước khi ngừng waiter cục bộ. Binary cũ phải từ
chối v4; marker không sửa request/handle/status gốc, không khẳng định provider đã dừng hoặc
review cũ đã/chưa xảy ra và không tạo ACK/verdict. Mọi ingress/replay theo causation gốc và
completion từ observation cũ đều bị fence. Invocation mới dùng đúng context/capability, có
request ID liên kết riêng, chỉ dispatch tới native Reviewer read-only khác qua preflight/lease
hiện hữu. Request mới chưa rõ delivery không được gửi lại qua restart. Đây là bảo đảm từ
source và kiểm thử hồi quy cục bộ; không tự chứng minh một run live đã hoàn tất.

Journal P19 riêng tư nằm dưới `<selected-state>/agentic/journal`. Nó
dùng tuần tự hóa trong cùng process cộng với `flock` của Linux, fsync file, rename nguyên tử và
fsync thư mục. Nó bị ràng buộc với repository và từ chối state hỏng/không được hỗ trợ.
Nó không phải kênh giao tiếp ArtifactStore. Mọi việc giao agent thực tế đều dùng
Herdr; journal lưu trạng thái scheduling/outbox/inbox và receipt.

Message ID và idempotency key từ chối việc tái sử dụng với payload xung đột. Người nhận bận
vẫn nằm trong hàng đợi mà không chặn các pane khác. Dispatch intent đi trước transport;
`sending` sau crash trở thành `unknown_delivery`. Timeout, lỗi transport bị ném
và receipt sai định dạng không bao giờ chứng minh không được giao. Chỉ reconcile tường minh với
`not_delivered` mới cho phép gửi lại đúng AgentRequest gốc. Một pane, fingerprint
của request hay lease bị thay đổi không bị âm thầm thay thế. Các thông điệp mơ hồ giữ
lease và không tự động gửi lại qua restart.

Các Core event batch được journal trước khi SQLite append và được retry idempotent.
Aggregate checkpoint được giữ lại; authoritative complete event replay khôi phục
trạng thái approval, retry, gate và cancellation. Projection RunStore được duy trì
không được dùng thay thế aggregate. Các outcome P17 đã hoàn thành có một
application journal write-ahead, nên lỗi SQLite có thể khôi phục outcome mà không chạy lại
check. Nếu việc thực thi bị gián đoạn trước khi outcome đó đến Runtime journal,
cờ pending của nó đòi hỏi host reconcile tường minh với receipt đã lưu của P17;
Runtime không tự động bắt đầu một lần thực thi verification khác.

Hủy lưu intent trước các interrupt, từ chối các task assignment mới,
hủy các lần chờ verification cục bộ, và giữ lại worktree/binding không chắc chắn. Một
interrupt được chấp nhận không phải là xác nhận đã dừng. Core có thể ở trạng thái `cancelling` trong khi miền SDLC
ghi nhận intent hủy. Verification muộn không thể làm sống lại run đó. Không tự động
dọn dẹp mang tính hủy hoại, protected merge, remote push hay production deploy nào được thực hiện.
Một Registry mutation đã được xác nhận trước khi một lần ghi journal cục bộ bị mất cũng có thể
đòi hỏi host reconcile idempotency receipt đã lưu của nó; Runtime dừng khi gặp
lỗi stale-version/fingerprint và không giả định mutation đó đã được rollback.
Các giả định Linux/filesystem cục bộ vẫn giữ nguyên; không bổ sung đảm bảo network-filesystem, same-user thù địch,
multi-host hay power-loss. P02-RA01/P03-RA01 hiện có vẫn mở.

## Receipt host Herdr có xác thực

Label release CLI là metadata chẩn đoán. Khởi tạo thăm dò protocol 22 /
schema 1 và mỗi thao tác xác thực phản hồi của nó. Không có allowlist release
hay cờ bypass phiên bản. Một phiên bản đã cài đặt được kiểm thử trực tiếp; chỉ sự không tương thích
wire thực tế mới là căn cứ để từ chối.

Submission handle của CLI vẫn chưa được xác minh và bất biến. ADR 0003, được chủ dự án
phê duyệt, bổ sung `AuthenticatedWorkflowEngine.verifyAgentBinding` và một
RoleMessage `execution.receipt`. Runtime xác thực sender/assignment và
lease của nó, ingest receipt đã ký canonical qua ArtifactStore, và ghi
Core proof event trước khi chấp nhận một result có tương quan. Core xác minh Ed25519
dựa trên `bindingReceiptKeys`, handle/target/session gốc chính xác và hash của receipt;
issuer không xác định, chữ ký giả mạo, proof xung đột và execution đã hủy/terminal
bị từ chối. Các handle cũ chưa xác minh không có proof vẫn không thể thành công.

Native plugin là `agents/coordinator/herdr-receipts/herdr-plugin.toml`. Action
`deliver` của nó nhận RoleMessage có cấu trúc trong invocation context của Herdr,
xác thực sender dựa trên manifest P13 của host, và với binding receipt
kiểm tra lại agent/session Herdr thực tế trước khi ký. Nó chuyển tiếp RoleMessage đã ký
tới ingress của Runtime host. Không có terminal snapshot nào được nâng thành
proof. Một binding đã ký xác nhận request; P17 vẫn xác minh độc lập
việc triển khai. Các callback xác thực phép đo của host/phê duyệt của người dùng vẫn
bắt buộc và không được thay bằng các hàm thành công vô điều kiện.

Cấu hình khóa công khai của issuer đáng tin cậy qua `bindingReceiptKeys` trên
Core engine hoặc `openAgenticWorkspace`. Đặt `nativeIngressSocket` để bật native
host adapter. Liên kết plugin qua cùng session Herdr có tên. Trong thư mục config
do Herdr tạo của plugin, tạo một `host.json` riêng tư:

```json
{
  "issuerId": "project-native-host",
  "privateKeyFile": "/private/native-host-key.pem",
  "runtimeSocket": "/short/path/bflow-ingress.sock",
  "manifestFile": "/project/.bflow/state/panes/session.manifest.json"
}
```

Khóa ký phải là một file khóa Ed25519 riêng tư thông thường, ngoài source control
và model prompt. Khóa công khai được cấu hình trong Core phải khớp issuer của nó. Việc ký
của native host không phải là tool hướng tới agent/model. Hạn chế quyền truy cập plugin/config như
một phần của ranh giới host cục bộ đáng tin cậy; không tuyên bố cô lập same-user thù địch.

Gọi action bằng Herdr API đã cài đặt `plugin.action.invoke`, với
`plugin_id: "bflow.receipts"`, `action_id: "deliver"`, và invocation context
chứa `selected_text` (JSON RoleMessage), `focused_pane_id`, `workspace_id`
và `correlation_id` bằng message ID của assignment. Payload `execution.receipt`
mang handle gốc và thời điểm quan sát; host chọn issuer và transport correlation của nó
và thay chữ ký đầu vào. Các xác nhận bị mất vẫn đòi hỏi reconcile; không bao giờ retry mù quáng một body đã bị thay đổi.

Handle bất biến nằm trong `agent.execution_bound`; `agent.binding_verified`
và command receipt của nó dùng event envelope v2. Các aggregate mang receipt dùng
aggregate codec v2. Các run cũ vẫn đọc được và không có bằng chứng bị bịa ra;
reader cũ từ chối event/codec mới thay vì đoán. Bố cục lưu trữ SQLite
không đổi. Giữ sẵn các khóa công khai lịch sử của issuer cho authoritative replay.

Các smoke test native transport cố ý dùng một custom host process và
Herdr plugin thật, không có model/provider. Trên binary 0.9.5 đã cài đặt, custom
actor đó không có `agent_session` gốc nào được expose và chưa sẵn sàng cho các prompt agent
thông thường; việc giao prompt của nó vẫn chưa xác minh/không chắc chắn. Smoke xác minh
khởi tạo protocol và việc giao RoleMessage có cấu trúc đã ký qua
plugin, không phải attestation binding thành công cho custom actor đó. Các
binding receipt không có session bị từ chối; việc chấp nhận signing/Core/checkpoint được bao phủ trong
các integration test riêng. Các tích hợp agent chính thức phải cung cấp
định danh native session thực tế của chúng cho receipt attestation. Việc chúng pass không thiết lập được việc triển khai
do AI sinh ra live, review model độc lập hay một delivery SDLC đầy đủ.
Host cục bộ mặc định được expose qua `ensureAgenticHost`. Nó khởi động một
process tách rời trước khi launch provider và chuẩn bị cài đặt MCP theo role và Claude hook.
Kích hoạt yêu cầu manifest `up` đầy đủ và các receipt SessionStart gốc khớp,
bao gồm session locator `herdr:claude` thực tế của Herdr.
Các pane provider trần legacy phải được dừng/tạo lại; chỉ tên process
không thiết lập được một role đã cấu hình. Scheduler của host và inbound Herdr prompt
pump chạy độc lập với các lượt model. `close()` ngắt kết nối một CLI client;
`quiesce()`, `checkpoint()` aggregate và `shutdown()` là các thao tác lifecycle
riêng biệt. Shutdown yêu cầu server Herdr có tên đã dừng. Công việc thất bại hoặc
không chắc chắn giữ lại worktree của nó và đòi hỏi reconcile.

Host `prepare(options)` chấp nhận lifecycle deadline, timeout và cancellation
signal. Việc chuẩn bị provider dùng deadline đó thay vì timeout control RPC mặc định
ngắn. Một lần chuẩn bị bị ngắt kết nối sẽ bị hủy; quiesce và shutdown
chờ nó drain trước khi nhả các launch registration. Không lần chuẩn bị hết hạn hay bị hủy nào
cho phép launch pane. Chuẩn bị độc lập không có option bị
giới hạn mười phút; khởi động CLI cung cấp ngân sách cấu hình còn lại của nó.
`openPersistedAgenticHost` mở lại một host cho shutdown/recovery bằng platform,
policy và behavioral authority đã lưu; nó không yêu cầu thay đổi cấu hình.
Khi thử lại một lần khởi động đang chờ trong cùng daemon, host kiểm tra lại profile,
binary/config, skill đã pin, Gateway và preflight nhưng giữ nguyên generation, launch
và token; cổng activated health cuối cùng vẫn bắt buộc. Không phục hồi cache launch
qua daemon restart, và không tự đổi launch khi material đã hết hạn hoặc bị drift.
Yêu cầu sửa đổi từ Conversation được gắn vào run ngay khi host tiếp nhận vào outbox,
trước khi chuyển tới Coordinator. Việc này không tạo receipt Herdr nhận lại hay
phê duyệt thiết kế; replay cùng revision giữ nguyên lịch sử và các cổng human.
Các quan sát provider của permanent role chạy tối đa ba cái cùng lúc, sau khi chuẩn bị
tuần tự environment/skills/Gateway. Mỗi provider subprocess nhận
cancellation signal của thao tác và deadline còn lại; việc chuẩn bị launch
vẫn chờ tất cả verdict preflight bắt buộc.

Entrypoint stdio MCP chỉ expose các tool orchestration cho Coordinator, và
việc ủy quyền/nộp triển khai chỉ cho Developer. Bằng chứng thay thế của Tester/QA
và verdict của Reviewer/QA gắn với các diff đã commit chính xác do host thu thập
và các criterion đã chấp nhận. Xác thực của host so sánh các receipt chính xác đã phát hành;
các cờ `independentExecution` hay approval do model cung cấp không cấp thẩm quyền nào. Các
thông điệp role gốc vẫn đi qua Herdr plugin thực tế; control socket
mang các thao tác của host, thay vì giao assignment giữa các agent.

Cấu hình verification mặc định hỗ trợ tài liệu (`.md`, `.txt`,
`.rst`) với acceptance criterion thủ công. Nó chạy `git diff --check` trên các revision
task và tích hợp chính xác, yêu cầu phán đoán độc lập của Reviewer và QA,
và yêu cầu bằng chứng thay thế của Tester/QA trước khi chấp nhận task. Kiểm tra toàn vẹn Git này
không thiết lập hành vi ứng dụng tùy ý. Các thay đổi hành vi và TDD bắt buộc
cần các measurement runner được cấu hình và fail closed trong host mặc định.
Delivery và các phê duyệt do dự án bắt buộc vẫn là quyết định của con người;
chính sách specification rủi ro thấp đã duyệt có thể chấp nhận một lightweight spec.

Chỉ hook UserPromptSubmit cục bộ theo launch của Conversation ghi lại các lượt raw của người dùng
đã xác thực, ràng buộc với pane/native session chính xác của chúng và một message ID bền vững. Hook
trả về ID đó và context Conversation có giới hạn (session, quyết định đang chờ, workflow và 20 thông điệp mới nhất không kèm metadata) cho Chat. Chat nộp một quyết định có cấu trúc
`conversation_decide`; Runtime chèn nội dung gốc và nguồn gốc đã lưu,
xác thực các tham chiếu trạng thái, và gọi Gateway. Lượt không xác định/cũ,
principal bị thay đổi và quyết định xung đột bị từ chối. Các quyết định đã hoàn thành replay
kết quả bền vững của chúng; xác nhận FIFO vẫn pending cho đến khi Gateway xử lý
lượt đó. Các quyết định bị gián đoạn giữ timestamp và ID ổn định cho việc reconcile Gateway/outbox,
kể cả khi một lượt người dùng thông thường mới hơn đã đến. Conversation không thể bypass điều này bằng một
`delegation.request` trực tiếp qua `send_role_message`.

Các phản hồi phê duyệt của con người thực tế đang chờ vẫn nằm trên đường hook đáng tin cậy.
Schema quyết định của Chat loại trừ các phản hồi approval. Các lần giao RoleMessage Runtime
chính xác được xử lý như transport, và các role envelope không thể trở thành văn bản phê duyệt
của con người. Không có MCP tool nào phê duyệt thay mặt người dùng. Khóa/cấu hình riêng tư của host và Unix
socket có quyền chỉ owner. Kích hoạt yêu cầu một native Bflow
launch receipt chính xác; các pane cũ không có host hook không bị âm thầm tiếp nhận. Đây là các kiểm soát tin cậy host
cục bộ, không phải cô lập OS same-user thù địch. Launch provider live, ràng buộc native-session,
role-message receipt, triển khai task và delivery cuối là các mảnh
bằng chứng riêng biệt; chỉ riêng host test cục bộ không chứng minh một lần chạy SDLC live đầy đủ.

## Validation

Build trước các test có mục tiêu, vì chúng ghép các implementation `dist` của package thật:

```sh
pnpm build
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test packages/core/test
pnpm check:deps
pnpm typecheck
TMPDIR=/tmp pnpm test
git diff --check
git status --short
```

Các test P19 dùng Core/Registry/SQLite/ArtifactStore/P15/P16/P17/P18 thật và các
Git repository tạm thời thật, với pane vật lý/Herdr transport giả lập và các check runner
độc lập được inject. Chúng xác minh composition/policy. Các native transport test opt-in riêng thực thi
Herdr plugin/giao chữ ký thực tế, không tuyên bố hành vi AI live hay
live binding attestation cho một custom host không có định danh session. `TMPDIR=/tmp` tránh giới hạn độ dài đường dẫn Unix-domain-socket trong một
fixture POSIX ArtifactStore hiện có dưới đường dẫn temp mặc định dài của môi trường này.

Một lần cài đặt sạch, cô lập cũng làm lộ việc P14 import Zod trực tiếp mà thiếu
dependency trong manifest. Sửa tích hợp chỉ thêm `zod` vào manifest của package đó
và importer trong lockfile; không thay đổi implementation P14 hay shared contract nào.

Để thực thi binary đã cài đặt trong một session có tên tạm thời, sau khi build:

```sh
BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1
```

Test này sở hữu các đường dẫn XDG/socket ngắn và cấu hình shell riêng, đăng ký một
custom native host process (không phải AI model), và chỉ dừng session test của chính nó.

## Khôi phục session, quản lý context, observability và resilience

### Activity log của task

Runtime ghi một JSONL activity log tại `task-activity.jsonl` trong private Runtime state đã được resolve (thường là `.bflow/state/agentic/task-activity.jsonl`; khi workspace cần state riêng tư bên ngoài repo, dùng vị trí private được pin thay thế). Retention mặc định giữ tối đa 1000 entries và 512 KiB. Log giữ các milestone đã quan sát như admission, thay đổi trạng thái, assignment, verification, approval và kết quả agent đã xác thực. Đây là bản ghi chẩn đoán có giới hạn; nó không lưu prompt, argv, tool input/output hay private model reasoning. Terminal output và nhãn transport vẫn là dữ liệu không tin cậy; Herdr `done` không chứng minh task thành công.

Trong một host đã activate, pane `task-log` hiển thị các dòng mới nhất trong tab Logs. Các role có thể gọi `read_task_log`; Conversation và Coordinator đọc theo session/run, còn specialist phải lọc theo run/task được giao. `log_task_step` ghi một dòng tiến độ ngắn gắn với assignment hiện tại. Các dòng tự báo cáo và log không phải approval, receipt hay verification evidence. Nội dung đã được redaction, chuẩn hóa một dòng, giới hạn kích thước/dung lượng; lỗi ghi log không làm thay đổi kết quả nghiệp vụ.

Lỗi `assess` ghi diagnostic có schema path đã biết và hướng dẫn `planning_reference` thay vì chỉ tên `Error`;
viewer giữ tối đa 120 ký tự outcome. Không ghi tool arguments. Các pha chưa chạy không có
bằng chứng từ log: intake/planning/blockage không chứng minh implementation, verification
hay review đã hoàn tất. Milestone riêng cho thay đổi `run.workflowCycle` hiện chưa được ghi
(khác với task verification cycle); cần bổ sung và kiểm thử trước khi khẳng định log bao phủ
đầy đủ vòng verification/rework cấp workflow.

Viewer đọc đủ snapshot trong giới hạn lưu trữ, giữ các lần xuất hiện lặp và không phát lại lịch sử khi file được thay thế nguyên tử. Bản ghi mới có ID riêng; khóa lọc theo run/task gốc được giữ riêng với chuỗi hiển thị đã rút gọn hoặc redaction. Khi Herdr khởi động lại và dùng lại pane ID cho terminal khác, Runtime bỏ binding cũ và tạo pane log mới, giữ nguyên terminal thay thế. Việc đóng pane yêu cầu process-info khớp đúng pane và chỉ có tiến trình viewer dự kiến ở foreground.

`@bflow/runtime` cũng export các dịch vụ độ tin cậy cục bộ tùy chọn cho các repository thật:

- **Session Recovery (`SessionRecoveryService`)**: Phân biệt `graceful_shutdown`, `crash` và `transient_disconnect` qua `bflow down` / `bflow up`; flush và khử trùng lặp state của `AgenticJournal` và SQLite `RunStore`; khôi phục các run chưa hoàn tất từ aggregate checkpoint cộng event tail; reconcile SQLite với các pane/role Herdr để phát hiện các sai lệch `agent_lost`, `agent_replaced` và `orphan_agent`; thu hồi lease cũ; kiểm tra Git worktree/commit mà không dùng lệnh hủy hoại; cấm gửi lại prompt mù quáng khi lần thực thi trước không chắc chắn (`unknown_delivery` hoặc worktree bị sửa); và không bao giờ đánh dấu task succeeded khi không có `AgentResult` có tương quan, đã xác minh và các gate đạt.
- **Context Management (`ProjectContextService`)**: Phân tích cấu trúc repository và workspace package mà không cần vector database, đọc tài liệu dự án và chỉ dẫn role, lưu và truy vấn architectural decision record (ADR), chọn tất định các file liên quan đến task trong ngân sách byte/file nghiêm ngặt, theo dõi phiên bản `Specification` và `ArtifactReference`, chuẩn bị các context bundle có giới hạn theo role với việc scrub secret, và phát hiện context/spec drift qua các lần restart.
- **Observability (`ObservabilityTracker`)**: Theo dõi thời lượng run, thời lượng theo task và theo attempt, agent assignment, verification cycle, số lần retry/rework, các episode thời gian blocked, tỷ lệ test pass/fail, kích thước context bundle, và metric token/chi phí model đã xác minh chỉ khi `source: "provider_reported"` (không bao giờ ước lượng token hay chi phí khi không có telemetry của provider).
- **Resilience (`BoundedConcurrencyLimiter`, `StructuredLogger`, `redactSecrets`, `executeWithRetry`, `withOperationTimeout`)**: Cung cấp bounded concurrency với drain barrier `quiesce()`, structured JSONL logging với tự động redact secret (bảo tồn các định danh miền như `fencingToken` và bộ đếm token), và các helper backoff/timeout chặn tự động retry khi `unknown_delivery` cho đến khi reconcile hoàn tất.

Các dịch vụ này là các building block được export; `openAgenticWorkspace` và CLI không
tự động ghép context service, structured logger hay observability
tracker. Stdout/stderr Herdr nền của CLI nay đi qua một relay redact theo dòng
tách rời, có giới hạn; chẩn đoán của host cũng scrub các dạng secret đã biết. Redaction nhận diện các pattern đã cấu hình
và các dạng credential dạng văn bản; nó không thể đảm bảo loại bỏ các secret tùy ý không có nhãn,
đã mã hóa hay nhị phân. Giữ secret ngoài requirement và prompt, vì
Herdr CLI nhận chúng qua đối số process.

`withOperationTimeout` trả về `unknown_delivery` do contract định nghĩa với
`retryable: false` và `manualInterventionRequired: true` khi timeout cục bộ của nó
hết hạn: hủy việc chờ không chứng minh một thao tác đã bắt đầu đã dừng. Tùy chọn
`onTimeoutCode` đã deprecated vẫn được chấp nhận để tương thích source nhưng
không thể ghi đè sự không chắc chắn đó. `executeWithRetry` sẽ không gửi lại nó.

Việc đọc context repository (bao gồm tài liệu, role prompt, ADR và việc chọn
file) kiểm tra lại containment của đường dẫn đã phân giải, bao gồm symlink của thư mục cha,
từ chối special file bằng các lần mở descriptor nonblocking/no-follow, và tính
kích thước/checksum từ các byte đã đọc thay vì từ phân tích đã cache. Điều này không
tuyên bố bảo vệ khỏi một process same-user thù địch liên tục thay thế đường dẫn.
`prepareRoleTaskContext` cũng thực thi `maxTotalBytes` trên toàn bộ prompt,
bao gồm chỉ dẫn, specification và tóm tắt ADR. Context quá khổ fail
với lỗi có thể hành động thay vì âm thầm cắt bớt governance hay criterion.
Ngân sách output này không giới hạn mọi cấp phát bộ nhớ khi phân tích.

Các lệnh verification có mục tiêu:

```sh
pnpm exec vitest run packages/runtime/test/unit/resilience-observability.test.ts
pnpm exec vitest run packages/runtime/test/unit/project-context-service.test.ts
pnpm exec vitest run packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts
```

## Verification của host đã cấu hình và xác thực bền vững

The default host discovers Runtime-private adapters for JS/TS (Vitest 1/2/3,
Jest, Mocha, Node TAP), Python/pytest, Go, Rust, Maven/Gradle, .NET, Ruby
(RSpec/Minitest), PHPUnit and configured CTest. Unit/integration/E2E labels expose
exact naming rules through planning_reference; nested JS and multiple language projects can coexist. Criterion names are partitioned per selected runner and retained by the independent gates.
Owner-configured Node TAP/Vitest commands remain an optional override.

Executable/argv, offline settings, mounts and parsers come from Runtime. Manifest,
script, runner configuration, imported Gradle/MSBuild definitions and helper blobs are pinned to the committed original
revision; selected test files freeze after independent Red. Structured leaf results,
assertion/error discrimination and independent Quality Gates remain mandatory.

Linux Bubblewrap is discovered on PATH and actually probed. `up` exposes structured
sandbox unavailability; measurement never falls back to host execution. External
toolchains/caches mount narrowly and read-only, without whole homes or credentials.
Only public integrity-pinned npm lock v2/v3 warming is implemented, in a separate
no-script network sandbox with capability-probed slirp4netns egress, disabled host loopback/DNS proxy and an owned writable cache; measurement
then remains offline. Other ecosystems require installed dependencies/caches.

See [runner architecture, matrix and threat model](../../docs/verification-runners.md)
for exact formats, platform limits and agent setup routing. Evidence on the implementation
host is source plus local parser/fixture tests: the real Bubblewrap namespace probe is
blocked (`RTM_NEWADDR: Operation not permitted`), so successful sandbox measurements
and live Herdr/provider behavior are **not verified**. Native Windows/container
backends, macOS polyglot adapter mounts, Elixir/Swift/Dart adapters and universal safe dependency warming remain open.

Các receipt fsync riêng tư bảo tồn nguồn gốc human-hook, các quan sát review độc lập,
xác thực gate/evidence và native send intent/acknowledgement.
Restart khôi phục các approval và receipt đáng tin cậy mà không coi dialogue đã cache
hay việc hoàn thành transport là thẩm quyền. Đối số lease renew/release và kết quả phase
thất bại được ghi trước các side effect, với recovery idempotent chính xác.
Khi khôi phục Coordinator Stop, host phân biệt chính xác receipt `coordinator-stop`
và `coordinator-stop-handled`; giữ nguyên cả hai để restart không phát lại Stop đã xử lý.
Các kiểm tra định danh file, phạm vi session và checksum vẫn áp dụng.
Các task notice mượn lease assignment đang hoạt động và không thể reserve/release một
Developer slot thứ hai. Đây là các đảm bảo crash process cục bộ dưới mô hình tin cậy
Linux/filesystem đã nêu, không phải bằng chứng fault-campaign AI live hay power-loss.

## Role prompt và policy không hướng tới người dùng trong host mặc định

`runAgenticHost` dựng system prompt launch của mỗi role từ `agents/<role>/system-prompt.md` gốc đã cài đặt qua `readBuiltinRolePrompt` từ `@bflow/pane-manager` đã build (`packages/pane-manager/dist/index.js`, được nạp khi host khởi động, nên build pane-manager trước). Thiếu prompt Conversation hoặc Coordinator sẽ hủy việc khởi động host. Với mọi role trừ Conversation, host đảm bảo policy không hướng tới người dùng nguyên văn (`NON_USER_FACING_AUTONOMOUS_POLICY`, export từ `src/agentic/host.ts`) cộng với `NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT` (các trường `status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, `assumptions` tùy chọn): nó được nối thêm khi prompt đã nạp thiếu nó, hoặc khi không có builtin prompt. Một chỉ dẫn kết thúc cũng cấm hỏi người dùng trong pane và yêu cầu escalate lên Coordinator qua Herdr `RoleMessage`. Coordinator không còn đọc file prompt của nó riêng nữa; loader dùng chung cung cấp nó, tiếp theo là các chỉ dẫn tích hợp host. Văn bản prompt chỉ là chỉ dẫn và không chứng minh provider tuân theo.

Trong lúc khởi động, một SessionStart receipt cục bộ theo launch hoặc native-session receipt bị thiếu được báo cáo là `[bflow:native-startup-pending]`, mà `host-controller` biểu hiện thành `conflict` có thể retry (`details.stage: "native_startup"`) thay vì lỗi transport; hãy retry sau khi các native hook công bố receipt của chúng.

`ProjectContextService` nay ánh xạ role `reviewer` tới `agents/reviewer` (trước đây là `agents/verifier`) và chỉ lùi về chỉ dẫn verifier/QA khi chỉ dẫn reviewer hoặc security vắng mặt. Behavior test: `pnpm exec vitest run packages/runtime/test/agentic/agent-behavior-policies.test.ts`.

## P30 platform readiness

Claude được launch với `DISABLE_AUTOUPDATER=1`, áp dụng cả permanent role và Developer
động. Đây là policy môi trường riêng cho phiên để updater nền không đổi binary giữa
preflight và activation; các kiểm tra executable/config digest và attestation vẫn bắt buộc.

`DefaultPlatformReadinessService` (export từ `src/platform/index.ts`) ghép các thành phần
platform đã triển khai cho một session generation: role environment, skill session record, Gateway
registration, provider preflight/launch intent, và activation với launch attestation do host ký.
`createPlatformReadinessService` nối các thành phần thật từ một state directory, một `SkillManager`,
một Gateway control port tùy chọn và một attestation signer. Các class provider adapter cụ thể không được
export.

Các đảm bảo được triển khai ở đây, với package-local test trong `test/platform/service.test.ts`:

- `prepareSession` là all-or-nothing. Bất kỳ role bắt buộc nào chưa sẵn sàng (hoặc launch intent của nó
  không thể journal) tạo ra `ready: false` và không có launch material; các Gateway registration thực hiện trong lần gọi đó bị
  thu hồi theo từng role. Các role tùy chọn thất bại được báo cáo là `blocked` và bị bỏ qua.
- Một role cần Gateway service mà không có Gateway control port được cấu hình là `blocked`.
- Launch material (bearer token `launch.env`) chỉ được giữ trong bộ nhớ. Report, status snapshot và lỗi
  không bao giờ chứa giá trị token. Các launch đã nhả hoặc shut down bỏ material của chúng.
- `verifyActivated` yêu cầu một launch mà instance này đã chuẩn bị; `assertFresh` ủy quyền cho preflight đã cache.
- Persistent host kiểm tra activated health cho tối đa ba permanent role bắt buộc cùng lúc,
  bao gồm các quan sát pane của chúng. Mỗi role giữ launch đã chuẩn bị, quan sát native-session
  và attestation đã ký riêng của nó; khởi động chờ tất cả các check bắt buộc pass. Tham chiếu pane
  hoặc launch bị thiếu bị từ chối trước khi các probe bắt đầu. Một check thất bại dừng các check đang xếp hàng
  và drain các check đang chạy trước khi trả về lỗi đầu tiên theo thứ tự role đã cấu hình.
  Việc lên lịch này được bao phủ bởi các test cục bộ; mức giảm thời gian khởi động live chưa được đo.
- CLI có thể nộp một private preparatory role check sau khi native binding của role đó được
  công bố bền vững, chồng lấp tối đa ba check với các lần launch pane sau. Mỗi check xác thực
  các receipt startup/native/tool chính xác và thực hiện role health. Kích hoạt cuối cùng vẫn lặp lại
  toàn bộ cổng role bắt buộc với health mới và một attestation đã ký mới được xác minh cho mỗi role;
  kết quả chuẩn bị không bao giờ thay thế nó hay khởi động workspace/scheduler.
- Host provider factory tắt execution probe cho mọi provider trong preflight và activation:
  readiness dùng native auth, binary/config/permission, MCP, skill và attestation mới, không gọi model.
  Codex bootstrap được UserPromptSubmit ghi nhận native session rồi chặn bằng exit 2 trước inference;
  hook lỗi cũng chặn prompt. CLI vẫn chờ đầy đủ startup/tool/native receipts và activated health.
  Quota và khả năng chạy model chỉ được xác minh khi làm việc thật hoặc chủ động chạy
  `bflow doctor --deep`; readiness này không phải bằng chứng inference thành công.
- Các preparatory check dừng công việc đang xếp hàng khi thất bại và drain công việc đã bắt đầu. Một
  control acknowledgement riêng tư tách biệt drain công việc daemon và các journal native-session/startup
  tuần tự hóa sau khi client ngắt kết nối, trước CLI quiesce/shutdown/cleanup. Prepare drain generation trước
  trước khi thay thế các launch, và kích hoạt cuối cùng drain công việc chuẩn bị trước cổng mới của nó.
- Codex setup review, preflight probe và các lần launch role permanent/dynamic dùng chung HOME/PATH đã chọn
  và các bộ chọn Orca pane/root/endpoint/port bên ngoài được để rỗng tường minh trong môi trường con. Cài đặt cha
  và các hook Herdr/Runtime bắt buộc của Bflow được bảo tồn; một hook snapshot không được hỗ trợ vẫn chặn launch.
- Các đường dẫn hook runner ngắn ràng buộc toàn bộ thư mục host repository/session và vẫn ổn định qua
  host recovery. Các repository riêng biệt không thể ghi đè hay xóa runner của nhau. Một thư mục tạm
  không an toàn hoặc là symlink có sẵn không bao giờ bị chmod hay tiếp nhận.
- Hook ingress xác thực event/session và các trường prompt/tool bắt buộc. Input bọc banner
  phải chứa đúng một hook object khớp; input mơ hồ bị từ chối. `PreToolUse` input không hợp lệ
  phát ra một quyết định deny tường minh. Chỉ lượt khởi động Codex ràng buộc environment được dành riêng mới bị bỏ qua.
- Nguồn native session phải nhận diện provider đã cấu hình (ví dụ `codex` hoặc `herdr:codex`).
  Herdr như một transport không làm cho các nguồn `herdr`/`herdr:herdr` chung chung trở thành bằng chứng provider hợp lệ.

- Claude roles dùng isolator profile nhận `CLAUDE_CONFIG_DIR=<selected-profile-HOME>/.claude` trong cả preflight probe lẫn final launch. Điều này ghim việc native auth/config lookup vào profile đã chọn và ngăn `CLAUDE_CONFIG_DIR` được kế thừa từ bên ngoài chọn account khác. Sau đó Claude giữ `.claude.json` native tại `CLAUDE_CONFIG_DIR/.claude.json`; Runtime không copy, migrate hay symlink file `HOME/.claude.json` độc lập. Profile MCP synchronization quản lý riêng các managed MCP entry ở cả hai native location, còn account state vẫn thuộc profile. Hành vi này được kiểm tra bằng local synthetic-state tests, không phải xác minh provider hoặc model live.

Giới hạn: đây là composition source chỉ với bằng chứng fake-runner và fake-Gateway cục bộ. Các provider
probe live, Gateway daemon live và wiring Pane Manager/Conversation không được xác minh ở đây. Service
tạo thư mục state riêng tư `gen-<n>/roles/<role>` của mỗi role trước preflight.

### Khả năng tiếp cận MCP tool trong process, cổng Developer và mất Gateway (P30 hardening)

`src/agentic/tool-reachability.ts` chứng minh khả năng tiếp cận Gateway tool từ bên trong process provider đã launch,
không chỉ từ config digest. Với mỗi launch có Gateway registration (permanent role tại `prepare`, Developer
động tại lúc cấp phát) host ghi một plan riêng tư, không chứa token `gateway-probes/<launchId>.json` (dir 0700,
file 0600, nguyên tử): launch id, Gateway endpoint, registration id, tên biến `BFLOW_MCP_TOKEN_*`
được suy ra và các tool được phép. Launch material mang `BFLOW_LAUNCH_ID` không bí mật, nên hook
`SessionStart` gốc của provider tìm thấy plan của chính nó ngay cả khi nhiều Developer chạy đồng thời
(`<role>.gateway.json` legacy chỉ được đọc như fallback và bị xóa tại `prepare`). Hook thăm dò từng registration bằng bearer token từ
environment của chính nó (`initialize`, rồi `tools/list` với session id, 5 s mỗi request, `redirect: "error"`) và
chỉ báo cáo registration id, tên biến env, `ok`, các tool đã phát hiện và một code (`token_env_missing`,
`unauthorized`, `http_error`, `timeout`, `unreachable`, `protocol_error`, `missing_tools`). Các record được lưu theo
từng launch và pane.

- `activate` yêu cầu, với mỗi permanent role bắt buộc có registration, một record `ok` cho đúng launch
  đã chuẩn bị; record bị thiếu là `[bflow:native-startup-pending]`, record thất bại ném một lỗi có tên.
- Việc cấp phát của một Developer động trả về `conflict` có thể retry (`details.stage: "developer_startup"`) cho đến khi record của nó
  là `ok`; proof thất bại hoặc không có proof trong 30 s sẽ nhả launch và pane của nó (`validation` không thể retry).
- Mỗi 30 s host reconcile Gateway registration với Gateway control. Một registration bị thiếu sau khi
  Gateway daemon restart (hoặc hết hạn/thay đổi) đánh dấu launch của nó là `degraded`; các role degraded báo cáo `readyForPrompt:
  false`, nên outbox giữ thông điệp của chúng trong hàng đợi cho đến khi `bflow up` launch lại chúng (provider đang chạy giữ một
  token đã bị thu hồi; không thể hot-swap). Các check không chắc chắn không thay đổi gì.
- Một host daemon được restart sẽ cho nghỉ hưu các launch của daemon trước: nó thu hồi các registration của session, journal
  `released` cho các intent đang mở và xóa các plan/record của chúng; kích hoạt khi đó cần một `bflow up` mới.
- `platform_status` báo cáo khả năng tiếp cận theo từng launch, lần Gateway check cuối và mọi restart recovery, không có token.

Giới hạn: kế thừa environment của hook, mở rộng header `${VAR}` của Claude và `bearer_token_env_var` của Codex
chỉ được xác minh bằng các hook spawn cục bộ và config đã render, không phải provider hay Herdr live.

Legacy JS and owner commands also have a deny-default macOS Seatbelt backend (see the runner architecture document). Native polyglot adapter mounts/reports and dependency warming remain Linux-only; macOS was not measured on this integration host.

The polyglot measurement fixtures require both an installed toolchain and the pinned
fixture dependencies in its selected offline cache. Tests inventory Maven/Gradle/NuGet
prerequisites before measurement and explicitly skip unavailable environments; once a
measurement starts, missing transitive dependencies and all infrastructure errors fail.
Installed SDKs alone do not prove measurement readiness. Linux test dependencies are
staged without pnpm workspace links; production dependency escape checks remain enabled.
PHPUnit uses an ini-free PHP invocation with explicit public extensions, and Rust pins
its canonical C linker without importing host alternatives configuration. Dependency
warming avoids devpts so its network namespace stays owned by the user namespace entered
by slirp; the helper must return exactly its documented readiness byte before npm starts.

## Workflow liveness và capability recovery

Host cung cấp `repository_read` cho Coordinator và các role điều tra/verification, cùng
`read_pinned_instructions` để đọc nội dung skill đã pin. Reader chỉ đọc file text có giới hạn,
listing có cursor và các thao tác Git cố định; không nhận shell hoặc argv tùy ý. Git status/diff
fail closed khi repository cấu hình filter có thể chạy chương trình. Dispatch kiểm tra role,
pane/native session, launch, Bflow tools/list, repository/Git và manifest trước lease/transport.
Quyền ghi của Developer, Conditional TDD, verification và human gates vẫn theo các đường hiện có.

Quyền truy cập provider tới workspace được xác minh riêng trong `bflow up`. Khi chạy Git, Runtime
không đọc global/system configuration để quyết định ownership: mỗi subprocess canonicalize đúng
repository root (hoặc checkout verification mới tạo), reset các giá trị `safe.directory` kế thừa,
rồi chỉ tin đường dẫn đó trong process hiện tại. Điều này cho phép đọc repo do UID khác sở hữu mà
không thêm trust vào user-global Git config; nested repo/đường dẫn khác không được trust theo root
này. Runtime runner xác minh detached worktree bằng trust riêng cho checkout đó.

Coordinator gửi blocker tới Conversation phải được Runtime ghi nhận trước khi giao nguyên
RoleMessage đã xác thực. Run có thể chuyển sang `escalated` kèm `pendingAction`, owner,
nguyên nhân và phase để tiếp tục. `resume_run` chỉ tiếp tục action khớp, kiểm tra lại capability,
không vượt approval/cancellation hoặc delivery chưa rõ; intent chưa gửi được dùng lại id cũ.
Một lượt Coordinator chỉ báo progress rồi dừng không được tính là có next action.

Recovery đọc inbox/receipts bền vững, phục hồi wake thiếu theo đúng result/assignment/correlation,
và tiếp tục verification bị gián đoạn bằng plan đã đóng băng. Nó không tạo binding proof hoặc
resend delivery chưa rõ. Watchdog xét obligation của đúng run/pane; `unknown_delivery` là chờ
reconciliation có hành động xử lý, không phải task thành công hoặc bằng chứng treo.

Diagnostic specialist không đưa workflow đã tạo Core trở lại phase lập kế hoạch. Khi mở journal
cũ có phase bị ghi lùi, Runtime khôi phục phase thực thi hoặc chờ phê duyệt task/delivery còn
hiệu lực, giữ nguyên request và quyết định đã ghi; một action tạm dừng vẫn cần được xử lý riêng.
Người dùng có thể explicit resume action đó về `awaiting_approval`, rồi trả lời approval;
automatic resume vẫn bị chặn và việc resume không thay thế quyết định phê duyệt.

Conversation nhận notice qua inbox; receipt chưa đồng nghĩa model đã thấy hoặc người dùng đã
đọc. Host nhận diện layout idle đã quan sát của Claude/Codex, giữ draft không bị ghi đè và giới
hạn automatic wake ở ba lần mỗi notice qua restart. Notice và lỗi delivery vẫn được giữ khi
cạn budget; người dùng có thể mở Conversation và hỏi trạng thái rồi resume/cancel cùng run.
`host_status` trả các lỗi delivery gần nhất để chẩn đoán. Layout khác fail closed.

Xem `WORKFLOW-LIVENESS-AUDIT.md` và `WORKFLOW-LIVENESS-HANDOFF.md` cho nguồn gốc sự cố và
ranh giới nghiệm thu. Có local regression tests; live provider/full SDLC acceptance không được
suy ra từ fake transport, receipt, hoặc test Herdr native actor.

`conversation_decide` và `resume_run` của Conversation không bắt model chép `messageId`: host gắn quyết định vào lượt
người dùng mới nhất đã xác thực của đúng pane (nếu model truyền `messageId` thì vẫn phải khớp). Một lượt người dùng
kết thúc mà chưa có quyết định sẽ bị hook Stop từ chối, tối đa hai lần mỗi lượt, cho cả Claude và Codex. Codex ghi nhận
notice đã hiển thị qua `last_assistant_message` của Stop. Khi khởi động, host không chấm lại các lần dừng của Coordinator
thuộc session trước.

Để yêu cầu tiếp tục run bị chặn trong Conversation, dùng `tiếp tục` hoặc `resume <run-id>`.
Host kiểm tra input người dùng thật và session trước khi chuyển yêu cầu tới Runtime; thao tác
này không thay thế một approval đang chờ và không tạo workflow mới.
Khi một review read-only đã được giao chắc chắn nhưng chưa trả kết quả, explicit resume
có provenance từ Conversation cho phép Runtime gửi một diagnostic riêng cho đúng native
session cũ khi gate đang đợi. Request/handle gốc không đổi; diagnostic có lease riêng,
giữ capability gốc, không cấp verdict và không được resend nếu delivery chưa rõ. Native
session khác, gate đang chờ duyệt hoặc request chưa rõ delivery đều chặn continuation.
Mỗi lượt người dùng giữ wake bất biến riêng; replay cùng lượt không tiêu thêm budget.
Thông tin vận hành `task.status` đã xác thực từ Conversation được chuyển tới Coordinator
ngay cả khi run đang escalated hoặc chờ duyệt; nội dung được giữ lồng trong wake của
Runtime, không có quyền resume/approve. Replay receipt `received`, lỗi capability và Stop
của lượt thông tin đều giữ nguyên blocker, bằng chứng và các cổng phê duyệt hiện có.

Runtime lưu intake đã được Conversation xác thực cùng outbox intent trước dispatch đầu tiên;
`delegation.accepted` và ingress Herdr vẫn là các bước riêng. Vì vậy capability denial trước khi
Coordinator nhận yêu cầu cũng giữ được cùng run và action để xử lý, thay vì chỉ có terminal lỗi.

Conversation display recovery distinguishes notices surfaced to the model from
notices displayed to the user. Substantive progress with a run and a complete
headline remains eligible for display acknowledgement after restart. Claude and
Codex Stop hooks (Codex requires its final assistant message) can issue at most two
reminders per missed notice. Generic/truncated updates have no progress display
acknowledgement; display receipts never authorize a workflow or approval. These
guarantees are covered by local subprocess/host tests, not live-provider acceptance.

A numbered choice followed by prose is not committed as human governance at intake.
The original authenticated turn stays undecided for `conversation_decide`, allowing
Chat to revise the same workflow while an older approval is pending. The revision
uses normal Runtime admission/supersession; it does not fabricate an approval or
invoke operational resume. Exact numeric/option replies still use the trusted human
hook. Restart/replay coverage retains the same revision envelope and user-turn identity.

## Session cancellation controls

Một lượt người dùng được xác thực chỉ có một `conversation_decide`. Protocol Chat/host
riêng nhận `cancellationInput.runId`, `runIds` hoặc `scope: "session_existing"`;
Conversation đóng băng tập run trong session trước khi gửi từng cancellation có key riêng.
`CancellationRequest` và `DelegationRequest` công khai không đổi. Retry vẫn gắn với
message/provenance gốc và không mở workflow mới.

Runtime lưu cancellation control vào outbox trước khi áp dụng, độc lập với việc Coordinator
đang rảnh hoặc scheduler đang chờ verification. Tick/flush khôi phục control còn queued
sau restart; binding pane cũ không thay đổi quyền hủy của cùng session. Trạng thái `delivered`
của control này nghĩa là Runtime đã áp dụng cục bộ, không phải signed Herdr receipt hay
Coordinator đã bắt đầu lượt model. Cancellation đang `sending`/`unknown_delivery` giữ
quy trình reconciliation và không được gửi lại tự động.

Run đã hủy không dispatch công việc còn queued và không nhận approval để tiếp tục.
Conversation đối soát projection/pending approval với Runtime; entry chỉ có trong snapshot
được báo riêng, không được dùng làm bằng chứng còn chạy hay đã dừng. `cancelled` nghĩa là
ý định hủy có thẩm quyền đã được áp dụng; chỉ thông báo reconciliation cuối mới cho biết
`fully stopped` hoặc blocker cần xử lý. Native delivery chưa rõ được giữ nguyên và báo blocker,
không bị bỏ qua để tuyên bố đã dừng. Worktree vẫn được giữ để kiểm tra.

Regression cục bộ: build rồi chạy `pnpm exec vitest run
packages/runtime/test/agentic/cancel-reconcile.test.ts
packages/runtime/test/agentic/conversation-intake.test.ts packages/conversation/test`.
Các test dùng transport giả và storage/policy thật; không chứng minh các run trong session
production đã được dừng hoặc provider/Herdr live đã chấp nhận bản sửa.
