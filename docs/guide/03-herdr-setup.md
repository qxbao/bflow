# 3. Cài đặt và cấu hình Herdr

> **Trạng thái:** `@bflow/herdr-adapter` có mã nguồn và unit test với runner giả lập. Nó **chưa được kiểm chứng với Herdr thật**, và Runtime hiện **chưa thể** hoàn tất một task được dispatch qua Herdr (xem [Giới hạn khi ghép với Runtime](#giới-hạn-khi-ghép-với-runtime)). Không điều khiển session Herdr thật khi chưa được cho phép rõ ràng.

## Cài đặt Herdr

Repository này không đóng gói và không hướng dẫn cài Herdr; hãy làm theo tài liệu chính thức của Herdr. Adapter chỉ chấp nhận đúng phiên bản đã khảo sát:

| Kiểm tra | Giá trị bắt buộc | Lệnh adapter chạy trong `initialize` |
| --- | --- | --- |
| Phiên bản CLI | `herdr 0.9.1` | `herdr --version` |
| Protocol / schema | `protocol: 22`, `schema_version: 1` | `herdr api schema` |

Phiên bản khác trả về lỗi `unsupported_version`. Tự kiểm tra trước:

```bash
herdr --version
herdr api schema
```

## Lệnh Herdr mà adapter sử dụng

Adapter gọi CLI bằng `spawn` với `shell: false` (danh sách tham số, không qua shell). Đây là toàn bộ lệnh mà nó phát ra:

| Thao tác `AgentTransport` | Lệnh Herdr |
| --- | --- |
| `initialize` | `herdr --version`, `herdr api schema` |
| Kiểm tra pane trước mọi thao tác | `herdr agent get <paneId>` |
| `startAgent` (riêng của `HerdrCliTransport`) | `herdr agent start <name> --kind <kind> --pane <paneId> [--timeout <ms>] [-- <args...>]` |
| `send` | `herdr agent prompt <paneId> <instruction>` (không `--wait`) |
| `wait` | `herdr agent wait <paneId> --timeout <ms> [--until <state>...]` |
| `read` | `herdr agent read <paneId> --source visible --lines 80 --format text` |
| `cancel` | `herdr agent send-keys <paneId> ctrl+c` |

Pane phải **tồn tại sẵn**; adapter không tạo workspace/tab/pane. Target phải có `paneId`; adapter so khớp pane, workspace, tab, terminal, tên agent và `agent_session` (nếu có) trước khi thao tác.

## Tạo transport

```ts
import { createHerdrAdapter } from "@bflow/herdr-adapter";

const transport = createHerdrAdapter({
  binary: "herdr",          // mặc định "herdr"
  defaultTimeoutMs: 30_000  // mặc định 30000
});

const capabilities = await transport.initialize({
  runtimeId: "my-runtime",
  configuration: {},
  recoveryMode: false,
  initializedAt: new Date().toISOString()
});
if (!capabilities.ok) throw new Error(capabilities.error.message);
// capabilities.value.supportsSubmissionCorrelation === false
```

`createHerdrAdapter` trả về `AgentTransport` kèm `startAgent({ name, kind, paneId, timeoutMs?, args? })`; `timeoutMs` của startup phải trong khoảng 3001–300000 ms.

## Ý nghĩa kết quả từ Herdr

- `send` thành công chỉ xác nhận đã ghi vào terminal. Handle có `correlation: { provenance: "orchestrator", verified: false }`.
- Timeout, `agent_prompt_stalled`, mất kết nối hoặc phản hồi hỏng → `unknown_delivery`, **cấm gửi lại**. `reconcile` chỉ trả `bound` từ cache cục bộ, `not_delivered` khi chứng minh bị từ chối trước khi gửi, còn lại là `unknown_delivery` cần kiểm tra thủ công.
- `wait` trả trạng thái vòng đời (`idle`, `working`, `blocked`, `done`, `unknown`), **không bao giờ** là thành công nghiệp vụ.
- `read` trả một ảnh chụp terminal với `correlationVerified: false`.
- `cancel` gửi `ctrl+c` và chỉ trả về "đã chấp nhận yêu cầu", không xác nhận agent đã dừng.
- Prompt được truyền làm tham số tiến trình, nên tiến trình khác có quyền có thể thấy. **Không đặt bí mật trong `instruction`.**

Chi tiết: [packages/herdr-adapter/README.md](../../packages/herdr-adapter/README.md).

## Giới hạn khi ghép với Runtime

Hai điểm trong mã Runtime hiện tại khiến chuỗi Runtime + Herdr không chạy end-to-end:

1. `TaskDispatcher` dựng target là `{ transport: "herdr", agentId, paneId: "pane-<role>" }`. Nó **không đọc** `settings.execution.paneId` trong cấu hình agent. Herdr kiểm tra pane theo ID thật, nên pane phải có ID đúng là `pane-planner`, `pane-developer`… và tên agent khớp `agentId`.
2. Handle từ Herdr có `verified: false`. Core chỉ chấp nhận `AgentResult` khi handle đã bind có correlation `verified: true`, nên `completeTaskExecution` sẽ thất bại với `Agent result correlation is not verified for the bound execution`.

Vì vậy việc dùng Herdr với Runtime được xem là **chưa hỗ trợ** cho đến khi có quyết định tích hợp (kênh kết quả được xác minh và ánh xạ target từ cấu hình agent).
