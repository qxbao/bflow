# Filesystem ArtifactStore

`await openFilesystemArtifactStore({ root, storeId, busyTimeoutMs?, clock? })` trả về một `OperationResult<FilesystemArtifactStore>` triển khai mọi method `ArtifactStore` đã được phê duyệt. Gọi `close()` sau khi các stream đang hoạt động kết thúc. Root do operator cấu hình, không bao giờ do agent/URI cung cấp. Root mới là các thư mục riêng tư; root hiện có phải ở dạng canonical, không có symlink ancestor và không cho người dùng khác ghi.

```ts
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
const opened = await openFilesystemArtifactStore({ root: "/configured/artifacts", storeId: "local" });
if (!opened.ok) throw new Error(opened.error.message);
const store = opened.value;
try { const references = await store.find({ runId: "run-1" }); /* inspect OperationResult */ }
finally { store.close(); }
```

## Bố cục và publication

Root chứa `catalog.sqlite` (WAL + FULL synchronous), các file `stage-<uuid>`, `blob-<uuid>` và `read-<uuid>` tạm thời. Catalog SQLite có phiên bản lưu các reference đã xác thực, metadata, tombstone và các receipt idempotency bất biến. Store identity được lưu của nó ngăn việc vô tình mở lại một store khác dưới namespace URI khác. SQLite native dùng cùng yêu cầu Node >=22.13 không phụ thuộc thư viện như persistence; đã kiểm thử trên 22.23.2. Không có import/dependency nào giữa các leaf package này được đưa vào.

`put` stream byte trong các owned write buffer tối đa 64 KiB, tính SHA-256 hoặc SHA-512, xác minh kích thước/checksum kỳ vọng, fsync file, rename bên trong cùng root và fsync thư mục. Chỉ sau đó một transaction BEGIN IMMEDIATE mới publish metadata catalog và receipt. Mọi thao tác chia sẻ một ngân sách deadline; hết hạn trước khi catalog commit sẽ rollback và dọn orphan tạm/đã publish của thao tác này. Kết quả đã commit được trả về mà không có timeout sai. Timeout/not_started mô tả thao tác catalog công khai, không phải việc không có I/O file tạm riêng tư.

Mỗi chunk của producer được tiêu thụ đồng bộ trong một lượt JavaScript: sao chép tối đa 64 KiB vào một owned buffer, ghi hoàn toàn (kể cả xử lý short-write), rồi hash/đếm chính các byte đó. Không có view mutable nào của caller tồn tại qua một await. Điều này hỗ trợ chunk lớn với bộ nhớ bổ sung có giới hạn, không clone cả một chunk lớn, cũng không xếp hàng các ghi bất đồng bộ không giới hạn. Việc resize/tái sử dụng buffer của producer về sau không thể thay đổi byte đã lưu; checksum/kích thước mô tả byte khác sẽ bị từ chối. Kích thước/loại/nlink của file cuối được kiểm tra trước khi publication. Open, fsync, close và publication vẫn bất đồng bộ. Đánh đổi là event loop bị chặn trong lúc ingest chunk: kiểm tra ngân sách diễn ra giữa các segment, nhưng I/O file thường native không thể bị ngắt cưỡng bức. Producer nên yield các chunk vừa phải để đảm bảo khả năng phản hồi; đây là local store, không phải dịch vụ I/O worker không chặn.

Publication filesystem và SQLite commit KHÔNG phải một transaction nguyên tử. Crash trước khi catalog commit có thể để lại stage/blob chưa được lập chỉ mục; chúng không bao giờ truy cập được qua reference/query. Khôi phục sau crash là fail-closed: không tự động nhận (adopt) orphan. Lỗi thông thường, checksum mismatch, cancellation, xung đột receipt và ghi trùng lặp sẽ xóa các file chưa dùng của thao tác này. Dọn dẹp orphan/retention offline phải phối hợp với writer/reader đang hoạt động; không thực hiện sweep tự động không an toàn.

Các connection/tiến trình đồng thời dùng khóa writer của SQLite và các ràng buộc unique identity/receipt, không dùng bản đồ reservation trong bộ nhớ. Key trùng lặp yêu cầu write option đã parse giống hệt VÀ byte đến đã được xác minh; blob đã lưu cũng được xác minh lại trước khi trả về receipt gốc. Payload khác nhau thì xung đột. Artifact ID là bất biến; một key khác không thể ghi đè một ID hiện có. Danh tính receipt tồn tại qua việc mở lại và xóa. Chỉ các artifact ID biểu diễn được trong URI (`[A-Za-z0-9._-]+`, loại trừ `.`/`..`) mới có thể được publish: schema Reference đã phê duyệt không cho phép ID Unicode/khoảng trắng tùy ý dù WriteOptions có thể parse chúng. Các input đó trả về validation, không phải reference giả mạo.

## Tính toàn vẹn và an toàn

`get` parse và đối khớp toàn bộ reference với catalog tin cậy, từ chối đường dẫn không phải regular/symlink/hard-link trước khi mở, rồi mở blob do catalog chọn với O_NOFOLLOW và O_NONBLOCK khi được hỗ trợ. Danh tính inode và device của descriptor/đường dẫn được kiểm tra sau khi mở, và kiểm tra thất bại sẽ đóng descriptor. File FIFO/socket/device không phải blob hợp lệ; một FIFO không thể giữ thao tác trong một lần open đọc bị chặn. Nó sao chép vào một read snapshot riêng tư với buffer có giới hạn trong khi hash và xác thực kích thước, rồi chỉ yield byte sau khi toàn bộ snapshot vượt qua các kiểm tra toàn vẹn. Reference cũ/hỏng/giả mạo/ngoài store không thể trả về byte thành công. Việc consumer streaming return sớm sẽ dọn snapshot. Việc dọn dẹp thử tất cả descriptor và xóa file tạm ngay cả khi một lần close thất bại, trả về lỗi có kiểu. Bản sao đĩa bổ sung là có chủ ý: hash trong khi đã yield byte sẽ để lộ dữ liệu hỏng trước khi phát hiện. `resolve`/`find` trả về metadata catalog; chúng không khẳng định rằng một tiến trình bên ngoài đã để nguyên blob kể từ khi publication.

`resolve` và `find` chạy query và materialization của chúng trong một read transaction BEGIN DEFERRED duy nhất. Các tombstone commit đồng thời ở một WAL connection khác không làm thay đổi snapshot của phản hồi đó; phân trang qua các lời gọi riêng vẫn không phải là snapshot sống lâu. Kiểm tra ngân sách/cancellation bao quanh mỗi lần quan sát, kể cả sau materialization. Hết hạn sau query là timeout/observation_only, trong khi deadline không hợp lệ là lỗi validation. Các kiểm tra này cố ý tách biệt với xử lý mutation: put/delete trả về kết quả đã commit của chúng ngay cả khi clock/AbortSignal thay đổi sau COMMIT.

Mọi tên filesystem đều là tên UUID được sinh ra hoặc tên catalog cố định, không bao giờ là artifact ID thô hay đường dẫn URI. Danh tính root inode/device/canonical được kiểm tra lại, catalog symlink/hard link bị từ chối, và việc mở blob là no-follow. Điều này phòng thủ trước artifact reference không tin cậy và các tấn công đường dẫn có từ trước. Nó không bảo vệ trước một tiến trình thù địch có cùng thẩm quyền filesystem liên tục hoán đổi đường dẫn giữa các syscall: Node không cung cấp API directory-handle kiểu openat đầy đủ ở đây. Root của store và các thư mục ancestor phải do operator kiểm soát. Không log nội dung file, prompt hay metadata nhạy cảm.

`delete` tombstone nguyên tử khả năng hiển thị trong catalog và giữ lại receipt/blob để phục vụ audit và an toàn cho reader đang hoạt động. Xóa lặp lại trả về false; key/ID cũ vẫn bị giữ chỗ, ngăn việc hồi sinh âm thầm. Đây là xóa logic, KHÔNG phải xóa vật lý an toàn. Dọn dẹp retention offline là một chính sách operator riêng. Reference thiếu trả về null; đọc thiếu trả về not_found. Mọi lỗi stream là một OperationResult có cấu trúc.

AbortSignal/timeout giới hạn cả các lời gọi `next()` upstream bị treo lẫn streaming thông thường. Timeout bằng 0 hết hạn ngay lập tức; timer được chia chunk/đặt lại cho các độ trễ lớn. Một producer bỏ qua cancellation không thể bị store dừng cưỡng bức; iterator.return của nó được yêu cầu, và tài nguyên cục bộ được dọn mà không await một producer bị chặn vĩnh viễn.

## Xác minh và bàn giao

Từ thư mục gốc: `pnpm exec vitest run packages/artifact-store/test/artifact-store.test.ts` (build trước cho các subprocess test). Các file/catalog thật tạm thời bao phủ stream nhị phân/rỗng/lớn, đồng thời giữa các instance/tiến trình, receipt sau restart, hỏng dữ liệu, đường dẫn/symlink không an toàn, cancellation, lock deadline, rollback và read snapshot đã xác minh.

P06 sở hữu authorization, proposal ingestion, retention policy và điều phối giữa RunStore, ArtifactStore và transport. Việc publish một artifact không có nghĩa là task của agent đã thành công. Runtime phải ghi nhận bền vững các trusted reference và xử lý riêng việc giao Herdr không chắc chắn; không khẳng định đảm bảo exactly-once xuyên tài nguyên hay phân tán. Power-loss testing, hành vi network filesystem, thay thế đường dẫn thù địch cùng-user và lưu trữ multi-host là NOT VERIFIED. Dung lượng đĩa vật lý tăng theo các tombstone/orphan được giữ lại cho đến khi một retention policy phối hợp được áp dụng.
