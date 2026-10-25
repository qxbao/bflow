# Khôi phục phiên làm việc (Session Recovery)

Trong Bflow, **khôi phục phiên/pane vật lý** và **khôi phục quy trình công việc (workflow)** là hai cơ chế hoàn toàn tách biệt. Trong quá trình chẩn đoán sự cố, bạn bắt buộc phải giữ nguyên đường dẫn checkout, thư mục Git nội bộ, thư mục cấu hình `.bflow` và toàn bộ các Git worktree hiện có. Việc sao chép hoặc di chuyển tệp cấu hình đã gắn kết định danh sang máy khác hoàn toàn không được hệ thống hỗ trợ.

---

## 1. Các lệnh kiểm tra ban đầu

Khi gặp sự cố gián đoạn hoặc cần phục hồi, hãy thực thi tuần tự các lệnh sau để thu thập thông tin hiện trạng:

```bash
bflow status --json
bflow doctor --json
git status --short
git worktree list
```

---

## 2. Quy trình xử lý theo từng kịch bản sự cố

| Sự cố phát sinh | Quy trình chẩn đoán và khắc phục chuẩn mực |
| :--- | :--- |
| **Mất kết nối terminal client** | Nếu máy chủ Herdr và manifest vẫn đang hoạt động hợp lệ, chỉ cần thực thi lại lệnh `bflow attach`. |
| **Mất pane hoặc máy chủ sau khi đã `up` thành công** | Chạy `status` và `doctor` để kiểm tra; sau đó thực thi `bflow up` để Pane Manager (P13) đối soát với manifest hiện hành, tự động tái sử dụng hoặc khôi phục các liên kết phù hợp. |
| **Khởi động bị gián đoạn ở giai đoạn `server_starting` hoặc `manager_pending`** | Kiểm tra trạng thái máy chủ và trình quản lý pane trước; CLI có thể từ chối thử lại ngay để tránh phát sinh tác dụng phụ trùng lặp. Người vận hành host cần chủ động đối soát trạng thái, không được tự ý xóa bỏ bản ghi ý định (intent). |
| **Quá trình hạ dịch vụ còn kẹt ở giai đoạn `stopping`** | Đối soát trạng thái máy chủ, vai trò và checkpoint; tuyệt đối không chạy lệnh `up` nhằm lách qua quá trình shutdown chưa rõ kết quả. |
| **Khóa vòng đời còn sót lại (Stale Lifecycle Lock)** | Xác minh tiến trình sở hữu khóa đã thực sự thoát khỏi hệ thống; chỉ người vận hành mới được phép dọn dẹp khóa cũ sau khi đã chứng minh không còn bất kỳ thao tác nền nào đang chạy (thông qua `bflow recover --yes`). |
| **Cấu hình báo lỗi khác biệt repository** | Chuyển về đúng đường dẫn checkout tương ứng; nếu là bản clone mới, hãy chạy `init` để sinh định danh mới và chỉ áp dụng các chính sách di động (portable policies), không cố gắng tái sử dụng trạng thái hoặc biên nhận cũ. |
| **Khởi động lại Runtime P19** | Mở lại host với cùng repository, session và thư mục lưu trữ; khởi tạo và kiểm tra kỹ lưỡng nhật ký journal, outbox và các biên nhận trước khi tiếp tục chu kỳ điều phối (`tick`). |

---

## 3. Phân vùng dữ liệu và nguyên tắc sao lưu an toàn

- **Tầng P12**: Lưu trữ ý định (intent), manifest và khóa lock tại thư mục `.bflow/state`.
- **Tầng P13 (Pane Manager)**: Lưu trữ manifest của các pane tại `.bflow/state/panes/`.
- **Tầng P19 (Agentic Workspace)**: Mặc định aggregate checkpoint, event log, receipt và journal tại `.bflow/state/agentic/`. Nếu filesystem checkout không giữ private mode, Runtime có thể pin private state ngoài repo dưới `$XDG_STATE_HOME/bflow/repositories/...`; `doctor` báo vị trí hiệu lực. Locator đã pin nhưng thiếu/hỏng phải block, không tạo authority thay thế. Machine Gateway/skills/secret có lifetime và state riêng, không thuộc repo down cleanup.

> [!CAUTION]
> Tuyệt đối không chỉnh sửa thủ công các tệp JSON hoặc cơ sở dữ liệu SQLite nhằm thay đổi trạng thái phê duyệt (`approval`) hay trạng thái tác vụ (`task status`). Khi thực hiện sao lưu (backup), bắt buộc phải tạm dừng mọi tiến trình ghi (`quiesce writers`) và áp dụng quy trình sao lưu tương thích với SQLite cho toàn bộ cơ sở dữ liệu, sidecar, artifact, journal và Git worktree. Việc chỉ sao chép một tệp `.db` trong khi tiến trình khác đang ghi không được coi là một bản sao lưu toàn vẹn.

---

## 4. Xử lý trạng thái truyền tin bất định (Uncertain Delivery)

Sau sự cố sập nguồn, P19 sẽ tự động chuyển các thông điệp outbox đang ở trạng thái `sending` chưa thể xác minh thành **`unknown_delivery`**. 

Cần lưu ý rằng việc hết thời gian chờ (timeout), mất kết nối mạng hoặc lệnh hủy đang chờ xử lý không phải là bằng chứng khẳng định agent chưa nhận được prompt hoặc đã dừng hẳn. Host và Coordinator phải sử dụng các công cụ chuyên dụng `inspect` và `reconcile_delivery` đi kèm với ID thông điệp gốc:
- Chỉ khi nhận được kết quả xác thực chính thức là **`not_delivered`**, hệ thống mới cho phép gửi lại **chính xác yêu cầu ban đầu**.
- Tuyệt đối không tự ý thay đổi pane, lease, mã băm lũy thừa (idempotency fingerprint) hay nội dung chỉ dẫn rồi coi đó là một lượt thử lại hợp lệ.
- Phải duy trì lease và các liên kết bất định nhằm ngăn chặn việc xuất hiện writer thứ hai can thiệp vào cùng một tác vụ.

---

## 5. Khôi phục quá trình kiểm tra xác minh (Verification Recovery)

Nếu hệ thống sập nguồn trong quá trình xác minh, host bắt buộc phải đối soát biên nhận của P17 đã được lưu trữ trước khi cho phép chạy lại bài kiểm tra:
- Các kết quả đã được ghi trước (write-ahead) có thể được áp dụng lại một cách lũy thừa (idempotently).
- Các biên nhận đang chờ xử lý chưa được đối soát tuyệt đối không được phép tự động kích hoạt lượt kiểm tra thứ hai.
- Quá trình phát lại (replay) sự kiện và checkpoint của Core Engine có trách nhiệm khôi phục đầy đủ phán quyết phê duyệt, trạng thái cổng kiểm tra, số lần thử lại, yêu cầu hủy và kết quả lệnh; bản chiếu của RunStore hoặc artifact trên đĩa không thể thay thế cho checkpoint tổng hợp có thẩm quyền đó.

---

## 6. Tiếp tục qua Conversation và cancellation

Với P19, gửi `tiếp tục` hoặc `resume <run-id>` trong Conversation khi pending action cho phép. Host gắn yêu cầu vào đúng human turn đã xác thực; giữ run/action/receipt và kiểm lại capability, lease/fence, approval và delivery. Nếu notice nói Runtime tự resume thì không cần gửi thêm lệnh tiếp tục. Blocker cần sửa yêu cầu (ví dụ project policy full SDD) phải nhận revision qua Conversation; lặp resume không sửa spec hoặc cấp approval.

Cancellation cũng đi qua Conversation. Runtime lưu control trước khi áp dụng, khôi phục control queued qua restart, không dispatch thêm task sau khi đã hủy. `cancelled` xác nhận intent được áp dụng; chờ reconciliation report để biết `fully stopped` hay còn native delivery/writer cần xử lý. Không cleanup worktree chỉ từ nhãn cancelled.

## 7. Lệnh khôi phục của CLI Runtime cũ

Đối với các lượt chạy quy trình thuộc Runtime cũ:

```bash
bflow status run-123 --json
bflow resume run-123 --idempotency-key operator-resume-123 --json
```

Lệnh `resume` này vận hành hoàn toàn qua Runtime cũ và cơ chế khôi phục tương ứng của nó, không hỗ trợ mở lại host P19 hoặc tạo pane mới. Tuyệt đối không sử dụng lệnh này cho các lượt chạy P19 được lưu trữ ở thư mục khác. Các lệnh hủy hoặc ngắt quãng chỉ ghi nhận ý định và gửi yêu cầu dừng; người vận hành phải xác nhận chắc chắn tiến trình ghi đã kết thúc trước khi tiến hành dọn dẹp hoặc thử lại. Tuyệt đối không được xóa cưỡng chế worktree, reset nhánh Git, xóa database hoặc chỉnh sửa biên nhận chỉ để giải tỏa trạng thái tắc nghẽn (`blocked`).
