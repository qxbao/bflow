# SQLite RunStore

`openSqliteRunStore({ filename, busyTimeoutMs?, clock? })` trả về một `OperationResult<SqliteRunStore>` triển khai mọi method `RunStore` đã được phê duyệt. Gọi `close()` khi shutdown. Thư mục cha do operator cấu hình và phải tồn tại sẵn. Không có singleton hay fallback in-memory.

```ts
import { openSqliteRunStore } from "@bflow/persistence";
const opened = openSqliteRunStore({ filename: "/configured/data/runs.sqlite" });
if (!opened.ok) throw new Error(opened.error.message);
const store = opened.value;
try { const run = await store.get("run-1"); /* inspect OperationResult */ }
finally { store.close(); }
```

## Driver và schema

Triển khai dùng `node:sqlite` thật, khả dụng không cần flag trên Node >=22.13; đã xác minh ở đây trên Node 22.23.2. API native vẫn còn experimental ở Node 22. Loader nhỏ `sqlite.ts` dùng `createRequire` vì danh sách built-in của Vite 5 trong workspace có trước module này. Không cần dependency bổ sung hay thay đổi lockfile. DatabaseSync thực thi đồng bộ: hỗ trợ các transaction cục bộ ngắn, không phải dịch vụ database worker không chặn.

Migration 1 trong `src/migrations.ts` tạo các bảng STRICT cho run, event, operation receipt, command receipt và checkpoint. `PRAGMA user_version` được cập nhật trong cùng transaction migration; schema tương lai bị từ chối, không bao giờ hạ cấp. Foreign key được bật trên mọi connection của store. Các unique index bảo vệ event ID toàn cục, sequence/version/event idempotency key theo từng run, và command ID/key theo từng run. Các query index bao phủ workflow/status, thời gian tạo và vị trí checkpoint.

Các connection dùng WAL, synchronous FULL và busy timeout cấu hình được (mặc định 5000 ms). Mọi mutation dùng BEGIN IMMEDIATE; ngân sách của nó được kiểm tra trước khi lấy writer lock, ngay sau khi lấy, trong các batch và trước COMMIT. Validation thất bại, version cũ, ràng buộc SQL, cancellation hoặc hết hạn trước commit sẽ rollback mọi event, receipt và cập nhật run index. Sau COMMIT, kết quả đã commit được trả về, không phải timeout có thể retry an toàn. Lỗi busy của SQLite ánh xạ thành conflict; hết hạn trong lúc chờ ánh xạ thành timeout/not_started. `timeoutMs: 0` hết hạn ngay lập tức. Timeout bị bỏ qua nghĩa là không có deadline cho thao tác, nhưng thời gian chờ lock vẫn bị giới hạn bởi busyTimeoutMs. DatabaseSync không thể bị ngắt trong một câu lệnh native; các kiểm tra ngăn các hiệu ứng chưa commit của nó trở nên bền vững sau khi hết hạn.

## Event, receipt và checkpoint

Các event batch đã parse dùng các validator tương thích và batch được export. Các event gốc (kể cả receipt `command.completed` đầy đủ) vẫn là nguồn có thẩm quyền cho Core replay. Operation receipt giữ các fingerprint SHA-256 canonical và kết quả create/append gốc qua các lần mở lại. Cùng key/khác nội dung thì conflict; append trùng lặp trả về vị trí gốc và mọi event ID trùng mà không ghi lại. Command receipt được lập chỉ mục trong transaction của event, ngăn các danh tính command trùng lặp có hiệu ứng mới dưới một append key mới.

Snapshot được duy trì là một projection lưu trữ/truy vấn của các trường event tường minh, không phải trạng thái aggregate/recovery của Core. Nó không sinh attempt ID từ thuật toán riêng của Core: một ID xuất hiện khi dispatch/binding cung cấp nó. Nó không bao giờ suy ra thành công từ output của agent, gate hay approval. Consumer dựng lại aggregate đầy đủ qua Core từ các event có thẩm quyền hoặc một aggregate checkpoint do Core sinh. Không dùng `get().snapshot` làm checkpoint khôi phục tail hay quyết định dispatch.

`create` giữ nguyên vị trí snapshot ban đầu được cung cấp. Với một lịch sử đầy đủ mới, Runtime phải tạo một seed version/sequence-zero trước khi append toàn bộ event batch Core ban đầu. Một seed nhập khác 0 khai báo baseline lịch sử chưa đầy đủ; không có event hay command outcome trước đó nào bị bịa ra. Việc nhập như vậy cần một aggregate checkpoint có thẩm quyền để khôi phục, hoặc lịch sử đầy đủ được cung cấp riêng.

Việc ghi checkpoint yêu cầu aggregate version kỳ vọng hiện tại và vị trí stream khớp. Cả hai codec đã phê duyệt đều được giải mã bằng validator được export; sai lệch danh tính state/envelope/run/workflow/task thất bại theo hướng fail-closed. Checkpoint chỉ-snapshot vẫn được chấp nhận như record lưu trữ nhưng không thể tự khôi phục trạng thái phụ trợ. Trạng thái aggregate đầy đủ (dữ liệu approval/gate/cancellation/retry/receipt) được lưu nguyên vẹn, không tạo lại. Checkpoint mới nhất hỏng/không được hỗ trợ trả về lỗi có kiểu; không khẳng định fallback âm thầm hay khôi phục thành công. JSON được lưu có checksum cùng xác thực schema/index. Checksum phát hiện hỏng dữ liệu, không phát hiện các chỉnh sửa database độc hại bởi operator đáng tin của nó.

Các method đọc dùng read transaction SQLite nhất quán. Các trang được sắp xếp theo keyset (run theo run ID, event theo sequence); cursor có phiên bản và giới hạn trong query/run. `eventTailCursor(runId, afterSequence)` tạo một tail cursor loại trừ (exclusive) tương thích với `readEvents`. Phân trang không phải snapshot tại một thời điểm qua các lời gọi riêng.

## Xác minh và bàn giao

Từ thư mục gốc: `pnpm exec vitest run packages/persistence/test/run-store.test.ts` (build trước cho các subprocess test). Các test dùng database thật tạm thời, mở lại, connection/tiến trình đồng thời, rollback, lock deadline, khoảng trống lịch sử, hỏng codec và xung đột idempotency.

P06 phải lưu các event dispatch-intent đầy đủ trước transport, lưu execution binding/receipt, giữ unknown_delivery sau restart và không bao giờ gửi lại một cách mù quáng. Kiểm tra lease/fencing và Core replay thuộc về chủ sở hữu của chúng. Không có transaction nguyên tử xuyên RunStore, artifact filesystem/catalog và Herdr. Hành vi power-loss, network filesystem, đảm bảo multi-host và triển khai trên các phiên bản Node khác là NOT VERIFIED. Không có migration database prototype nào bịa ra command receipt còn thiếu. Sao lưu SQLite một cách nhất quán (kể cả ngữ nghĩa WAL đang hoạt động), không chỉ sao chép file chính trong lúc ghi.
