# Workflow chỉ phân tích nghiệp vụ (BA-only)

Module `packages/runtime/src/analysis/**` cho phép chạy một workflow chỉ phân tích nghiệp vụ và bàn giao đặc tả,
không thi công sản phẩm. Đây là **extension của Runtime**, không phải engine thực thi riêng. Nó tái sử dụng:

- Core `DeterministicWorkflowEngine` cho DAG, chuyển trạng thái hợp lệ, gate, retry có giới hạn và approval.
- `RunStore` (SQLite) cho event có thẩm quyền và khôi phục bằng replay.
- `ArtifactStore` cho tài liệu, báo cáo kiểm tra, verdict review và manifest bàn giao, tất cả có checksum.
- `@bflow/test-strategy` cho quyết định Conditional TDD `not_applicable` và evidence alternative verification.
- Contract `WorkflowPack` (schemaVersion 3) và `resolveWorkflowPack`/`workflowPackDigest` cho pack được pin.

Không thay đổi `@bflow/contracts`, cấu hình root hay lockfile.

## Ràng buộc của Runtime hiện tại

`AgenticWorkflowRuntime.proposeWorkflow` (`src/agentic/runtime.ts`) bắt buộc implementation:

- Mọi node DAG phải là task `developer`, kèm `ownedPaths` nằm trong `affectedPaths`. Specialist chỉ được gọi
  read-only qua `requestSpecialist`.
- Sau design approval, run chuyển sang `implementing`. Workflow luôn kết thúc bằng task `workflow-verification`
  trên change đã tích hợp Git (`captureIntegratedChange`, integration worktree/branch).

Vì vậy BA-only **không thể** chạy qua luồng đó nếu không tạo Developer task giả, patch no-op hoặc nới lỏng gate. Module
này không làm những điều đó. Nó thêm một luồng song song, tương thích, chỉ có các loại task phân tích.

## Pack

Pack là `WorkflowPack` bình thường. Ví dụ: [support/analysis-only-pack.json](support/analysis-only-pack.json).

- `workflow.id = "bflow.analysis-only"`; `workflow.version = "1"` chọn phiên bản planner.
- `capabilities.required` bắt buộc chứa `workflow.analysis_only`. Các mục `analysis.output.<section>` là output policy,
  trong đó 6 section lõi bắt buộc: `scope`, `functional_requirements`, `acceptance_criteria`, `nfr`,
  `business_flows`, `glossary`. Ba section `context_notes`, `data_notes`, `api_notes` là tùy chọn.
- `skills.<role>` chỉ pin được cho specifier/architect/reviewer/coordinator.
- Bị từ chối: `roles.*`, `tools.required` không rỗng, skill cho Developer/QA/tester, capability lạ, sai pin
  (id/version/digest) và digest không khớp nội dung.
- Pack phải khóa (`lockedFields`) hai field `workflow.id` và `capabilities.required`.

`buildAnalysisPack` tạo pack kèm digest. `resolveAnalysisPack(pack, pin)` kiểm tra pack và trả về policy.

## Intake và DAG

`AnalysisIntakeSchema` khai báo:

- phát biểu nguyên văn của người dùng;
- deliverables;
- AC của **công việc phân tích**;
- quyết định nghiệp vụ bắt buộc;
- `surveyPaths`: đường dẫn được phép khảo sát, chỉ đọc;
- `documentRoot`: nơi ghi bàn giao, không được chồng lên `surveyPaths`.

Coordinator dùng `planAnalysisWorkflow` để lập DAG mặc định. Nếu Coordinator tự đề xuất DAG,
`assertAnalysisOnlyWorkflow` kiểm tra lại:

| Task | Role | Gate / điểm người duyệt |
| --- | --- | --- |
| `survey` (chỉ khi có `surveyPaths`) | architect/specifier | Runtime tự đọc file và ghi sha256 |
| `elicitation` | specifier | **Người dùng trả lời quyết định nghiệp vụ** (Core approval) |
| `specification` | specifier/architect | `analysis-verification` (verification loop có giới hạn) |
| `review` | reviewer | `independent-review` + **người duyệt tài liệu** |
| `publication` | coordinator (Runtime thực thi) | `publication-integrity` |

DAG đề xuất bị từ chối khi có:

- role/kind khác bảng trên, chẳng hạn developer, implement, deploy hay install;
- metadata `ownedPaths`/`commands`/`worktree`;
- gate do agent tự định nghĩa;
- thiếu stage hoặc sai thứ tự phụ thuộc;
- survey không có quyền.

Approval point, retry bound và gate luôn do Runtime đặt lại.

## Nguồn của phát biểu

Mỗi FR/AC/NFR, phạm vi, luồng, thuật ngữ và ghi chú đều mang `provenance`:

| Kind | Ref hợp lệ |
| --- | --- |
| `user` | `intake:<id>` hoặc `decision:<id>` đã được người dùng trả lời |
| `source` | `source:<path>#<sha256>` khớp đúng quan sát mà Runtime đã đọc |
| `inference` | ID của các phát biểu làm căn cứ, không được tự tham chiếu |
| `open_decision` | `decision:<id>` chưa được trả lời |

## Verification (gate `analysis-verification`)

Việc file tồn tại không đủ để pass. `verifyAnalysisDocument` kiểm tra:

- **Consistency**: ID không trùng; không có phát biểu vừa trong vừa ngoài phạm vi; thuật ngữ không mâu thuẫn; chỉ có
  các ghi chú context/data/API đã được yêu cầu.
- **Traceability**:
  - deliverable nằm trong output policy và không rỗng;
  - FR ↔ AC theo cả hai chiều, và luồng nghiệp vụ trỏ tới FR có thật;
  - mọi AC bắt buộc của công việc phân tích được phủ bởi phát biểu có thật.
- **Testability**: AC có given/when/then và oracle quan sát được. Từ ngữ mơ hồ (fast, user-friendly, nhanh,
  dễ dùng…) phải có ngưỡng số hoặc là quyết định còn mở.
- **NFR**:
  - `accepted` cần metric, oracle, workload và threshold;
  - `undecided` phải trỏ tới quyết định chưa trả lời.
- **Provenance**: theo bảng ở mục trên.
- **Câu hỏi chưa giải quyết**:
  - câu hỏi blocking chưa trả lời làm gate `blocked`; run chuyển `needs_revision`;
  - câu hỏi không blocking được đưa vào bàn giao.

Khi gate thất bại, Core chạy retry có giới hạn và gửi lại cho specifier kèm findings. Mặc định tối đa 3 lần
(`maxIterations` cho phép 1–10). Gate `independent-review` yêu cầu đủ ba điều kiện:

- reviewer khác danh tính với tác giả;
- verdict ghim đúng digest tài liệu hiện tại;
- verdict là `approved`, không có finding blocking, và tài liệu vẫn pass kiểm tra.

## Quyền và ghi tài liệu

- Assignment luôn mang `permissions.write = "none"`, `commands = "none"`, `read = surveyPaths`.
- Output có `writes`/`files`/`patch`/`commands`/`proposedTasks`/`install`/`deploy`, survey đọc ngoài phạm vi, hoặc
  output từ sai role đều là **permission denial**. Denial được ghi vào journal, attempt thất bại, và retry có giới hạn.
- Chỉ Runtime ghi repository, và chỉ khi tài liệu đã được người duyệt: hai file Markdown
  `<documentRoot>/<requestId>/r<revision>/{analysis,handoff}.md`. Thư mục cha là symlink thì bị từ chối. File đã tồn tại
  không bị ghi đè, trừ trường hợp publish lại nội dung y hệt sau restart.

## Quyết định, approval và bàn giao

- `decideBusinessQuestions` cần decision của **người** được xác thực. Port `authorizeHuman` từ chối các tên role agent.
  Thiếu câu trả lời cho câu hỏi blocking thì approval bị từ chối và run tiếp tục bị chặn.
- `decideDocument` phải nêu đúng digest tài liệu đã review. Approval có metadata
  `approvalScope: analysis_document, productAcceptance: not_established`.
- `handoff.md` chứa manifest:
  - pin của pack, phiên bản workflow, digest intake, phiên bản/digest/artifact của tài liệu;
  - kết quả kiểm tra, verdict review độc lập, approval;
  - nguồn: phát biểu người dùng, quyết định, quan sát source kèm sha256;
  - câu hỏi còn mở; `tdd.mode = not_applicable` và alternative verification `manual_review`.
- **Phê duyệt tài liệu không đồng nghĩa nghiệm thu sản phẩm.**

## Khôi phục và revision

- Core event được append vào RunStore sau mỗi mutation. Sau restart, aggregate được dựng lại bằng `engine.recover`
  replay event, sau đó mới áp approval hay gate.
- Binding được ghi vào Core trước khi giao việc cho role:
  - Execution đã bind nhưng chưa có kết quả thì không bao giờ gửi lại mù. Runtime gọi `roles.reconcile`.
    Nếu kết quả `unknown`, run bị `blocked` với `unknown_delivery:<executionId>`.
  - Nếu journal mất bản ghi binding, Runtime nhận binding từ Core và đi tiếp bằng reconcile.
  - Task đã hoàn tất không bị giao lại.
- `revise` tạo một run mới, revision n+1, mang lý do và các quyết định đã trả lời. Run cũ chuyển `superseded` và giữ
  nguyên lịch sử tài liệu, approval và bàn giao.

## Cách dùng

```ts
import { AnalysisWorkflowRuntime, resolveAnalysisPack } from "@bflow/runtime";
const runtime = await AnalysisWorkflowRuntime.open({ engine, runStore, artifactStore, roles, repositoryRoot, journalPath,
  authorizeHuman, now: () => new Date().toISOString() });
await runtime.start({ runId, intake, pack, packPin });
await runtime.drive(runId);                       // dừng ở awaiting_business_decision
await runtime.decideBusinessQuestions(runId, { decision: "approved", answers, decidedBy: "user:<id>" });
await runtime.decideDocument(runId, { decision: "approved", documentDigest, decidedBy: "user:<id>" });
```

## Tích hợp còn lại (đề xuất, cần owner duyệt)

1. Host MCP tool cho Coordinator: `propose_analysis_workflow` gọi `start`. Port `AnalysisRolePort` giao việc qua
   Runtime → Herdr `RoleMessage`. `reconcile` dùng execution binding/receipt hiện có.
2. Conversation route `decideBusinessQuestions`/`decideDocument` qua `request_user_decision` hiện có.
   `authorizeHuman` dùng cùng cơ chế xác thực human decision của host.
3. Chọn pack qua `environment.workflowPack` (đã có). `bflow up` cần nhánh khởi động không yêu cầu Developer/Git
   integration khi `workflow.id = bflow.analysis-only`. Đây là thay đổi trong P29/P30, không phải contract.
4. Lưu journal trong private runtime state (`resolvePrivateRuntimeStateDirectory`), giống journal agentic.

## Giới hạn

- Mức bằng chứng: source cộng test local (`test/analysis/analysis-workflow.test.ts`) với role giả lập xác định,
  Core/RunStore/ArtifactStore thật. Chưa nối với host/Herdr/Conversation, chưa có lệnh CLI, chưa có live provider
  acceptance.
- Correlation của kết quả role do Runtime gán qua port in-process. Khi nối Herdr, correlation phải đến từ binding
  receipt có xác thực.
- Kiểm tra từ ngữ mơ hồ dùng danh sách từ khóa, không phải hiểu ngữ nghĩa. Verdict reviewer không chứng minh chất
  lượng phán đoán.
- Run bị thay thế không bị hủy trong Core (task chờ quyết định vẫn treo). Journal chặn mọi tiến triển của run đó.
- Journal là file JSON ghi nguyên tử, một writer. Chưa có lock giữa nhiều process.
