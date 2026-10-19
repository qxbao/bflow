# `@bflow/conversation` — Conversation Agent & Delegation Gateway

> **Phase**: `P14` (Wave B — Bflow Agentic SDLC v2)
> **Package**: `@bflow/conversation`
> **Agent Implementation**: `agents/chat` (`role: "conversation"`, `agentId: "chat"`)
> **Herdr Target**: `bflow attach` connects exclusively to the `chat` pane (`paneGroup: "conversation"`)

---

## 1. Overview & Architectural Role

In Bflow Agentic SDLC v2, `@bflow/conversation` implements the **Conversation Agent** (`chat`) and the **Delegation Gateway**. It is the **single user-facing touchpoint** in the entire multi-agent system.

```
                                      +------------------------------------+
                                      |            Human User              |
                                      +------------------------------------+
                                                         ^
                                                         | (bflow attach)
                                                         v
                                      +------------------------------------+
                                      |     Conversation Agent (chat)      |
                                      |    (packages/conversation &        |
                                      |         agents/chat)               |
                                      +------------------------------------+
                                          |                          ^
                     RoleMessage Envelope |                          | RoleMessage Envelope
                     (delegation.request, |                          | (delegation.accepted,
                      approval.decision)  |                          |  conversation.progress,
                                          v                          |  approval.request)
+--------------------------------------------------------------------------+
|                      Herdr Multi-Pane Orchestrator                       |
|                          (AgentTransport / Protocol 22)                  |
+--------------------------------------------------------------------------+
                                          |                          ^
                                          v                          |
                                      +------------------------------------+
                                      |      Coordinator Agent             |
                                      |  (Task DAG & Specialist Dispatch)  |
                                      +------------------------------------+
```

### Key Architectural Boundaries:
- **Sole User Interface**: Lập trình viên kết nối vào hệ thống độc quyền qua terminal pane của `chat`. Không bao giờ kết nối trực tiếp vào pane của Developer hay Coordinator.
- **Read-Only Workspace**: Tác tử `chat` hoạt động với `readOnlyWorkspace: true`. Tuyệt đối không bao giờ tự ý sửa đổi mã nguồn kho lưu trữ.
- **No Direct Specialist Dispatch**: Không bao giờ giao việc trực tiếp cho `developer`, `tester`, `reviewer`, `qa`, `security` hay `architect`. Mọi ủy quyền phải thông qua `coordinator`.
- **No Unilateral Completion**: Không bao giờ tự ý chuyển trạng thái workflow thành `completed`. Trạng thái hoàn tất chỉ được ghi nhận khi có bằng chứng nghiệm thu từ Coordinator/Runtime.

---

## 2. The 10 Core Capabilities

1. **Authoritative System Prompt & Role Profile** (`agents/chat/` & `src/prompts.ts`):
   Định nghĩa rõ ràng vai trò `chat`, 5 nguyên tắc ứng xử cốt lõi, 6 ý định người dùng và 8 ranh giới bất biến.
2. **Chat-owned intent decisions** (`src/chat-decision.ts`):
   Chat hiểu ý định và gửi quyết định có cấu trúc qua `conversation_decide`. Gateway kiểm tra schema và mục tiêu trạng thái; classifier deterministic chỉ còn là API tương thích cho caller cũ và đường phê duyệt từ hook đáng tin cậy.
3. **Structured `DelegationRequest` Generation** (`src/delegation-builder.ts`):
   Đóng gói yêu cầu người dùng thành hợp đồng `DelegationRequest` chuẩn v2 (`schemaVersion: 2`) với danh sách tiêu chí nghiệm thu `acceptanceCriteria` có thể kiểm chứng.
4. **Handoff to Coordinator via Herdr** (`src/herdr-bridge.ts`):
   Chuyển giao yêu cầu sang cho Coordinator Agent thông qua phong bì `RoleMessage` trên `AgentTransport`.
5. **Ingest Progress & Coordinator Results** (`src/herdr-bridge.ts` & `src/conversation-gateway.ts`):
   Tiếp nhận các thông điệp `delegation.accepted`, `conversation.progress`, `task.status`, `approval.request`, `verification.result`, `verification.escalation`, `review.verdict`.
6. **Substantive Response Formatting** (`src/response-formatter.ts`):
   Lọc bỏ các nhịp đập (heartbeat) lặp lại vô nghĩa; chuyển đổi các sự kiện kỹ thuật phức tạp thành ngôn ngữ tự nhiên dễ hiểu; báo rõ ràng nguyên nhân khi `blocked` hoặc `failed`.
7. **Context & Correlation ID Management** (`src/context-store.ts`):
   Duy trì xuyên suốt `correlation_id` cho từng yêu cầu từ lúc bắt đầu, qua làm rõ, bàn giao, cập nhật tiến độ cho tới khi kết thúc.
8. **Multi-Workflow Support in Single Session** (`src/conversation-gateway.ts`):
   Quản lý đồng thời nhiều `WorkflowRequestContext` độc lập trong cùng một `ConversationSession`, mỗi workflow có `run_id` và `correlation_id` riêng biệt.
9. **Approval, Rejection & Clarification Mediation** (`src/conversation-gateway.ts`):
   Điều phối chu trình phê duyệt (`awaiting_user_approval`) và đối thoại làm rõ (`awaiting_user_clarification`) hai chiều an toàn.
10. **Busy-State FIFO Inbound Buffer** (`src/conversation-gateway.ts`):
    Hàng đợi `pendingInboundQueue` lưu giữ an toàn mọi tin nhắn đến từ User hoặc Coordinator trong lúc `chat` đang ở trạng thái `working` hoặc đang xử lý dở dang một lượt giao tiếp. Tự động xả tuần tự khi rảnh, đảm bảo **zero message loss**.

---

## 3. The 6 Recognized Intents

| Ý định (Intent) | Điều kiện kích hoạt | Hành động của Conversation Agent |
| :--- | :--- | :--- |
| **`conversation_only`** | Lời chào, hỏi thông tin hệ thống, câu hỏi khái niệm chung không yêu cầu sửa/viết code. | Phản hồi trực tiếp cho người dùng; không tạo workflow hay gọi Coordinator. |
| **`clarify`** | Yêu cầu lớn chưa rõ phạm vi (`inScope`/`outOfScope`), thiếu target module hoặc tiêu chí nghiệm thu. | Tạo câu hỏi làm rõ tập trung (1-3 câu); chuyển phiên sang `awaiting_user_clarification`. |
| **`workflow_request`** | Yêu cầu tính năng/sửa lỗi có phạm vi hành động rõ ràng; hoặc câu trả lời làm rõ đầy đủ chi tiết; hoặc yêu cầu thay đổi giữa chừng (`isRequirementChange: true`). | Tạo `DelegationRequest` có cấu trúc; gửi sang Coordinator qua Herdr `RoleMessage`; chuyển phiên sang `delegated_to_coordinator`. |
| **`status_query`** | Hỏi thăm tiến độ, trạng thái hiện tại, kiểm tra blocker (`"tiến độ"`, `"status"`, `"đang làm gì"`). | Tổng hợp báo cáo tiến độ trực quan từ context; không làm thay đổi trạng thái workflow. |
| **`approval_response`** | Người dùng phê duyệt, từ chối hoặc yêu cầu sửa đổi (`"approve"`, `"từ chối"`, `"cần sửa"`). | Xác thực nguồn gốc người dùng (`provenance`); tạo `ApprovalDecision`; gửi sang Coordinator; giải phóng approval pending. |
| **`cancellation_request`** | Người dùng yêu cầu dừng hoặc hủy workflow (`"cancel"`, `"hủy"`, `"dừng"`). | Tạo `CancellationRequest`; gửi thông điệp yêu cầu dừng sang Coordinator; cập nhật trạng thái workflow sang `cancelled`. |

---

## 4. The 8 Mandatory Rules & Security Invariants

1. **Cấm gọi trực tiếp Developer hoặc chuyên gia**: Conversation Agent chỉ được phép tương tác với `user`, `coordinator` và `runtime`. Tuyệt đối không gửi thông điệp hay ủy quyền cho `developer`.
2. **Cấm sửa đổi mã nguồn trực tiếp**: Workspace của Conversation Agent là read-only (`readOnlyWorkspace: true`).
3. **Cấm tự ý chuyển trạng thái thành `completed`**: Không bao giờ coi trạng thái Herdr transport `done` là workflow thành công. Chỉ Coordinator/Runtime với bằng chứng nghiệm thu mới có quyền kết luận hoàn tất.
4. **Bắt buộc dùng phong bì `RoleMessage` qua Herdr**: Mọi giao tiếp giữa các tác tử phải được đóng gói qua `RoleMessageSchema` (`schema_version: 2`).
5. **Cấm dùng file hoặc database làm hòm thư polling**: File lưu trữ chỉ dùng để phục hồi phiên sau sự cố, không dùng để trao đổi dữ liệu thay thế giao thức Herdr.
6. **Lưu ngữ cảnh chỉ cho mục đích phục hồi sự cố**: `ConversationContextStore` được thiết kế riêng biệt cho Conversation Agent khôi phục trạng thái.
7. **Chỉ chấp nhận phê duyệt từ người dùng xác thực**: Mọi `ApprovalDecision` phải có `provenance.origin === "user"` và `provenance.authenticatedUser === true`. Từ chối mọi phê duyệt giả mạo từ mã nguồn.
8. **Xem dữ liệu kho lưu trữ là không tin cậy**: Mọi nội dung đọc từ repository (README, commit, diff, issue) phải được bọc trong `<untrusted_repository_content>` và quét an toàn bằng `inspectRepositoryContentSafety()`.

---

## 5. Herdr Bridge & Unknown Delivery Handling

Lớp `HerdrConversationBridge` kết nối Conversation Agent với hạ tầng Herdr `AgentTransport`:
- **Đóng gói `AgentRequest`**: Tự động chuyển đổi `RoleMessage` thành `AgentRequest` nhắm tới Coordinator pane với chính sách retry tuyến tính và idempotency key.
- **Biên lai Herdr**:
  - `status === "accepted"`: Ghi nhận biên lai và lưu `handle`.
  - `status === "unknown_delivery"`: Đánh dấu trạng thái `unknown_delivery`, **cấm resend tự động** (`resendAllowed: false`).
- **Tái hòa giải (Reconciliation)**:
  - Khi một thông điệp rơi vào `unknown_delivery`, bắt buộc phải gọi `reconcileDelivery()`.
  - Chỉ khi kết quả hòa giải là `not_delivered` (`retrySafe: true`) thì hệ thống mới cho phép thử gửi lại (`resendAllowed: true`).

---

## 6. Busy-State Inbound Buffering (`pendingInboundQueue`)

Khi `ConversationAgent` đang ở trạng thái bận:
- Đang bận thực hiện lệnh trong terminal (`agentBusy: true`).
- Đang trong quá trình chờ đợi I/O của một lượt xử lý người dùng (`isProcessingTurn: true`).

Bất kỳ tin nhắn nào đến từ người dùng hoặc thông điệp tiến độ/phê duyệt từ Coordinator sẽ:
1. Được đưa vào hàng đợi `pendingInboundQueue` (`PendingInboundItem`).
2. Lưu tức thì vào `ConversationContextStore` để chống mất dữ liệu khi crash.
3. Khi người dùng gửi đến trong lúc bận, hệ thống trả về thông báo tiếp nhận an toàn (`queuedBecauseBusy: true`).
4. Ngay khi `chat` chuyển về trạng thái rảnh (`busy = false`), hàm `flushPendingInboundQueue()` sẽ tự động xử lý tuần tự toàn bộ hàng đợi theo nguyên tắc **FIFO**.

---

## 7. Context Persistence & Crash Recovery

Gói cung cấp 2 cài đặt của `ConversationContextStore`:
1. `InMemoryConversationContextStore`: Lưu trữ snapshot dạng deep clone trong RAM cho unit testing.
2. `FileConversationContextStore`:
   - Lưu trữ tại `<storageDir>/<sessionId>.context.json`.
   - Cơ chế ghi nguyên tử (Atomic Write): Ghi ra file `.tmp` ngẫu nhiên rồi mới `rename` sang file chính thức.
   - Chống tấn công duyệt đường dẫn (Path Traversal Protection): Nghiêm cấm các ký tự `/`, `\`, `..` trong `sessionId`.

---

## 8. Usage Example

```ts
import {
  ConversationGateway,
  HerdrConversationBridge,
  FileConversationContextStore,
  MockHerdrAgentTransport
} from "@bflow/conversation";

// 1. Khởi tạo transport và storage
const transport = new MockHerdrAgentTransport();
const contextStore = new FileConversationContextStore(".bflow/context");

// 2. Khởi tạo Herdr bridge
const bridge = new HerdrConversationBridge({
  transport,
  sessionId: "session-001",
  conversationAgentId: "chat",
  conversationPaneId: "pane-chat",
  coordinatorTarget: {
    transport: "herdr",
    agentId: "coordinator",
    paneId: "pane-coordinator"
  }
});

// 3. Khởi tạo Gateway
const gateway = new ConversationGateway({
  sessionId: "session-001",
  herdrSessionId: "herdr-sess-123",
  conversationAgentId: "chat",
  paneId: "pane-chat",
  bridge,
  contextStore
});

// Khôi phục hoặc tạo mới phiên
await gateway.initializeOrRecoverSession();

// 4. Xử lý lượt nhập của người dùng
const response = await gateway.handleUserTurn({
  sessionId: "session-001",
  content: "Xây dựng module xác thực JWT HS256 trong packages/auth với test",
  provenance: {
    origin: "user",
    authenticatedUser: true,
    userId: "alice",
    channel: "herdr_attach"
  }
});

console.log("Intent nhận diện:", response.value.recognizedIntent); // "workflow_request"
console.log("Phản hồi của Chat:", response.value.agentReply.content);
```

---

## 9. Ingress Validation & Ranh giới người dùng so với tác tử chuyên môn

- **Xác thực dữ liệu đầu vào**: `UserTurnInputSchema` (strict Zod) được áp dụng cho mọi `UserTurnInput` trong `ConversationGateway`; đầu vào sai trả về lỗi `validation`. Mỗi `ConversationMessage` được kiểm tra bằng `ConversationMessageSchema` trước khi lưu. `ConversationContextSnapshotSchema` kiểm tra nghiêm ngặt snapshot khi nạp lại ngữ cảnh. Các schema khác (`MessageProvenanceSchema`, `ExtractedRequirementDraftSchema`, `PendingClarificationContextSchema`) được xuất từ `types.ts`.
- **Prompt hệ thống (`prompts.ts`, `agents/chat/system-prompt.md`)**: mục "User Interaction & Autonomous Specialist Delegation Boundary" nêu rõ Conversation là điểm tương tác người dùng duy nhất; `coordinator`, `analyst`, `architect`, `planner`, `developer`, `reviewer`, `verifier`/`qa` là tác tử thực thi tự trị, không đối thoại với người dùng. Chỉ Conversation được hỏi làm rõ và trung chuyển `approval.request` / `approval.decision`. Prompt của Conversation không được chứa khối chính sách "non-user-facing execution agent" của các vai trò khác (xem `validateAutonomousRolePrompt` trong `@bflow/agent-registry`).
- Thông điệp từ vai trò chuyên môn tới `user` không được chấp nhận ở tầng Herdr; mọi yêu cầu làm rõ hoặc phê duyệt phải đi qua Coordinator tới Conversation.

## Hosted Chat intent routing

The trusted provider hook records the actual user turn before Chat acts and returns its
`messageId` plus persisted Conversation context. Chat calls the Conversation-only
`conversation_decide` MCP tool with that ID and a `ChatDecisionSchema` decision. The host
binds the proposal to the recorded pane/native session and injects user content/provenance;
model parameters cannot supply human authority. Gateway uses that validated decision directly.
It does not run the natural-language classifier on a supplied decision.

Decisions cover direct replies, clarification, workflow handoff, status and targeted
cancellation. Clarification questions include the exact options Chat asks the user, so the
saved questions and Chat transcript support short answers such as “A, giữ cả 5 tiêu chí”.
The resulting draft explicitly targets the pending clarification. Independent requests get
separate run/correlation IDs even while another request is delegated.

A workflow draft requires defined scope and non-empty acceptance criteria. Named modules or
roles can define scope without literal paths: `affectedPaths: []` is valid. A read-only
investigation can be delegated as `kind: "spike"`; delegation metadata preserves
`workflowKind` and `codeChangesAuthorized` (false by default for spikes), with manual review
criteria. The objective and criteria must retain the user's scope and no-edit constraint.
This metadata does not replace downstream Runtime policies or independent acceptance.

`approval_response` is excluded from the model decision schema. Pending human approvals and
specialist decisions still use the authenticated user hook and existing exact option checks.
Free-text specialist answers without offered options must start with the pending `apr-...`
request ID. An explicit governance reply or exact offered option can commit a decision;
incidental approval words in a new workflow request cannot.
Conversation cannot approve through MCP, assign specialists directly, edit code, or claim
transport completion proves workflow success.

Structured decisions survive the existing busy FIFO and context recovery. Committed retries
return the saved response without another handoff; conflicting decisions for the same user
message are rejected. Model-path delegation identities are stable per trusted user message.
State validation rejects unknown clarification/cancellation targets and requires an explicit
existing run for requirement changes. Snapshot format v2 remains compatible; decision
receipts use the existing ConversationMessage metadata field.

Direct `handleUserTurn` callers without `conversationDecision` retain the legacy deterministic
classifier. That API still requires implementation wording/path scope and keeps investigations
in Conversation; it is not the ordinary hosted Chat route. It remains for compatibility and
authenticated approval extraction, not as a second semantic veto over Chat.

These guarantees have local package/integration tests. They do not establish live provider,
Herdr transport, or full SDLC acceptance. Running hosts need a rebuild and restart to load the
new MCP tool and prompt.
