# @bflow/mcp-services

Điều phối service ở cấp OS, pooling resource backend và quản lý browser runtime cô lập cho Model Context Protocol (MCP) trong nền tảng Bflow Agentic SDLC.

## Trạng thái package

- **Platform Version**: Version 3 (`CURRENT_PLATFORM_SCHEMA_VERSION = 3`)
- **Protocol Baseline**: Model Context Protocol Specification `2025-11-25`
- **Package Type**: ESM (`type: module`)
- **Trạng thái xác minh**: Unit/integration tests bao phủ OS service, resource và dedicated browser runtime; Runtime cũng đã nối giao dịch lease độc quyền `BrowserResourceTransactions` ở mức source + local tests. Đây chưa phải full provider/Chrome workflow acceptance live. Xem [implementation status](../../docs/implementation-status.md).

---

## Mục đích kiến trúc và bất biến ranh giới

`@bflow/mcp-services` cung cấp lớp trừu tượng hệ điều hành cấp host cho hệ sinh thái MCP dùng chung của Bflow. Nó quản lý vòng đời daemon OS chạy nền, điều tiết và cân bằng bộ nhớ tiến trình cùng concurrency trên các MCP backend, và cung cấp các browser runtime Chrome/Chromium chuyên dụng, an toàn cho việc tự động hóa của agent.

```
+-----------------------------------------------------------------------------------+
|                              Bflow MCP Gateway (P27)                              |
+-----------------------------------------------------------------------------------+
                                       |
    +----------------------------------+----------------------------------+
    |                                  |                                  |
    v                                  v                                  v
+-----------------------+  +-----------------------+  +-----------------------+
| BflowOSServiceManager |  | BackendResourceManager|  |DedicatedBrowserRuntime|
| - systemd --user      |  | - Lazy / Eager startup|  | - Dedicated profiles  |
| - launchd gui/<uid>   |  | - Idle sweep & timers |  | - Loopback debugging  |
| - Windows schtasks    |  | - Memory RSS tracking |  | - Page ownership gate |
| - Non-root execution  |  | - Process pooling     |  | - Crash auto-recovery |
| - Self-healing repair |  | - Multi-client sharing|  | - Multi-agent context |
+-----------------------+  +-----------------------+  +-----------------------+
    |                                  |                                  |
    +----------------------------------+----------------------------------+
                                       |
                                       v
                    +-------------------------------------+
                    |            os-paths.ts              |
                    | - XDG / AppSupport / LocalAppData   |
                    | - Strict repo isolation guard       |
                    | - Personal browser profile firewall |
                    +-------------------------------------+
```

### Bất biến ranh giới

> [!IMPORTANT]
> **Không yêu cầu quyền Root / Administrator**:
> Mọi service nền, tiến trình và unit hoạt động chặt chẽ trong user session không đặc quyền:
> - Linux: `systemd --user`
> - macOS: `launchd` trong user domain `gui/<uid>`
> - Windows: Scheduled Tasks (`schtasks`) chạy với `LogonType: InteractiveToken` và `RunLevel: LeastPrivilege`.
>
> Các binary leo thang đặc quyền (`sudo`, `su`, `doas`, `pkexec`, `runas`) nằm trong denylist nghiêm ngặt và bị validate đầu vào từ chối.

> [!IMPORTANT]
> **Chỉ bind mạng trên Loopback**:
> Mọi health probe của service, listener của gateway và endpoint remote debugging của Chrome DevTools chỉ bind vào các địa chỉ loopback (`127.0.0.1`, `localhost`, `[::1]`). Việc bind vào interface bên ngoài (`0.0.0.0`, LAN, hoặc địa chỉ IP công cộng) bị từ chối với `non_loopback_forbidden`.

> [!IMPORTANT]
> **Đường dẫn chuẩn OS nằm ngoài Repository**:
> Các unit cấu hình service, log bền vững, state file và thư mục dữ liệu người dùng của trình duyệt chỉ được phân giải tại các vị trí người dùng chuẩn của OS:
> - Linux: `$XDG_CONFIG_HOME/bflow`, `$XDG_DATA_HOME/bflow`, `$XDG_STATE_HOME/bflow`
> - macOS: `~/Library/Application Support/bflow`, `~/Library/Logs/bflow`
> - Windows: `%LOCALAPPDATA%\bflow`, `%APPDATA%\bflow`
>
> Việc đặt profile trình duyệt hoặc service unit bên trong bất kỳ Git repository hay workspace root nào bị từ chối với `repository_profile_forbidden`. Va chạm với thư mục trình duyệt cá nhân bị ngăn bằng path firewall nghiêm ngặt (`personal_profile_forbidden`).

> [!NOTE]
> **Ổn định Contract**:
> `@bflow/mcp-services` tuân thủ chặt chẽ `@bflow/contracts` version 3 mà không sửa các signature contract dùng chung.

---

## Các module cốt lõi

### 1. OS Service Manager (`BflowOSServiceManager`)
Xử lý việc đăng ký service nền gốc (native), điều khiển vòng đời, logging và tự phục hồi:
- **Native Unit đa OS**: Sinh và cài đặt các unit file với dấu hiệu sở hữu bất biến `# Managed by bflow`:
  - Linux: các `systemd` user service unit (`~/.config/systemd/user/bflow-<serviceId>.service`)
  - macOS: các `launchd` user agent (`~/Library/LaunchAgents/dev.bflow.<serviceId>.plist`)
  - Windows: Scheduled Tasks (`\Bflow\bflow-<serviceId>`) với Logon Trigger và hook `.cmd` trong thư mục Startup.
- **Tự phục hồi (Self-Healing & Auto-Recovery) (`recoverIfDead`)**: Liên tục giám sát tình trạng sống của service và các endpoint HTTP `/health` loopback. Khởi động lại các service đã chết và giới hạn các đợt restart liên tiếp (`maxRestartBurst`) để ngăn crash loop.
- **Bảo vệ chống can thiệp và sửa chữa (`repair`)**: Xác thực digest của unit file so với cấu hình chuẩn. Bảo vệ các unit không thuộc sở hữu (`unowned_unit_file`) và tự động tạo bản sao lưu có timestamp trước khi cập nhật các unit bflow đã bị sửa.
- **Mô phỏng Logon (`simulateUserLogin`)**: Phát hiện các service đã cài đặt được bật cho user login và khởi chạy chúng khi startup.

### 2. Backend Resource Manager (`BackendResourceManager`)
Triển khai `MCPServiceManager` để giám sát các backend tool driver:
- **Khởi động Lazy so với Eager**: Các backend eager khởi động khi khởi tạo session, còn các backend lazy nặng (như `chrome-devtools-mcp` hay `gitnexus`) không tốn RAM và không tốn process handle cho đến khi agent có nhu cầu tool đầu tiên.
- **Ghép kênh kết nối đa Client**: Các agent đồng thời (`claude`, `codex`, `agy`) kết nối tới một partition backend dùng chung mà không nhân bản tiến trình OS.
- **Bảo vệ Client đang hoạt động**: Các cơ chế release backend và idle sweep từ chối dừng backend khi còn kết nối client đang hoạt động, lời gọi in-flight, hoặc mutation không chắc chắn đang chờ reconciliation (`retained_active_clients`, `retained_active_calls`, `retained_for_reconciliation`).
- **Cửa sổ Idle Sweep Grace (`idleTimeoutMs`)**: Giữ backend ở trạng thái ấm trong các khoảng nghỉ ngắn giữa task, kết nối lại ngay cho agent quay lại, và dừng backend khi idle timeout hết hạn (`stopped_idle`).
- **Hạn ngạch tiến trình và bộ nhớ**: Thực thi số tiến trình tối đa (`maxProcessCount`) và giới hạn tổng RSS bộ nhớ (`maxTotalMemoryBytes`), tự động loại bỏ các backend idle chưa được cấp phát khi hệ thống chịu áp lực.

  macOS đo RSS của PID bằng `/bin/ps` có timeout thay cho đọc `/proc` hoặc dùng
  ước lượng browser 50 MiB. Phép đo thất bại không được ghi thành sample thành công;
  sampler giữ observation trước đó. Đây là số đo PID, chưa phải tổng RAM của cây
  Chrome renderer. Test portability dùng Node child riêng, không phải Chrome live acceptance.

### 3. Dedicated Browser Runtime (`DedicatedBrowserRuntime`)
Điều phối các session Chrome/Chromium headless cô lập cho agent:
- **Cây Profile chuẩn OS**: Sinh các thư mục dữ liệu người dùng mang tính xác định, an toàn với filesystem, nằm ngoài repository và tách biệt khỏi profile Chrome cá nhân.
- **Exclusive Profile Locking**: Quản lý `.bflow-profile.lock` nguyên tử và phát hiện `SingletonLock` / `SingletonSocket` gốc của Chrome. Tự động nhận diện PID đã chết và dọn dẹp các lock cũ.
- **Cô lập Page và Context đa Agent**:
  - Ở chế độ `browser_context`, chia sẻ một tiến trình Chrome duy nhất giữa các agent đồng thời tạo browser context cô lập và cookie store riêng cho mỗi task của agent.
  - Ở chế độ `separate_process` (hoặc khi Chrome không hỗ trợ browser context), cấp các instance Chrome chuyên dụng với profile người dùng độc lập.
- **Page Ownership Gate**: Mọi thao tác điều hướng, truy cập nội dung, thay đổi cookie hoặc đóng page đều bị chặn bởi `BrowserCallerIdentity` (`registrationId`, `runId`, `taskId`, `scope`). Truy cập chéo agent trái phép bị chặn với `page_ownership_conflict`.
- **Phục hồi Crash (`reconnectAfterCrash`)**: Phát hiện tiến trình bị chấm dứt (`browser_crashed`), xóa các PID lock file cũ, khởi chạy lại Chrome trên loopback, và khôi phục session debug tối đa `maxReconnectAttempts` lần.
- **Dọn dẹp Task tức thì (`cleanupTask`)**: Dọn dẹp mọi page đang mở, browser context và instance chuyên dụng ngay khi task hoàn tất, giải phóng bộ nhớ tức thì.

---

## Tham chiếu API

### Các Class được xuất

| Class | Source | Mục đích |
| --- | --- | --- |
| `BflowOSServiceManager` | `src/os-service-manager.ts` | Cài đặt, khởi động, giám sát và sửa chữa các service cấp người dùng gốc của OS. |
| `SafeOSCommandRunner` | `src/os-service-manager.ts` | Thực thi các lệnh subprocess không root, không qua shell, có bảo vệ timeout. |
| `BackendResourceManager` | `src/resource-manager.ts` | Giám sát các partition MCP driver, lấy mẫu bộ nhớ, hạn ngạch tiến trình và sweep. |
| `DedicatedBrowserRuntime` | `src/browser-runtime.ts` | Quản lý profile Chrome chuyên dụng, quyền sở hữu page, cookie store và phục hồi crash. |
| `DefaultBrowserLauncher` | `src/browser-runtime.ts` | Thăm dò và spawn các binary Chrome/Chromium cục bộ với debug loopback. |

### Các hàm tiện ích được xuất

| Function | Source | Mô tả |
| --- | --- | --- |
| `resolveBflowOSPaths(options)` | `src/os-paths.ts` | Trả về các đường dẫn config, data, log và profile chuẩn cho Linux, macOS và Windows. |
| `validateBrowserProfileDirectory(options)` | `src/os-paths.ts` | Đảm bảo đường dẫn profile là tuyệt đối, nằm ngoài repo, và không nằm trong thư mục Chrome cá nhân. |
| `resolveDedicatedProfileDir(root, scope)` | `src/os-paths.ts` | Tính đường dẫn thư mục mang tính xác định cho một `TrustScope` cho trước. |
| `validateLoopbackDebuggingHost(host)` | `src/os-paths.ts` | Đảm bảo host chỉ là `127.0.0.1`, `localhost`, hoặc `[::1]`. |
| `validateNoRootCommand(argv)` | `src/os-service-manager.ts` | Bảo vệ các đối số lệnh khỏi các binary leo thang đặc quyền và ký tự điều khiển. |
| `defaultIsPidAlive(pid)` | `src/browser-runtime.ts` | Kiểm tra một process ID cho trước có đang chạy trên OS hay không. |
| `scopeToKey(scope)` | `src/browser-runtime.ts` | Sinh một chuỗi key chuẩn tắc cho một `TrustScope`. |
| `isSameScope(a, b)` | `src/browser-runtime.ts` | So sánh xem hai instance `TrustScope` có đại diện cho cùng một ranh giới hay không. |

---

## Các lệnh test chạy được

Từ thư mục gốc repository:

```bash
# Run all tests in @bflow/mcp-services
pnpm --filter @bflow/mcp-services test

# Run TypeScript compilation and type checking
pnpm --filter @bflow/mcp-services run build
pnpm --filter @bflow/mcp-services run typecheck

# Run specific test suites
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/os-service-manager.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/resource-manager.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/browser-runtime.test.ts
pnpm --filter @bflow/mcp-services test packages/mcp-services/test/integration-scenarios.test.ts
```

Để biết hướng dẫn đầy đủ về triển khai, cấu hình, xử lý sự cố và tinh chỉnh, xem [OPERATIONS.md](OPERATIONS.md).
