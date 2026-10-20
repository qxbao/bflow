# Phase P27 (`@bflow/mcp-gateway`) — Bàn giao tích hợp

## 1. Baseline và định danh branch

- **Phase**: P27 — Shared MCP Gateway (`@bflow/mcp-gateway`)
- **Base Commit (hậu duệ của P24)**: `e058d1636e9c895b633fe8070d1164f02953cf1a` (giữ baseline P24 `8dbb0561adbb41235d481e9800c2cb72eae81658`)
- **Branch**: `agent/mcp-gateway/p27-shared-gateway`
- **Owned Paths đã sửa**: chỉ `packages/mcp-gateway/**`.

---

## 2. Các capability đã triển khai

1. **MCP Service Registry và Sharing Policy Engine (`src/registry.ts`, `src/security.ts`)**:
   - Validate `MCPServiceDefinitionSchema` (`schemaVersion === 3`, từ chối các tool `cli_only` và phiên bản không được hỗ trợ).
   - Gắn mỗi service với một `MCPBackendSharingPolicy` tường minh (`transportCapabilities`, `concurrencyModel`, `sessionIsolationPolicy`, `sharedStatePolicy`, `resourceOwnership`, `reconnectBehavior`).
   - Thực thi việc chia sẻ và phân vùng an toàn (`computePartitionKey`, `evaluateSharingCompatibility`): không bao giờ giả định các backend `stdio_mcp` tùy ý có thể chia sẻ trên toàn máy; cô lập các stdio service có trạng thái theo repository (`repository_partition`) hoặc theo session (`session_partition` / `single_client_isolated`), và chặn các backend `unsupported` / `unsafe_unshareable` mà không giả mạo capability.
2. **Streamable HTTP Server trên Loopback (`src/http-server.ts`)**:
   - Mặc định bind vào `127.0.0.1`, thực thi validate `Host` loopback, từ chối `Origin` của trình duyệt/CSRF (`403 Forbidden`), bảo vệ payload bằng `maxBodyBytes` (`413 Payload Too Large`), và xác thực Bearer token theo scope (`401 Unauthorized`).
   - Phục vụ MCP Streamable HTTP (`POST /mcp` JSON và SSE streaming, `GET /mcp` SSE keepalive kèm dọn dẹp khi ngắt kết nối, `DELETE /mcp` kết thúc session, `GET /health` và `GET /metrics`).
   - Thực thi ngăn cách session nghiêm ngặt (kiểm tra sở hữu `Mcp-Session-Id`) để agent của Project A không thể truy cập session hay trạng thái tool của Project B.
3. **Stdio-to-HTTP Bridge (`src/stdio-bridge.ts`)**:
   - Bridge các lời gọi HTTP/Gateway đa client qua một subprocess `stdio_mcp` duy nhất do Gateway sở hữu (`SubprocessStdioDriverFactory` + `StdioToHttpBridge`).
   - Xác minh đường dẫn executable chuẩn tắc (`realpath`), là file thường, có execute bit, mode không cho group/world ghi (`0o022`), `executableDigest` SHA-256, và môi trường child đã được làm sạch trước khi spawn.
   - Triển khai framing JSON-RPC 2.0 phân tách bằng newline với bảo vệ `maxFrameBytes` theo UTF-8, backpressure `'drain'` của stream (`maxPendingWrites`), và ánh xạ lại request-ID (`gw_<gen>_<seq>_<session>`) để hơn 10 client đồng thời không bao giờ xung đột hay rò rỉ response.
   - Chặn và ngăn các prompt tương tác bị cấm (`elicitation/*`, `sampling/createMessage`, `oauth/interactive`, `browser/permissionPrompt`) để các quyết định của người dùng phải đi qua Runtime → Herdr → Conversation.
4. **Quản lý vòng đời và tái sử dụng Backend (`src/service-manager.ts`)**:
   - Triển khai `DefaultMCPServiceManager` (`ensure`, `inspect`, `release`, `start`, `stop`, `restart`, `status`, `health`).
   - Single-flight các request `ensure` đồng thời theo từng partition, tái sử dụng các backend đang chạy khỏe (`activeProcessCount === 1`), thực thi `restartLimit` có giới hạn, và giữ nguyên các external worker (`existing_shared_worker`, `native_remote_mcp`) qua `release` và `stop`.
   - Bảo vệ các tiến trình do `bflow` sở hữu khỏi bị dừng idle sớm trong khi các lời gọi mutating không chắc chắn (`status: "unknown"`) đang chờ reconciliation.
5. **Concurrency, Backpressure, Timeout, Exclusive Lease và Metrics (`src/gateway.ts`, `src/metrics.ts`)**:
   - Triển khai `BflowSharedMCPGateway` (`register`, `revoke`, `acquireResource`, `renewResource`, `releaseResource`, `call`, `reconcileCall`).
   - Thực thi semaphore `maxConcurrency` theo partition và backpressure `maxQueueSize` có giới hạn.
   - Phân biệt timeout hàng đợi trước khi dispatch (`retrySafety: "not_started"`) với timeout/crash của lời gọi mutating sau khi dispatch (`status: "unknown"`, lưu call ledger, bắt response đến muộn, và cách ly exclusive resource cho đến khi `reconcileCall`).
   - Thực thi exclusive resource lease với `fencingToken` đơn điệu cho các tool tác động đến trình duyệt.
   - Theo dõi số tiến trình theo thời gian thực, bộ nhớ RSS Linux (`/proc/<pid>/status`), thực thi `maxProcessCount` / `maxMemoryBytes`, và các phân vị độ trễ (`minMs`, `maxMs`, `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`).

---

## 3. Tích hợp workspace và ghép Runtime P30

1. `references` của `tsconfig.json` gốc, importer của `pnpm-lock.yaml` và `README.md` có `@bflow/mcp-gateway`, nên `pnpm build`, `pnpm check:deps`, `pnpm typecheck` và `pnpm test` ở gốc bao phủ P27.
2. Trong P30 (`packages/runtime/**`), ghép `BflowSharedMCPGateway`, `DefaultMCPServiceManager` và `StreamableHttpGatewayServer` vào vòng đời session (`ensure` trước khi launch agent, `register` cho từng role, `revoke`/`release` khi session `down`).
