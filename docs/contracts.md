# Hợp đồng giao tiếp công khai (Public Contracts)

Toàn bộ các schema công khai, kiểu dữ liệu suy diễn, bộ xác thực thuần túy (pure validators) và các giao diện cổng (ports) đều được xuất bản chính thức từ package `@bflow/contracts`. Lược đồ Zod schema đóng vai trò là cơ quan thẩm quyền tối cao tại ranh giới tiếp nhận (ingress) của mỗi package. Các đối tượng trao đổi dữ liệu đều tuân thủ quy tắc nghiêm ngặt (`.strict()`); mọi trường dữ liệu lạ không được khai báo trước sẽ bị từ chối, trừ khi được bổ sung tường minh trong các phiên bản lược đồ kế tiếp.

---

## 1. Quy ước về Lỗi và Xử lý Bất đồng bộ

Mọi thao tác bất đồng bộ (Promise) công khai đều trả về kết quả chuẩn hóa theo kiểu `OperationResult<T>`:

```ts
type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };
```

Kiểu dữ liệu `ContractError` được phân biệt theo trường mã lỗi `code`:
- **Lỗi không thể thử lại ngay (Non-retryable)**: Các lỗi thẩm định (`validation`), yêu cầu hủy (`cancellation`), truyền tin bất định (`unknown_delivery`), hỏng dữ liệu (`corruption`), phiên bản không hỗ trợ (`unsupported_version`) và không tìm thấy thực thể (`not_found`).
- **Lỗi có thể thử lại có điều kiện (Retryable with preconditions)**: Các lỗi xung đột dữ liệu (`conflict`), quá thời gian chờ (`timeout`) và tầng truyền tải không khả dụng (`transport_unavailable`) chỉ được phép thử lại sau khi đã thỏa mãn các điều kiện tiên quyết (ví dụ: tải lại trạng thái mới nhất sau khi gặp xung đột).
- **Lỗi truyền tin bất định (`unknown_delivery`)**: Khi một yêu cầu đã vượt qua ranh giới tầng truyền tải nhưng không thể xác nhận phản hồi, hệ thống trả về `unknown_delivery` với cờ `retryable: false`, bắt buộc phải qua đối soát (reconciliation) hoặc xử lý thủ công; bên gọi tuyệt đối không được tự ý diễn giải thành lỗi timeout thông thường để gửi lại.

Các luồng dữ liệu bất đồng bộ (async stream: `read`, `get` của artifact và `watch` của runtime) đều phát ra `OperationResult<T>` nhằm đảm bảo lỗi ở từng phần tử đều mang kiểu dữ liệu rõ ràng.

Đối tượng `OperationOptions` cung cấp tín hiệu hủy hợp tác `AbortSignal`, thời gian chờ tương đối và hạn chót tuyệt đối (deadline). Việc hủy chờ ở client cục bộ không đồng nghĩa với việc tác vụ thực thi từ xa đã dừng lại.

---

## 2. Dữ liệu cốt lõi và các Bất biến Hệ thống

| Tên Hợp đồng | Cam kết được bảo đảm bởi Schema / Pure Validator |
| :--- | :--- |
| **`WorkflowDefinition`** | Định danh tác vụ/cổng kiểm soát là duy nhất; liên kết cổng và điểm mút phụ thuộc hợp lệ; không chứa phụ thuộc trùng lặp; không có chu trình vòng lặp trong đồ thị DAG; giới hạn mức độ đồng thời dương. |
| **`TaskDefinition`** | Phân định vai trò và câu lệnh chỉ dẫn rõ ràng; quy định cấu hình thử lại, sửa đổi và thời gian chờ; cờ phê duyệt bắt buộc; liên kết cổng kiểm soát chất lượng tường minh. |
| **`AgentRequest`** | Định danh yêu cầu và lần thử; định vị đối tượng đích; số thứ tự lần thử; mốc thời gian; cấu hình retry/timeout và khóa lũy thừa của yêu cầu. |
| **`AgentExecutionHandle`** | Định danh thực thi/yêu cầu/lần thử bền vững; định vị đối tượng đích; nguồn gốc tương quan và con trỏ phục hồi tùy chọn. |
| **`AgentResult`** | Kết quả nghiệp vụ tách biệt hoàn toàn khỏi trạng thái tầng truyền tải; tương quan đã xác thực cho mọi kết quả kết luận; phân loại lỗi/tắc nghẽn theo từng trạng thái và thứ tự thời gian. |
| **`ArtifactProposal`** | Siêu dữ liệu ban đầu chưa được xác thực, chứa tên logic an toàn và kích thước/mã băm mong đợi. |
| **`ArtifactReference`** | Đánh dấu artifact đã lưu trữ tin cậy với ID an toàn, định dạng URI ràng buộc `artifact://store/id`, xác thực toàn vẹn bằng SHA-256 hoặc SHA-512. |
| **`ApprovalRequest` / `ApprovalDecision`** | Đối tượng mục tiêu mang kiểu cụ thể; phiên bản sửa đổi/thế hệ tác vụ; khóa lũy thừa; bằng chứng/phản hồi đi kèm và thông tin kiểm toán người thực hiện. |
| **`DomainEvent`** | Lược đồ sự kiện phiên bản 1; định danh luồng/tổng hợp và tải trọng dữ liệu nghiêm ngặt có phiên bản. |
| **`RecoveryCheckpoint`** | Lược đồ điểm kiểm tra phiên bản 1 đi kèm codec định danh (`snapshot-v1` hoặc `aggregate-v1`), vị trí luồng/phiên bản và trạng thái JSON. |

Hai hàm kiểm tra `validateTaskTransition` và `validateRunTransition` là các quy tắc chuẩn tắc kiểm soát sự chuyển trạng thái. Hàm `validateEventBatch` là điều kiện tiên quyết bắt buộc trước khi ghi nhận sự kiện nguyên tử vào cơ sở dữ liệu.

---

## 3. Giao diện Tầng truyền tải `AgentTransport`

- **`initialize`**: Trả về danh mục năng lực đã xác thực của tầng truyền tải, bao gồm khả năng hỗ trợ đối soát tương quan hay không.
- **`send`**: Trả về biên nhận gửi `AgentSubmissionReceipt`, tuyệt đối không phải là kết quả tác vụ. Trạng thái `accepted` cấp phát handle thực thi; `rejected` chứng minh yêu cầu không được chấp nhận; `unknown_delivery` nghiêm cấm việc tự động gửi lại.
- **`reconcile`**: Sử dụng ID yêu cầu, ID lần thử, khóa lũy thừa và định vị đích để đối soát. Trả về `bound`, `not_delivered` (kết quả mơ hồ duy nhất an toàn để gửi lại), hoặc `unknown_delivery` đòi hỏi can thiệp thủ công.
- **`read`**: Phát luồng các thông điệp và đề xuất artifact theo handle thực thi và con trỏ vị trí.
- **`wait`**: Trả về dữ liệu quan sát tầng truyền tải `AgentTransportObservation`. Các trạng thái như `done` hay `blocked` chỉ phản ánh sự kiện truyền tải, không đại diện cho kết quả tác vụ thành công hay thất bại.
- **`cancel`**: Gửi yêu cầu hủy từ xa và ghi nhận phản hồi chấp nhận hoặc từ chối; không xác nhận việc tiến trình đã dừng hẳn.

Thứ tự đảm bảo tính bền vững: Ghi nhận ý định phân phối (`dispatch intent`) $\to$ Gửi qua tầng truyền tải $\to$ Lưu sự kiện `agent.execution_bound` trước khi sử dụng handle. Nếu tiến trình sập nguồn giữa bước gửi và liên kết, cơ chế khôi phục sẽ dựa vào thông tin đã lưu để tiến hành đối soát.

---

## 4. Bộ máy Quy trình `WorkflowEngine`

Động cơ quy trình thực hiện thẩm định định nghĩa; khởi tạo, tiến bước và tái thiết lập ảnh chụp trạng thái snapshot; kiểm tra tính hợp lệ của các bước chuyển trạng thái tác vụ; liên kết handle thực thi; ghi nhận kết quả đối soát truyền tin và kết quả agent đã xác thực; yêu cầu và áp dụng phê duyệt cùng đánh giá chất lượng; đồng thời ghi nhận xác nhận hủy bỏ. Mọi lệnh làm thay đổi trạng thái đều bắt buộc phải mang phiên bản tổng hợp kỳ vọng và/hoặc khóa lũy thừa tương ứng.

Engine nắm giữ quyền đưa ra các quyết định nhưng không trực tiếp thực hiện thao tác I/O ngoại vi. Bên gọi có trách nhiệm lưu trữ các sự kiện phát ra một cách nguyên tử trước khi thực thi các tác dụng phụ tiếp theo. Lệnh `recordAgentResult` sẽ chủ động từ chối các quan sát chưa được xác thực (`unverified`) ngay tại ranh giới Zod schema.

Mỗi thay đổi trạng thái thành công đều kết thúc bằng sự kiện `command.completed` chứa biên nhận có phiên bản: định danh lệnh, khóa lũy thừa, mã băm SHA-256 của lệnh đã thẩm định, số thứ tự sự kiện đầu tiên và danh sách tác vụ đủ điều kiện chạy (`runnable tasks`). Cùng một khóa với cùng mã băm sẽ trả về kết quả ban đầu; nếu mã băm khác biệt sẽ báo lỗi xung đột.

---

## 5. Tầng Lưu trữ Lịch sử `RunStore`

- **`appendEvents`**: So sánh phiên bản kỳ vọng (`expectedVersion`) một cách nguyên tử, kiểm tra số thứ tự cuối cùng kỳ vọng (`expectedLastSequence`), và ghi nhận lô sự kiện đã qua thẩm định.
- **Xử lý trùng lặp**: Tái tạo lại kết quả ban đầu và báo cáo ID sự kiện trùng lặp mà không gây ra tác dụng phụ mới.
- **Tính nguyên tử**: Bản ghi sự kiện và bản ghi chỉ mục/snapshot bắt buộc phải được duy trì trong cùng một giao dịch SQLite duy nhất.
- **`saveCheckpoint`**: Thực hiện theo cơ chế lạc quan (optimistic) và chỉ lưu trữ các điểm kiểm tra hoàn chỉnh đi kèm phiên bản codec hợp lệ.
- **Khôi phục trạng thái**: Thẩm định tính tương thích diễn ra trước khi phát lại (replay). Các checkpoint hỏng hoặc không được hỗ trợ sẽ bị loại bỏ để ưu tiên checkpoint hợp lệ trước đó hoặc thực hiện phát lại toàn bộ sự kiện từ đầu.

---

## 6. Kho lưu trữ Tạo phẩm `ArtifactStore`

Phương thức `put` tiếp nhận luồng dữ liệu byte cùng thông tin toàn vẹn kỳ vọng, chỉ trả về tham chiếu bất biến đáng tin cậy sau khi đã kiểm tra mã băm checksum, kích thước và lưu trữ bền vững xuống đĩa. Bên gọi tuyệt đối không được tự ý chuyển đổi ID artifact hay tên logic thành đường dẫn hệ thống tệp tin trực tiếp. Các thao tác `get`, `resolve`, `find` và `delete` chỉ được phép hoạt động trên các tham chiếu tin cậy và ID an toàn.

---

## 7. Đăng ký Vai trò và Cấp phát Tài nguyên `AgentRegistry`

Thao tác `resolve` đơn thuần là tra cứu cấu hình vai trò. Năng lực thực thi (capacity) được quản lý và bảo lưu thông qua các phương thức nguyên tử: `acquireLease`, `renewLease` và `releaseLease`. Bản hiện thực bắt buộc phải thực thi giới hạn số tác vụ đồng thời (`maxConcurrentTasks`), thời hạn hết hạn, phiên bản lease kỳ vọng, token hàng rào (`fencing token`) tăng đơn điệu và khóa lũy thừa trong cùng một giao dịch bền vững. Một fencing token cũ không bao giờ được phép phân phối công việc mới.

---

## 8. Cổng Kiểm soát Chất lượng `QualityGate`

Các cổng chất lượng ở cấp quy trình được liên kết từ tác vụ theo định danh và giai đoạn. Lệnh `EvaluateQualityGateCommand` (sự kiện `quality_gate.evaluation_requested`) lập lịch định danh đánh giá. Lệnh `RecordQualityGateResultCommand` (sự kiện `quality_gate.evaluated`) trả kết quả về quy trình dưới sự bảo vệ của phiên bản kỳ vọng và tính lũy thừa. Đầu ra ban đầu là đề xuất artifact chưa được xác thực cho đến khi được lưu trữ chính thức. Chỉ có Workflow Engine mới có quyền thay đổi trạng thái tác vụ hoặc lượt chạy.

---

## 9. Phê duyệt (Approval) và Sửa đổi (Rework)

Đối tượng mục tiêu của phê duyệt (`ApprovalTarget`) bắt buộc phải thuộc một trong ba loại: lượt chạy (`run`), tác vụ (`task`) hoặc cổng chất lượng (`quality gate`). Sự kiện yêu cầu phê duyệt (`approval.requested`) và quyết định phê duyệt (`approval.decided`) là các bản ghi độc lập. Quyết định phê duyệt chỉ áp dụng cho đúng ID phê duyệt, đối tượng, phiên bản sửa đổi và thế hệ tác vụ tương ứng. 

Quyết định yêu cầu sửa đổi (`changes_requested`) điều khiển việc chuyển đổi trạng thái sửa đổi một cách tường minh (`succeeded → ready` với thế hệ `generation + 1`), tuyệt đối không bao giờ cho phép chuyển trực tiếp từ trạng thái kết thúc sang trạng thái đang chạy (`running`). Số lần sửa đổi tối đa `maxReworks` đếm số lần chuyển thế hệ; thế hệ ban đầu (generation 0) là công việc gốc chứ không tính là sửa đổi.

---

## 10. Cơ chế Hủy bỏ Bất đồng bộ (Cancellation)

Quy trình hủy bỏ bao gồm ba giai đoạn bền vững:
1. `CancellationRequest` (sự kiện `cancellation.requested`): Ghi nhận ý định hủy bỏ của người dùng.
2. `CancellationResult`: Ghi nhận phản hồi chấp nhận hoặc từ chối từ tầng truyền tải.
3. `CancellationStopConfirmation` (sự kiện `cancellation.stop_confirmed`): Xác nhận tiến trình thực thi đã thực sự dừng hoàn toàn.

Chỉ khi nhận được sự chấp nhận hủy, trạng thái của quy trình mới chuyển sang `cancelling`. Nếu kết quả thành công hoặc thất bại của tác vụ được ghi nhận trước, chuyển trạng thái hoàn tất sẽ thắng; tín hiệu xác nhận hủy đến muộn sẽ được bảo lưu phục vụ kiểm toán chứ không ghi đè kết quả kết thúc. Xác nhận dừng của một tác vụ không chứng minh các tác vụ khác đã dừng hẳn.

---

## 11. Tính tương thích của Sự kiện và Điểm kiểm tra

Phiên bản lược đồ của sự kiện và checkpoint hiện tại là `1`. Khi phân tích cú pháp:
1. Phát hiện phiên bản tường minh; các dữ liệu thiếu trường này được coi là phiên bản kế thừa v0.
2. Nâng cấp siêu dữ liệu (upcast) cho các định dạng v0 đã biết mà không làm biến đổi tải trọng dữ liệu nghiệp vụ.
3. Thẩm định nghiêm ngặt theo lược đồ schema hiện hành.
4. Trả về mã lỗi `unsupported_version` nếu gặp phiên bản số không được hỗ trợ và `validation` nếu dữ liệu sai lệch định dạng.

Codec `bflow.workflow-aggregate+json` chứa toàn bộ ảnh chụp snapshot, trạng thái phê duyệt/cổng/hủy, lịch sử các lần thử thành công, lịch lập trình thử lại, cùng toàn bộ biên nhận và kết quả lệnh ban đầu. Quá trình phát lại phần đuôi (tail-only replay) bắt buộc phải sử dụng codec này. Hệ thống tuyệt đối không hỗ trợ hạ cấp phiên bản (downcasting).

---

## 12. Dịch vụ Điều phối `RuntimeService`

Đây là ranh giới cung cấp các ca sử dụng hướng tới giao diện dòng lệnh (CLI). Mọi thao tác và luồng sự kiện của Runtime đều tuân thủ cùng quy ước xử lý lỗi có kiểu chuẩn xác. Runtime chịu trách nhiệm tổ hợp tầng lưu trữ, động cơ quy trình, tầng truyền tải, registry quản lý vai trò, cổng chất lượng và kho artifact. Mã nguồn của ứng dụng CLI tuyệt đối không được can thiệp trực tiếp vào các bộ điều hợp cụ thể.

## Contracts v2 (nâng cấp Agentic SDLC P11)

Contracts v2 mở rộng `@bflow/contracts` để hỗ trợ kiến trúc agentic SDLC đa agent (P11–P19). Nó thêm 17 Zod schema có thẩm quyền, envelope `RoleMessage` giữa các agent được chuẩn hóa, và sự tách biệt ranh giới chặt chẽ giữa bốn state domain riêng biệt. Mọi schema thực thi parsing đầu vào strict (`.strict()`) và xử lý lỗi có kiểu qua `OperationResult<T>`.

### Bốn state domain tách biệt

Để ngăn sự ghép nối nguy hiểm giữa transport observation và business outcome, hệ thống tách biệt chặt chẽ bốn state domain trực giao:

| State Domain | Enum Type | Valid Values | Authority | Invariant Guarantee |
| --- | --- | --- | --- | --- |
| **Agent Transport State** | `AgentTransportState` | `starting`, `accepted`, `idle`, `working`, `blocked`, `done`, `unknown`, `disconnected`, `cancelled` | Herdr `AgentTransport` | Chỉ là transport observation. Herdr `done` **không bao giờ** chứng minh task hoàn thành hay thành công. |
| **SDLC Work Status** | `SdlcWorkStatus` (`TaskStatus`, `RunStatus`) | `intake`, `clarifying`, `specifying`, `planning`, `tdd_deciding`, `implementing`, `verifying`, `reviewing`, `awaiting_approval`, `completed`, `escalated`, `failed`, `cancelled` | `WorkflowEngine` & Quality Gates | Task success conclusive yêu cầu `AgentResult` đã correlate và artifact khách quan đã xác minh. |
| **Conversation Session Status** | `ConversationSessionStatus` | `active`, `awaiting_user_clarification`, `delegated_to_coordinator`, `reporting_progress`, `awaiting_user_approval`, `completed`, `paused`, `closed`, `archived` | `ConversationSessionManager` | Theo dõi vòng đời hội thoại hướng người dùng và quản lý lượt tương tác của con người. |
| **Approval Status** | `ApprovalStatus` | `pending`, `approved`, `changes_requested`, `rejected`, `expired`, `cancelled`, `superseded` | Governance Gates & Human Approvers | Quyết định của gate điều khiển execution transition; `changes_requested` điều khiển rework generation N -> N+1. |

### Envelope giao tiếp giữa các role (`RoleMessage`)

Mọi giao tiếp peer-to-peer và phân cấp truyền qua Herdr transport phải được bọc trong envelope strict `RoleMessageSchema` (bí danh `InterRoleMessageSchema`):


```ts
export const RoleMessageSchema = z.object({
  schema_version: z.literal(2),
  message_id: IdentifierSchema,
  correlation_id: IdentifierSchema,
  causation_id: IdentifierSchema.optional(),
  run_id: IdentifierSchema.optional(),
  sender: z.object({
    role: z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")]),
    agent_id: IdentifierSchema.optional(),
    pane_id: IdentifierSchema.optional()
  }).strict(),
  recipient: z.object({
    role: z.union([AgentRoleSchema, z.literal("user"), z.literal("runtime")]),
    agent_id: IdentifierSchema.optional(),
    pane_id: IdentifierSchema.optional()
  }).strict(),
  type: z.enum([
    "conversation.intake",
    "conversation.clarification",
    "conversation.progress",
    "delegation.request",
    "delegation.accepted",
    "spec.draft",
    "spec.approved",
    "tdd.decision",
    "task.assignment",
    "task.status",
    "implementation.submitted",
    "verification.requested",
    "verification.result",
    "verification.escalation",
    "review.verdict",
    "approval.request",
    "approval.decision"
  ]),
  payload: JsonValueSchema,
  artifact_references: z.array(ArtifactReferenceSchema),
  occurred_at: IsoDateTimeSchema.optional(),
  idempotency_key: IdempotencyKeySchema.optional(),
  metadata: MetadataSchema.optional()
}).strict();
```

### 17 Contracts v2

#### 1. `ConversationSession` (`ConversationSessionSchema`)
Biểu diễn vòng đời và state bền vững của một session hội thoại hướng người dùng:
- `schemaVersion`: `2` — Literal số, version 2.
- `sessionId`: `Identifier` — ID duy nhất của conversation session.
- `herdrSessionId`: `Identifier` — ID Herdr multi-pane session liên kết.
- `conversationAgentId`: `Identifier` — Identity của Conversation Agent được bind.
- `paneId`: `Identifier` — Terminal pane locator chứa Conversation Agent.
- `status`: `ConversationSessionStatus` — `"active" | "awaiting_user_clarification" | "delegated_to_coordinator" | "reporting_progress" | "awaiting_user_approval" | "completed" | "paused" | "closed" | "archived"`.
- `activeRunId`: `Identifier` (tùy chọn) — ID workflow run liên kết; bắt buộc khi `status` là `delegated_to_coordinator` trừ khi có `specificationId`.
- `specificationId`: `Identifier` (tùy chọn) — ID specification liên kết.
- `activeApprovalIds`: `Identifier[]` — Các ID human approval chưa giải quyết đang chờ trong session này.
- `turnCount`: `number` (số nguyên không âm) — Số lượt hội thoại đã hoàn thành.
- `unresolvedQuestions`: `string[]` — Các câu hỏi làm rõ đang chờ người dùng trả lời (độ dài tối thiểu 1 khi `status` là `awaiting_user_clarification`).
- `createdAt`, `updatedAt`: `IsoDateTime` — Timestamp ISO để audit.
- `closedAt`: `IsoDateTime` (tùy chọn) — Timestamp kết thúc session.
- `metadata`: `Metadata` (tùy chọn) — Ngữ cảnh session mở rộng được.

#### 2. `ConversationMessage` (`ConversationMessageSchema`)
Biểu diễn một lượt trao đổi hội thoại riêng lẻ giữa user, agent và runtime:
- `schemaVersion`: `2` — Literal số, version 2.
- `messageId`: `Identifier` — Identity duy nhất của message.
- `sessionId`: `Identifier` — ID conversation session liên kết.
- `correlationId`: `Identifier` — Token correlation của lượt.
- `runId`: `Identifier` (tùy chọn) — ID workflow run được bind.
- `turnSequence`: `number` (số nguyên không âm) — Bộ đếm sequence tăng nghiêm ngặt trong session.
- `sender`: `"user" | "conversation" | "coordinator" | "runtime"`.
- `recipient`: `"user" | "conversation" | "coordinator"` — Invariant: `sender` không được bằng `recipient`; sender `"user"` chỉ có thể gửi tới `"conversation"`, và recipient `"user"` chỉ có thể nhận từ `"conversation"`.
- `intent`: `"user_request" | "clarification_question" | "clarification_answer" | "spec_draft_review" | "delegation_handoff" | "progress_update" | "approval_prompt" | "approval_response" | "final_summary" | "error_report"`.
- `content`: `string` (tối thiểu 1 ký tự) — Nội dung văn bản cho con người đọc.
- `artifactReferences`: `ArtifactReference[]` — Các stored reference gắn với lượt.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (tùy chọn).

#### 3. `DelegationRequest` (`DelegationRequestSchema`)
Contract handoff chính thức giữa lớp conversation và lớp coordination:
- `schemaVersion`: `2` — Literal số, version 2.
- `delegationId`: `Identifier` — ID duy nhất của delegation request.
- `messageId`: `Identifier` — Identity của message gốc.
- `correlationId`: `Identifier` — Token truy vết.
- `sessionId`: `Identifier` — ID conversation session gốc.
- `runId`: `Identifier` (tùy chọn; bắt buộc khi `requestedBy` là `"coordinator"`).
- `requestedBy`: `"conversation" | "coordinator"` — Invariant: `"conversation"` chỉ có thể delegate tới `"coordinator"`; `"coordinator"` không thể delegate tới `"conversation"` hoặc `"coordinator"`.
- `targetRole`: `AgentRole` — Specialist role đích.
- `title`: `string` (tối thiểu 1 ký tự) — Tiêu đề mô tả ngắn.
- `objective`: `string` (tối thiểu 1 ký tự) — Mục tiêu delegation chi tiết.
- `specificationId`: `Identifier` — ID specification artifact được bind.
- `sddLevel`: `SddPolicyLevel` (`"lightweight" | "full"`).
- `acceptanceCriteria`: `AcceptanceCriterion[]` (tối thiểu 1 criterion).
- `tddDecision`: `TddDecision` (tùy chọn).
- `inputArtifacts`: `ArtifactReference[]` — Các reference ngữ cảnh đầu vào hỗ trợ.
- `priority`: `"low" | "normal" | "high" | "critical"`.
- `requestedAt`: `IsoDateTime`.
- `idempotencyKey`: `IdempotencyKey` — Chốt chặn khử trùng lặp.
- `metadata`: `Metadata` (tùy chọn).

#### 4. `AgentRole` & `AgentRoleProfile` (`AgentRoleSchema`, `AgentRoleProfileSchema`)
10 role chuẩn thay thế 4 role MVP:
- Giá trị enum: `"conversation" | "coordinator" | "planner" | "architect" | "specifier" | "developer" | "tester" | "reviewer" | "qa" | "security"`.
- `AgentRoleProfile` định nghĩa governance của role:
  - `role`: `AgentRole`.
  - `title`: `string`, `description`: `string`.
  - `defaultCapabilities`: `Identifier[]` (tối thiểu 1).
  - `allowedRecipients`: `(AgentRole | "user" | "runtime")[]` (tối thiểu 1; `"conversation"` chỉ được gồm `"user" | "coordinator" | "runtime"`, và các specialist role chỉ được gồm `"coordinator" | "runtime"`).
  - `canDelegateToSpecialist`: `boolean` — **System Invariant**: Phải là `true` CHỈ với `"coordinator"`; mọi role khác phải là `false`.
  - `userFacing`: `boolean` — **System Invariant**: Phải là `true` CHỈ với `"conversation"`; mọi role khác phải là `false`.
  - `readOnlyWorkspace`: `boolean`.
  - `requiresDedicatedPane`: `true` (literal `true`).
  - `requiresDedicatedPane`: `true` (literal `true`).

#### 5. `AgentCapability` (`AgentCapabilitySchema`)
Định nghĩa giới hạn năng lực vận hành, category và các tool được gán:
- `id`: `Identifier` — Identifier duy nhất của capability.
- `name`: `string`, `description`: `string`.
- `category`: `AgentCapabilityCategory` (`"conversation" | "coordination" | "specification" | "architecture" | "implementation" | "testing" | "verification" | "review" | "security"`).
- `readOnly`: `boolean` — Capability có hoạt động mà không mutate workspace hay không.
- `requiredTools`: `string[]` (tùy chọn) — Whitelist các CLI hoặc shell tool thực thi được.
- `metadata`: `Metadata` (tùy chọn).

#### 6. `AgentAssignment` (`AgentAssignmentSchema`)
Bản ghi bền vững bind một task execution với một agent instance, role và physical pane cụ thể:
- `schemaVersion`: `2` — Literal số, version 2.
- `assignmentId`: `Identifier` — ID duy nhất của assignment.
- `runId`: `Identifier`, `taskId`: `Identifier`, `delegationId`: `Identifier`.
- `role`: `AgentRole` — Invariant: `role` không được là `"conversation"`.
- `agentId`: `Identifier` — Identifier của agent instance đích.
- `paneId`: `Identifier` — Herdr terminal pane locator.
- `leaseId`: `Identifier` — Registry lease liên kết.
- `fencingToken`: `number` (số nguyên dương) — Fencing token đơn điệu bảo vệ transport dispatch.
- `requiredCapabilities`: `Identifier[]` — Các capability đã validate cho task.
- `assignedBy`: `"coordinator"` (literal).
- `assignedAt`: `IsoDateTime`.
- `status`: `"assigned" | "active" | "released" | "revoked" | "completed" | "failed"`.
- `worktreePath`: `string` (tùy chọn) — Đường dẫn tới git worktree cô lập.
- `idempotencyKey`: `IdempotencyKey`.
- `metadata`: `Metadata` (tùy chọn).

#### 7. `PaneBinding` (`PaneBindingSchema`)
Mô tả việc cấp phát vật lý một terminal pane trong một Herdr session multi-pane:
- `schemaVersion`: `2` — Literal số, version 2.
- `bindingId`: `Identifier` — ID duy nhất của pane binding.
- `sessionId`: `Identifier` — ID session manifest cha.
- `role`: `AgentRole` — Agent role được bind.
- `agentId`: `Identifier` — Agent instance được bind.
- `workspaceId`: `Identifier`, `tabId`: `Identifier`, `paneId`: `Identifier`.
- `terminalId`: `Identifier` (tùy chọn) — Herdr terminal handle liên kết.
- `session`: `AgentSessionLocator` (tùy chọn).
- `paneGroup`: `"conversation" | "coordination" | "verification" | "developer_worktree"` (tùy chọn) — Phân loại nhóm terminal tab/pane.
- `permanent`: `boolean` (tùy chọn) — Khai báo pane role là cố định (ví dụ Conversation, Coordinator) hay được spawn/hủy động (ví dụ Developer worktree).
- `provider`: `string`, `agentKind`: `string`, `model`: `string` (tùy chọn).
- `cwd`: `string`, `worktreePath`: `string` (tùy chọn).
- `isolationMode`: `"dedicated_pane"` (literal).
- `readOnlyWorkspace`: `boolean`.
- `transportState`: `AgentTransportState` (`"starting" | "accepted" | "idle" | "working" | "blocked" | "done" | "unknown" | "disconnected" | "cancelled"`).
- `boundAt`: `IsoDateTime`.
- `lastHeartbeatAt`: `IsoDateTime` (tùy chọn).
- `metadata`: `Metadata` (tùy chọn).

#### 8. `SessionManifest` (`SessionManifestSchema`)
Manifest định nghĩa topology, layout và state đang hoạt động của một Herdr session multi-pane:
- `schemaVersion`: `2` — Literal số, version 2.
- `sessionId`: `Identifier` — ID session manifest.
- `projectName`: `string`, `workspaceRoot`: `string`.
- `herdrWorkspaceId`: `Identifier`, `herdrTabId`: `Identifier`.
- `status`: `"initializing" | "up" | "degraded" | "stopping" | "down"`.
- `conversationSessionId`: `Identifier` — Conversation session identity được bind.
- `activeRunIds`: `Identifier[]` — Các workflow run ID đang hoạt động đồng thời.
- `panes`: `PaneBinding[]` (tối thiểu 1 pane; invariant: `paneId` duy nhất giữa mọi pane; `sessionId` của mỗi pane phải khớp; khi `status` là `"up"`, phải gồm cả pane `"conversation"` và `"coordinator"`).
- `attachTarget`: `{ role: "conversation", paneId: Identifier, terminalId?: Identifier }` — **Invariant**: `attachTarget.paneId` phải bằng `paneId` của conversation pane.
- `createdAt`, `updatedAt`: `IsoDateTime`.
- `stoppedAt`: `IsoDateTime` (tùy chọn).
- `metadata`: `Metadata` (tùy chọn).

#### 9. `Specification` (`SpecificationSchema`)
Requirements artifact có cấu trúc được tạo ra theo Spec-Driven Development (SDD):
- `schemaVersion`: `2` — Literal số, version 2.
- `specId`: `Identifier` — ID duy nhất của specification.
- `runId`: `Identifier` (tùy chọn).
- `sessionId`: `Identifier` — ID conversation session gốc.
- `level`: `SddPolicyLevel` (`"lightweight" | "full"`).
- `complexity`: `"trivial" | "standard" | "complex"` (tùy chọn; `ChangeComplexitySchema`) — Phân loại độ phức tạp thay đổi thích ứng, định hướng độ sâu requirement và testing.
- `riskLevel`: `"low" | "medium" | "high" | "critical"` (tùy chọn; `RiskLevelSchema`) — Đánh giá rủi ro chi phối tiêu chí review và approval.
- `version`: `number` (tùy chọn, số nguyên dương) — Bộ đếm revision đơn điệu cho sự tiến hóa của specification.
- `title`: `string` (đã trim, tối thiểu 1), `summary`: `string` (đã trim, tối thiểu 1), `problemStatement`: `string` (đã trim, tối thiểu 1).
- `scope`: `{ inScope: string[]; outOfScope: string[] }` (`inScope` tối thiểu 1 mục).
- `acceptanceCriteria`: `AcceptanceCriterion[]` (tối thiểu 1 mục; `id` trùng bị từ chối).
- `traceabilityTaskIds`: `Identifier[]` (tùy chọn) — Traceability hai chiều liên kết criteria với các node DAG của task.
- `affectedPaths`: `string[]` (tối thiểu 1 mục).
- `architectureNotes`: `string` (tùy chọn; **bắt buộc** khi `level` là `"full"`).
- `dataModelChanges`: `string` (tùy chọn).
- `securityConsiderations`: `string` (tùy chọn; **bắt buộc** khi `level` là `"full"`).
- `rollbackPlan`: `string` (tùy chọn; **bắt buộc** khi `level` là `"full"`).
- `testStrategy`: `TestStrategy` (tùy chọn; **bắt buộc** khi `level` là `"full"`).
- `tddDecision`: `TddDecision` (tùy chọn; **bắt buộc** khi `level` là `"full"`).
- `status`: `"draft" | "review_pending" | "approved" | "superseded" | "rejected"`.
- `artifactRef`: `ArtifactReference` (tùy chọn; **bắt buộc** khi `status` là `"approved"`).
- `createdBy`: `string`, `approvedBy`: `string` (tùy chọn; **bắt buộc** khi `status` là `"approved"`).
- `createdAt`, `updatedAt`: `IsoDateTime`.
- `metadata`: `Metadata` (tùy chọn).

#### 10. `AcceptanceCriterion` (`AcceptanceCriterionSchema`)
Acceptance criterion chính thức gắn với verification tự động hoặc qua gate:
- `id`: `Identifier` — Identifier duy nhất của criterion.
- `description`: `string` (đã trim, tối thiểu 1 ký tự).
- `category`: `"functional" | "non_functional" | "security" | "performance" | "edge_case" | "regression"`.
- `verificationMethod`: `"unit_test" | "integration_test" | "e2e_test" | "typecheck" | "lint" | "static_analysis" | "manual_review"`.
- `required`: `boolean`.
- `status`: `"pending" | "satisfied" | "failed" | "waived"`.
- `evidenceArtifactIds`: `ArtifactId[]` — Invariant: Cần tối thiểu 1 evidence artifact khi `status` là `"satisfied"`, trừ khi `verificationMethod` là `"manual_review"`.
- `waiverReason`: `string` (tùy chọn; **bắt buộc** khi `status` là `"waived"`).

#### 11. `TestStrategy` (`TestStrategySchema`)
Testing policy định hướng task verification và độ phủ criterion:
- `schemaVersion`: `2` — Literal số, version 2.
- `strategyId`: `Identifier` — Identifier của strategy.
- `specId`: `Identifier` — Identifier của specification được bind.
- `tddDecision`: `TddDecision` — Invariant: `tddDecision.specId` phải khớp `specId`.
- `requiredTestLevels`: `("unit" | "integration" | "e2e" | "property" | "regression" | "smoke")[]` — Invariant: Cần tối thiểu 1 level khi TDD mode là `"required"`.
- `targetCommands`: `string[]` — Invariant: Cần tối thiểu 1 target test command khi TDD mode là `"required"`.
- `coverageThresholdPercent`: `number` (tùy chọn, khoảng 0–100).
- `independentVerificationRequired`: `true` (literal `true`).
- `criterionMappings`: Mảng `{ criterionId: Identifier; testNames: string[] }`.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (tùy chọn).

#### 12. `TddDecision` (`TddDecisionSchema`)
Quyết định conditional TDD do Coordinator đánh giá:
- `schemaVersion`: `2` — Literal số, version 2.
- `decisionId`: `Identifier` — Identifier của decision.
- `runId`: `Identifier`, `taskId`: `Identifier` (tùy chọn), `specId`: `Identifier`.
- `mode`: `TddMode` (`"required" | "recommended" | "not_applicable"`).
- `rationale`: `string` (đã trim, tối thiểu 10 ký tự).
- `verifiableConditions`: `string[]` (tối thiểu 1 chuỗi condition không rỗng).
- `changeClassification`: `ChangeClassification` (`"domain_logic" | "bugfix" | "api_contract" | "refactoring" | "ui_layout" | "documentation" | "configuration" | "exploratory_spike"`).
- `requiresFailingTestFirst`: `boolean` — Invariant: Phải là `true` khi `mode` là `"required"`; phải là `false` khi `mode` là `"not_applicable"`; `"domain_logic"` và `"bugfix"` không thể được đánh dấu `"not_applicable"` nếu không có `metadata.humanOverrideApproved === true` tường minh.
- `decidedBy`: `"coordinator" | "planner" | "architect" | "human_operator"`.
- `decidedAt`: `IsoDateTime`.
- `verifiedByGateId`: `Identifier` (tùy chọn).
- `metadata`: `Metadata` (tùy chọn).

#### 13. `VerificationResult` (`VerificationResultSchema`)
Kết quả verification toàn diện do các evaluator độc lập tạo ra:
- `schemaVersion`: `2` — Literal số, version 2.
- `verificationId`: `Identifier` — ID của verification outcome.
- `runId`: `Identifier`, `taskId`: `Identifier`, `cycleNumber`: `number` (positive integer), `attemptId`: `Identifier`.
- `status`: `VerificationResultStatus` (`"passed" | "failed" | "inconclusive" | "blocked" | "escalated"`) — Phân loại verdict toàn diện. `"inconclusive"` chỉ các tín hiệu test mơ hồ hoặc finding chưa xác minh cần chạy lại.
- `verificationScope`: `"task" | "workflow"` (tùy chọn) — Phân biệt task-level verification với workflow-level verification sau tích hợp.
- `independentExecution`: `true` (literal `true`).
- `evaluatedCriteria`: Mảng `{ criterionId: Identifier; passed: boolean; command?: string; exitCode?: number; evidenceArtifactId: ArtifactId; summary: string }` (tối thiểu 1 mục; mọi `evidenceArtifactId` phải tồn tại trong `evidenceArtifacts`; khi `status` là `"passed"`, mọi criteria phải có `passed: true`).
- `qualityGateResults`: `QualityGateResult[]` — Invariant: Khi `status` là `"passed"`, mọi quality gate result phải có `status: "passed"`.
- `evidenceArtifacts`: `ArtifactReference[]` (tối thiểu 1 mục; tất cả phải khớp `runId`).
- `findings`: `QualityFinding[]` — Invariant: Khi `status` là `"passed"`, findings không được chứa severity `"error"`.
- `changeSet`: `GitChangeSet` (tùy chọn).
- `verifiedBy`: `"quality_gate" | "qa" | "reviewer" | "tester"`.
- `startedAt`, `completedAt`: `IsoDateTime` (invariant: `completedAt >= startedAt`).
- `metadata`: `Metadata` (tùy chọn).

#### 14. `VerificationCycle` & `VerificationEscalation` (`VerificationCycleSchema`)
State của một vòng verification lặp được giới hạn bởi `maxIterations`:
- `schemaVersion`: `2` — Literal số, version 2.
- `cycleId`: `Identifier`, `runId`: `Identifier`, `taskId`: `Identifier`, `specId`: `Identifier`.
- `verificationScope`: `"task" | "workflow"` (tùy chọn) — Phạm vi task-level so với workflow-level.
- `currentIteration`: `number` (số nguyên dương; không được vượt `maxIterations`).
- `maxIterations`: `number` (số nguyên từ 1 đến 10; mặc định: `3`).
- `status`: `"in_progress" | "passed" | "rework_required" | "escalated" | "aborted"` — Invariants: status `"passed"` yêu cầu `history` không rỗng với result cuối có status `"passed"`; khi `currentIteration === maxIterations` và result cuối là `"failed"` hoặc `"inconclusive"`, cycle không thể là `"rework_required"` và phải escalate hoặc abort.
- `tddDecision`: `TddDecision`.
- `history`: `VerificationResult[]`.
- `escalation`: `VerificationEscalation` (tùy chọn; **bắt buộc** khi `status` là `"escalated"`):
  - `escalatedAt`: `IsoDateTime`.
  - `reason`: `string` (tối thiểu 1 ký tự).
  - `target`: `"coordinator" | "human_operator"`.
  - `approvalRequestId`: `Identifier` (tùy chọn).
  - `evidenceArtifacts`: `ArtifactReference[]` (tối thiểu 1 mục).
- `startedAt`, `updatedAt`: `IsoDateTime`.
- `metadata`: `Metadata` (tùy chọn).

#### 15. `GitChangeSet` (`GitChangeSetSchema`)
Trạng thái thay đổi Git workspace được ghi nhận như một trusted artifact:
- `schemaVersion`: `2` — Literal số, version 2.
- `changeSetId`: `Identifier`, `runId`: `Identifier`, `taskId`: `Identifier`, `attemptId`: `Identifier`.
- `worktreePath`: `string`, `branchName`: `string`.
- `baseCommitHash`: `string` (7–40 ký tự hex).
- `headCommitHash`: `string` (7–40 ký tự hex).
- `dirtyWorkingTree`: `boolean`.
- `filesChanged`: `GitChangedFile[]` (tối thiểu 1 mục; `{ path: string; changeType: "added" | "modified" | "deleted" | "renamed"; previousPath?: string; additions: number; deletions: number }`; path phải là đường dẫn an toàn tương đối repo, không có directory traversal).
- `patchArtifact`: `ArtifactReference` — Invariants: `kind` phải là `"patch"`; `runId` phải khớp `runId` của changeSet.
- `createdAt`: `IsoDateTime`.
- `metadata`: `Metadata` (tùy chọn).

#### 16. Extended `ApprovalRequest` & `ApprovalDecision` (`approval.ts`)
Mở rộng discriminated union tương thích ngược, hỗ trợ 8 target type:
- `schemaVersion`: `1 | 2` (hỗ trợ cả record v1 và v2).
- `approvalId`: `Identifier`, `runId`: `Identifier`, `sessionId`: `Identifier` (tùy chọn).
- `status`: `ApprovalStatus` (tùy chọn; `"pending" | "approved" | "changes_requested" | "rejected" | "expired" | "cancelled" | "superseded"`).
- `expiresAt`: `IsoDateTime` (tùy chọn).
- `target`: `ApprovalTarget` discriminated union hỗ trợ:
  - `{ type: "run" }`
  - `{ type: "task", taskId: Identifier }`
  - `{ type: "quality_gate", taskId?: Identifier, gateId: Identifier }`
  - `{ type: "specification", specId: Identifier }`
  - `{ type: "tdd_decision", decisionId: Identifier, taskId?: Identifier }`
  - `{ type: "verification_escalation", cycleId: Identifier, taskId: Identifier }`
  - `{ type: "git_changeset", changeSetId: Identifier, taskId: Identifier }`
  - `{ type: "delegation", delegationId: Identifier }`
- `revision`: `number` (số nguyên dương), `generation`: `number` (số nguyên không âm).
- `requestedBy`: `string`, `requestedAt`: `IsoDateTime`, `reason`: `string`.
- `evidence`: `ArtifactReference[]`.
- `idempotencyKey`: `IdempotencyKey`.
- `metadata`: `Metadata` (tùy chọn).
- `ApprovalDecisionSchema`: `schemaVersion: 1 | 2`, `approvalId`, `runId`, `sessionId?`, `target`, `revision`, `generation`, `decision: "approved" | "rejected" | "changes_requested"`, `decidedBy`, `decidedAt`, `reason?` (bắt buộc với rejection/changes_requested), `feedbackArtifacts`, `idempotencyKey`, `metadata?`.

#### 17. Extended `RecoveryCheckpoint` (`execution.ts`, `recovery.ts`)
Mở rộng tương thích ngược của checkpoint envelope và aggregate state:
- **Envelope (`RecoveryCheckpointSchema`)**:
  - `checkpointSchemaVersion`: `1` (literal `1` tương thích ngược).
  - `codec`: Discriminated union `{ name: "bflow.workflow-run-snapshot+json", version: 1 }` | `{ name: "bflow.workflow-aggregate+json", version: 1 }`.
  - `checkpointId`: `Identifier`, `runId`: `Identifier`.
  - `sessionId`: `Identifier` (tùy chọn).
  - `conversationSessionId`: `Identifier` (tùy chọn).
  - `eventSequence`: `number`, `version`: `number`.
  - `state`: `JsonValue`, `resumeCursor`: `string` (tùy chọn).
  - `createdAt`: `IsoDateTime`, `metadata`: `Metadata` (tùy chọn).
- **State (`WorkflowAggregateCheckpointStateSchema`)**:
  - `schemaVersion`: `1`.
  - `snapshot`: `WorkflowRunSnapshot`.
  - `sdlcContext`: `SdlcRecoveryContext` (tùy chọn) gồm:
    - `conversationSession`: `ConversationSession` (tùy chọn).
    - `sessionManifest`: `SessionManifest` (tùy chọn).
    - `specifications`: `Specification[]` (tùy chọn).
    - `activeAssignments`: `AgentAssignment[]` (tùy chọn).
    - `verificationCycles`: `VerificationCycle[]` (tùy chọn).
    - `gitChangeSets`: `GitChangeSet[]` (tùy chọn).
  - `approvals`, `gateRequests`, `gateOutcomes`, `successfulAttempts`, `cancellations`, `retrySchedules`, `attemptBaselines`, `commands`.

#### 18. `RoleMessage` / `InterRoleMessage` (`session.ts`)
Envelope peer-to-peer và phân cấp được chuẩn hóa trên Herdr transport:
- `schema_version`: `2` (literal 2).
- `message_id`: `Identifier`, `correlation_id`: `Identifier`.
- `causation_id`: `Identifier` (tùy chọn).
- `run_id`: `Identifier` (tùy chọn; **bắt buộc** với mọi type trừ `"conversation.intake"` và `"conversation.clarification"`).
- `sender`: `{ role: AgentRole | "user" | "runtime", agent_id?: Identifier, pane_id?: Identifier }`.
- `recipient`: `{ role: AgentRole | "user" | "runtime", agent_id?: Identifier, pane_id?: Identifier }`.
- `type`: `RoleMessageType` (17 wire type riêng biệt: `"conversation.intake" | "conversation.clarification" | "conversation.progress" | "delegation.request" | "delegation.accepted" | "spec.draft" | "spec.approved" | "tdd.decision" | "task.assignment" | "task.status" | "implementation.submitted" | "verification.requested" | "verification.result" | "verification.escalation" | "review.verdict" | "approval.request" | "approval.decision"`).
- `payload`: `JsonValue`.
- `artifact_references`: `ArtifactReference[]` (tất cả phải khớp `run_id` khi có).
- `occurred_at`: `IsoDateTime` (tùy chọn).
- `idempotency_key`: `IdempotencyKey` (tùy chọn).
- `metadata`: `Metadata` (tùy chọn).

#### 19. Environment Doctor Contracts (`EnvironmentDoctorCheck`, `EnvironmentDoctorReport`)
Được dùng bởi `bflow doctor` (P12) và `SessionLifecycleManager.doctorSession` để kiểm tra các điều kiện tiên quyết của môi trường:
- `EnvironmentDoctorCheck` (`EnvironmentDoctorCheckSchema`): Kết quả một system check riêng lẻ:
  - `checkId`: `Identifier` — Identifier duy nhất của check.
  - `name`: `string` (đã trim, tối thiểu 1).
  - `status`: `"passed" | "warn" | "failed"`.
  - `message`: `string` (đã trim, tối thiểu 1).
  - `remediation`: `string` (tùy chọn, đã trim, tối thiểu 1).
- `EnvironmentDoctorReport` (`EnvironmentDoctorReportSchema`): Doctor report tổng hợp:
  - `schemaVersion`: `2` (literal 2).
  - `workspaceRoot`: `string` (đã trim, tối thiểu 1).
  - `sessionId`: `Identifier` (tùy chọn).
  - `healthy`: `boolean` — Invariant: Không được là `true` khi bất kỳ check nào trong `checks` có `status === "failed"`.
  - `checks`: `EnvironmentDoctorCheck[]` (tối thiểu 1 check).
  - `checkedAt`: `IsoDateTime`.
  - `metadata`: `Metadata` (tùy chọn).
- `SessionLifecycleManager.doctorSession(options: { workspaceRoot: string }): Promise<EnvironmentDoctorReport>`: Port interface chạy bộ doctor trên môi trường.

## Contracts v3 (P24 platform baseline)

P24 thêm các root document additive với `schemaVersion: 3` (`CURRENT_PLATFORM_SCHEMA_VERSION`), strict parsing; nested value objects thừa hưởng version của envelope. Không đổi signature port cũ, RoleMessage v2, SessionManifest v2, event/checkpoint codec. Version khác 3 phải trả `unsupported_version`; v3 malformed trả `validation`. Quyết định D24-01 và kế hoạch compatibility ở [runtime architecture v3](runtime-architecture-v3.md). Tất cả được export từ barrel `packages/contracts/src/index.ts`.

| File | Exports chính | Thiết kế chi tiết |
| --- | --- | --- |
| `platform.ts` | `AgentProviderIdSchema` (`claude`/`codex`/`agy`), `ConfigurationLevelSchema` (`machine`/`repository`/`session`), `TrustScopeSchema` + `isTrustScopeWithin`, `ScopedOperationSchema`, `Sha256DigestSchema`, `SecretReferenceSchema`, `SafeArgumentSchema` | [runtime v3](runtime-architecture-v3.md) |
| `provider.ts` | `PermissionProfileSchema`, `AgentEnvironmentSchema`, `AgentProviderDescriptorSchema`, `AgentLaunchProfileSchema`, `AgentLaunchAttestationSchema`, `AgentHealthRequestSchema`/`AgentHealthResultSchema`, `AGENT_HEALTH_CHECKS`, port `AgentProviderAdapter` | [provider contracts](provider-contracts.md) |
| `setup.ts` | `ToolCapabilitySchema`, `ToolInstallRequestSchema`, `SetupStepSchema`, `MachineSetupPlanSchema`, `SetupReceiptSchema`, `SetupApplyRequestSchema`, port `ToolInstaller` | [runtime v3 §4](runtime-architecture-v3.md) |
| `mcp.ts` | `MCPEndpointSchema`, `MCPServiceDefinitionSchema`, `MCPClientRegistrationSchema`, `MCPServiceObservationSchema`, `MCPResourceLeaseSchema`/`MCPResourceRequestSchema`/`MCPResourceRenewRequestSchema`, `MCPToolCallSchema`/`MCPToolCallResultSchema`, ports `MCPServiceManager`, `SharedMCPGateway` | [shared MCP](shared-mcp-architecture.md) |
| `skills.ts` | `SkillPinSchema`, `SkillDefinitionSchema`, `RoleSkillBindingSchema`, `SkillManifestSchema` | [skills](skills-architecture.md) |
| `commands.ts` | `BflowCommandSchema`, `CommandExecutionResultSchema`, port `BflowCommandExecutor` | [runtime v3 §7](runtime-architecture-v3.md) |

Các package leaf P25–P29 phân tích dữ liệu trao đổi bằng các schema này (ví dụ `agent-providers` với `AgentHealthRequestSchema`/`AgentLaunchProfileSchema`). Một số tham số package-local (metadata skill, `.bflow/skills.json`, request của machine-setup) dùng schema strict riêng và không phải public contract. `SkillManager` là class của `@bflow/skills`; contracts v3 chỉ có data schemas cho skills, không có port `SkillManager`. Ngoài các contract trên, `EnvironmentDoctorReportSchema` vẫn ở `schemaVersion: 2`; chi tiết check theo nhóm của `bflow doctor` hiện nằm trong CLI, chưa là contract public.


## D-TOOLS-01 — additive tool policy và usage contracts

Quyết định được duyệt trong [tools design](superpowers/specs/2026-10-24-tools-sdlc-design.md), triển khai sau P24. Không đổi RoleMessage v2, SessionManifest v2, RuntimeService hay Core event/checkpoint/SQL formats.

| Export/source | Phạm vi |
| --- | --- |
| [`tool-policy.ts`](../packages/contracts/src/tool-policy.ts) | `RepositoryToolPolicySchema`, `RoleToolRequirementSchema`, `ResolvedToolGrantSchema`, `ToolActionRequestSchema`; strict v3, phân biệt catalog ID/service/operation, role, trigger, scope và executable identity |
| [`tool-usage.ts`](../packages/contracts/src/tool-usage.ts) | `ToolUsageRecordSchema`; invocation disposition, consumption và trusted artifact evidence riêng |

Các schema parse ingress/egress; Runtime/Gateway vẫn xác minh authority, digest, lease/fence và runtime provenance. Schema hợp lệ không chứng minh tool đã invoked, output consumed hoặc task thành công. [Integration guide](tools-sdlc-integration.md) mô tả default-policy composition và migration hiện tại.


## Runtime-private additions after the documentation baseline

- **[Rework dossiers & per-finding verdicts](rework-causality.md)**: Use strict Runtime-local codecs (`schemaVersion: 1`), an optional journal/checkpoint `reworkResolutions` history, and required per-finding `findingVerdicts` covering every finding of the current generation. They are not new exports of `@bflow/contracts` and do not change RoleMessage v2, SessionManifest v2, RuntimeService, Core event/checkpoint codecs or SQL schema. The host validates their identity/revision/generation and trusted artifact references at its ingress.
- **[Test-integrity gate (`host-test-integrity`)](../packages/runtime/TEST-INTEGRITY-VALIDATION.md)**: Uses Runtime-private schemas (`test-integrity.ts`, `schemaVersion: 1`) for AST-based test/config weakening candidates, Reviewer adjudications (`TestIntegrityVerdictSchema`) and per-candidate owner exceptions (`TestIntegrityExceptionRecordSchema`).
- **[Fast-path review waivers](adr/0004-fast-path-review-waiver.md) & [regression scope](verification-runners.md#regression-scope-verificationregressionscope)**: Add optional `ReviewWaiverSchema` (`deterministic_coverage` / `identical_integrated_tree`) in `@bflow/verification` and Runtime-private `fastPath` / `host-regression-<profile.id>` records without altering `@bflow/contracts`.
- **[Task handovers](../packages/runtime/README.md#bàn-giao-tác-vụ-task-handover) & MCP compact/cursor tools**: `TaskHandoverRecordSchema` (`schemaVersion: 1` in `packages/runtime/src/agentic/task-handover.ts`), `propose_task_handover`, `read_task_handover`, `read_project_policy` and `read_mcp_output_page` are host MCP tools and Runtime-private journal structures.
- **[Read-only workflow telemetry](../packages/runtime/TELEMETRY-SPEC.md)**: `WorkflowTelemetryReportSchema` (`schemaVersion: 1` in `packages/runtime/src/agentic/workflow-telemetry.ts`) powers `bflow status <run-id> --telemetry [--json]` via the agentic host control socket without changing public `@bflow/contracts`.
- **[Browser MCP resource transactions](../packages/runtime/src/platform/browser-resource-transactions.ts)**: `BrowserResourceTransactions` persists `gen-N/browser-resource-transactions.json` (`schemaVersion: 1`) using the existing v3 `MCPResourceRequestSchema` / `MCPResourceLeaseSchema` contracts.
- **Conversation short aliases**: Optional fields in Conversation's private snapshot/notice receipts, not replacement wire IDs. `read_updates` is a host MCP tool, not a new `BflowCommand` or independent approval API. [Conversation guide](guide/conversation-updates.md).
- **NFR guidance**: Uses the existing `AcceptanceCriterion.description`, categories and `verificationMethod` enum; it adds no metric/threshold fields, SLA defaults or metadata protocol. [NFR/test design](nfr-and-test-design.md).
