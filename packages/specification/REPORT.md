# Báo Cáo Triển Khai & Nghiệm Thu Phase P15: Spec-Driven Development Engine (`@bflow/specification`, `agents/analyst`, `agents/architect`)

## 1. Tổng Quan & Mục Tiêu

Phase **P15** hiện thực hóa **Spec-Driven Development (SDD) Engine** cho hệ thống **Bflow Agentic SDLC v2** dựa trên `@bflow/contracts` (v2):
- Thiết lập **Specification** là nguồn chân lý duy nhất (**Single Source of Truth**) xác định mục tiêu và tiêu chí nghiệm thu (`AcceptanceCriterion`) của mọi công việc.
- Áp dụng cơ chế **Adaptive SDD** (độ chi tiết tỷ lệ với mức độ rủi ro và ảnh hưởng): phân loại thay đổi thành `trivial`, `standard`, `complex` gắn với cấp độ `lightweight` / `full`, yêu cầu tài liệu tương ứng và cổng phê duyệt con người (`humanApprovalRequired`) đối với thay đổi rủi ro cao.
- Thực thi trên Git worktree độc lập `.agents/worktrees/p15-specification` (nhánh `agent/specification/p15-specification-engine`), tuân thủ tuyệt đối phạm vi đường dẫn sở hữu: `packages/specification/**`, `agents/analyst/**`, và `agents/architect/**`.

---

## 2. Danh Mục Tệp Tin & 8 Thành Phần Đã Triển Khai

### 2.1. Gói `@bflow/specification` (`packages/specification/**`)
1. **Specification Classification (`src/classification.ts`)**:
   - `ChangeAssessmentSchema`, `ClassificationSchema`, `classifyChange`, `classifyChangeSafe`, `getRequiredSpecSections`, `hasSecurityPathHint`, `hasPublicApiPathHint`, `hasDataSchemaPathHint`.
   - Phân loại `trivial | standard | complex`, cấp độ `lightweight | full`, mức rủi ro `low | medium | high | critical` và cờ `humanApprovalRequired`.
   - Cưỡng chế quy tắc không bỏ qua vấn đề bảo mật chỉ vì thay đổi mã nguồn có vẻ nhỏ thông qua đánh giá cờ tác động và conservative path hints.
2. **Specification Schema Validation (`src/schema.ts`)**:
   - `PolicyDetailsSchema`, `SpecificationDocumentSchema`, `parseSpecification`, `policyDetails`, `validateSpecificationDocument`, `SpecDraftPayloadSchema`, `SpecApprovedPayloadSchema`.
   - Kiểm tra cấu trúc tỷ lệ với độ phức tạp:
     - `trivial`: Mục tiêu ngắn gọn (`title`, `summary`, `problemStatement`, `scope`, `affectedPaths`) và tối thiểu 1 điều kiện hoàn thành bắt buộc (`required: true`).
     - `standard`: Bổ sung `functionalRequirements` và `proposedTestStrategy`.
     - `complex`: Bổ sung `designProposal`, `technicalConstraints`, `apiDataContracts`, `risksAndTradeoffs`, `architectureNotes`, `securityConsiderations`, `rollbackPlan`, `testStrategy`, `tddDecision`, cùng `dataModelChanges` & `migrationStrategy` khi có tác động dữ liệu/migration.
3. **Spec Versioning (`src/engine.ts`)**:
   - `createDraft` (khởi tạo `version: 1`, trạng thái `draft`), `revise` (tăng `version` đúng 1 đơn vị, bảo toàn định danh `specId`/`sessionId`/`runId`/`createdAt`, yêu cầu `revisionReason` và thay đổi thực chất), `supersede` (chuyển bản `approved` cũ sang `superseded` khi bản `version + 1` được phê duyệt).
4. **Acceptance Criteria Management (`src/criteria.ts`)**:
   - `addCriterionToDraft`, `updateCriterionInDraft`, `removeCriterionFromDraft`: chỉ cho phép chỉnh sửa tiêu chí trên bản `draft`, tự động đồng bộ `traceabilityTaskIds` và `testStrategy.criterionMappings`.
   - `assertNoCriteriaWeakeningOnFailure`: cưỡng chế quy tắc **không tự sửa tiêu chí nghiệm thu để hợp thức hóa implementation thất bại** (chặn xóa, hạ `required: false`, hạ cấp `verificationMethod`, đổi `category`, hoặc sửa `description` của tiêu chí đang fail).
   - `evaluateCriteriaFromVerification`: đánh giá khách quan trạng thái tiêu chí từ `VerificationResult` độc lập mà không làm đột biến tạo phẩm đặc tả đã phê duyệt.
5. **Spec-to-Task Traceability (`src/traceability.ts`)**:
   - `validateTraceability`, `buildTraceabilityMatrix` (ma trận truy vết 2 chiều `criterionToTasks` & `taskToCriteria`, phát hiện `orphanCriterionIds`, `unmappedWorkflowTaskIds`, `unknownMappedTaskIds`).
   - `validateChangedFilesScope`: kiểm tra danh sách file thay đổi so với `affectedPaths` (hỗ trợ exact path, directory prefix, glob và chặn path traversal).
6. **Spec Change Detection (`src/traceability.ts`)**:
   - `detectSpecChanges`: phát hiện tiêu chí thêm (`addedCriterionIds`), xóa (`removedCriterionIds`), sửa (`changedCriterionIds`), giữ nguyên (`unchangedCriterionIds`), các trường yêu cầu thay đổi (`changedFields`), các task bị ảnh hưởng trực tiếp (`affectedTaskIds`) và bị ảnh hưởng bắc cầu theo DAG (`transitivelyAffectedTaskIds`).
7. **Spec Approval Policy (`src/engine.ts`)**:
   - `submitForReview`, `requestApproval`, `approve`, `reject`, `assertImplementationReady`, `verifyArtifact`.
   - Chặn review và implementation khi còn `unresolvedQuestions` (*"Không triển khai trước khi yêu cầu cốt lõi đủ rõ"*).
   - Bắt buộc phê duyệt bởi con người có xác thực (`humanApprovalRequired`) đối với thay đổi `complex` / rủi ro cao trước khi implementation.
   - Phát hiện mọi hành vi sửa đổi trái phép nội dung, tiêu chí nghiệm thu, metadata hoặc chữ ký phê duyệt sau khi đặc tả đã được duyệt.
8. **Artifact References, Rendering & RoleMessage (`src/content.ts`, `src/render.ts`, `src/prompts.ts`)**:
   - `canonicalJson`, `contentBytes`, `digest`, `createSpecificationArtifactProposal` (JSON & Markdown), `buildSpecRoleMessage` (`spec.draft` & `spec.approved`), `renderSpecification`.

### 2.2. Cấu hình & System Prompts cho Analyst và Architect (`agents/analyst/**`, `agents/architect/**`)
- `agents/analyst/{prompt.md,system-prompt.md,role-profile.json,README.md}` (`role: "specifier"`, `readOnlyWorkspace: true`, `userFacing: false`, `allowedRecipients: ["coordinator", "runtime"]`).
- `agents/architect/{prompt.md,system-prompt.md,role-profile.json,README.md}` (`role: "architect"`, `readOnlyWorkspace: true`, `userFacing: false`, `allowedRecipients: ["coordinator", "runtime"]`).

### 2.3. Ví dụ Artifact (`packages/specification/examples/**`)
- `examples/trivial.{json,md}`: Thay đổi tài liệu đơn giản (`trivial`, `lightweight`, `low`).
- `examples/standard.{json,md}`: Sửa lỗi logic (`standard`, `lightweight`, `medium`).
- `examples/api.{json,md}`: Thêm API công khai mới (`complex`, `full`, `high`).
- `examples/complex.{json,md}`: Thay đổi database schema & migration (`complex`, `full`, `high`).

---

## 3. Quy Trình Thực Thi Đa Tác Tử (Flash 3.8 ➔ Argon 4 High Review ➔ Flash 3.8 Fix ➔ Argon 4 High Nghiệm Thu)

1. **Đợt 1 — Triển khai bởi 4 Subagent Flash 3.8**:
   - **Subagent 1 (Flash 3.8)**: Triển khai `classification.ts`, `schema.ts`, `content.ts`, `render.ts`.
   - **Subagent 2 (Flash 3.8)**: Triển khai `criteria.ts`, `traceability.ts`, `engine.ts`.
   - **Subagent 3 (Flash 3.8)**: Triển khai `prompts.ts`, `agents/analyst/**`, `agents/architect/**`, `examples/api.{json,md}`.
   - **Subagent 4 (Flash 3.8)**: Hợp nhất `index.ts`, cập nhật `README.md`, và xây dựng bộ kiểm thử `specification.test.ts` (116 bài test).
2. **Đợt 2 — Kiểm toán độc lập bởi Argon 4 High (`Principal Reviewer`)**:
   - Phát hiện **4 Blockers + 1 Major**:
     - *Blocker 1*: `buildSpecRoleMessage` chưa kiểm tra `spec.status === "approved"`, `spec.approvedBy`, `spec.artifactRef` và `senderRole === "coordinator"` khi phát thông điệp `spec.approved`, cũng như chưa đối chiếu `spec.runId === options.runId`.
     - *Blocker 2*: `createSpecificationArtifactProposal` có nhánh fallback sang `SpecificationSchema.parse` khi thiếu `metadata.sdd`, làm lộ kẽ hở bỏ qua `parseSpecification` của P15.
     - *Blocker 3*: `validateChangedFilesScope` chưa lọc path traversal (`..`, `/`, `\`) và khớp nhầm mẫu file có phần mở rộng như prefix thư mục.
     - *Blocker 4*: `assertNoCriteriaWeakeningOnFailure` chưa đối chiếu định danh (`specId`, `sessionId`, `runId`), chưa chặn hành vi đổi `category` của tiêu chí đang fail, và `addCriterionToDraft` / `updateCriterionInDraft` chưa xác thực Zod cho `mappedTaskIds`.
     - *Major 1*: `engine.supersede` chưa kiểm tra tính đơn điệu của thời gian (`next.updatedAt >= previous.updatedAt`).
3. **Đợt 3 — Khắc phục bởi Subagent Flash 3.8 (`P15 Remediation Engineer`)**:
   - Sửa triệt để cả 4 Blockers và 1 Major, bổ sung bộ regression tests chuyên biệt (nâng tổng số bài kiểm thử của gói lên **121 test cases**).
4. **Đợt 4 — Nghiệm thu cuối cùng bởi Argon 4 High**:
   - Xác minh toàn bộ mã nguồn, ràng buộc hợp đồng, tính bất biến của tạo phẩm và bộ kiểm thử toàn monorepo đạt 100%, ký kết quả **`NGHIỆM THU: APPROVED`**.

---

## 4. Kết Quả Kiểm Chứng Thực Thi

| Lệnh kiểm tra | Mã thoát | Kết quả chi tiết |
| :--- | :---: | :--- |
| `pnpm run check:deps` | `0` | `Workspace dependency graph is acyclic (12 packages, 18 internal edges).` |
| `pnpm run typecheck` | `0` | Toàn bộ workspace pass strict TypeScript check (`0 errors`) |
| `pnpm --filter @bflow/specification test` | `0` | **1 file passed, 121 / 121 tests passed** |
| `pnpm run test` | `0` | **40 test files passed, 922 / 922 tests passed (0 regressions)** |
| `git diff --check` | `0` | Không có lỗi khoảng trắng hay định dạng |
| `git status --short` | `0` | Chỉ chứa các file thuộc `packages/specification/**`, `agents/analyst/**`, `agents/architect/**` |
