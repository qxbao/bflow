# Thiết kế bổ sung — hoàn tất live acceptance #7, #8, #12

Trạng thái: đề xuất để chủ dự án duyệt, CHƯA chấp thuận implementation.
Không sửa source/contract theo đề xuất này trong lúc bộ kiểm thử integration hiện tại đang chạy.

## 1. Mục tiêu và bằng chứng hiện có

Yêu cầu gốc đòi live E2E đủ tám tính năng, không lấy fake-role tests làm bằng chứng. Run chính cấp slug đã completed,
đúng năm approval bắt buộc cùng Task Acceptance; integrated revision 82803de40c64bb1aaa7742d319b44b35d9f1416e.
Handover HTML/Markdown chính thức có status eligible, verify exit 0 và đủ sáu hàng traceability.
Run chính, receipts, worktrees và package này phải giữ nguyên; mọi probe bổ sung có session/run ID riêng và ghi rõ là probe.

Khoảng trống xác nhận từ source:

- `packages/runtime/README.md`, `ANALYSIS-ONLY-WORKFLOW.md`, `QA-ONLY-WORKFLOW.md`: hai extension chưa nối host/Herdr/Conversation/CLI.
- `analysis/workflow.ts` và `qa/workflow.ts`: role ports hiện trả `{agentId, output}`, Core handle dùng logical `analysis-role`/`qa-role`.
  Không thể gắn một callback gọi model rồi nâng các logical handle thành live transport proof.
- Các helper quyết định hiện tạo lại ApprovalDecision timestamp/idempotency key. Host phải áp dụng nguyên quyết định
  được Conversation xác thực; không được tạo receipt giả để làm helper pass.
- `agentic/provider-failover.ts`: failover của pinned specialist profile bị từ chối có chủ ý. Không được bỏ pin hay
  bỏ restrictions để thỏa test. #12 sẽ kiểm trên một flow riêng dùng Developer không có custom profile; #2 đã có bằng chứng riêng.

## 2. Quyết định kiến trúc đề xuất

Nối hai extension hiện có vào persistent host bằng một bridge dùng các boundary hiện có. Giữ nguyên luật
`AgenticWorkflowRuntime.proposeWorkflow` chỉ nhận Developer DAG cho luồng thi công. Không tạo Developer giả, patch no-op,
hoặc engine mới. Core vẫn quyết định DAG/state/gate; RunStore và ArtifactStore giữ dữ liệu authoritative.

Chọn đường qua Conversation → Coordinator → host → extension Runtime → Registry/Herdr. Routing chỉ theo exact pinned
WorkflowPack và workflow identity, không suy từ provider name hay lời văn của agent. Cấu hình không được âm thầm đổi
luồng của một run đã tồn tại. Run kind và journal identity được đóng băng tại intake.

Các phương án không chọn: gọi SDK từ script rồi tự gắn nhãn live E2E (thiếu Conversation/transport governance); nới DAG
thi công để nhận BA/QA (phá boundary); tự phê duyệt hoặc tạo synthetic verified handle (không có authority).

## 3. Transport và recovery

Bridge dùng exported AgentRequest/RoleMessage/AgentExecutionHandle/AgentBindingReceipt/AgentResult/ArtifactReference schemas.
Protocol 22 và RoleMessage v2 không đổi. Payload riêng được schema-validate thêm trong Runtime sau envelope ingress.

Cho mỗi role task thật:

1. Resolve actual pane/native session và profile/skill policy; preflight rồi lấy Registry lease/fence.
2. Lưu immutable dispatch intent trước side effect, kiểm lại lease/fence ngay trước Herdr send.
3. Lưu actual handle/receipt trước khi coi binding recoverable; không dựng pane ID từ task ID.
4. Ingest authenticated correlated role output; kiểm schema, scope và role; persist result/evidence trước Core transition.
5. Crash giữa intent/send/bind giữ unknown delivery. Reconcile actual execution/request key; chỉ resend khi not_delivered đã được chứng minh.

Phần lease/fence/receipt phải tái dùng hoặc trích thành helper từ transaction layer hiện có, giữ nguyên behavior của luồng thi công.
Không dùng ArtifactStore/file polling làm kênh liên vai trò. Publication BA và execution/report QA do Runtime nội bộ thực thi,
được ghi rõ là internal tasks; không giả chúng là Herdr execution.

SDK/local ports hiện có giữ tương thích và mức chứng cứ local. Native host path phải dùng actual bindings; journal local cũ
không được upcast thành live proof. Nếu cần codec mới: namespace/version mới, đọc lịch sử cũ read-only, không tạo receipt còn thiếu.

## 4. Approval và trạng thái

Bổ sung entrypoint nhận nguyên exported ApprovalDecision cho BA business/document gates và QA design gate; helper SDK cũ
có thể giữ wrapper tương thích nhưng host không dùng wrapper tạo lại quyết định. AuthorizeHuman xác minh chính exact decision
đã ghi bởi HostReceiptJournal, gồm run/session/target/revision/generation/digest/decidedAt/idempotency key.

Conversation là UI duy nhất. Request/decision đi qua đường chính thức, có card và artifact digest. Từ chối/stale/wrong scope
không làm Core tiến bước. Hết hạn/restart không mất câu hỏi. Không dùng approval sản phẩm để duyệt tài liệu BA/QA.

Bốn state domains vẫn tách biệt. Trạng thái internal published/reported được trình đúng output type và Core outcome;
không suy Herdr done, file tồn tại hay pane idle thành completion. CLI status/read_updates có thể đọc extension runs khi host
đang up hoặc đã down; query không khởi động provider hay tự repair state.

## 5. BA-only smoke

Dùng exact analysis pack hiện có trên một repository/sub-session biệt lập, với đầu vào là behavior và yêu cầu slug đã được chủ
sở hữu chấp thuận. Survey read-only; không cấp command/write/install/deploy cho role. Role specifier tạo FR/AC/NFR có provenance,
reviewer độc lập kiểm đúng digest; người dùng duyệt business decisions và document qua Conversation. Chỉ Runtime publish Markdown
vào documentRoot được intake cấp, với manifest/checksum. NFR phải có metric/oracle/workload/threshold; giá trị chưa được chủ dự án
quyết định giữ undecided và câu hỏi thật, không bịa ngưỡng. Published nghĩa là tài liệu đã duyệt, không phải sản phẩm đã nghiệm thu.

## 6. QA-only smoke

Dùng fixture HTTP loopback do host/harness sở hữu, bọc module slug của integrated revision đã duyệt; fixture không được quảng cáo
là API sản phẩm được giao. Ghim build identity vào 82803de; protected product paths có digest trước/sau. Intake chỉ cho http_read,
origin chính xác, account anonymous của fixture, asset/report root riêng. Không cần browser hay credential mới cho smoke tối thiểu.

QA tạo test design, reviewer khác tác giả review, người dùng duyệt exact design trước mọi target side effect. Runtime thực thi qua
HTTP tool grant và fenced environment lease; lưu actual responses và evidence, phân loại product_failure/test_defect/environment_failure/
blocked/inconclusive đúng nghĩa. Report không cho phép sửa product source. Các đường mutation/reconciliation/cleanup hiện có phải giữ
regression dù smoke tối thiểu read-only.

## 7. #12 — fault-injected live failover riêng

Giữ nguyên main run đã completed. Probe riêng tái sử dụng bài toán slug đã chọn ngẫu nhiên trên clone baseline; không thay run chính.
Developer của probe không có custom profile. Primary gpt-6.1-sol, fallback gpt-6-luna, provider codex/native profile personal; cả hai đã có
live doctor evidence. Chain exact được preflight/bind trước launch, maxSwitches 1, không widen permission.

Fault harness là loopback reverse proxy tạm thời, forward tới backend OpenAI/Codex LB thật. Chỉ sau startup/assignment đã được
xác minh mới gây 429 có kiểm soát cho đúng native execution được chọn. CLI Codex thật phải phát sinh structured error của chính nó;
Host thu và authenticate observation từ native transcript. Không ghi giả ProviderFailureObservation hoặc receipt. Fallback phải gọi
model OpenAI thật và tiếp tục cùng probe run/task/worktree, giữ test revision/TDD evidence và attempt history.

Admission của proxy/environment phải qua cấu hình session được provider policy hỗ trợ; không sửa global config/provider profile của
người dùng, không ghi/log credential. Cách cấu hình cụ thể được quyết định trong một spike giao thức read-only trước implementation.
Nếu không có đường admission hợp lệ hoặc native CLI không phát sinh structured event hỗ trợ, đánh dấu probe bị chặn; không nới parser,
không dùng model ID giả, không thay bằng mock rồi báo live PASS. Không thêm manual-continuation public contract trong phạm vi này.

Trước executor mới: chứng minh process scope cũ dừng, reconcile delivery, không unknown_delivery, retire lease cũ, lấy fence mới.
Sau switch: actual model/provider/startup proof, immutable handles, one writer và unchanged task authority. Kết quả phải ghi
fault-injected live test; không mô tả như một outage tự nhiên của nhà cung cấp.

## 8. Acceptance criteria của phần bổ sung

| ID | Điều kiện chấp nhận | Evidence bắt buộc |
| --- | --- | --- |
| ext-1 | Exact BA/QA pack chọn extension qua Conversation/host; luồng thi công cũ giữ nguyên | live intake, pinned pack, run kind, schema rejection |
| ext-2 | Native role tasks dùng actual receipt/handle, lease/fence và đúng session | journal intent/binding, authenticated receipts, restart fault test |
| ext-3 | Exact human decisions được áp dụng nguyên vẹn, không tự tạo lại receipt | pending request, canonical decision equality, wrong digest/replay denials |
| ext-4 | BA-only publish FR/AC/NFR hợp lệ; không implementation patch/Developer | document digest, independent verdict, human approvals, protected Git diff |
| ext-5 | QA-only có design/execution/report trên exact fixture build; không sửa product | test design digest, lease/grant, actual response evidence, before/after hashes |
| ext-6 | Restart không replay unknown work hoặc mất human gate | controlled crash/reconcile logs và cùng run ID |
| ext-7 | #12 có native structured failure và fallback model thật, giữ context/history | old stop proof, reconcile, new fence/binding/model, same run/task/worktree/TDD |
| ext-8 | Không secret/raw agent logs trong report/handover | allow-list + redaction/hash verification |
| ext-9 | Existing SDD/TDD/verification/rework/permissions và toàn bộ compatibility checks giữ nguyên | affected tests, build/type/dependency checks, independent source review |

TDD required cho host dispatch/recovery/approval behavior. BA/QA business workflows dùng TddDecision not_applicable với alternative
verification thật theo extension hiện có. NFR transport: một request key tối đa một accepted native delivery sau reconcile; không có
concurrent writer; zero protected-source mutations trong QA-only; bounded retry/rework giữ max 3 trừ policy đã được owner duyệt.

## 9. Quyền sở hữu, tương thích và quyết định còn chờ

Production owners: Runtime/host + Conversation + CLI + Pane Manager nếu cần shared transport extraction. Contract schemas hiện có là
ưu tiên; không sửa packages/contracts, root config hay lockfile chỉ để làm adapter dễ hơn. Nếu phát hiện mismatch thực sự, lập integration
decision riêng ghi motivation/affected owners/compatibility-migration/approving owner trước khi đổi public contract.

Handoff giai đoạn hiện tại vẫn hợp lệ và không bị sửa bởi probe bổ sung. Source integration hiện tại phải pass trước khi lấy baseline
cho branch/worktree implementation mới. Không push. Mỗi approval mới cần quyết định người dùng thật; quyền Trust của sample không
được suy sang một repository khác.

Đề xuất cần chủ dự án duyệt là xây host bridge nêu trên và chạy fault probe riêng theo đúng các điều kiện, sau đó mới lập implementation
plan. Đây không phải yêu cầu xác nhận lại Delivery #9 đã được duyệt. Chưa implementation theo thiết kế này.
