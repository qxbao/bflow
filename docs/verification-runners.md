# Verification runner

## Tự động phát hiện (mặc định, không cần cấu hình)

Các acceptance criteria có `verificationMethod` là `unit_test` hoặc `integration_test` được
đo mà không cần cấu hình từ người dùng. Khi `.bflow/verification.json` không tồn tại,
Runtime tự kiểm tra repository (`packages/runtime/src/agentic/runner-detection.ts`)
và cung cấp hai label cho Coordinator qua `planning_reference.testRunners`:

| Label | Method | Level |
| --- | --- | --- |
| `auto:unit` | `unit_test` | `unit`, `regression` |
| `auto:integration` | `integration_test` | `integration`, `regression` |

Việc phát hiện không chạy package script, không dùng shell và không cài đặt. Nó chấp nhận:

- **vitest 2.x** được khai báo trong `package.json` và cài ở root repository
  (`node_modules/vitest/vitest.mjs`, là thư mục thật, không phải symlink). Được đo bằng
  JSON reporter cùng reporter đồng hành của Runtime.
- **`node --test`** khi script `test` chứa lệnh `node [cờ] --test`, trong đó cờ chỉ được là `--experimental-strip-types` hoặc `--disable-warning=<tên>` (các cờ này được chuyển tiếp trước `--test`; cờ khác như `--require` khiến script không được nhận diện). Được đo dưới dạng TAP phẳng.
  Không cần dependency.
- Một **`tsc` build** tùy chọn (`tsc`, `tsc -b` hoặc `tsc --build`, có thể kèm đường dẫn
  project tương đối an toàn) từ script `build`, chạy như một bước prepare trong sandbox trước
  các test. Nó chỉ được tạo output bị git ignore. Các build script khác bị bỏ qua và được ghi
  trong detection notes.
- Các thư mục `node_modules` lồng nhau được tìm bằng cách duyệt không đi theo symlink.
  Mỗi thư mục được mount read-only tại cùng đường dẫn tương đối bên trong checkout đo.

Giới hạn: chỉ hỗ trợ vitest 2.x và `node --test`. Các version khác (ví dụ vitest 3) báo
`unsupported` kèm version tìm thấy. `node_modules` bị thiếu hoặc `node_modules` ở root là
symlink cũng là unsupported. Việc đo yêu cầu sandbox của hệ điều hành: Linux với `bwrap`, hoặc macOS với `sandbox-exec` (xem bên dưới), không có truy cập
mạng và không cài dependency. Nếu việc phát hiện là `unsupported`, Runtime thử lại ở lần
`propose_workflow` kế tiếp (và khi Coordinator đọc `planning_reference`), nên việc cài
dependency hoặc thêm runner không đòi hỏi restart host. Khi đó Coordinator được thông báo
(`no_test_runner_detected`) để thêm một task setup; người dùng được hiển thị thông báo đó.

Với mỗi task, Runtime gắn profile đã phát hiện với các định danh lấy từ specification đã
chấp nhận: tên test từ `criterionMappings` của các tiêu chí tự động đang active có method đó,
và file test từ `affectedPaths` là file test và, với Developer, thuộc sở hữu của task. File
test phải được commit trong checkout tại revision được đo. vitest báo `fullName` (các tiêu đề
describe cộng tiêu đề test nối bằng một dấu cách). node --test chỉ báo tiêu đề test.

## Owner override tùy chọn: `.bflow/verification.json`

Owner vẫn có thể tự khai báo các behavioral command trong `.bflow/verification.json`
(ví dụ cho runner hoặc reporter mà việc phát hiện không hỗ trợ, hoặc để pin argv chính xác).
Khi file đó tồn tại, các command của nó được dùng đúng như trước đây, và việc tự động phát hiện
bị tắt cho host đó. Đây là thẩm quyền của operator: Coordinator có thể chọn các command label
đã chấp nhận và tên test đã ánh xạ, nhưng không thể cung cấp executable, argv, output hay
verdict thành công. Host đã persist pin digest của cấu hình. Thay đổi file sau khi host được
tạo sẽ bị từ chối; hãy giữ state và reconcile/migrate host một cách tường minh. Không xóa
journal của host để vượt qua sự không khớp cấu hình.

## Ví dụ Node TAP

Thay `/absolute/path/to/node` bằng executable Node đã cài. Giữ đúng đường dẫn test đã commit
và đúng tên đã quan sát; protocol Node được hỗ trợ là TAP `node:test` phẳng, với assertion
failure cho pha Red.

```json
{
  "schemaVersion": 1,
  "behavioralCommands": [{
    "id": "unit",
    "command": "owner:test-unit",
    "executable": "/absolute/path/to/node",
    "args": ["--test", "--test-reporter=tap", "test/behavior.test.cjs"],
    "method": "unit_test",
    "levels": ["unit", "regression"],
    "testNames": ["ac-1: Target behavior matches expected output"],
    "testPaths": ["test/behavior.test.cjs"],
    "timeoutMs": 30000,
    "maxOutputBytes": 1048576
  }]
}
```

Strategy đã chấp nhận phải dùng `owner:test-unit` và ánh xạ tiêu chí tới đúng tên test.
Quyền sở hữu task đã chấp nhận phải bao gồm các đường dẫn test và implementation. Chỉ thêm
cấu hình này với tư cách project owner; Developer không thể sửa `.bflow` qua các tool của nó
hay commit nó như một phần của task.

## Ví dụ Vitest 2.1

Dùng cùng envelope và các field command, với:

```json
{
  "reporter": "vitest_json",
  "executable": "/absolute/path/to/node",
  "args": [
    "/absolute/toolchain/node_modules/vitest/vitest.mjs",
    "run", "--globals", "--reporter=json", "--no-cache",
    "--maxWorkers=1", "--minWorkers=1", "test/behavior.test.cjs"
  ],
  "dependencyRoots": ["/absolute/toolchain/node_modules"]
}
```

Đây là đoạn fragment để gộp vào command hoàn chỉnh, không phải schema cấu hình riêng. Dùng
`fullName` JSON thực tế của Vitest cho mọi mục `testNames` (bao gồm tên suite). Runtime thêm
reporter đồng hành tin cậy của nó vì JSON của Vitest 2.1 bỏ sót các runtime error không được xử
lý. Thiếu completion, runtime error, skipped, todo, không có test nào, bộ đếm sai định dạng,
tên không mong đợi, timeout và output bị cắt đều chặn bằng chứng. Node TAP vẫn là mặc định khi
bỏ qua `reporter`.

## Phạm vi thực thi và an toàn

Behavioral verification hiện chạy trên hai backend sandbox: Linux (`/usr/bin/bwrap`) và macOS
(Seatbelt, `/usr/bin/sandbox-exec`). Các đoạn dưới đây mô tả backend Linux; khác biệt của macOS nằm ở mục
"Backend macOS (Seatbelt)" ngay sau đó.

Backend Linux yêu cầu `/usr/bin/bwrap` và quyền tạo namespace
user/mount/PID/network. Không có fallback không sandbox. Mỗi lần đo dùng một Git checkout
detached mới tại đúng revision đã commit, môi trường sạch và namespace filesystem rỗng.
`/usr` của hệ thống, executable Node, `/etc/hosts`, checkout và các root `node_modules`
read-only được cấu hình tường minh được mount. Home, state, socket và network của host đều
không có. Root dependency phải là thư mục canonical tên `node_modules`; symlink trỏ ra ngoài
các cây đã mount vẫn không khả dụng. Đây là ranh giới Linux cục bộ, không phải đảm bảo
multi-tenant hay chống kernel thù địch.

### Backend macOS (Seatbelt)

Trên macOS, Runtime dùng `/usr/bin/sandbox-exec` với profile `(deny default)`
(`packages/runtime/src/agentic/behavioral-sandbox-darwin.ts`). Vẫn không có fallback không sandbox:
thiếu `sandbox-exec` hoặc launcher báo lỗi (`sandbox-exec: ...`) là lỗi hạ tầng, không bao giờ được tính là
kết quả test. Khác biệt so với Linux:

- Seatbelt không ẩn đường dẫn mà chỉ từ chối nội dung. Host vẫn tồn tại và metadata (`stat`) đọc được vì
  `realpath` của Node cần `lstat` mọi thư mục cha; nội dung home, `.ssh`, `/etc`, state, secret và
  Git metadata đều bị từ chối đọc/ghi.
- Chỉ có các quyền ghi: checkout và một thư mục `tmp` riêng (cũng là `TMPDIR`/`HOME` của tiến trình).
  File reporter companion, executable Node và các root dependency chỉ đọc.
- Không có bind mount, nên `node_modules` phát hiện tự động được clone vào checkout bằng `cp -c -R`
  (copy-on-write trên APFS), rồi policy chặn ghi lên cây đã clone. `node_modules` phải được git ignore,
  giống mountpoint trên Linux.
- Network, socket của host và signal tới process khác đều bị từ chối. Chỉ cho phép signal tới process con của
  chính nó (Vitest cần để dừng worker) và đọc `/etc/hosts` để phân giải `localhost`; không có `mach-lookup`
  nên không có kênh DNS.
- `sandbox-exec` được Apple đánh dấu deprecated nhưng vẫn hoạt động trên Darwin 25.6.
- Mức bằng chứng: source cộng test đối kháng cục bộ (`behavioral-sandbox-darwin.test.ts`) và đo thật
  `node --test` (TypeScript) lẫn Vitest 2.1.9 trên macOS. Chưa có live acceptance toàn luồng SDLC và chưa
  có đảm bảo chống kernel thù địch.

Không có việc cài dependency, khôi phục workspace symlink hay fetch qua mạng nào diễn ra tự
động. Dependency mà test cần phải được cài sẵn trong `node_modules` của repository (hoặc là
một phần của checkout đã commit). Bước build duy nhất là bước prepare `tsc` được phát hiện đã
mô tả ở trên. Workspace link tới các package chưa mount, output `dist` do các build script
khác tạo ra, coverage tổng hợp, tiêu chí manual/automated hỗn hợp và các version reporter khác
không được hỗ trợ bởi đường mặc định; hãy dùng owner override cho các trường hợp đó.
Bộ `pnpm test` thông thường của repository được chạy riêng; không tuyên bố rằng nó chạy trọn
vẹn trong fixture runner nhỏ có cấu hình này.

Mỗi command có timeout riêng tối đa 300 giây; tổng ngân sách đã cấu hình (gồm overhead của
checkout) phải nằm trong deadline của host. Output bị giới hạn 4 MiB mỗi command. Việc thực thi
làm thay đổi hoặc sinh file trong checkout bị từ chối; dùng `--no-cache` và tránh cập nhật
snapshot hay output coverage. Chỉ các checkout đo dùng một lần mới bị xóa cưỡng bức; worktree
của Developer được giữ lại.

## TDD có điều kiện

Với TDD bắt buộc, ban đầu Developer chỉ có thể sửa/commit các file test đã cấu hình. Nó yêu
cầu Red độc lập rồi nhường lượt. QA thực thi runner; Runtime ghi một receipt tin cậy và
resume cùng Developer đó bằng task lease hiện có. Sau Red, các test blob chính xác đó bị đóng
băng. Green và Refactor đo các revision implementation đã commit với cùng các test. `check_work`
cung cấp phản hồi cho Developer và không bao giờ cung cấp bằng chứng acceptance độc lập.

Assertion failure thật sinh ra chẩn đoán được giữ lại và thông báo sửa chữa có giới hạn; lặp
lại một revision đã fail không đưa thêm job vào hàng đợi. Lỗi hạ tầng được escalate. Cạn giới
hạn phase hoặc verification cũng escalate. Sự không chắc chắn về native delivery được reconcile
riêng và không bao giờ bị diễn giải thành test failure để biện minh cho việc gửi lại công việc.
Các approval bắt buộc về con người/thiết kế/delivery vẫn có hiệu lực.
