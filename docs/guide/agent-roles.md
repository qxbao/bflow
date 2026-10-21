# Các vai trò Agent (Agent Roles)

Trong hệ thống Bflow, tên hiển thị (display name), khóa topo (topology key) và vai trò theo hợp đồng (contract/config role) có sự phân biệt rõ ràng. Trong danh sách cấu hình `environment.roles[].role`, bạn bắt buộc phải sử dụng **contract role** theo bảng dưới đây; các bí danh như `chat`, `analyst`, `qa-verifier` chỉ được sử dụng trong các API định nghĩa topo hoặc profile, không được dùng làm giá trị thay thế trong cấu hình vòng đời.

---

## 1. Bảng ánh xạ vai trò và trách nhiệm

| Vai trò | Khóa Topo (Topology Key) | Tên trong Hợp đồng (Contract/Config Role) | Phân định trách nhiệm chính |
| :--- | :--- | :--- | :--- |
| **Chat** | `chat` | `conversation` | Là giao diện duy nhất tương tác với người dùng; làm rõ yêu cầu, báo cáo tiến độ và tiếp nhận quyết định/phê duyệt |
| **Coordinator** | `coordinator` | `coordinator` | Lập đặc tả yêu cầu, xây dựng đồ thị DAG, gọi các công cụ của Runtime và phân bổ nhiệm vụ cho các chuyên gia |
| **Analyst** | `analyst` | `specifier` | Phân tích yêu cầu nghiệp vụ, xác định danh sách tiêu chí nghiệm thu (criterion IDs), phạm vi và đánh giá tác động |
| **Architect** | `architect` | `architect` | Thiết kế kiến trúc tổng thể, xác định API, lược đồ dữ liệu, bảo mật, phương án rollback và cân nhắc đánh đổi (tradeoffs) |
| **Planner** | `planner` | `planner` | Phân rã tác vụ, thiết lập thứ tự phụ thuộc, duy trì khả năng truy vết (traceability) và phân định quyền sở hữu đường dẫn mã nguồn |
| **Developer** | `developer` | `developer` | Trực tiếp triển khai mã nguồn trong Git worktree riêng biệt; cung cấp bằng chứng bản vá (patch) và kết quả kiểm thử |
| **Reviewer** | `reviewer` | `reviewer` | Rà soát mã nguồn độc lập; đưa ra phán quyết (verdict) dựa trên phiên bản Git chính xác và bằng chứng khách quan |
| **QA Verifier** | `qa-verifier` | `qa` | Xác minh kiểm thử độc lập, đảm bảo độ bao phủ tiêu chí nghiệm thu và kiểm tra bằng chứng TDD |

---

## 2. Cấu hình vai trò và nguyên tắc cấp phát

Cấu hình mẫu CLI khởi tạo bảy vai trò thường trực (permanent roles) sử dụng `codex` và đều được gán `required: true`. Ví dụ một mục cấu hình trong tệp:

```json
{ "role": "specifier", "cli": "codex", "required": true }
```

- **Công cụ dòng lệnh (`cli`)**: Phải là một loại agent được hỗ trợ sẵn trên biến môi trường `PATH`. Tầng P12 không chấp nhận lệnh đi kèm tham số hoặc đường dẫn tệp thực thi tuyệt đối cho vai trò. Danh sách chuẩn mực được quy định tại [P13 types](../../packages/pane-manager/src/types.ts). Lưu ý rằng agent đã cài đặt nhưng chưa hoàn tất đăng nhập có thể rơi vào trạng thái bị chặn (`blocked`); trạng thái này không phải bằng chứng về sự không tương thích phiên bản.
- **Vai trò Developer**: Tuyệt đối **không thêm vai trò Developer vào danh sách thường trực `environment.roles`**; nếu cố tình thêm, bộ điều hợp sẽ từ chối khởi động. Runtime và Pane Manager (P13) sẽ tự động cấp phát Developer một cách linh hoạt theo từng tác vụ, đi kèm Git worktree độc lập và giới hạn hạn mức dung lượng (capacity).

---

## 3. Ranh giới vận hành và bảo mật giữa các vai trò

- **Conversation Agent**: Tuyệt đối không được phép chỉnh sửa mã nguồn trực tiếp hoặc tự ý điều phối Developer.
- **Coordinator Agent**: Mọi hành động điều phối và cấp phát bắt buộc phải thực thi thông qua Runtime.
- **Các vai trò phân tích & kiểm tra**: Analyst, Architect, Planner, Reviewer và QA đều là các vai trò chỉ đọc (`read-only`) theo chính sách hệ thống; host có trách nhiệm thực thi quyền ghi ở cấp độ tiến trình và Git worktree. Các chỉ dẫn trong system prompt hay cờ `readOnlyWorkspace: true` không thể thay thế cho cơ chế sandbox bảo mật ở cấp hệ điều hành.
- **Giao tiếp liên vai trò**: Mọi vai trò bắt buộc phải trao đổi thông điệp thông qua phong bì dữ liệu chuẩn hóa [RoleMessage](herdr-communication.md), tuyệt đối không được tự ý ghi tệp tin ra đĩa để giả lập hộp thư trao đổi nội bộ.
