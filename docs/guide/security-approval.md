# Bảo mật & Phê duyệt (Security & Approval)

Tệp cấu hình repository và các tệp mẫu tuyệt đối không được chứa mã khóa bí mật (token), khóa API (API key), cookie phiên, mật khẩu, khóa ký riêng tư (private signing key) hay các URL chứa thông tin xác thực. Mọi thông tin đăng nhập và xác thực phải được quản lý bên ngoài kho mã nguồn thông qua cơ chế của nhà cung cấp hoặc máy chủ host. 

Tệp `.bflow/.gitignore` do lệnh `init` tự động khởi tạo đã bao gồm các quy tắc loại trừ cho thư mục trạng thái, nhật ký log, biến môi trường, dữ liệu tạm, artifact, registry và cơ sở dữ liệu. Cần lưu ý rằng việc bỏ qua qua gitignore không có tác dụng mã hóa dữ liệu và không thể tự động gỡ bỏ các bí mật đã từng bị commit vào lịch sử Git trước đó. Ngoài ra, bản thân các artifact và tệp nhật ký cũng có thể chứa thông tin nhạy cảm cần được bảo vệ.

---

## 1. Ranh giới tin cậy của Host và Phân quyền

Chỉ sử dụng các mẫu template, tiến trình agent và module host thực sự đáng tin cậy:
- Biến môi trường `BFLOW_ENVIRONMENT_MODULE` chỉ định module ESM có toàn quyền thực thi mã nguồn, biến này do người vận hành trực tiếp thiết lập trong môi trường máy chủ và không bao giờ được đọc từ cấu hình repository.
- Đường dẫn `HERDR_CONFIG_PATH` trỏ tới tệp cấu hình riêng của Herdr. Tệp `config.yml` của Bflow cho phép tùy chọn provider, model và effort cho từng vai trò nhưng tuyệt đối không quản lý thông tin xác thực của provider.
- Các câu lệnh prompt có thể bị lộ khi kiểm tra danh sách tiến trình (`argv`/process inspection); tuyệt đối không nhúng thông tin bí mật vào yêu cầu nghiệp vụ hay chỉ dẫn prompt.

Mọi cổng kiểm soát độc lập và danh tính người phê duyệt bắt buộc phải do host tin cậy trực tiếp thẩm định. Hệ thống không chấp nhận việc giả mạo xác thực thông qua callback luôn trả về `true`, cờ tự khai báo `humanOverrideApproved` của agent, hay một dòng chữ "approved" đơn thuần trên terminal. Các tệp mẫu đều là bản thảo sơ bộ, không chứa URI artifact hay biên nhận phê duyệt giả lập và không tự cấp quyền triển khai mã nguồn.

---

## 2. Các điểm chốt chặn kiểm soát (Governance Checkpoints)

| Điểm chốt chặn | Thành phần thực thi có thẩm quyền |
| :--- | :--- |
| **Nghiệm thu Đặc tả / Thiết kế và Phê duyệt Triển khai** | Tầng P15 và P19; quyết định của con người liên kết với hồ sơ (dossier bundle) thông qua Conversation Agent. |
| **Bắt buộc TDD trước khi viết mã nguồn** | Tầng P16, P19 và ranh giới quyền ghi của host; bắt buộc phải có trạng thái kiểm thử Red độc lập. |
| **Tác vụ có cờ `requiresApproval: true`** | Core Engine và P19; ngăn chặn việc hoàn tất tác vụ hoặc phân phối tác vụ phụ thuộc cho tới khi có quyết định phê duyệt chính xác theo phiên bản và thế hệ tác vụ. |
| **Xác minh tác vụ và quy trình độc lập** | Tầng P17 kết hợp các lệnh kiểm tra tin cậy của host, vai trò Reviewer và QA, dựa trên đúng phiên bản Git và bằng chứng khách quan. |
| **Phê duyệt bàn giao thành phẩm (Delivery Approval)** | Tầng P19; chỉ được kích hoạt sau khi hoàn tất xác minh sau tích hợp và kiểm tra phiên bản mã nguồn đã sạch sẽ (clean pinned revision). |

Kiến trúc v2 tiếp nhận quyết định phê duyệt thông qua Conversation Gateway và phương thức `authorizeHuman` tin cậy của host. Danh mục trạng thái phê duyệt (`ApprovalStatus`) bao gồm: `pending`, `approved`, `changes_requested`, `rejected`, `expired`, `cancelled`, `superseded`:
- Quyết định từ chối (`rejected`) sẽ lập tức dừng mọi kế hoạch điều phối tiếp theo.
- Quyết định yêu cầu sửa đổi (`changes_requested`) không làm mất đi các giới hạn số lần sửa đổi và lặp lại.
- Quyết định phê duyệt cho một tác vụ cụ thể không có giá trị cấp quyền tự động cho các hành động khác.

---

## 3. Lệnh phê duyệt của CLI Runtime cũ

```bash
bflow approve review --run run-123 --decision approved --by alice
bflow approve review --run run-123 --decision changes_requested --by alice --reason "Bổ sung bằng chứng cho trường hợp biên"
```

Lệnh này bắt buộc phải áp dụng cho đúng tác vụ, lượt chạy, phiên bản và thế hệ đang chờ phê duyệt thực tế. Cần lưu ý rằng tham số `--by` chỉ mang tính chất ghi nhận danh tính người thực hiện chứ không phải cơ chế đăng nhập một lần (SSO). Lệnh này ghi nhận quyết định tác vụ thuộc Runtime cũ, không phải là API phê duyệt hồ sơ dossier của P19.

---

## 4. Phê duyệt hook toàn cục của Codex (Codex Global Hooks)

Người vận hành cần xem xét và phê duyệt hook toàn cục thông qua quy trình thiết lập riêng biệt trước khi khởi chạy các vai trò sử dụng Codex:

```bash
bflow setup --codex-hooks --plan
bflow setup --codex-hooks --apply
bflow setup --codex-hooks --check
```

- Cờ `--plan` chỉ thực hiện đọc và hiển thị danh sách sự kiện, câu lệnh, tệp phụ thuộc, mã băm SHA-256 cùng mã tổng hợp (digest) của toàn bộ snapshot.
- Cờ `--apply` hiển thị chi tiết nội dung cần rà soát và yêu cầu người dùng xác nhận trực tiếp trong terminal. Khi chạy trong môi trường không có terminal tương tác, bắt buộc phải truyền đồng thời cờ `--yes` và mã digest đã được rà soát:
  ```bash
  bflow setup --codex-hooks --apply --yes --hook-digest <snapshot-digest>
  ```

Lệnh `setup --yes` thông thường sẽ không tự động duyệt hook. Chế độ hook không cài đặt thêm công cụ hay plugin, không can thiệp vào cấu hình toàn cục của provider và không thực thi hook trong quá trình rà soát. Cờ `--check` sẽ trả về mã thoát khác 0 nếu hook chưa được phê duyệt hoặc không được hỗ trợ.

Bản ghi phê duyệt được lưu trữ an toàn trong vùng trạng thái riêng của Bflow tại `${XDG_STATE_HOME:-$HOME/.local/state}/bflow/codex-hook-approvals.json` với quyền tệp `0600` và thư mục cha được bảo mật tuyệt đối. 

---

## 5. Ranh giới thực thi và hạn chế an toàn

- **Thực thi phân quyền**: Các cờ vai trò chỉ đọc (`read-only`), quyền trên hệ thống tệp tin, quyền sở hữu nhánh Git và chính sách lệnh bắt buộc phải do host trực tiếp kiểm tra và thực thi; các câu lệnh trong prompt không thể thay thế cho cơ chế kiểm soát quyền của hệ điều hành.
- **Hạ tầng phân tán**: Các cam kết vận hành trên hệ thống tệp tin mạng (NFS/SMB), phân bổ lease phân tán, môi trường đa máy chủ (multi-host) và đảm bảo an toàn dữ liệu khi mất nguồn đột ngột hiện chưa được kiểm chứng đầy đủ.
- **Giới hạn quyền tự động**: Workflow Runtime không cung cấp công cụ tự động triển khai (deploy), tự động push hoặc tự động merge vào các nhánh được bảo vệ, cũng như không tự ý thay đổi thông tin bí mật. Không được suy diễn các quyền hạn này từ quyết định phê duyệt tác vụ thông thường. Xem thêm tại [Khôi phục phiên làm việc (Session Recovery)](session-recovery.md).
