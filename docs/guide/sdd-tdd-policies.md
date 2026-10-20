# Chính sách SDD & TDD (Phát triển theo Đặc tả & Kiểm thử)

Trước khi bắt đầu giai đoạn triển khai mã nguồn (implementation), hệ thống bắt buộc phải có tài liệu Đặc tả yêu cầu (`Specification`) đã được phê duyệt chính thức đi kèm các bản ghi tiêu chí nghiệm thu (`AcceptanceCriterion`) cụ thể. Lưu ý rằng tài liệu `Specification` sử dụng `schemaVersion: 2`, khác biệt hoàn toàn với lược đồ cấu hình/quy trình `schemaVersion: "1"`. Hệ thống tuyệt đối không dựa vào số dòng thay đổi (diff) để suy diễn mức độ đặc tả SDD.

---

## 1. Phân loại đặc tả SDD (P15) và kết quả chính sách TDD (P16)

| Kịch bản mẫu | Phân loại & Mức độ SDD (P15) | Chế độ TDD tương ứng (P16) |
| :--- | :--- | :--- |
| **Tính năng mới (Feature)** | `standard` / `full` | `required` (Bắt buộc TDD) |
| **Sửa lỗi cục bộ (Bugfix)** | `standard` / `lightweight` | `required` (Bắt buộc TDD) |
| **Tái cấu trúc mã nguồn (Refactor)** | `standard` / `lightweight` | `recommended` (Khuyến nghị TDD) |
| **Tài liệu thuần túy (Docs)** | `trivial` / `lightweight` | `not_applicable` (Không áp dụng TDD) |

Bảng trên phản ánh kết quả đánh giá thực tế khi chạy qua bộ máy đánh giá, không phải là một bảng ghi đè (override) thủ công:
- **Yêu cầu mức `full`**: Tầng P15 luôn yêu cầu mức `full` đối với các tính năng mới. Các thay đổi liên quan đến bảo mật, API công khai, cấu trúc dữ liệu, kiến trúc tổng thể, di chuyển dữ liệu (migration), tác động liên quan nhiều module hoặc có độ rủi ro cao đều tự động được nâng lên mức `complex / full` và bắt buộc phải có sự phê duyệt từ con người.
- **Quy tắc nâng mức rủi ro**: Ngay cả việc sửa đổi tài liệu thuần túy nhưng nằm trên các đường dẫn nhạy cảm cũng có thể bị nâng mức đặc tả. Dự án có thể thiết lập thêm các bước phê duyệt bổ sung; cấu hình ngưỡng tối thiểu (`minimumLevel`) tuyệt đối không thể dùng để hạ cấp phân loại của P15.

---

## 2. Các cấp độ đặc tả yêu cầu

Chi tiết xác thực được quy định tại [P15 validator](../../packages/specification/src/schema.ts):
- **Cấp độ Lightweight**: Bắt buộc nêu rõ bài toán cần giải quyết, phạm vi (scope), các đường dẫn bị ảnh hưởng (affected paths), danh sách tiêu chí nghiệm thu (acceptance criteria) và khả năng truy vết (traceability).
- **Cấp độ Standard**: Kế thừa toàn bộ cấp độ Lightweight, bổ sung thêm yêu cầu chức năng (functional requirements) và chiến lược kiểm thử đề xuất (proposed test strategy).
- **Cấp độ Full**: Kế thừa cấp độ Standard, bổ sung thiết kế kiến trúc, phân tích bảo mật, phương án rollback, chiến lược kiểm thử chi tiết (`TestStrategy`) và quyết định TDD (`TddDecision`).
- **Cấp độ Complex**: Kế thừa cấp độ Full, yêu cầu bổ sung thiết kế chi tiết, các ràng buộc kỹ thuật, phân tích hợp đồng giao tiếp, đánh đổi kiến trúc (tradeoffs) và chiến lược di chuyển dữ liệu nếu có thay đổi về lược đồ dữ liệu.

Các tệp `sdd/*.assessment.json` trong [thư mục mẫu](../../templates/node-typescript/sdd/) đóng vai trò là đầu vào cho `ChangeAssessmentSchema`. Các tệp `specifications/*.spec.json` là các bản thảo hợp lệ cho `SpecificationDocumentSchema`, chứa `metadata.sdd` và `metadata.conditionalTdd`. Tuyệt đối không giả mạo trường `approvedBy` hay URI artifact. Các giá trị định danh run/session và dấu thời gian trong mẫu chỉ nhằm mục đích kiểm tra tính hợp lệ của schema/policy; host có trách nhiệm liên kết lại phiên thực tế và giải quyết lại chiến lược thay vì chỉ thay đổi ID của một quyết định đã băm.

---

## 3. Chính sách TDD có điều kiện (Conditional TDD - P16)

Động cơ P16 phân tích 7 nhóm thông tin đầu vào: loại tác vụ, tiêu chí nghiệm thu, mức độ tác động, hạ tầng kiểm thử, khả năng kiểm thử, rủi ro kỹ thuật và quy ước của dự án. Trường cấu hình `environment.tdd.policy` không thể thay thế cho quy trình đánh giá đó. Để tùy chỉnh, hãy cập nhật tệp đánh giá cho sát với thực tế, khai báo các lệnh kiểm thử khả dụng, sau đó thực thi `TestStrategyResolver.resolve(spec)` và `validateAgainstSpecification(strategy, spec)` trực tiếp trên host.

| Chế độ TDD (`mode`) | Nghĩa vụ bắt buộc khi thực thi |
| :--- | :--- |
| **`required`** | Bắt buộc phải có trạng thái **Red** (kiểm thử thất bại đúng lỗi hành vi mong đợi) trước khi cho phép Developer bắt đầu viết code; phải giữ nguyên phiên bản kiểm thử, tên test và câu lệnh khi chuyển sang trạng thái **Green**; bắt buộc chạy lại toàn bộ kiểm thử thành công sau bước **Refactor**. |
| **`recommended`** | Khuyến khích áp dụng chu trình TDD; dù không bắt buộc Red trước, vẫn bắt buộc phải có biên nhận xác minh độc lập (independent verification receipt) thành công. |
| **`not_applicable`** | Không áp dụng TDD nhưng bắt buộc phải có hình thức xác minh thay thế (alternative verification) phù hợp với loại tiêu chí: rà soát thủ công (manual review), kiểm tra lint, kiểm tra kiểu tĩnh (typecheck), kiểm tra schema hoặc chạy smoke test. |

> [!IMPORTANT]
> - Lỗi do thiếu thư viện hoặc hạ tầng kiểm thử chưa sẵn sàng không được công nhận là trạng thái Red hợp lệ.
> - Các thay đổi hành vi hỗn hợp có thể bị bắt buộc áp dụng TDD ngay cả khi tên tác vụ ghi là sửa tài liệu hay cấu hình.
> - Các tác vụ logic nghiệp vụ (domain logic) hoặc sửa lỗi (bugfix) không bao giờ được resolver cho phép gán `not_applicable`. Không có cờ boolean tự khai báo nào có thể dùng để bỏ qua kiểm tra.

Bằng chứng kỹ thuật thực tế được ghi nhận thông qua các phương thức `recordEvidence`, `assertReadyToImplement` và `assertEvidenceComplete`. Host có trách nhiệm xác thực runner, phiên bản mã nguồn (revision), thời gian thực thi và nội dung nhật ký log; đồng thời chuyển đổi `ArtifactProposal` thông qua `ArtifactStore` để lấy tham chiếu tin cậy `artifact://`. Một bản JSON chiến lược hợp lệ hay lời khẳng định của agent rằng "tests passed" hoàn toàn không được coi là bằng chứng. Xem thêm tại [Vòng lặp kiểm tra (Verification Loop)](verification-loop.md).
