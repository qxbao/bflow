# Vòng lặp kiểm tra (Verification Loop)

Trong kiến trúc Bflow, quy trình kiểm tra được chia làm hai tầng nghiêm ngặt:
1. **Xác minh cấp độ tác vụ (Task Verification - P17/P19)**: Đánh giá trực tiếp trên `GitChangeSet`, tài liệu đặc tả (`Specification`) và chiến lược kiểm thử (`TestStrategy`) đã đóng băng.
2. **Xác minh cấp độ quy trình (Workflow Verification - P17/P18)**: Sau khi Git Orchestrator (P18) tích hợp các nhánh theo đúng thứ tự phụ thuộc, P17 sẽ tiến hành xác minh toàn diện quy trình trên phiên bản tích hợp thực tế.

> [!IMPORTANT]
> Việc một tác vụ đơn lẻ vượt qua bài kiểm tra (`task passed`) không thể thay thế cho bước xác minh sau tích hợp (post-integration verification) hoặc sự phê duyệt chính thức từ người vận hành trước khi bàn giao kết quả.

---

## 1. Cấu hình kiểm tra độc lập và các kết quả đánh giá

Host có trách nhiệm cấu hình danh sách kiểm tra tác vụ (`taskChecks`), kiểm tra quy trình (`workflowChecks`), các bộ chạy cổng chất lượng tất định (`QualityGate` runners), vai trò Reviewer/QA và cơ chế xác thực. Các bài kiểm tra này bắt buộc phải là những đầu vào tin cậy do chủ sở hữu dự án thiết lập, tuyệt đối không lấy tùy tiện từ các tệp JSON do agent tự sinh. 

Trong dự án mẫu TypeScript, các lệnh kiểm tra thực tế bao gồm `pnpm typecheck`, `pnpm build` và `pnpm test`. Đối với việc rà soát tài liệu thủ công, cần có con người hoặc vai trò chuyên trách độc lập kiểm tra tài liệu sau khi render cùng tính chính xác của các câu lệnh mẫu. Việc chỉ khai báo tên bài kiểm tra không đồng nghĩa với việc câu lệnh đã được thực thi hoặc môi trường đã được cô lập an toàn.

| Kết quả đánh giá (`outcome`) | Ý nghĩa và hành động tiếp theo |
| :--- | :--- |
| **`passed`** | Vượt qua kiểm tra; bắt buộc phải có đầy đủ bằng chứng tiêu chí nghiệm thu, đúng phiên bản mã nguồn chính xác và biên nhận kiểm thử độc lập trước khi chuyển sang bước kế tiếp. |
| **`failed`** | Thất bại có nguyên nhân rõ ràng; Developer có thể được yêu cầu sửa đổi trong phạm vi ngân sách số lần thử còn lại. |
| **`inconclusive`** | Kết quả không thể kết luận do thiếu bằng chứng xác thực; hệ thống sẽ tự động leo thang (escalate) xin ý kiến người vận hành, tuyệt đối không suy đoán là đã pass. |
| **`blocked`** | Quá trình xác minh bị chặn bởi các điều kiện ngoại cảnh (hạ tầng lỗi, thiếu dịch vụ); tự động leo thang tới người vận hành. |

---

## 2. Ngân sách thử lại và sửa đổi (Retry & Rework Budget)

Cấu hình mẫu quy định: số lần thử lại tối đa `maxAttempts: 2` (khoảng trễ cố định 1.000 ms), số lần sửa đổi tối đa `maxReworks: 2`, hành động khi cạn kiệt ngân sách `onExhausted: "require_human"`, và thời gian chờ thực thi tối đa 300.000 ms với `onTimeout: "fail"`. 

Các chỉ số này thuộc về các cơ chế kiểm soát hoàn toàn riêng biệt:

| Cơ chế kiểm soát | Nguồn cấu hình | Mục đích và ý nghĩa vận hành |
| :--- | :--- | :--- |
| **Thử lại khi thực thi (Execution Retry)** | `task.retry` | Ngân sách số lần thử lại khi việc triển khai tác vụ gặp lỗi kỹ thuật |
| **Thực hiện sửa đổi (Rework Generation)** | `task.rework` | Giới hạn số lần chỉnh sửa lại sau khi nhận phán quyết yêu cầu sửa đổi (`changes_requested`) |
| **Chu trình xác minh (Verification Cycle)** | `propose_workflow.maxIterations` (P19) | Giới hạn số vòng lặp xác minh của P17 (mặc định: 3, cho phép từ 1–10) |
| **Thời gian chờ vòng đời (Lifecycle Timeout)** | `environment.*TimeoutMs` / `--timeout` | Hạn mức thời gian chờ tối đa cho các thao tác khởi động hoặc dừng môi trường |

CLI đã chuyển `environment.verification.maxIterations` sang persistent host. Config schema nhận tới 100 nhưng host/VerificationEngine chỉ nhận 1–10, mặc định 3; giá trị ngoài giao miền này bị từ chối, không tự clamp hoặc bỏ qua. P19 sẽ tăng ngân sách sửa chữa thêm `maxIterations - 1` và áp dụng siêu dữ liệu cổng kiểm tra `boundedVerificationRetry` cho các bài kiểm tra độc lập bắt buộc trước khi hoàn tất. Các ngân sách thử lại và sửa lỗi đều có giới hạn hữu hạn; tuyệt đối không nhân gộp các ngân sách để tạo ra số lần thử vô hạn.

---

## 3. Rework có giải trình theo finding

Sau cycle thất bại cần sửa, Runtime giao `reworkContext` với exact finding ID, revision/generation và ngân sách còn lại. Developer nộp `findingResolutions` theo từng finding: nguyên nhân, source location, repair summary, phép kiểm tra phân biệt trước/sau và evidence. `addressed` cần commit sạch mới và ràng buộc revision đúng; `disputed`/`blocked` phải có lý do và bằng chứng tương ứng.

Hồ sơ được host kiểm tra cấu trúc/provenance và lưu vào ArtifactStore; report này chưa tự chứng minh causal claim đúng. Reviewer/QA nhận dossier và dùng `findingVerdicts` để xác nhận hoặc bác bỏ. Host/Runtime bắt buộc `findingVerdicts` độc lập phủ đủ mọi finding trong `reworkContext.findings` của generation hiện hành (ghim vào revision, attempt và dossier); thiếu/lệch verdict bị từ chối hoặc chuyển thành `inconclusive` thay vì pass, và settlement chỉ đóng các finding có verdict `confirmed`. Mức bằng chứng hiện tại là source + local/fake-runner tests, chưa phải live provider/Herdr acceptance, và guard cấu trúc không tự chứng minh chất lượng phán đoán của model. Ngoài ra, bộ cổng mặc định có `host-test-integrity` kiểm tra AST JS/TS đối với thay đổi làm yếu test/config giữa base được bảo vệ và candidate, yêu cầu Reviewer thẩm định từng finding và hạ cấp fast-path để giữ review độc lập. [Rework reference](../rework-causality.md) · [Test integrity](../../packages/runtime/TEST-INTEGRITY-VALIDATION.md).

Test plan mới dùng chuỗi criterion → risk/viewpoint → exact test/check → observation → evidence. NFR có thêm điều kiện/oracle đã được duyệt; skill reference không thay runner khả dụng hoặc TddDecision. [NFR/test design](../nfr-and-test-design.md).

## 4. Xử lý khi cạn kiệt số lần thử và khôi phục trạng thái

Khi đã cạn kiệt số vòng lặp tối đa, Runtime sẽ tự động leo thang thông qua Conversation Agent để yêu cầu con người can thiệp. Trong mọi tình huống, hệ thống:
- Tuyệt đối không tự ý cắt giảm tiêu chí nghiệm thu, thay đổi đặc tả hay sửa đổi chiến lược kiểm thử chỉ nhằm mục đích làm "xanh" kết quả kiểm thử.
- Tuyệt đối không tự động tăng giới hạn số lần thử.
- Nếu việc xác minh quy trình sau tích hợp thất bại, hệ thống đòi hỏi phải có một kế hoạch sửa đổi/ủy quyền mới được phê duyệt; tuyệt đối không tự ý chỉnh sửa đồ thị DAG đã được thông qua.
- Nếu xảy ra xung đột mã nguồn, Git worktree và nhánh tương ứng sẽ được giữ nguyên trạng để người vận hành xử lý có kiểm soát.

Cơ chế phát lại trạng thái của Core (`replay`) luôn bảo toàn đầy đủ các quyết định phê duyệt, số lần thử lại, trạng thái cổng kiểm tra và yêu cầu hủy bỏ. Nếu xảy ra sự cố sập nguồn (crash) trong quá trình xác minh, host sẽ chủ động đối soát các biên nhận mà P17 đã lưu trữ trước khi thực hiện bài kiểm tra mới, không dựa vào ảnh chụp màn hình terminal để phỏng đoán kết quả. Xem thêm tại [Khôi phục phiên làm việc (Session Recovery)](session-recovery.md) và [Bảo mật & Phê duyệt (Security & Approval)](security-approval.md).
