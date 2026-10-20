# Specification Engine (P15)

`@bflow/specification` triển khai phân loại thay đổi thích ứng, validation dựa trên contract, các revision specification bất biến, quản lý acceptance criterion, truy vết criterion/task, phân tích tác động của thay đổi yêu cầu, chính sách approval, và render tài liệu dễ đọc cho con người. Đây là leaf package phụ thuộc vào `@bflow/contracts` và `zod`. Nó không dispatch agent và cũng không chọn chính sách TDD.

Định dạng tài liệu công khai là `@bflow/contracts.Specification` (schemaVersion 2). `SpecificationDocumentSchema` parse schema được export đó và validate `metadata.sdd` riêng, có phiên bản của P15 bằng `PolicyDetailsSchema`. Không có thay đổi contract dùng chung hay upcaster nào được đưa vào. `version`, `complexity`, `riskLevel` và `traceabilityTaskIds` là tường minh đối với tài liệu P15. Các spec cũ thiếu metadata P15 yêu cầu một assessment tường minh và một draft mới; chúng không được nâng cấp hay phê duyệt ngầm.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────────────┐
                      │              Coordinator Agent               │
                      └──────────────────────┬───────────────────────┘
                                             │ Task Delegation (RoleMessage)
                                             ▼
                 ┌────────────────────────────────────────────────────────┐
                 │                  Specialist Agents                     │
                 │   - Analyst (specifier): Requirements, Criteria        │
                 │   - Architect (architect): Constraints, API/Data       │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                      ┌──────────────────────┼──────────────────────┐
                      ▼                      ▼                      ▼
           ┌──────────────────────┐┌──────────────────┐┌──────────────────────┐
           │ 1. Classification    ││ 2. Schema        ││ 3. Versioning &      │
           │    & Assessment      ││    Validation    ││    Approval Engine   │
           └──────────────────────┘└──────────────────┘└──────────────────────┘
                      │                      │                      │
                      ▼                      ▼                      ▼
           ┌──────────────────────┐┌──────────────────┐┌──────────────────────┐
           │ 4. Criteria Mgmt     ││ 5. Traceability  ││ 6. Change Detection  │
           │    & Inviolability   ││    Matrix        ││    & DAG Impact      │
           └──────────────────────┘└──────────────────┘└──────────────────────┘
                      │                      │                      │
                      └──────────────────────┼──────────────────────┘
                                             │
                                             ▼
           ┌──────────────────────────────────────────────────────────────┐
           │ 7. Artifact Proposal & Protocol 22 RoleMessage Egress        │
           │    - JSON / Markdown Proposals via Content-Addressed Hash    │
           │    - spec.draft / spec.approved RoleMessage Envelopes        │
           │    - Rendered Markdown via renderSpecification               │
           └──────────────────────────────────────────────────────────────┘
```

---

## 8 P15 Specification Components

### 1. Specification Classification

Việc phân loại thay đổi dựa trên impact assessment tường minh thay vì kích thước code diff. Ngay cả một thay đổi một dòng đối với authentication, public contract hoặc database migration cũng có thể gây ra rủi ro nghiêm trọng về bảo mật hoặc kiến trúc.

- **`ChangeAssessmentSchema`**: Impact assessment có cấu trúc do Analyst hoặc Architect cung cấp:
  - `kind`: `"documentation"` | `"formatting"` | `"feature"` | `"bugfix"` | `"refactoring"` | `"configuration"`
  - `behaviorChange`: boolean
  - `modules`: mảng không rỗng các tên module bị ảnh hưởng
  - `securityImpact`, `publicApiImpact`, `dataSchemaImpact`, `architectureImpact`, `migrationRequired`: các cờ boolean
  - `risk`: `"low"` | `"medium"` | `"high"` | `"critical"`
  - `unresolvedQuestions`: mảng các điểm mơ hồ còn mở đang chặn review/triển khai
- **`classifyChange(assessment, affectedPaths)`**: Đánh giá các cờ assessment và gợi ý đường dẫn theo hướng thận trọng:
  - Nâng lên `complexity: "complex"`, `level: "full"`, `riskLevel: "high"`, `humanApprovalRequired: true` nếu bất kỳ cờ impact nào là true, nhiều module bị chạm tới, risk là high/critical, hoặc gợi ý đường dẫn khớp.
  - Nâng lên `complexity: "standard"`, `riskLevel: "medium"` nếu có thay đổi hành vi hoặc risk là medium.
  - Giới hạn `complexity: "trivial"`, `level: "lightweight"`, `riskLevel: "low"` cho các thay đổi không đổi hành vi, rủi ro thấp và không có tác động security/API/data/architecture.
- **`classifyChangeSafe(assessment, affectedPaths)`**: Biến thể không throw, trả về `OperationResult<Classification>`.
- **Gợi ý đường dẫn thận trọng**:
  - `hasSecurityPathHint(paths)`: Khớp security, auth, crypto, secret, permission, token, jwt, tls, v.v.
  - `hasPublicApiPathHint(paths)`: Khớp các ranh giới contracts, openapi, proto, graphql.
  - `hasDataSchemaPathHint(paths)`: Khớp migrations, thư mục schema hoặc file `.sql`.
- **`getRequiredSpecSections(complexity, migrationOrSchemaImpact)`**: Trả về danh sách tên các section bắt buộc cho complexity đã cho.

| Complexity | Nội dung tối thiểu | SDD Level | Governance Gate |
| --- | --- | --- | --- |
| `trivial` | Title, summary, problem statement, scope, affected paths, >= 1 criterion bắt buộc | `lightweight` | Nghiệm thu tự động có ủy quyền |
| `standard` | Các section của trivial + functional requirements + proposed test strategy | `lightweight` (`full` cho tính năng mới) | Nghiệm thu tự động có ủy quyền |
| `complex` | Các section của standard + design proposal, technical constraints, API contracts, risks/tradeoffs, architecture notes, security considerations, rollback plan, test strategy, TDD decision (+ migration strategy & dataModelChanges nếu schema bị ảnh hưởng) | `full` | Phê duyệt thiết kế của con người đã xác thực |

---

### 2. Specification Schema Validation

`SpecificationDocumentSchema` tinh chỉnh `@bflow/contracts.Specification` bằng cách áp dụng validation nghiêm ngặt lên `metadata.sdd` của P15:

- **`PolicyDetailsSchema`**: Định nghĩa schema metadata:
  - `policyVersion: 1`
  - `assessment`: `ChangeAssessment`
  - `functionalRequirements`: mảng các chuỗi không rỗng
  - `proposedTestStrategy`: chuỗi tùy chọn
  - `designProposal`, `technicalConstraints`, `apiDataContracts`, `risksAndTradeoffs`: chuỗi/mảng cho các thay đổi complex
  - `migrationStrategy`: chuỗi tùy chọn cho thay đổi data schema
  - `traceability`: mảng các `{ criterionId, taskIds }`
  - `revisionReason`: chuỗi tùy chọn, bắt buộc ở các revision
- **`parseContractOrP15Specification(input)`**: Chấp nhận một tài liệu P15 `SpecificationDocumentSchema` hoặc một `Specification` contract thuần; với loại sau, nó tổng hợp policy details `metadata.sdd` hợp lệ (giá trị mặc định cho assessment, requirements và traceability) để các helper criteria, traceability và change-detection cũng hoạt động trên contract spec.
- **`parseSpecification(input)`**: Validate rằng:
  - Classification khớp với assessment đã khai báo và affected paths.
  - Các mục scope (`inScope`, `outOfScope`) không để trống.
  - Version là một số tường minh.
  - `updatedAt >= createdAt`.
  - Có ít nhất một acceptance criterion là `required: true`.
  - Các section bắt buộc cho thay đổi `standard` và `complex` có mặt và không rỗng.
  - Traceability map tồn tại cho mọi criteria và khớp `traceabilityTaskIds`.
  - Nếu có `testStrategy` hoặc `tddDecision`, chúng tham chiếu đúng `specId` và `runId` tương ứng.
- **`validateSpecificationDocument(input)`**: Validator an toàn trả về `OperationResult<Specification>`.
- **`policyDetails(input)`**: Helper trích xuất `PolicyDetails` đã parse từ một specification hợp lệ.

---

### 3. Spec Versioning

Specification tuân theo vòng đời bất biến, có phiên bản. Các specification đã được phê duyệt không bao giờ bị sửa tại chỗ.

- **`SpecificationEngine.createDraft(input)`**:
  - Khởi tạo một specification mới ở `version: 1` với `status: "draft"`.
  - Bắt buộc mọi acceptance criteria ở `status: "pending"` với `evidenceArtifactIds` rỗng và không có `waiverReason`.
  - Cấm `approvedBy` hoặc `artifactRef` có sẵn từ trước.
- **`SpecificationEngine.revise(previousApproved, proposedDraft, reason)`**:
  - Bảo toàn danh tính specification: `specId`, `runId`, `sessionId` và `createdAt` phải khớp.
  - Bắt buộc tăng version: `proposed.version === previous.version + 1`.
  - Validate timestamp không giảm: `updatedAt >= previous.updatedAt`.
  - Gắn `revisionReason` không rỗng vào `metadata.sdd`.
  - Verify tính toàn vẹn artifact của `previous` nếu có artifact reference.
  - Chạy `detectSpecChanges` để đảm bảo requirements hoặc criteria thực sự đã thay đổi (`requiresReapproval`).
  - Trả về `{ specification: nextDraft, impact }` sẵn sàng cho lượt review mới.
- **`SpecificationEngine.supersede(previousApproved, nextApproved)`**:
  - Chuyển `previousApproved` từ `status: "approved"` sang `status: "superseded"` khi `nextApproved` đã được phê duyệt.
  - Verify cả hai artifact reference trong `ArtifactStore` trước khi cập nhật status.

---

### 4. Acceptance Criteria Management & Inviolability

Acceptance criteria định nghĩa các điều kiện tiên quyết có thể kiểm chứng để hoàn thành task. Chúng được bảo vệ bằng các guardrail chống làm yếu đi nghiêm ngặt:

- **Bất biến bất khả xâm phạm của Criteria**: Criteria **KHÔNG BAO GIỜ** được xóa, chuyển thành tùy chọn, nới lỏng phương thức verification, hay diễn đạt lại để hợp thức hóa một triển khai đang thất bại.
- **`addCriterionToDraft(spec, criterion, mappedTaskIds)`**: Thêm một criterion pending mới vào draft specification, cập nhật traceability và mapping test strategy.
- **`updateCriterionInDraft(spec, criterionId, patch)`**: Cập nhật các thuộc tính criterion (`description`, `category`, `verificationMethod`, `required`, `mappedTaskIds`) trên draft specification.
- **`removeCriterionFromDraft(spec, criterionId)`**: Xóa một criterion khỏi draft, dọn dẹp traceability và test strategy. Thất bại nếu xóa criterion bắt buộc cuối cùng.
- **`assertNoCriteriaWeakeningOnFailure(previousSpec, proposedSpec, failedVerification, options)`**:
  - Kiểm tra các criteria thất bại trong `failedVerification.evaluatedCriteria`.
  - Throw lỗi nếu bất kỳ criterion thất bại nào bị:
    1. Bị xóa trong `proposedSpec`.
    2. Đổi từ `required: true` sang `required: false`.
    3. Làm yếu độ nghiêm ngặt của phương thức verification (ví dụ `e2e_test` -> `manual_review`).
    4. Sửa đổi mô tả.
  - Chỉ được bypass **khi và chỉ khi** `options.explicitUserRequirementChangeAuthorized === true`.
- **`evaluateCriteriaFromVerification(spec, verificationResult)`**:
  - Đánh giá criteria dựa trên một `VerificationResult` độc lập từ P17.
  - Returns `CriteriaEvaluationSummary` (`allRequiredSatisfied: boolean`, `evaluations: CriterionEvaluation[]`).
  - Giữ nguyên specification đã phê duyệt ở trạng thái bất biến; kết quả verification thuộc về các evidence artifact riêng.

---

### 5. Spec-to-Task Traceability

Mọi requirement và criterion phải truy vết xuôi tới các execution task, và mọi execution task phải truy vết ngược về requirements.

- **`validateTraceability(spec, workflow)`**:
  - Throw nếu các workflow task tham chiếu acceptance criteria không xác định, nếu có criterion nào không có task được map, hoặc nếu workflow task và traceability không khớp chính xác.
  - Validate rằng mọi acceptance criterion trong `spec` được map tới ít nhất một task trong `workflow`.
  - Validate rằng mọi task được tham chiếu trong `metadata.sdd.traceability` tồn tại trong `workflow.tasks`, và không có workflow task mồ côi thiếu criteria được map.
- **`buildTraceabilityMatrix(spec, workflow?)`**:
  - Returns `TraceabilityMatrix`:
    - `criterionToTasks`: Record map criterion ID sang task ID.
    - `taskToCriteria`: Record map task ID sang criterion ID.
    - `orphanCriterionIds`: Criteria không có task được giao.
    - `unmappedWorkflowTaskIds`: Workflow task không có criteria được map.
    - `unknownMappedTaskIds`: Task trong traceability không tồn tại trong workflow.
    - `unknownCriterionIds` (tùy chọn): Criterion ID được workflow task tham chiếu mà spec không định nghĩa.
  - Khi spec có `metadata.sdd.traceability` tường minh, mapping đó có thẩm quyền; nếu không có nó và có workflow được cung cấp, mapping được suy ra từ `acceptanceCriteria` của từng task.
    - `valid`: chỉ báo boolean cho traceability hai chiều đầy đủ.
- **`validateChangedFilesScope(spec, changedPaths)`**:
  - Validate xem các changed file có nằm trong `spec.affectedPaths` hay không.
  - Hỗ trợ khớp đường dẫn chính xác, khớp tiền tố thư mục và glob pattern (`**`, `*`, `?`).
  - Returns `{ withinScope: boolean, outOfScopePaths: string[] }`.

---

### 6. Spec Change Detection & DAG Impact Analysis

Khi requirements thay đổi giữa chừng workflow, `detectSpecChanges` xác định chính xác tác động lên criteria và task DAG:

- **`detectSpecChanges(previousSpec, nextSpec, workflow?)`**:
  - Nhận diện criteria được thêm, xóa, thay đổi và không đổi:
    - `addedCriterionIds`: criteria mới được đưa vào.
    - `removedCriterionIds`: criteria đã bị xóa.
    - `changedCriterionIds`: criteria có description, category, verificationMethod hoặc trạng thái required thay đổi.
    - `unchangedCriterionIds`: criteria có canonical JSON giống hệt nhau giữa các version.
  - Nhận diện các field thay đổi:
    - `changedFields`: danh sách các field cấp cao nhất và field chính sách SDD đã thay đổi (ví dụ `summary`, `scope`, `functionalRequirements`, `designProposal`).
  - Nhận diện thay đổi toàn cục:
    - `globalRequirementsChanged`: true nếu bất kỳ requirement cấp cao nhất hoặc section chính sách nào thay đổi ngoài criteria.
  - Tính các task bị ảnh hưởng:
    - `affectedTaskIds`: các task duy nhất được map trực tiếp tới criteria đã thay đổi (hoặc toàn bộ task được map nếu global requirements thay đổi).
    - `transitivelyAffectedTaskIds`: các task downstream trong DAG `workflow.dependencies` bị ảnh hưởng gián tiếp.
  - Reapproval gate:
    - `requiresReapproval`: true nếu bất kỳ criterion hoặc requirement nào bị thay đổi.

---

### 7. Spec Approval Policy & Governance

Vòng đời approval quản lý việc chuyển đổi chính thức từ trạng thái draft sang approved:

```
[ draft ] ──── submitForReview() ────► [ review_pending ]
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │ approve()                                         │ reject()
                    ▼                                                   ▼
              [ approved ]                                    [ rejected / draft ]
                    │
                    ▼ supersede()
              [ superseded ]
```

- **`SpecificationEngine.submitForReview(draft)`**:
  - Tính canonical JSON của các requirement được review (không gồm metadata vòng đời).
  - Verify kích thước tài liệu (`<= 1 MiB`).
  - Lưu canonical JSON vào `ArtifactStore` với checksum SHA-256 và kích thước chính xác.
  - Gắn `ArtifactReference` được trả về và đặt `status: "review_pending"`.
- **`SpecificationEngine.requestApproval(pending, options)`**:
  - Tạo một `ApprovalRequest` chính thức nhắm tới `{ type: "specification", specId }` tại `revision: spec.version` hiện tại.
  - Gắn content digest và artifact reference làm evidence.
- **`SpecificationEngine.approve(pending, request, decision)`**:
  - Verify tính toàn vẹn artifact qua `verifyArtifact`.
  - Validate cửa sổ approval, request ID khớp, revision và generation.
  - Gọi `authorizeApprover(decision, humanRequired)`:
    - Thay đổi low-risk/trivial cho phép approver tự động có ủy quyền (ví dụ Coordinator).
    - Thay đổi complex/high-risk bắt buộc có phê duyệt của owner là con người đã xác thực.
  - Chuyển specification sang `status: "approved"`.
- **`SpecificationEngine.reject(pending, request, decision)`**:
  - Với `decision.decision === "rejected"`: chuyển specification sang `status: "rejected"`.
  - Với `decision.decision === "changes_requested"`: đưa specification về `status: "draft"` sạch (xóa artifactRef và approvedBy) để rework.
- **`SpecificationEngine.assertImplementationReady(approved, request, decision, workflow)`**:
  - Bắt buộc specification đã approved, decision đã được verify, artifact còn nguyên vẹn, và traceability của workflow đầy đủ khớp.
- **`SpecificationEngine.verifyArtifact(spec)`**:
  - Đọc stream artifact đã lưu từ `ArtifactStore`, tính lại digest SHA-256, kiểm tra độ dài byte, và so sánh canonical JSON với requirements hiện tại của spec.

---

### 8. Artifact References, RoleMessage Protocol & Specialist Prompts

P15 chuẩn hóa giao tiếp giữa các Herdr pane và store bên ngoài:

- **`createSpecificationArtifactProposal(spec, options)`**:
  - Định dạng: `"json"` (nội dung canonical JSON) hoặc `"markdown"` (markdown đã render dễ đọc cho con người).
  - Tính checksum SHA-256 và kích thước.
  - Returns `{ proposal: ArtifactProposal, bytes: Buffer, checksum: string }`.
- **`buildSpecRoleMessage(options)`**:
  - Dựng các envelope `RoleMessage` của Protocol 22:
    - `type: "spec.draft"`: payload chứa `specId`, `specLevel`, `title`, `authorRole`, `summary`, `affectedPaths`.
    - `type: "spec.approved"`: payload chứa `specId`, `approvedBy`, `approvedAt`, `notes` tùy chọn.
  - Điền sender, recipient, correlation ID, causation ID, run ID và các artifact reference đính kèm.
- **`renderSpecification(spec)`**:
  - Định dạng specification thành Markdown dễ đọc cho con người, khớp với các ví dụ chuẩn trong `examples/`.
- **Analyst & Architect Specialist Prompts**:
  - `ANALYST_ROLE_PROFILE`: Specialist profile cho Analyst (`role: "specifier"`, workspace chỉ đọc).
  - `ARCHITECT_ROLE_PROFILE`: Specialist profile cho Architect (`role: "architect"`, workspace chỉ đọc).
  - `ANALYST_SYSTEM_PROMPT`: System prompt đầy đủ định nghĩa ranh giới và trách nhiệm SDD của Analyst.
  - `ARCHITECT_SYSTEM_PROMPT`: System prompt đầy đủ định nghĩa ranh giới và governance kỹ thuật của Architect.
  - Cả hai prompt đều bao gồm chính sách thực thi non-user-facing bắt buộc (không hỏi người dùng; ghi lại các giả định có thể đảo ngược; blocker và các quyết định làm thay đổi spec được escalate lên Coordinator qua Herdr) và structured result bảy field (`status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, `assumptions` tùy chọn). Các prompt `agents/analyst` và `agents/architect` đi kèm có cùng các section này.
  - `renderSpecialistSpecificationPrompt(options)`: Sinh task assignment prompt cho việc soạn thảo ban đầu hoặc revision phiên bản.
- **Specification Examples** trong `packages/specification/examples/`:
  - `trivial.json` / `trivial.md`: Cập nhật tài liệu cục bộ (lightweight, low risk).
  - `standard.json` / `standard.md`: Bugfix một module (lightweight, medium risk).
  - `complex.json` / `complex.md`: Thay đổi database schema kèm migration (full, high risk).
  - `api.json` / `api.md`: Mở rộng public contract kèm TDD decision và test strategy (full, high risk).

---

## Example Usage

```ts
import {
  SpecificationEngine,
  classifyChange,
  parseSpecification,
  renderSpecification,
  createSpecificationArtifactProposal,
  buildSpecRoleMessage
} from "@bflow/specification";

// 1. Classify change based on structured assessment
const assessment = {
  kind: "feature",
  behaviorChange: true,
  modules: ["auth"],
  securityImpact: true,
  publicApiImpact: true,
  dataSchemaImpact: false,
  architectureImpact: false,
  migrationRequired: false,
  risk: "high",
  unresolvedQuestions: []
};
const classification = classifyChange(assessment, ["packages/contracts/src/auth.ts"]);
console.log(classification.complexity); // "complex"
console.log(classification.humanApprovalRequired); // true

// 2. Initialize SpecificationEngine with trusted ArtifactStore
const engine = new SpecificationEngine({
  artifactStore,
  authorizeApprover: async (decision, humanRequired) => {
    return humanRequired ? decision.decidedBy === "human-owner" : true;
  }
});

// 3. Draft, submit for review, request approval, approve
const draft = engine.createDraft(specDocument);
const reviewed = await engine.submitForReview(draft);
const request = await engine.requestApproval(reviewed, {
  approvalId: "approval-1",
  requestedBy: "coordinator"
});
const approved = await engine.approve(reviewed, request, decision);

// 4. Assert implementation readiness against planned workflow DAG
await engine.assertImplementationReady(approved, request, decision, workflowDefinition);

// 5. Generate artifact proposal and protocol 22 RoleMessage
const { proposal } = createSpecificationArtifactProposal(approved, {
  proposalId: "proposal-1",
  format: "json"
});
const message = buildSpecRoleMessage({
  messageId: "msg-1",
  correlationId: "corr-1",
  runId: approved.runId,
  senderRole: "coordinator",
  type: "spec.approved",
  spec: approved
});
```

---

## Validation Commands

Chạy từ thư mục gốc của repository:

```bash
# Typecheck specification package
pnpm --filter @bflow/specification typecheck

# Run all specification unit & integration tests
pnpm --filter @bflow/specification test
```
