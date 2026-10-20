# Public contracts

Toàn bộ schema công khai, type suy ra, pure validator và port được export từ `@bflow/contracts`. Zod schema là thẩm quyền runtime tại ingress của package. Các exchange object là strict; field không biết sẽ bị từ chối trừ khi một schema version sau này bổ sung tường minh.

## Quy ước về lỗi và bất đồng bộ

Các thao tác Promise công khai trả về `OperationResult<T>`:

```ts
type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };
```

`ContractError` là discriminated theo `code`. Các lỗi validation, cancellation, unknown delivery, corruption, unsupported version và not-found là không thể retry theo như nhận được. Các lỗi conflict, timeout và transport-unavailable chỉ có thể retry sau khi thỏa điều kiện tiên quyết được tài liệu hóa (ví dụ, reload sau conflict). Một `timeout` khai báo rằng thao tác chưa bắt đầu hoặc chỉ là observation. Một lần gửi có thể đã vượt qua ranh giới transport thì thay vào đó là `unknown_delivery`, luôn có `retryable: false`, và cần reconciliation/xử lý thủ công; caller không được diễn giải lại nó thành một timeout retry được thông thường.

Các async stream (`read`, artifact `get` và runtime `watch`) yield `OperationResult<T>` để các lỗi ở cấp item vẫn có kiểu. Một triển khai vẫn có thể bị JavaScript runtime làm gián đoạn, nhưng phải chuyển các lỗi domain/hạ tầng dự kiến thành `ContractError`.

`OperationOptions` cung cấp `AbortSignal` hợp tác, timeout tương đối và deadline tuyệt đối. Việc hủy chờ cục bộ không chứng minh việc hủy một remote execution.

## Dữ liệu cốt lõi và bất biến

| Contract | Được bảo đảm bởi schema/pure validator |
| --- | --- |
| `WorkflowDefinition` | Task/gate ID duy nhất, gate binding và dependency endpoint hợp lệ, không có dependency trùng, không có chu trình DAG, concurrency dương có giới hạn |
| `TaskDefinition` | Role/instruction, retry/rework/timeout, cờ approval, quality-gate binding tường minh |
| `AgentRequest` | Request và attempt identity, target locator, số attempt, thời gian, retry/timeout, idempotency của agent-request |
| `AgentExecutionHandle` | Execution/request/attempt identity bền vững, target locator, nguồn gốc correlation, recovery cursor tùy chọn |
| `AgentResult` | Business outcome tách biệt khỏi transport state; correlation đã xác minh cho mọi outcome conclusive; lỗi/blockage theo từng status và thứ tự timestamp |
| `ArtifactProposal` | Metadata không đáng tin với logical name an toàn và checksum/size kỳ vọng |
| `ArtifactReference` | Marker stored đáng tin, ID opaque an toàn, URI `artifact://store/id` có ràng buộc, mã hóa SHA-256/SHA-512 chính xác |
| `ApprovalRequest` / `ApprovalDecision` | Target có kiểu bắt buộc, revision/generation, idempotency, evidence/feedback và thời gian/actor audit |
| `DomainEvent` | Event schema v1 cùng stream/aggregate identity và payload strict có version |
| `RecoveryCheckpoint` | Checkpoint schema v1 cùng codec snapshot-v1 hoặc aggregate-v1 có tên, vị trí stream/version và state JSON |

`validateTaskTransition` và `validateRunTransition` là các quy tắc transition chuẩn tắc. `validateEventBatch` là tiền điều kiện chuẩn tắc cho append nguyên tử. Các Zod command/event schema gọi transition hoặc batch validator tương ứng.

## `AgentTransport`

- `initialize` trả về các transport capability đã xác minh, bao gồm việc submission correlation có sẵn hay không.
- `send` trả về `AgentSubmissionReceipt`, không phải task result. `accepted` có handle; `rejected` chứng minh không có submission nào được chấp nhận; `unknown_delivery` cấm resend.
- `reconcile` dùng request ID, attempt ID, idempotency key và target locator. Nó trả về `bound`, `not_delivered` (outcome mơ hồ duy nhất an toàn để retry), hoặc `unknown_delivery` yêu cầu can thiệp thủ công.
- `read` stream các transport message/proposal theo execution handle và cursor.
- `wait` trả về `AgentTransportObservation`. Các state như `done` và `blocked` là sự kiện transport và không hàm ý task outcome `succeeded` hay failed.
- `cancel` yêu cầu hủy từ xa và trả về chấp nhận/từ chối; nó không bao giờ xác nhận execution đã dừng.

Thứ tự bền vững là dispatch intent -> send -> persist `agent.execution_bound` trước khi dựa vào handle. Nếu process lỗi giữa send và binding, recovery dùng request identity/target đã persist để reconcile. Một transport không thể correlate prompt phải dùng orchestrator token được đánh dấu unverified và không được tạo ra task success đã xác minh.

## `WorkflowEngine`

Engine validate definition; tạo/advance/dựng lại snapshot; validate các task transition tường minh; bind execution handle; ghi lại delivery reconciliation và agent result đã xác minh; yêu cầu/áp dụng approval và quality evaluation; và ghi lại cancellation acceptance/confirmation. Mọi mutating command mang expected aggregate version và/hoặc idempotency identity tùy trường hợp.

Engine sở hữu các quyết định nhưng không sở hữu I/O bên ngoài. Caller persist các event phát ra một cách nguyên tử trước khi thực thi các side effect dẫn xuất. `recordAgentResult` từ chối các observation `unverified` tại ranh giới Zod của nó.

Mỗi mutation thành công kết thúc bằng một event `command.completed` chứa receipt có version: command identity, idempotency key, fingerprint SHA-256 của command đã validate, event sequence đầu tiên của command, và các runnable task ID. Receipt không chứa payload command thô. Cùng key với cùng fingerprint trả về result gốc; fingerprint khác thì conflict. `task.retry_scheduled` ghi lại timestamp eligibility xác định. Runtime phải persist toàn bộ event batch trả về trước khi hành động trên các runnable task; Core không hứa hẹn exactly-once execution phân tán.

`createCheckpoint` là thao tác engine chỉ đọc với expected aggregate version. Nó xuất một aggregate checkpoint hoàn chỉnh cho `RunStore.saveCheckpoint`; checkpoint chỉ có snapshot là không đủ cho tail-only recovery.

## `RunStore`

- `appendEvents` so sánh `expectedVersion` một cách nguyên tử, kiểm tra `expectedLastSequence`, và append batch đã validate.
- Việc xử lý command trùng lặp phải dựng lại outcome gốc và báo cáo event ID trùng mà không có side effect mới.
- Hàng event và hàng snapshot/index được duy trì phải chung một SQLite transaction.
- `saveCheckpoint` là optimistic và chỉ lưu checkpoint hoàn chỉnh có codec version.
- Compatibility parsing diễn ra trước replay. Các checkpoint không được hỗ trợ/hỏng bị loại bỏ để ưu tiên checkpoint trước đó/full replay theo persistence policy trong tương lai.

P00 định nghĩa các nghĩa vụ này nhưng không chọn SQLite driver hay migration framework.

## `ArtifactStore`

`put` nhận byte cùng integrity kỳ vọng và chỉ trả về reference bất biến đáng tin sau khi xác minh checksum/size và đặt bền vững. Caller không bao giờ được biến artifact ID hay logical name thành đường dẫn filesystem. `get`, `resolve`, `find` và `delete` được lifecycle cho phép hoạt động trên reference đáng tin/ID opaque. Việc sinh URI và canonical path containment vẫn là trách nhiệm của triển khai.

## `AgentRegistry`

`resolve` chỉ là tra cứu cấu hình. Capacity được giữ chỗ riêng qua `acquireLease`, `renewLease` và `releaseLease` nguyên tử. Các triển khai phải thực thi `maxConcurrentTasks`, expiry, expected lease version, fencing token tăng đơn điệu và idempotency trong cùng một durable transaction. Một fence cũ không bao giờ được dispatch công việc.

## `QualityGate`

Các định nghĩa gate cấp workflow được bind từ task theo ID và phase. `EvaluateQualityGateCommand`/`quality_gate.evaluation_requested` lập lịch một evaluation identity. `RecordQualityGateResultCommand`/`quality_gate.evaluated` trả nó về workflow dưới sự bảo vệ của expected-version và idempotency. Output tạo ra là artifact proposal không đáng tin cho đến khi được lưu. Chỉ workflow engine mới thay đổi task/run state.

## Approval và rework

`ApprovalTarget` chính xác là một trong run, task hoặc quality gate. `approval.requested` và `approval.decided` là các event bền vững riêng biệt. Decision chỉ áp dụng cho cùng approval ID, target, revision và generation; engine trong tương lai phải từ chối các decision cũ hoặc trùng lặp một cách idempotent. `changes_requested` điều khiển rework transition tường minh (`succeeded -> ready`, generation +1), không bao giờ là transition trực tiếp từ terminal sang running.

`ReworkPolicy.maxReworks` đếm các transition từ generation N sang N+1; generation zero là công việc gốc, không phải rework. `maxAttempts` của retry áp dụng riêng trong từng generation, dù `TaskState.attempt` công khai vẫn là attempt identity tăng đơn điệu toàn run. Khi cạn, `fail` làm run terminal failed trong khi `require_human` chặn run mà không tăng generation; một approval sau này có revision cao hơn có thể gỡ chặn. Các definition cũ không có `rework` vẫn hợp lệ theo schema và được Core xử lý như `{ maxReworks: 0, onExhausted: "fail" }`, nên definition cũ không được rework không giới hạn.

## Cancellation

Cancellation có ba giai đoạn bền vững:

1. `CancellationRequest` / `cancellation.requested` có version ghi lại intent;
2. `CancellationResult` / event accepted hoặc refused ghi lại phản hồi của transport;
3. `CancellationStopConfirmation` / `cancellation.stop_confirmed` ghi lại việc dừng terminal đã quan sát.

Chỉ acceptance thì state vẫn là `cancelling`. Nếu success/failure được quan sát trước, transition hợp lệ cho phép completion thắng; cancellation acknowledgement đến muộn được giữ lại để audit nhưng không được ghi đè terminal outcome.

Một cancellation toàn run có thể bao phủ nhiều execution đã bind. Mỗi `cancellation.stop_confirmed` xác định một execution đã dừng; aggregate checkpoint giữ các confirmation riêng biệt cho cùng cancellation ID. Xác nhận một execution không bao giờ chứng minh các execution khác đã dừng.

## Tương thích event/checkpoint

Event và checkpoint schema version hiện tại là `1`. Định dạng P00 gốc được gọi là legacy v0 vì nó thiếu các field này. `parseDomainEventWithCompatibility` và `parseRecoveryCheckpointWithCompatibility`:

1. phát hiện version tường minh, coi version thiếu là v0;
2. upcast metadata envelope/codec v0 đã biết mà không thay đổi domain payload;
3. validate schema strict hiện tại;
4. trả về `unsupported_version` cho các version số không biết và `validation` cho dữ liệu sai định dạng.

Sau khi parse envelope, `decodeWorkflowRunCheckpointState` validate JSON của checkpoint theo schema `WorkflowRunSnapshot` của codec và trả về `corruption` nếu không khớp. Recovery không được tin field JSON opaque nếu thiếu bước codec dispatch này.

P01 thêm codec `bflow.workflow-aggregate+json`, được giải mã bởi `decodeWorkflowAggregateCheckpointState`. Nó chứa snapshot, trạng thái approval/gate/cancellation, các attempt thành công, retry schedule và attempt baseline, cùng các command receipt/result gốc. Tail-only replay yêu cầu codec này. Một legacy snapshot checkpoint chỉ có thể bị bỏ qua khi có các event từ `run.created` trở đi để full replay. Các lịch sử event có trước `command.completed` không thể dựng lại an toàn idempotency command chính xác và phải được migrate từ các command receipt có thẩm quyền hoặc bị từ chối; không có identity nào bị bịa ra. Checkpoint không được hỗ trợ hoặc hỏng sẽ fail closed trong Core.

Không hỗ trợ downcasting. Một thay đổi schema trong tương lai phải bổ sung upcaster tường minh và fixture trước khi producer phát ra nó. Aggregate version và event sequence không bao giờ được dùng làm schema version.

Helper v0 chỉ cung cấp metadata version/codec khi domain payload vốn đã tương thích. Các event kind baseline có payload bắt buộc đã thay đổi (ví dụ chi tiết execution/result/approval) cố ý fail ở validation hiện tại thay vì bịa identity hay bằng chứng tin cậy. Nếu tồn tại dữ liệu prototype như vậy, persistence phase phải cung cấp migration từng event tường minh hoặc replay từ nguồn có thẩm quyền; P00 không lặng lẽ bịa ra các sự thật còn thiếu.

## `RuntimeService`

Đây là ranh giới use-case hướng CLI. Các thao tác và event stream của nó dùng cùng quy ước lỗi có kiểu. Runtime sẽ compose store, engine, transport, registry, gate và artifact trong khi giữ nguyên thứ tự ở trên. Code CLI không được chạm tới concrete adapter.

## Chính sách tương thích

Bản hardening này cố ý phá vỡ bootstrap `8d960d0` ban đầu trước khi việc triển khai downstream bắt đầu. Chi tiết migration nằm trong `docs/adr/0001-p00-contract-hardening.md`. Sau khi branch này được chấp nhận làm baseline P00, các thay đổi về field bắt buộc, method signature, ngữ nghĩa event hoặc idempotency cần có quyết định tích hợp, kế hoạch migration/upcast và sự chấp thuận của owner bị ảnh hưởng.

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
