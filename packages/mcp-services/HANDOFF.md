# Phase P27 (`@bflow/mcp-services`) — Bàn giao tích hợp

## 1. Baseline và quyền sở hữu

- **Phase**: P27 — OS Services, Resource Management và Dedicated Browser Runtime (`@bflow/mcp-services`)
- **Owned Paths**: `packages/mcp-services/**`

---

## 2. Các capability đã triển khai

1. **OS Service Manager (`src/os-service-manager.ts`, `services/**`)**:
   - Hỗ trợ Linux (`systemd --user`), macOS (`launchd` user agent trong `gui/<uid>`), và Windows (`schtasks` user logon với cổng xác minh tường minh `windowsVerified`).
   - Triển khai đầy đủ các lệnh vòng đời: `install`, `start`, `stop`, `restart`, `enableOnLogin`, `disableOnLogin`, `status`, `logs`, `healthCheck`, `repair`, `recoverIfDead` và `simulateUserLogin`.
   - Thực thi chạy không bằng root (`validateNoRootCommand`, denylist `sudo`, `su`, `doas`, `pkexec`, `runas`), ghi unit file nguyên tử (`writeFileAtomic`), bảo vệ unit file không thuộc sở hữu (`unowned_unit_file`), và health check chỉ qua loopback (`127.0.0.1`, `localhost`, `[::1]`).
2. **Backend Resource và Lifecycle Manager (`src/resource-manager.ts`)**:
   - Triển khai `MCPServiceManager` (`ensure`, `inspect`, `release`) từ `@bflow/contracts` với validate tại ranh giới bằng `MCPServiceObservationSchema.parse`.
   - Hỗ trợ khởi tạo user-session (`initializeUserSession`), trong đó các backend `eager` khởi động ngay và các backend `lazy` nặng (`chrome-devtools-mcp`, `gitnexus`, v.v.) giữ trạng thái chưa khởi động (`0` tiến trình, `0 B` RAM) cho đến lần có nhu cầu tool đầu tiên.
   - Ghép kênh các agent đồng thời (`claude`, `codex`, `agy`) vào một backend dùng chung duy nhất cho mỗi partition (`activeProcessCount === 1`) với khởi động single-flight và thực thi `maxConcurrentClients`.
   - Bảo vệ các client đang hoạt động (`retained_active_clients`), các lời gọi in-flight (`retained_active_calls`), các mutation không chắc chắn (`retained_for_reconciliation`), các attachment đa scope (`retained_attached_scopes`), và các worker `external` được tiếp nhận khỏi bị chấm dứt sớm.
   - Triển khai cửa sổ idle grace (`idleTimeoutMs`) với tái sử dụng instance ấm, `sweepIdleBackends()` định kỳ, giới hạn số tiến trình (`maxProcessCount`), và giám sát bộ nhớ RSS Linux (`sampleMemoryUsage()`).
3. **Dedicated Browser Runtime (`src/browser-runtime.ts`, `src/os-paths.ts`)**:
   - Phân giải các thư mục dữ liệu người dùng theo chuẩn OS nằm ngoài mọi Git repository (`repository_profile_forbidden`) và cô lập nghiêm ngặt khỏi profile Chrome cá nhân (`personal_profile_forbidden`).
   - Thực thi exclusive profile lock (`.bflow-profile.lock` và `SingletonLock` của Chrome), tự động phục hồi từ các lock cũ của PID đã chết sau crash.
   - Bind các endpoint debug của Chrome DevTools chặt chẽ vào loopback (`127.0.0.1`), thăm dò mức khả dụng của executable Chrome (`chrome_binary_missing`) và mức sẵn sàng của cổng debug (`debugging_endpoint_inaccessible`), và hỗ trợ tự động kết nối lại sau crash (`reconnectAfterCrash`).
   - Thực thi sở hữu page nghiêm ngặt theo `(registrationId, runId, taskId, scope)` xuyên suốt `openPage`, `navigatePage`, `getPageContent`, `setPageContent`, `getCookies`, `setCookies`, `listPages` và `closePage` (`page_ownership_conflict`), cô lập các session bằng `browserContextId` riêng cho từng task hoặc quay về dùng tiến trình/profile Chrome riêng cho từng task khi browser context không được hỗ trợ.
   - Dọn dẹp các page, context và instance chuyên dụng của task khi task hoàn tất (`cleanupTask`).
