# ADR 0004 — Fast-path cho thay đổi trivial và cơ chế miễn trừ review có kiểm chứng (`reviewWaiver`)

Trạng thái: Accepted — được project owner (dquanbao@gmail.com) phê duyệt ngày 2026-10-26.
Đây là quyết định tích hợp theo yêu cầu của `AGENTS.md` cho phép mở rộng quy tắc kiểm chứng của P17 (`packages/verification`), điều chỉnh luồng lập kế hoạch/phê duyệt thiết kế của P30 (`packages/runtime`, `agents/coordinator/**`) và bổ sung tuỳ chọn cấu hình `fastPath.mode` trên P29 (`apps/cli`).

## Bối cảnh (Context)

Khảo sát luồng thực thi thực tế tại baseline `ea15b4d` cho thấy một thay đổi đơn lẻ, phạm vi hẹp đã được P15 (`@bflow/specification`) phân loại `trivial` vẫn phải đi qua toàn bộ chuỗi bước trung gian trùng lặp:
1. Conversation chuyển `DelegationRequest` sang Coordinator.
2. Coordinator gọi `inspect` → `assess` → (có thể gọi `request_specialist`) → `propose_workflow`.
3. Dù `classification.humanApprovalRequired` là `false` với thay đổi `trivial`, mặc định `policy.sdd.approvalRequired: true` của dự án vẫn buộc dừng chờ người dùng duyệt thiết kế trước khi triển khai.
4. P17 (`packages/verification/src/model.ts:173`) áp đặt quy tắc cứng: mọi `VerificationPlan` bắt buộc phải chứa ít nhất một check `kind: "review"` (`"An independent Reviewer or QA check is required"`). Hệ quả là cả ở mức task lẫn mức workflow sau khi P18 (`@bflow/git-orchestrator`) merge, Runtime đều phải dispatch các lượt LLM cho `host-reviewer` và `host-qa`.

Trong khi đó:
- Các gate behavioral, regression và git-integrity của host đều được thực thi độc lập bởi chính host (`executorId: "bflow-host-behavioral-check"` / `"bflow-host-git-check"`), không dựa vào tuyên bố của agent. Khi mọi tiêu chí nghiệm thu bắt buộc của một task `trivial` đều thuộc loại tự động hóa (`verificationMethod !== "manual_review"`) và được phủ đầy đủ bởi các check `kind: "deterministic"` do host đo, việc bắt buộc thêm lượt Reviewer/QA ở mức task chỉ lặp lại kết quả đã được chứng minh bằng thực nghiệm.
- Với các thay đổi chỉ gồm tài liệu (`documentation`), các tiêu chí nghiệm thu là `manual_review` và không có test runner tự động, nên một role kiểm tra độc lập ở mức task vẫn cần thiết. Tuy nhiên, khi run chỉ có đúng một task đã vượt qua kiểm chứng (`cycle.status === "passed"`) và cây Git sau tích hợp (`integration.expectedHead^{tree}`) giống hệt cây Git của commit task (`task.changeSet.headCommitHash^{tree}`), việc chạy lại Reviewer và QA lần thứ hai ở mức workflow là hoàn toàn trùng lặp.

## Quyết định (Decision)

Áp dụng cơ chế **Fast-path cho thay đổi trivial** theo 8 quyết định thiết kế (D1–D8), đảm bảo nguyên tắc **fail-closed** (bất kỳ điều kiện nào không thoả mãn đều quay về luồng chuẩn):

- **D1 — Giữ ranh giới Coordinator nhưng rút gọn còn một lượt**: Conversation không dispatch trực tiếp cho Developer. `assess` trả thêm preview `fastPath: { eligible, blockers }`. Khi `eligible: true`, prompt yêu cầu Coordinator đề xuất ngay đúng **một** Developer task với `metadata.ownedPaths` bằng `affectedPaths`, không có dependency và không gọi `request_specialist`.
- **D2 — Runtime là nơi duy nhất tính toán thẩm quyền fast-path**: Runtime đánh giá thuần (`evaluateFastPath`) dựa trên cấu hình `policy.fastPath.mode`, phân loại `classifyChange` của P15, `Specification`, `WorkflowDefinition`, `TestStrategy` và lịch sử outbound của run. Mọi cờ `fastPath` do agent tự gắn trong `metadata` hoặc tool input đều bị bỏ qua.
- **D3 — Đóng băng quyết định tại `proposeWorkflow`**: Kết quả được ghi vào `RunRecord.fastPath` cùng lúc với `run.definition` trước khi tạo bất kỳ `VerificationCycle` nào, đảm bảo `planId` bất biến xuyên suốt các vòng rework. Khi có requirement revision hoặc follow-up run, quyết định được tính lại từ đầu.
- **D4 — Miễn trừ review mức task (`deterministic_coverage`)**: Cho phép lọc bỏ các check `kind: "review"` khỏi `VerificationPlan` mức `task` khi và chỉ khi:
  1. `run.fastPath.status === "active"`.
  2. Mọi `AcceptanceCriterion` đang hiệu lực (`status !== "waived"`) và bắt buộc (`required !== false`) đều có `verificationMethod !== "manual_review"`.
  3. Mỗi tiêu chí bắt buộc đều được phủ đầy đủ `testNames` bởi ít nhất một check `kind: "deterministic"` cùng `method`.
  4. `strategy.targetCommands.length > 0`.
  5. `strategy.tddDecision.mode !== "required"`.
- **D5 — Miễn trừ review mức workflow (`identical_integrated_tree`)**: Cho phép lọc bỏ các check `kind: "review"` khỏi `VerificationPlan` mức `workflow` khi và chỉ khi:
  1. `run.fastPath.status === "active"`.
  2. Run có đúng một task và `cycle` mức task của nó đã `passed`.
  3. Tree hash Git của commit tích hợp (`git rev-parse --verify <integration.expectedHead>^{tree}`) trùng khớp tuyệt đối (`^[a-f0-9]{40}$`) với tree hash của commit task đã verify (`<task.changeSet.headCommitHash>^{tree}`).
  4. Waiver ghi nhận `taskVerificationIds` (chứa đúng 1 ID kết quả verify mức task), `taskTree` và `integratedTree` để phục vụ kiểm toán. Các gate deterministic mức `integration`/`regression` (`host-git-integrity` và regression gate) vẫn bắt buộc giữ nguyên.
- **D6 — Hạ cấp một chiều (One-way Downgrade) trước khi tạo cycle**: Cả Runtime và P17 đều kiểm tra độc lập điều kiện của waiver. Nếu P17 từ chối waiver (`review_waiver_*`) hoặc tree hash không khớp (`tree_mismatch`), Runtime dựng lại `VerificationPlan` đầy đủ (có `host-reviewer` và `host-qa`), chuyển `run.fastPath.status = "downgraded"` kèm lý do và phát thông báo tiến độ tiếng Việt cho người dùng. Đã downgrade thì không bao giờ kích hoạt lại trong cùng proposal.
- **D7 — Giữ nguyên cô lập Git worktree**: Tiếp tục sử dụng worktree riêng cho Developer task và integration nhằm bảo toàn tính toàn vẹn của lease/fence, kiểm tra phạm vi file (`scopeCheck`), bằng chứng patch và khả năng phục hồi.
- **D8 — Tự động phê duyệt thiết kế khi fast-path active; giữ nguyên phê duyệt bàn giao (delivery)**: Khi `run.fastPath.status === "active"` và `classification.humanApprovalRequired === false`, `designNeedsHuman` bỏ qua cờ `policy.sdd.approvalRequired` cấp dự án để Coordinator tự duyệt thiết kế (`settleDesignApproval`) và phát thông báo tiến độ. Cổng phê duyệt bàn giao cuối cùng (`delivery` approval sau khi workflow verification hoàn tất) được giữ nguyên làm điểm chạm kiểm soát của người dùng.

## Hệ quả (Consequences)

- `docs/sdlc-policies.md`: Quy tắc trong vòng lặp kiểm chứng có giới hạn được cập nhật từ "luôn bắt buộc Reviewer/QA độc lập" thành "bắt buộc Reviewer/QA độc lập **hoặc** bằng chứng deterministic được đo độc lập bởi host kèm `reviewWaiver` hợp lệ đã được P17 kiểm chứng".
- Các thay đổi `trivial` đủ điều kiện (như refactor nhỏ có test runner tự động) không tốn thêm lượt chờ duyệt thiết kế và không gọi Reviewer/QA ở cả mức task lẫn workflow; các thay đổi chỉ sửa tài liệu (`manual_review`) vẫn chạy Reviewer/QA ở mức task nhưng bỏ qua bước review trùng lặp ở mức workflow.
- Mọi vi phạm điều kiện (đa task, glob path, > 5 đường dẫn, có câu hỏi chưa làm rõ, TDD `required`, dùng specialist, hoặc P17 từ chối waiver) đều tự động đi theo luồng kiểm chứng đầy đủ hiện hành.

## Tương thích & Di trú (Compatibility)

- **Không thay đổi `@bflow/contracts`**: `VerificationPlan` và `PlanInputSchema` là kiểu nội bộ của `@bflow/verification` nên trường tuỳ chọn `reviewWaiver` không làm thay đổi contract công khai.
- **Tương thích ngược với Journal và Host state**:
  - `RunRecord.fastPath` là trường tuỳ chọn trong private journal của Runtime; không tăng `version` của journal. Các journal cũ không có `fastPath` mặc định chạy theo luồng chuẩn.
  - Cấu hình `.bflow/config.yml` mới mặc định `environment.fastPath.mode: "auto"`. Tuy nhiên, các file `host.json` đã persist từ phiên bản trước khi nâng cấp (thiếu trường `fastPath`) được `effectiveFastPathMode(policy, true)` xử lý an toàn thành `"off"`.

## Các thành phần và Owner bị ảnh hưởng (Affected Owners)

- **P17 (`packages/verification/**`)**: Mở rộng `PlanInputSchema` với discriminated union `reviewWaiver` (`deterministic_coverage` | `identical_integrated_tree`) và kiểm chứng điều kiện thay cho lỗi cứng tại `model.ts:173`.
- **P30 (`packages/runtime/**`, `agents/coordinator/**`)**: Bổ sung module thuần `fast-path.ts`, lưu `RunRecord.fastPath` trong journal, cập nhật `assess` / `proposeWorkflow` / `designNeedsHuman` / `verificationPlan`, thêm port `policies.git.treeOf`, hiển thị thông báo tiếng Việt và cập nhật hướng dẫn trong `agents/coordinator/system-prompt.md`.
- **P29 (`apps/cli/**`)**: Bổ sung schema, giá trị mặc định `auto`, banner tiếng Việt cho `environment.fastPath.mode` và truyền sang `AgenticHostOptions.policy`.
