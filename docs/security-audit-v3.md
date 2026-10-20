# Bflow Platform v3 — Báo cáo kiểm toán bảo mật (P24–P34)

- **Ngày kiểm toán**: `2026-10-18`
- **Baseline commit**: `da9e166d136b199c62f4b862141357180268567c`
- **Vai trò**: Principal Security Auditor
- **Phạm vi**: Kiến trúc và thực thi bảo mật toàn tuyến Platform v3 (`packages/agent-providers`, `packages/machine-setup`, `packages/tool-installer`, `packages/mcp-gateway`, `packages/mcp-services`, `packages/skills`, `packages/runtime`, `packages/pane-manager`, `packages/conversation`, `packages/quality-gates`, `apps/cli`, `agents/**`, `skills/**`).

---

## 1. Tóm tắt điều hành (Executive Summary)

Báo cáo này ghi lại kết quả kiểm toán bảo mật độc lập cho Bflow Platform v3 dựa trên rà soát mã nguồn tĩnh, kiểm thử đơn vị/tích hợp (`2.589 PASS`), kiểm thử E2E (`84 PASS`), kiểm thử tiêm lỗi (`local-fault-probe.mjs`) và kiểm thử binary thực trên Linux `x86_64`.

> **Kết luận Kiểm toán Bảo mật**:
> - Toàn bộ **6 yêu cầu bảo mật cốt lõi (Security Checks)** trong phạm vi thiết kế Platform v3 đều **ĐẠT (`PASS`)** với bằng chứng thực thi cụ thể.
> - Tuy nhiên, hệ thống **chưa được chứng nhận Production-Ready cho môi trường đa người dùng / không tin cậy (Untrusted Multi-Tenant)** do giới hạn mô hình đe dọa cùng UID (`RR-13`, `PV3-09`) và chưa có chiến dịch kiểm thử đối kháng trực tiếp (live adversarial campaign) trên chuỗi LLM đầy đủ.

---

## 2. Kiểm tra 6 Tiêu chí Bảo mật Cốt lõi (Mandatory Security Checks)

| # | Tiêu chí kiểm tra bảo mật | Trạng thái | Cơ chế thực thi trong mã nguồn & Bằng chứng kiểm thử |
| :---: | :--- | :---: | :--- |
| **1** | **Không expose MCP ra mạng ngoài** | **PASS** | - `packages/mcp-gateway/src/http-server.ts` & `packages/contracts`: `MCPEndpointSchema` và `GatewayHttpServer` bắt buộc chỉ bind trên địa chỉ loopback (`127.0.0.1` hoặc `::1`), từ chối mọi giao diện mạng ngoài (`0.0.0.0` hoặc IP LAN như `192.168.x.x`).<br>- Kiểm tra nghiêm ngặt header `Host` và `Origin` chống DNS rebinding / CSRF từ trình duyệt.<br>- Mỗi client phải xuất trình Bearer token ngẫu nhiên 256-bit theo từng registration (`Authorization: Bearer <token>`), có thời hạn ngắn (`<= 1 giờ`) và bị thu hồi ngay khi `down` hoặc daemon restart. |
| **2** | **Không lưu credentials trong source code hoặc CLI argv** | **PASS** | - Rà soát toàn bộ source tree xác nhận không có API key hay OAuth token thật trong kho mã.<br>- `.bflow/.gitignore` tự động chặn `state/`, `logs/`, `secrets/`, `*.db`.<br>- `AgentEnvironmentSchema` chỉ chấp nhận tham chiếu `secret://<id>` trong `secretBindings`; `compileArgv` và `createProviderProcessRunner` cấm truyền giá trị secret, ký tự NUL (`\0`) hoặc xuống dòng trên dòng lệnh (`argv`).<br>- Khi kết nối tới Shared MCP Gateway qua HTTP, file cấu hình MCP trên đĩa (`0o600`) **không chứa giá trị token** mà chỉ lưu tên biến môi trường: Claude dùng `${BFLOW_MCP_TOKEN_*}` trong header, Codex dùng `bearer_token_env_var = "BFLOW_MCP_TOKEN_*"`.<br>- `scrubDiagnosticText` (`packages/agent-providers/src/diagnostics.ts`) và bộ lọc log của Runtime tự động che (`[REDACTED]`) Bearer tokens, khóa `sk-*`, `AIza*`, `ghp_*` và địa chỉ email. |
| **3** | **Không bypass protected approvals** | **PASS** | - `ConversationGateway` (`packages/conversation`) và `AgenticHost` (`packages/runtime/src/agentic/host.ts`) yêu cầu quyết định phê duyệt của con người (`human_approval`) phải đi kèm bằng chứng provenance Ed25519 từ hook vật lý `UserPromptSubmit` (`authenticatedUser: true`) và khớp chính xác `(targetId, revision, generation)`.<br>- Mọi lượt trả lời giả mạo từ agent (`origin: "agent"`, `authenticatedUser: false`), quyết định đã hết hạn hoặc thuộc run đã kết thúc đều bị từ chối (`e13` Case C3, `a492fde`, `baea512`, `51db621`).<br>- Ngoại lệ tự động duyệt (`autoaccept`) chỉ áp dụng cho `Specification` rủi ro thấp khi được owner cho phép; **không bao giờ** áp dụng cho cổng phê duyệt thiết kế (`design_approval`), task bắt buộc hoặc phê duyệt bàn giao cuối cùng (`release_approval` / delivery).<br>- Chế độ `unattended_isolated` không được phép miễn trừ các cổng phê duyệt bắt buộc của con người. |
| **4** | **Không chạy agent unrestricted trên repository không tin cậy** | **PASS** | - `PermissionModeSchema` chỉ gồm 3 chế độ: `restricted` (chỉ đọc), `workspace_auto` (chỉ ghi trong phạm vi worktree được cấp), và `unattended_isolated`. Không tồn tại chế độ `unrestricted` cấp máy.<br>- `compileProviderPermissions` (`packages/agent-providers/src/permissions.ts`) cấm tuyệt đối việc phát sinh cờ `--dangerously-skip-permissions` (Claude) hoặc `--dangerously-bypass-approvals-and-sandbox` (Codex) trừ khi chạy bên trong một OS sandbox/container đã được xác minh (`verifiedOsSandbox: true`) và `allowGlobalPermissionBypass` bị khóa ở `false`.<br>- `unattended_isolated` fail-closed (`unattended_isolation_unsupported` / `agy_unattended_unsupported`) nếu thiếu `/usr/bin/bwrap` hoặc nếu provider không hỗ trợ (`agy`).<br>- `Developer` chỉ được sửa các đường dẫn nằm trong `ownedPaths` của task (kiểm tra bởi hook `PreToolUse` và `GitOrchestrator`); trước khi đạt pha Red trong TDD bắt buộc, chỉ `testPaths` mới được phép chỉnh sửa. |
| **5** | **Không cho browser session truy cập chéo trái phép** | **PASS** | - `planChromeSession` (`packages/tool-installer/src/integrations.ts`) và `DedicatedBrowserRuntime` (`packages/mcp-services/src/browser.ts`) tạo thư mục dữ liệu người dùng riêng biệt với quyền `0o700` tại `<stateRoot>/chrome/<repoId>/<taskId>`, tách rời hoàn toàn khỏi profile Chrome cá nhân của người dùng (`~/.config/google-chrome`).<br>- Kiểm tra `SingletonLock` trước khi mở phiên; nếu profile đang bị khóa thì trả về `status: "profile_locked"` thay vì dùng chung.<br>- Cổng Remote Debugging của Chrome chỉ gắn vào `127.0.0.1`.<br>- Mỗi tab/trang được gắn quyền sở hữu theo `(sessionId, taskId, leaseId, fencingToken)`; mọi nỗ lực điều hướng hoặc đọc trang của task khác đều bị chặn với mã lỗi `conflict` (`diagnosticCode: "page_ownership_conflict"`, đã xác minh trong `e15` Case E4). |
| **6** | **Không có shared backend được tuyên bố an toàn khi chưa kiểm chứng** | **PASS** | - Mọi dịch vụ MCP chia sẻ qua `BflowMcpGateway` phải vượt qua kiểm tra nhị phân (quyền thực thi không cho phép group/world-writable, SHA-256 digest), khởi tạo giao thức JSON-RPC `initialize` và đối chiếu danh sách `tools/list` (kèm `inputSchema` hợp lệ chuẩn MCP, commit `3a9f461`).<br>- Mọi role được chuẩn bị (`prepare` / dynamic `Developer`) có đăng ký Gateway đều bắt buộc phải gửi bằng chứng `toolReachability` thực tế từ bên trong tiến trình của provider trước khi được nhận bất kỳ công việc nào (`372b119`, `9595d02`).<br>- Nếu một lời gọi công cụ có tác dụng phụ gặp lỗi timeout/mất kết nối (`unknown_state`), Gateway đưa phiên đó vào diện cách ly (quarantine) và **không tự động phát lại (no blind replay)**. |

---

## 3. Mô hình đe dọa và Ranh giới Tin cậy (Threat Model & Trust Boundaries)

### 3.1 Thành phần trong Ranh giới Tin cậy (Trusted Computing Base — TCB)
- Nhân hệ điều hành Linux, hệ tệp POSIX cục bộ (hỗ trợ `0700`/`0600` và `flock`), `/usr/bin/bwrap` (Bubblewrap).
- Tiến trình `AgenticHost` (`@bflow/runtime`), `BflowMcpGateway` (`@bflow/mcp-gateway`), `Herdr` daemon (`protocol 22`), và khóa ký `Ed25519` sinh riêng theo từng phiên trong `.bflow/state`.
- Người vận hành (Operator) tương tác qua terminal gắn với pane `conversation`.

### 3.2 Thành phần Không tin cậy (Untrusted / Constrained Actors)
- **Đầu ra của LLM / Agent Providers (`claude`, `codex`, `agy`)**: Không bao giờ được tin cậy để tự xác nhận hoàn thành công việc (`Herdr done != task success`), tự cấp quyền phê duyệt, tự sửa `Specification` đã duyệt, hoặc tự đánh giá Quality Gate của chính mình.
- **Nội dung trong Repository / Test Code**: Được coi là có khả năng chứa prompt injection (`malicious_repository_content` trong `e13` Case C4) hoặc mã kiểm thử độc hại. Các lệnh kiểm thử hành vi (Node TAP / Vitest JSON) luôn chạy trong **Bubblewrap namespace cô lập** (`empty root`, `/usr` chỉ đọc, mạng bị ngắt `network: deny`, không mount `$HOME`, `.bflow`, `.git` hay Unix sockets của host).

---

## 4. Rủi ro Bảo mật Tồn đọng và Chấp nhận Rủi ro (Residual Risks)

| Mã rủi ro | Mức độ | Mô tả chi tiết | Biện pháp giảm thiểu hiện tại & Điều kiện đóng |
| :--- | :---: | :--- | :--- |
| **`RR-13` / `PV3-09`** | **Medium (P2 — Đề xuất chấp nhận cho Single-Operator)** | **Chia sẻ cùng UID giữa các tiến trình Provider**: Các CLI `claude`, `codex`, `agy` chạy dưới cùng UID của người dùng. Một tiến trình cùng UID bị chiếm quyền có thể đọc `/proc/<pid>/environ` để lấy Bearer token `BFLOW_MCP_TOKEN_*` hoặc can thiệp socket cùng UID. | - Token có phạm vi hẹp theo role/session, thời hạn ngắn (`<= 1 giờ`) và bị thu hồi ngay khi `down` hoặc host restart.<br>- Env không còn truyền qua dòng lệnh `herdr agent start` mà truyền qua Herdr socket lúc tạo pane (`33ca7ab`).<br>- **Điều kiện đóng cho Multi-Tenant**: Chạy từng provider bên trong OS user/container riêng biệt và truyền token qua file descriptor/socket riêng. |
| **`RR-26`** | **High (Ràng buộc vận hành)** | **Hệ tệp `fuseblk` (NTFS) không bảo toàn quyền `0700`/`0600`**: Trên phân vùng mount `fuseblk`, `chmod 0600` vẫn trả về `0777` và `uid=0`. | Bflow kiểm tra quyền file nghiêm ngặt và từ chối chạy state trên `fuseblk`. Operator bắt buộc đặt repository/worktree hoặc thư mục trạng thái trên hệ tệp POSIX (`ext4`/`xfs`/`tmpfs`). |
| **`RR-16`** | **Low / Medium (P2)** | **Giới hạn của cơ chế che dấu mật khẩu (Log Redaction)**: Bộ lọc regex che được các định dạng token/key đã biết (`Bearer`, `sk-*`, `AIza*`, `ghp_*`, email), nhưng không thể đảm bảo phát hiện 100% chuỗi bí mật mã hóa tùy ý (base64/hex không tiền tố) trong raw artifact/log. | Thư mục `.bflow/state` và `artifacts` được đặt quyền `0700`/`0600`; không đẩy raw logs lên hệ thống công khai khi chưa rà soát. |
| **`PV3-04`** | **Medium (P2)** | **Cài đặt công cụ bên thứ ba & Native Plugins**: Các gói npm cài đặt ở bước `setup` kiểm tra SHA-256 tarball chính nhưng cây phụ thuộc bắc cầu (transitive dependencies) và license (ví dụ GitNexus noncommercial) cần được kiểm toán theo chính sách tổ chức. | Chế độ `isolatedRoot` (`01e53a4`, `15f7a34`) đã giữ mọi thay đổi plugin/PATH/systemd bên trong thư mục cô lập khi test; môi trường production nên dùng offline bundle đã kiểm duyệt. |
