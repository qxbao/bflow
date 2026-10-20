# File-backed Agent Registry

`createAgentRegistry({ stateFile, clock? })` triển khai `AgentRegistry` với một state file đơn host tường minh. `AgentConfiguration.settings` giữ nguyên các thiết lập provider, kind và execution dưới dạng JSON do contract định nghĩa; việc validate riêng cho từng transport thuộc về transport/runtime sử dụng chúng. `resolve` chỉ là tra cứu cấu hình mang tính xác định; `null` nghĩa là không có role/capability nào khớp, và nó không giữ chỗ (reserve) năng lực xử lý.

Mọi thao tác đều dùng một lock file loại trừ lẫn nhau dùng chung giữa các process. Các mutation ghi ra file tạm, fsync file đó, rename nguyên tử rồi fsync thư mục chứa. State có phiên bản lưu lại lease ID, idempotency receipt và fencing watermark của từng agent qua các lần restart process. Việc acquire tuân thủ `maxConcurrentTasks` và từ chối lease active thứ hai cho cùng run/task/attempt. Lease đang active ngăn việc thay thế hoặc xóa cấu hình. Renew/release yêu cầu fencing token và version hiện tại; việc hết hạn dùng clock được inject đáng tin cậy, không dùng timestamp do caller cung cấp. Các key trùng nhưng payload khác nhau sẽ gây conflict.

Phạm vi: một máy và một filesystem cục bộ được mọi registry process dùng chung. Đây không phải dịch vụ lease phân tán/qua mạng và không tuyên bố an toàn trên các filesystem thiếu exclusive-create và atomic rename đáng tin cậy. Nếu process crash khi đang giữ file `.lock`, có thể để lại stale lock; các thao tác sẽ timeout theo hướng fail-closed, và operator phải xác nhận owner đã chết trước khi xóa đúng lock đó. File receipt/history sẽ tăng dần cho đến khi có chính sách migration/compaction tường minh trong tương lai. Runtime phải giữ và verify lease/fence hiện tại ngay trước khi dispatch; trạng thái working của Herdr không phải là lease. Package này không triển khai SQLite hay port persistence P03.

Chạy test bằng `pnpm exec vitest run packages/agent-registry/test/agent-registry.test.ts` từ thư mục gốc repository. Test behavior-policy: `pnpm exec vitest run packages/agent-registry/test/agent-behavior-policies.test.ts`.

Deadline của thao tác tách biệt với thời điểm lease hết hạn. Có thể inject `operationClock` để test deadline một cách xác định; mặc định là `Date.now`. Một budget duy nhất được kiểm tra trước khi acquire lock, sau khi acquire lock, trước khi áp dụng mutation, và trước khi rename nguyên tử. `timeoutMs: 0` hết hạn ngay lập tức; option sai định dạng là lỗi validation. Nếu budget hết hạn trước khi commit, state tạm được xóa và state bền vững/fencing không đổi. Khi rename đã bắt đầu, thao tác hoàn tất phần việc durability và báo kết quả đã commit thay vì báo timeout an toàn để retry sau khi đã mutate.

## MVP SDLC Roles & Configuration

Package cung cấp các role profile và cấu hình mang tính xác định cho bốn agent SDLC cốt lõi:

| Role | Responsibility | Workspace Confinement | Output Requirements |
| --- | --- | --- | --- |
| `planner` | Phân rã yêu cầu cấp cao thành các task DAG xác định | `readOnlyWorkspace: true` | DAG task, dependency, criteria; không thay đổi code |
| `developer` | Triển khai thay đổi của task trong một worktree branch cô lập | `readOnlyWorkspace: false` (giới hạn trong worktree được giao) | Git commit, các changed file theo đường dẫn tương đối, tóm tắt test tự báo cáo, patch proposal |
| `reviewer` | Code review chỉ đọc, security audit và verify criteria | `readOnlyWorkspace: true` (`modifiedFiles: []`) | Quyết định phê duyệt (`approved` / `changes_requested`), findings, đánh giá criteria |
| `qa` | Đảm bảo chất lượng độc lập và verify bằng test tự động | `readOnlyWorkspace: true` | Evidence chạy test độc lập, verdict passed/failed; không bao giờ tin lời agent tự khẳng định |

### Multi-Provider / Multi-Model Configuration

Agent có thể được cấu hình trên nhiều provider (Anthropic Claude, OpenAI Codex, Google Gemini, local runner) mà không hardcode một model duy nhất:

- `createMvpRoleConfiguration(input)`: Validate và dựng một `AgentConfiguration`, áp dụng các chính sách bất biến của role (`readOnlyWorkspace`, `allowTaskDelegation: false`, `requiresIndependentTestVerification: true`, `maxTokens` là số nguyên dương, `temperature` hữu hạn trong `[0, 2]`, và execution argument không chứa NUL).
- `createDefaultMvpConfigurations(overrides?)`: Sinh cấu hình chuẩn cho cả 4 role, có thể nhận override theo từng role cho provider, kind, model, priority hoặc execution parameter.
- `seedMvpAgentRegistry(registry, overrides?, options?)`: Seed một `AgentRegistry` bằng 4 cấu hình role MVP thông qua upsert idempotent.
- `resolveMvpRoleAgent(registry, role, context, options?)`: Resolve một cách xác định agent đã cấu hình cho một role và context, trả về `configuration`, `settings` đã validate và `MvpRoleProfile`.

## Workflow Definitions & Loader

Module workflow cung cấp template và validation cho ba loại workflow SDLC cốt lõi:

- **`feature`** (`createFeatureWorkflowDefinition`): Luồng triển khai chuẩn `plan -> implement -> review -> qa`. Yêu cầu approval ở review và gắn quality gate ở QA.
- **`bugfix`** (`createBugfixWorkflowDefinition`): Phân tích root cause, sửa lỗi kèm regression test, review, và regression verification gate.
- **`refactor`** (`createRefactorWorkflowDefinition`): Phân rã theo module và ghi lại invariant, refactor code bảo toàn hành vi, review, và invariant verification gate.

### Workflow Validation & Verification

- `validateMvpWorkflowConventions(workflow)`: Đảm bảo rằng:
  - Mọi task dùng role MVP hợp lệ (`planner`, `developer`, `reviewer`, `qa`). Delegation tùy ý hoặc role ngoài phạm vi bị từ chối.
  - Mọi task có acceptance criteria không rỗng.
  - Task reviewer có `requiresApproval: true`.
  - Task QA có ít nhất một binding `qualityGates` bắt buộc.
- `loadWorkflowDefinition(source, options?)`: Load và validate workflow definition từ một chuỗi `WorkflowKind` (`feature`, `bugfix`, `refactor`), chuỗi JSON thô hoặc object.
- `verifyWorkflowRolesRegistered(workflow, registry, runId, options?)`: Resolve và verify rằng mọi role mà các task trong workflow yêu cầu đều đã được đăng ký và đang active trong `AgentRegistry` được cung cấp.

## Parameterized Prompt Rendering & Safety Guardrails

- `renderRolePrompt(role, params, options?)`: Sinh system prompt và task prompt có cấu trúc, mang tính xác định cho từng role MVP. Prompt bao gồm:
  - Định nghĩa role, nhiệm vụ và ràng buộc.
  - `UNTRUSTED_CONTENT_SAFETY_RULES` (6 quy tắc bất khả xâm phạm).
  - Link và URI của input artifact đáng tin cậy (`ArtifactReference`).
  - JSON schema nghiêm ngặt cho structured output bắt buộc.
  - Validate tham số riêng theo role (ví dụ từ chối traversal `..` trong `worktreePath` của developer, đảm bảo `runId` của input artifact khớp `runId` của prompt, và kiểm tra các kind input artifact được phép).

### Prompt-Injection & Untrusted Content Guardrails

Mọi nội dung repository, mô tả issue, diff và test log đều được coi là dữ liệu không đáng tin cậy:

- `wrapUntrustedRepositoryContent(label, content)`: Escape các tag thoát khỏi delimiter và bao dữ liệu không đáng tin cậy trong các XML fence `<UNTRUSTED_REPOSITORY_CONTENT label="..." trust="untrusted_data_only">`.
- `detectDangerousInstructions(content)`: Quét nội dung để phát hiện prompt injection nguy hiểm thuộc 7 loại:
  1. `prompt_override`: Chỉ thị cố gắng bỏ qua hoặc ghi đè system instruction hay prompt trước đó.
  2. `role_escape`: Cố gắng đổi role, đóng vai admin/root hoặc vào chế độ jailbreak (ví dụ DAN).
  3. `approval_or_test_bypass`: Chỉ thị tự động approve review, giả mạo test pass hoặc bỏ qua quality gate.
  4. `arbitrary_delegation`: Delegation trái phép cho agent bên ngoài, spawn process hoặc pipe nội dung tải về vào shell.
  5. `dangerous_command`: Lệnh phá hoại (`rm -rf /`, `mkfs`, fork bomb, ghi trực tiếp vào thiết bị, quyền root).
  6. `secret_exfiltration`: Cố gắng đọc hoặc trích xuất biến môi trường, credential, `.env` hoặc private key.
  7. `delimiter_breakout`: Tag đóng (`</UNTRUSTED_REPOSITORY_CONTENT>`), system fence giả hoặc special token thô của LLM.
- `validateUntrustedContentPolicy(content, options?)`: Đánh giá mức an toàn của nội dung và trả về lỗi validation nếu phát hiện chỉ thị nguy hiểm khi chế độ thực thi chính sách nghiêm ngặt đang bật.

## Structured Output Validation & Contract Mappers

Mỗi role phải phản hồi bằng một JSON payload có định dạng nghiêm ngặt, tuân theo role contract của nó:

- **`planner`** (`PlannerOutput`): Tóm tắt cấp cao, danh sách task đã lên kế hoạch kèm acceptance criteria, và dependency tường minh giữa các task. Validate task ID duy nhất, chỉ dùng role MVP, và không có chu trình dependency.
- **`developer`** (`DeveloperOutput`): `taskId`, `worktreePath` (khớp đường dẫn được giao, không có `..`), `commit` (SHA hex hợp lệ 7-40 ký tự), `changedFiles` theo đường dẫn tương đối (không có đường dẫn tuyệt đối hay `..`), và `testReport` (`selfReportedOnly: true`, exitCode/failure nhất quán).
- **`reviewer`** (`ReviewerOutput`): `taskId`, `decision` (`approved` hoặc `changes_requested`), `summary`, `criteriaEvaluation`, `findings`, và `modifiedFiles: []` (bắt buộc là mảng rỗng; reviewer không được sửa code). `approved` yêu cầu mọi criteria đạt và không có finding mức error; `changes_requested` yêu cầu ít nhất một criterion chưa đạt hoặc một finding.
- **`qa`** (`QaOutput`): `taskId`, `verdict` (`passed` hoặc `failed`), `summary`, `criteriaVerification`, và `testVerification` chứa `independentRunVerified: true`, `exitCode` là số nguyên, các số đếm test không âm, và `evidenceArtifactIds` không rỗng. Verdict `passed` bắt buộc `independentRunVerified === true`, `exitCode === 0`, `failedCount === 0`, `passedCount > 0`, và mọi criteria đã được verify.

### Validation & Mapping Functions

- `validateRoleOutput(role, rawOutput, context?)`: Validate và parse output thô (chuỗi hoặc object), từ chối các field delegation trái phép (`delegatedTasks`, `subagents`) và role không khớp.
- `toContractAgentResult(output, envelope)`: Map output đã validate sang `AgentResult` của `@bflow/contracts`. Verdict QA failed được map thành `status: "failed"` với code `qa_verification_failed`.
- `toContractApprovalDecision(output, envelope)`: Map `ReviewerOutput` sang `ApprovalDecision` của `@bflow/contracts`.
- `toContractQualityGateResult(output, envelope)`: Map `QaOutput` sang `QualityGateResult` của `@bflow/contracts` với các quality finding có cấu trúc.

## Trusted Artifact Reference Handoff

Nghiêm cấm chia sẻ trực tiếp các giá trị `ArtifactProposal` chưa được verify giữa các role. Artifact phải được ingest vào `ArtifactStore` trước khi chuyển cho các role downstream:

- `ROLE_ARTIFACT_HANDOFF_RULES`: Định nghĩa các đường handoff hợp lệ và các artifact kind được phép/bắt buộc:
  - `planner -> developer`: documents, reports, agent-outputs (mặc định bắt buộc: `document`).
  - `developer -> reviewer`: patches, test-results, reports, agent-outputs, logs (mặc định bắt buộc: `patch`).
  - `reviewer -> developer` (rework): reports, documents, agent-outputs (mặc định bắt buộc: `report`).
  - `developer -> qa`: patches, test-results, logs, reports, agent-outputs (mặc định bắt buộc: `test-result`).
  - `reviewer -> qa`: reports, documents, patches, test-results, logs, agent-outputs (mặc định bắt buộc: `report`).
- `createRoleArtifactHandoff(request)`: Validate rằng handoff tuân theo rule của role, mọi artifact là object `ArtifactReference` đã lưu trữ khớp run ID, không trùng ID, và chứa đủ các kind bắt buộc.
- `ingestRoleArtifactProposals(store, proposals, contentByProposalId, options?)`: Ingest proposal vào một `ArtifactStore` sau khi verify kích thước byte và checksum mật mã, trả về các bản ghi `ArtifactReference` đáng tin cậy.

## End-to-End Feature Workflow Example

- `buildCompleteFeatureWorkflowExample(store)`: Minh họa vòng đời thực thi SDLC 4 giai đoạn hoàn chỉnh, dùng một `ArtifactStore` bắt buộc (các bản ghi `ArtifactReference` đáng tin cậy với `trust: "stored"` chỉ có thể xuất phát từ việc ingest vào `ArtifactStore`; bỏ qua `store` sẽ trả về lỗi validation):
  1. **Planner**: Render prompt, tạo specification artifact proposal, ingest vào store, sinh DAG đã lên kế hoạch, và tạo `AgentResult` của contract.
  2. **Developer**: Nhận specification reference đã lưu qua handoff, render prompt với đường dẫn worktree cô lập, tạo patch và unit test proposal, lưu chúng, và tạo `AgentResult` của contract.
  3. **Reviewer**: Nhận patch và test reference qua handoff, render review prompt kèm diff, sinh review report proposal, validate quyết định `approved`, và tạo `AgentResult` cùng `ApprovalDecision` của contract.
  4. **QA**: Nhận review report và test log reference độc lập, render QA prompt, verify evidence chạy test độc lập, validate verdict `passed`, và tạo `AgentResult` cùng `QualityGateResult` của contract.

## Autonomous Execution & Behavior Policy

`src/behavior-policy.ts` (được re-export từ package index) định nghĩa chính sách cho các role không giao tiếp với người dùng. Chỉ role Conversation (`conversation`/`chat`) được nói chuyện với người dùng; mọi role khác phải làm việc tự chủ và chuyển mọi việc cần con người qua Coordinator và Conversation thông qua Herdr.

- `NON_USER_FACING_POLICY_PARAGRAPHS` / `NON_USER_FACING_AUTONOMOUS_POLICY`: khối bắt buộc (không hỏi người dùng, không chờ input của người dùng, ghi lại các giả định có thể đảo ngược và rủi ro thấp, escalate có cấu trúc lên Coordinator khi bị chặn, im lặng không bao giờ là sự cho phép, không tuyên bố thành công nếu không có evidence). `renderRolePrompt` giờ nhúng khối này vào mọi role prompt MVP ("Non-User-Facing Autonomous Execution Policy") và thêm ràng buộc structured-handoff.
- `STRUCTURED_RESULT_REQUIRED_FIELDS`: `status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`. `ALL_SDLC_BEHAVIOR_ROLES` / `NON_CHAT_SDLC_ROLES` liệt kê các role được bao phủ.
- `validateAutonomousRolePrompt(role, prompt)`: với các role không phải chat, yêu cầu chính sách xuất hiện nguyên văn, có đề cập riêng đến Herdr và mọi field của structured-result, đồng thời từ chối các chỉ thị hỏi hoặc chờ người dùng trong pane. Với `conversation`/`chat`, nó từ chối khối non-user-facing và yêu cầu delegation sang Coordinator qua Herdr, xử lý clarification và approval.
- `validateAutonomousStructuredResult(role, raw, context?)`: validate status (`completed | succeeded | passed | failed | blocked | escalated | changes_requested | inconclusive`); tuyên bố thành công cần evidence (và, khi có context, các test đã chạy với exit code 0); `blocked`/`escalated` cần blockers; `inconclusive` cần evidence hoặc blockers; `next_role` không bao giờ được là `user`; các kiểm tra context từ chối thay đổi ngoài `ownedPaths` (`isPathWithinOwnedPaths`), approval chưa được cấp, quyền dùng tool đã cạn và sự thao túng bởi nội dung repository không đáng tin cậy.
- `validateHerdrRoleHandoff(message)`: parse một `RoleMessage` bằng contract schema và từ chối mọi sender không phải conversation gửi tới `user`, các specialist escalation (`escalation.notice`, `task.blocked`, `clarification.needed`, `verification.escalation`) không gửi tới Coordinator, và các type Coordinator chuyển tiếp cho con người không gửi tới Conversation. Nó chấp nhận id sender/recipient ở dạng camelCase hoặc snake_case.
- `evaluateBehavioralScenario(input)`: helper ra quyết định mang tính xác định cho các kịch bản như input mơ hồ, lỗi build, cần approval, hết quyền dùng tool, vượt phạm vi, thiếu evidence verification và nội dung repository độc hại.

`safety.ts` còn gắn cờ các pattern `direct_pane_user_prompt` (role escape) và `silence_as_approval` (approval bypass) trong nội dung không đáng tin cậy. Đây là các validator tĩnh trên prompt và message; chúng không chứng minh rằng một provider live hay Herdr pane thực sự tuân thủ chính sách.
