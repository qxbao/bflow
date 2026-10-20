# Tham chiếu cấu hình (Configuration Reference)

Bflow sử dụng tệp `.bflow/config.yml` làm cấu hình chuẩn (canonical config). Tệp này được định dạng theo chuẩn YAML 1.2 có kèm chú thích hướng dẫn chi tiết và được phân tích cú pháp theo cơ chế an toàn: mỗi tệp chỉ chứa duy nhất một tài liệu, các khóa ánh xạ phải là chuỗi ký tự, đồng thời từ chối các explicit tag, merge key hoặc alias vòng lặp. 

Tệp cấu hình bắt buộc phải có các trường: `schemaVersion: "1"`, `projectName`, `runtimeId`, `createdAt`, `storage`, `defaultWorkflow`; riêng các lệnh quản lý vòng đời (lifecycle commands) đòi hỏi thêm khối `environment`. Hệ thống duy trì tính tương thích ngược với các tệp `.bflow/config.yaml` và `.bflow/config.json` cũ. Bạn có thể sử dụng lệnh `bflow config-migrate` để tự động sao lưu và chuyển đổi dữ liệu sang định dạng chuẩn `.bflow/config.yml`. Tuyệt đối không tự ý thay đổi trường `schemaVersion`.

---

## 1. Quyết định về tính tương thích (Compatibility Decision)

Theo phê duyệt chính thức từ chủ sở hữu dự án, định dạng cấu hình chuẩn đã được chuyển sang YAML có chú thích và bổ sung hai trường tùy chọn theo vai trò là `model` và `effort`, hoàn toàn không làm thay đổi cấu trúc dữ liệu cốt lõi hay schema version của `@bflow/contracts`. Bflow CLI, Runtime, các bộ điều hợp nhà cung cấp (provider adapters) cùng các template mẫu đều đọc thống nhất các trường mới này; nếu để trống, hệ thống sẽ sử dụng giá trị mặc định của từng provider. 

Việc đổi tên tệp và chuyển đổi định dạng cũ chỉ diễn ra khi người dùng chủ động chạy `bflow config-migrate`, lệnh này sẽ bảo lưu nguyên vẹn từng byte của tệp gốc sang tệp `.bak`. Khi muốn áp dụng cấu hình provider/model/effort mới cho một host đang hoạt động, người vận hành cần thực thi `bflow down` trước, sau đó biên dịch và cập nhật đồng bộ các package liên quan.

---

## 2. Bảng mô tả chi tiết các trường cấu hình

| Trường cấu hình | Định dạng / Giá trị mặc định | Thành phần tiêu thụ và giới hạn kỹ thuật |
| --- | --- | --- |
| `projectName` | Chuỗi ký tự không rỗng | Tên hiển thị của dự án; không quyết định định danh của phiên (session identity) |
| `runtimeId` | Chuỗi ký tự không rỗng (sinh tự động khi init) | Dùng cho Runtime workspace phiên bản cũ; cần giữ ổn định khi thực hiện khôi phục |
| `createdAt` | Chuỗi thời gian chuẩn ISO | Siêu dữ liệu ghi nhận thời điểm khởi tạo cấu hình |
| `storage.runStorePath` | `.bflow/data/runs.db` | Đường dẫn tương đối từ workspace tới cơ sở dữ liệu SQLite của CLI Runtime cũ |
| `storage.artifactStoreRoot` | `.bflow/artifacts` | Thư mục lưu trữ artifact của ArtifactStore thuộc CLI Runtime cũ |
| `storage.registryStateFile` | `.bflow/registry/state.json` | Tệp lưu trữ trạng thái của Registry dựa trên tệp của CLI cũ |
| `defaultWorkflow` | `WorkflowDefinition`, schema `"1"` | Định nghĩa quy trình mặc định cho CLI cũ; không phải thư mục chứa thư viện workflow |
| `environment.repositoryId` | Mã băm sinh từ checkout / thư mục Git | Kiểm tra quyền sở hữu repository; không được tự sửa để chiếm quyền điều khiển session cũ |
| `environment.workspaceRoot` | Đường dẫn tuyệt đối chuẩn (canonical path) | Xác thực tính hợp lệ của checkout hiện tại |
| `environment.sessionName` | `bf-` + 20 ký tự hex | Tên định danh phiên Herdr duy nhất được cấp riêng cho checkout |
| `environment.herdrBinary` | `"herdr"` | Tên hoặc đường dẫn tệp thực thi nhị phân cho các lệnh vòng đời |
| `environment.roles` | Mảng `{role, cli, model?, effort?, required}` | Danh sách vai trò duy nhất; `conversation` và `coordinator` bắt buộc có `required: true`. Các trường `model`/`effort` là tùy chọn; riêng Agy tích hợp effort trực tiếp trong tên model |
| `environment.sdd.minimumLevel` | `"lightweight"` hoặc `"full"` | Được P12 lưu trữ và kiểm tra; chưa tự động truyền trực tiếp sang P19 |
| `environment.sdd.approvalRequired` | `true` | Được P12 lưu trữ và kiểm tra; host bắt buộc phải cấu hình chính sách phê duyệt riêng |
| `environment.tdd.policy` | Bắt buộc là `"conditional"` | Không hỗ trợ cấu hình toàn cục `always` hoặc `disabled`; P16 sẽ đánh giá theo từng đặc tả |
| `environment.verification.maxIterations` | Số nguyên từ 1–100 (mặc định: `3`) | P12 kiểm tra phạm vi; API `propose_workflow` của P19 nhận giới hạn từ 1–10 (mặc định: `3`) |
| `environment.verification.onExhausted` | Bắt buộc là `"require_human"` | Ngăn chặn việc lặp lại vô hạn; bắt buộc chuyển giao cho con người khi hết số lần thử |
| `environment.concurrency.maxConcurrency` | Số nguyên từ 1–64 (mặc định: `2`) | P12 truyền giá trị này làm hạn mức cho P13; host P19 có cấu hình `maxDeveloperCapacity` riêng |
| `environment.startupTimeoutMs` | Số nguyên từ 1–600.000 ms (mặc định: `300000`) | Hạn mức thời gian chờ tối đa cho quá trình khởi động (`bflow up`) |
| `environment.shutdownTimeoutMs` | Số nguyên từ 1–600.000 ms (mặc định: `30000`) | Hạn mức thời gian chờ tối đa cho quá trình hạ dịch vụ (`bflow down`) |

---

## 3. Quản lý lưu trữ và phân vùng trạng thái

API `openAgenticWorkspace` của P19 mặc định lưu trữ dữ liệu độc lập tại thư mục:
`.bflow/state/agentic/{runs.db,registry.json,artifacts,journal,conversation}`.

Tùy chọn `storageDirectory` là thiết lập riêng của host; ba trường `storage.*` của CLI cũ ở bảng trên không làm thay đổi các đường dẫn này. Tuyệt đối không sao chép hoặc tráo đổi trạng thái giữa hai Runtime khác nhau chỉ vì chúng có tên tệp giống nhau.

Tệp mẫu [config.fragment.json](../../templates/node-typescript/config.fragment.json) chỉ định nghĩa các trường di động (portable) thuộc khối `environment`. Hãy thực hiện `init` trước rồi mới chạy script áp dụng mẫu để đảm bảo tính toàn vẹn của định danh. Ví dụ về một đoạn cấu hình chính sách:

```json
{
  "sdd": { "minimumLevel": "lightweight", "approvalRequired": true },
  "tdd": { "policy": "conditional" },
  "verification": { "maxIterations": 3, "onExhausted": "require_human" },
  "concurrency": { "maxConcurrency": 2 }
}
```

Đoạn trích này chỉ là thành phần thuộc khối `environment`, không phải là một tệp cấu hình độc lập hoàn chỉnh. Tầng P12 có thể tiếp nhận cấu hình này nhưng chưa tự động thực thi trong P19. Host có trách nhiệm đọc chính sách đã được phê duyệt, kiểm tra các giới hạn của API đích và truyền tường minh vào các cổng/công cụ tương ứng. Không sử dụng giá trị tối đa 100 của P12 để gọi vào API P19 vốn chỉ cho phép tối đa 10.

---

## 4. Phân định trách nhiệm cấu hình giữa Bflow và Herdr

| Mục cấu hình | Phân định trách nhiệm |
| --- | --- |
| Định danh repository, chính sách hệ thống, quy trình workflow, đường dẫn lưu trữ, lựa chọn vai trò/nhà cung cấp/mô hình/effort | Quản trị tại tệp `config.yml` của Bflow |
| Xác thực tài khoản nhà cung cấp, thông tin đăng nhập và tích hợp giao diện terminal/UI | Quản trị bên ngoài qua cấu hình của Herdr và nhà cung cấp tương ứng |
| Tệp `roles.host.json` | Cấu hình nội bộ của API `RolePaneManagerConfig`; host tự nạp trực tiếp, CLI không đọc tệp này |
| Đánh giá đặc tả (Spec assessment), TestStrategy, lệnh kiểm tra verification, xác thực quyền phê duyệt | Đầu vào thuộc hồ sơ dossier/host, không cấu hình tùy tiện trong `config.yml` |

Các biến môi trường `BFLOW_HERDR_BIN` và `HERDR_BIN` được factory của Runtime cũ tiếp nhận; các lệnh quản lý vòng đời mới sử dụng `environment.herdrBinary`. Biến `BFLOW_ENVIRONMENT_MODULE` dùng để chỉ định module ESM của host có quyền thực thi mã nguồn (chỉ người vận hành tin cậy mới được thiết lập biến này). Biến `HERDR_CONFIG_PATH` trỏ tới tệp cấu hình của Herdr.

---

## 5. Kiểm tra mức độ tính toán (Effort Validation)

Mức độ tính toán (`effort`) được kiểm tra tiền trạm (preflight) nghiêm ngặt theo từng nhà cung cấp:
- **Claude**: Hỗ trợ `low`, `medium`, `high`, `xhigh`, `max`.
- **Codex**: Hỗ trợ `minimal`, `low`, `medium`, `high`, `xhigh`.
- **Agy**: Không có trường `effort` riêng; mức tính toán được mã hoá trực tiếp trong tên mô hình.

Nếu nhà cung cấp không hỗ trợ tùy chỉnh model/effort hoặc CLI thiếu cờ thực thi tương ứng, quá trình kiểm tra tiền trạm sẽ chủ động chặn việc khởi chạy thay vì bỏ qua cấu hình một cách âm thầm.

Tài liệu tham chiếu mã nguồn triển khai:
- Trình nạp cấu hình: [config loader](../../apps/cli/src/config.ts)
- Trình nạp môi trường: [environment loader](../../apps/cli/src/environment-config.ts)
- Bộ điều hợp P12: [P12 adapter](../../apps/cli/src/pane-manager-integration.ts)
- Không gian làm việc P19: [P19 workspace](../../packages/runtime/src/agentic/workspace.ts)
