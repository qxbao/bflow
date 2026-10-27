# Xử lý sự cố (Troubleshooting)

Khi gặp sự cố, bước đầu tiên là kiểm tra hiện trạng bằng các lệnh `bflow status --json`, `bflow doctor --json` kết hợp kiểm tra trạng thái Git (`git status`, `git worktree list`). 

> [!NOTE]
> Lệnh `doctor` có thể trả về phong bì `ok: true` nhưng mã thoát tiến trình là `exit 1` kèm `data.healthy: false`: điều này có nghĩa là báo cáo chẩn đoán đã được khởi tạo thành công nhưng có bài kiểm tra thành phần phát hiện lỗi. Lệnh `status` khi chạy không kèm tham số sẽ báo cáo trạng thái môi trường hiện hành; cú pháp `status <run-id>` hoặc kèm bộ lọc sẽ dùng để truy vấn các lượt chạy thuộc Runtime cũ.

---

## 1. Bảng chẩn đoán và khắc phục sự cố

| Hiện tượng lỗi | Nguyên nhân gốc rễ và hướng xử lý |
| :--- | :--- |
| `Not a Git working repository` | Thư mục hiện tại không phải Git repo hợp lệ; hãy chuyển tới checkout thực sự hoặc chạy `git init` trước khi thực thi `init`. |
| Lỗi cú pháp YAML trong `config.yml` | Kiểm tra thụt lề (indentation), khóa trùng lặp và đảm bảo tệp chỉ chứa một document duy nhất. Tags, merge keys và alias vòng lặp bị từ chối. Với cấu hình cũ, chạy `bflow config-migrate`; giữ lại tệp `.bak` nếu cần rollback. |
| `Config belongs to another repository` | Cấu hình mang định danh thuộc về repository khác; không sao chép định danh giữa các checkout. Xem hướng dẫn khôi phục khi clone/di chuyển repo. |
| Role không thuộc danh mục permanent của P13 | Sử dụng đúng tên vai trò chuẩn trong hợp đồng; vai trò Developer bắt buộc phải do Runtime tự động cấp phát, không được cấu hình thường trực. |
| Model hoặc effort bị chặn khi preflight | Lựa chọn model phù hợp với tài khoản/nhà cung cấp. Claude hỗ trợ: `low|medium|high|xhigh|max`; Codex hỗ trợ: `minimal|low|medium|high|xhigh`. Agy mã hoá mức effort trực tiếp trong tên model và không dùng trường `effort`. |
| Agent bị thiếu hoặc bị chặn (`blocked`) lúc `up` | Thông báo lỗi sẽ chỉ rõ role, provider, pane/session và câu lệnh xử lý. Dùng lệnh `pane read` nếu cần xem giao diện, nhưng lưu ý không chia sẻ dữ liệu thô chứa bí mật; hãy xử lý dứt điểm hộp thoại tương tác trước khi thử lại, không gửi lại nhiệm vụ ngay. |
| `bflow up` thất bại sau khi đã bắt đầu khởi động | Hệ thống sẽ tự động kích hoạt dọn dẹp bằng quy trình hạ dịch vụ an toàn (`safe down`). Nếu dọn dẹp không an toàn hoặc chưa xong, hệ thống bảo lưu biên nhận thao tác và trạng thái phục hồi; hãy đọc `status`/`doctor`, xử lý nguyên nhân rồi chạy `bflow down --yes` để đối soát. Tuyệt đối không tự ý xóa `.bflow`. |
| Nhấn `Ctrl+C` lúc `up` hoặc bị quá thời gian chờ (timeout) | Hệ thống kích hoạt dọn dẹp an toàn nếu đã làm thay đổi session. Nếu việc truyền tin chưa rõ ràng hoặc rào chắn an toàn bị chặn, biên nhận và trạng thái được giữ nguyên; hãy đọc `status`/`doctor`, rồi chạy `bflow down --yes` để đối soát. Không xóa `.bflow`. |
| `Named session exists without ownership evidence` | Tồn tại phiên Herdr trùng tên nhưng thiếu bằng chứng sở hữu từ repo hiện tại; không tự tiện tiếp nhận hoặc xoá session đó; kiểm tra lại đường dẫn checkout và manifest. |
| Khóa vòng đời (lifecycle lock) sót lại từ phiên bản cũ | Dừng lệnh up/down cũ trước, sau đó thực thi `bflow recover --yes`. Chỉ thư mục khóa rỗng cũ mới bị dọn dẹp; trạng thái dữ liệu, worktree và agent được bảo toàn nguyên vẹn. |
| `Another up/down is still running` | Khóa kernel vẫn đang thuộc sở hữu của một tiến trình thực tế. Hãy đợi hoặc nhấn `Ctrl+C` lệnh đó; không được xoá tệp `lifecycle.guard` vì sẽ phá vỡ tính tuần tự an toàn. |
| Lỗi `spawn flock ENOENT` | Linux cần `flock` util-linux trên PATH; macOS cần bản hỗ trợ inherited file descriptor. Cài đúng nền tảng, không thay flock bằng lock file tự chế. |
| Codex hiển thị hộp thoại Update CLI / trust / login | Lỗi chỉ rõ role, pane và session. Hãy mở đúng session bằng lệnh được gợi ý, xử lý hộp thoại tương tác thủ công rồi chạy lại `bflow up`. Bflow không tự động chấp nhận cập nhật, tin cậy hay phân quyền. |
| Quá trình hạ dịch vụ bị gián đoạn (Interrupted shutdown) | Chạy lại lệnh `bflow down --yes`; hệ thống sẽ quan sát các pane còn sống, thực hiện rút cạn/ghi checkpoint và chỉ đóng các thành phần còn sót lại. |
| Lệnh down thiếu rào chắn an toàn (shutdown barrier) | Kiểm tra cấu hình host tùy biến; host Claude mặc định có rào chắn an toàn thực sự, cờ `--yes` không bao giờ bỏ qua bước rút cạn/checkpoint. |
| Lệnh up thành công nhưng không nhận workflow qua chat | Kiểm tra nhật ký host, phiên native, công cụ MCP, hook và tính tương thích của manifest; kiểm tra bộ chạy verification được cấu hình nếu đang làm việc với các tác vụ hành vi. |
| Thay đổi chính sách khi host đã khởi chạy | Host từ chối việc âm thầm thay đổi chính sách; cần hạ dịch vụ (`down`), tạm dừng và đối soát cấu hình host bền vững trước khi áp dụng thay đổi. |
| Agent ở trạng thái `done` nhưng run chưa thành công | Cần chờ kết quả xác thực có chữ ký số, kết quả kiểm tra verification và phê duyệt từ con người; trạng thái `done` chỉ phản ánh việc kết thúc lượt xử lý của agent. |
| Lệnh kiểm thử lỗi trước giai đoạn Red | Cần cài đặt phụ thuộc hoặc kiểm tra lệnh có tồn tại; lỗi hạ tầng kỹ thuật không được tính là trạng thái Red hợp lệ của hành vi đích. |
| Lỗi đường dẫn socket Unix quá dài trong ArtifactStore | Trên Linux, hãy cấu hình `TMPDIR=/tmp` cho các fixture/test; không tự ý sửa đổi contract hoặc bỏ qua việc kiểm tra. |
| Herdr báo lỗi `local socket name length exceeds capacity of sun_path` | Kiểm tra độ dài đường dẫn XDG runtime và config. Nên sử dụng các thư mục riêng tư ngắn dưới `/tmp`; giữ nguyên lựa chọn này cho mọi lệnh thuộc cùng một phiên làm việc. |
| Kiểm thử subprocess import mã cũ trong `dist/` | Luôn chạy lại `pnpm build` trước khi thực thi các bài kiểm thử có mục tiêu (targeted tests). |
| Lệnh `pnpm install` trong ví dụ không cài phụ thuộc | Thư mục ví dụ không thuộc workspace gốc; hãy sao chép ra repository độc lập hoặc sử dụng cờ `pnpm install --ignore-workspace --frozen-lockfile`. |

---

Các lỗi mới theo platform/tool policy:

| Hiện tượng | Xử lý |
| --- | --- |
| `bflow: command not found` sau bootstrap | Mở terminal mới hoặc reload đúng file shell setup thông báo; launcher cần source checkout/build còn ở vị trí đã setup |
| Mất account/config khi dùng `BFLOW_HOME` làm đường dẫn source | `BFLOW_HOME` chọn isolated environment; dùng `BFLOW_SOURCE` cho script source theo [installation](installation.md), giữ selector isolation nhất quán |
| Tool optional degraded / required blocked | Đọc reason theo inventory, repo allowance, grant và readiness; không thêm skill để giả quyền tool |
| Browser action báo resource busy / transaction expired | Role khác đang giữ lease browser, hoặc transaction quá 5 phút; hoàn tất/reconcile transaction cũ thay vì lấy lại state. Gate `host-app-*` báo `app_check_browser_busy`: một gate khác đang giữ lease host-local, thử lại sau |
| GitNexus stale hoặc storage lock bận | Maintenance để nhả reader/writer, rồi setup đúng repo; không tự rebuild index dưới role đang active |
| Yêu cầu sửa lightweight/full SDD | Trả lời revision gợi ý cho đúng run trong Conversation; không lặp resume để bỏ policy |
| `agy_onboarding_incomplete` | Kiểm tra onboarding/auth trong đúng profile/HOME launch; Agy Conversation vẫn unsupported |

## 2. Các nguyên tắc xử lý kỹ thuật quan trọng

- **Kiểm tra tính tương thích Herdr**: Nhãn phiên bản phát hành khác nhau không đồng nghĩa với việc không tương thích. Quá trình kiểm tra dựa trên hợp đồng giao tiếp (wire contract) và phản hồi thực tế của từng thao tác; hệ thống chỉ báo lỗi không tương thích khi có thao tác thực tế bị lỗi. Tuyệt đối không thêm cơ chế bỏ qua phiên bản (version bypass) vào cấu hình.
- **Tính toàn vẹn của dữ liệu trạng thái**: Khi gặp tình trạng truyền tin bất định (`unknown_delivery`), bài kiểm tra đang chờ hoặc xung đột mã nguồn, người vận hành và host phải cùng đối soát; tuyệt đối không tự ý sửa đổi trạng thái trực tiếp trong SQLite/JSON, tự ký biên nhận giả lập hoặc xóa cưỡng chế Git worktree.
- **Bảo mật thông tin**: Luôn giữ lại ID của run/message/task, mã thoát (exit code) và các bằng chứng đã làm sạch dữ liệu nhạy cảm khi báo cáo sự cố; không chia sẻ khóa bí mật, biến môi trường, thông tin đăng nhập hoặc prompt chứa bí mật.

---

## 3. Quản lý Prompt và Bố cục giao diện

Vai trò Chat và Coordinator được nạp nguyên vẹn nội dung prompt gốc từ tài nguyên của Bflow trước lượt xử lý đầu tiên, không yêu cầu agent phải tự tìm đọc tệp prompt. Claude sử dụng cơ chế tệp prompt native; Codex sử dụng `model_instructions_file` theo [tài liệu cấu hình của OpenAI](https://developers.openai.com/codex/config-reference). Nếu tệp bắt buộc bị thiếu, vượt quá kích thước cho phép hoặc là symlink không hợp lệ, hệ thống sẽ chặn quá trình khởi tạo và báo lỗi rõ ràng. 

Các pane được gắn nhãn vai trò trực quan; tab đầu tiên được đặt tên là `conversation` thay vì số 1. Phiên làm việc mới sử dụng bố cục lưới 2x2 cho Coordination và 2 pane cho Verification. Khi đồng bộ lại phiên cũ, hệ thống chỉ điều chỉnh lại kích thước các đường biên để phân chia không gian đồng đều, giữ nguyên định danh pane và tiến trình; không dùng lệnh áp dụng lại layout vì có thể tạo thêm terminal mới ngoài ý muốn.

---

## 4. Các lỗi phổ biến khi khởi động hệ thống

- **`The machine Gateway is bound to workspace ...`**: Gateway trên máy hiện đang được liên kết với một repository khác. Hãy thực thi:
  ```bash
  bflow setup --apply --yes --dir <đường dẫn repo hiện tại>
  ```
- **`Repository trust confirmation is waiting for your choice`**: Claude đang chờ người dùng xác nhận tin cậy repository tại pane. Hãy mở pane để xác nhận (thông qua `bflow attach` hoặc lệnh `herdr` được gợi ý), hoặc cấu hình `environment.permissions.trustedWorkspace: true` trong tệp cấu hình.
- **`No supported test runner detected`**: Runtime không nhận diện được bộ chạy kiểm thử. Cú pháp `node --test` được hỗ trợ kể cả khi có các cờ bổ sung như `--experimental-strip-types` hoặc `--disable-warning=<tên>`; Vitest bắt buộc phải là phiên bản 2.x và được cài đặt tại thư mục gốc. Việc đo kiểm hành vi đòi hỏi môi trường Linux với `bwrap` hoặc macOS với `sandbox-exec`.
- **Gateway bị sập lặp đi lặp lại khi khởi động (macOS/Linux)**: Khởi chạy lệnh sau ở chế độ trực quan (foreground) để quan sát chi tiết lỗi:
  ```bash
  node apps/cli/dist/setup-gateway.js --serve ~/.config/bflow/setup-gateway.json <digest>
  ```
