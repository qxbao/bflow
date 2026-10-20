# Phase P27 (`@bflow/mcp-gateway`) — Review Code, Giao thức và Bảo mật của Argon

## 1. Phạm vi và quy trình review

- **Quy trình**: Plan (Argon) → Implement (Flash subagents `2a6693a6-1250-44b1-89c9-e86a92cd9e98`, `a1a838ab-7e41-4af7-81db-2f88b375dfa0`, `25470f7b-7420-4822-ab34-d77bfd74c8e5`) → Review (Argon) → Fix (Flash subagent `88faf3b5-03f1-4088-b484-270c801e1aa0`) → Final Acceptance (Argon).
- **Baseline được review**: Branch `agent/mcp-gateway/p27-shared-gateway` (hậu duệ của baseline P24 `8dbb0561adbb41235d481e9800c2cb72eae81658`).
- **Owned Paths**: `packages/mcp-gateway/**`.

---

## 2. Phát hiện của Argon Review và các khắc phục của Flash

| ID | Mức độ | Khu vực | Phát hiện trong bản triển khai Flash ban đầu | Khắc phục Flash đã áp dụng và xác minh |
| --- | --- | --- | --- | --- |
| **R27-01** | High | Uncertainty & Reconciliation (`src/stdio-bridge.ts`, `src/gateway.ts`, `src/metrics.ts`) | 1. Trong `StdioToHttpBridge.callTool`, khi `sendJsonRpcRequest` thất bại do timeout hoặc crash (`!res.ok`), nó vô điều kiện đặt `reconcileLedger` thành `{ status: "failed" }`, ghi đè `{ status: "unknown" }` từ `triggerCrash` và đánh dấu sai các lời gọi in-flight bị timeout là `"failed"`.<br>2. Các response JSON-RPC đến muộn sau khi client timeout bị bỏ vì `pendingRequests` đã xóa `upstreamId`.<br>3. `interactive_prompt_blocked` bị coi là lỗi mutating không chắc chắn thay vì trả về lỗi `validation` mang tính xác định.<br>4. Các timeout/hủy của lời gọi mutating sau dispatch chỉ tăng `unknownToolCalls`. | **ĐÃ SỬA**: Theo dõi trạng thái `dispatched` trong `StdioToHttpBridge` để giữ `{ status: "unknown" }` sau khi ghi và `{ status: "not_delivered" }` trước khi ghi; thêm map `timedOutUpstreamRequests` để các response đến muộn cập nhật `reconcileLedger` cho `reconcileCall`; truyền `interactive_prompt_blocked` trực tiếp dưới dạng `err(upstreamRes.error)` cùng mục audit `interactive.blocked`; ghi nhận `timedOutToolCalls` / `cancelledToolCalls` qua `recordMutatingTimeoutOrCancel`. |
| **R27-02** | High | Trust Scope Authority & Lease Fencing (`src/gateway.ts`) | 1. Trong `BflowSharedMCPGateway.revoke`, `isTrustScopeWithin(operation.scope, reg.scope)` đảo ngược `candidate` và `authority`, ngăn một operator có scope repository hoặc machine thu hồi đăng ký session con.<br>2. `releaseResource` không xác minh việc scope của caller được chứa trong scope cho phép, không từ chối việc giải phóng resource đang bị quarantine, và bỏ qua `fencingToken` lỗi thời không khớp. | **ĐÃ SỬA**: Cập nhật `revoke` thành `isTrustScopeWithin(reg.scope, operation.scope)`; thực thi kiểm tra scope containment, từ chối quarantine (`resource_quarantined`), và từ chối lease/fence lỗi thời (`stale_lease`) trong `releaseResource`. |
| **R27-03** | High | Theo dõi client đang hoạt động, `single_client_isolated` và Idle Release Guard (`src/gateway.ts`, `src/service-manager.ts`) | 1. `BflowSharedMCPGateway` không gọi `serviceManager.attachClient`/`detachClient`, khiến `activeClientCount` ở mức `0` và bỏ qua các kiểm tra đa client của `single_client_isolated`.<br>2. `DefaultMCPServiceManager.release` dừng các tiến trình idle do `bflow` sở hữu mà không kiểm tra liệu các lời gọi không chắc chắn (`status === "unknown"`) còn tồn tại trên partition đó hay không. | **ĐÃ SỬA**: Nối `attachClient` và `detachClient` xuyên suốt đăng ký, mở/ngắt session, thu hồi và các lời gọi tool; thực thi xung đột `single_client_isolated` (`single_client_limit`); thêm `setHasUncertainCallsCheck` để `release` giữ lại các tiến trình có lời gọi `unknown` chưa giải quyết (`retained_for_reconciliation`). |
| **R27-04** | Medium | Stdio Framing, Drain Backpressure, MCP Cancellation và Subprocess Isolation (`src/stdio-bridge.ts`) | 1. `maxFrameBytes` kiểm tra `.length` UTF-16 thay vì `Buffer.byteLength`.<br>2. `writeRaw` không chờ `'drain'` của Node stream khi `stdin.write(...)` trả về `false`.<br>3. `sendCancelNotification` gửi `"$/cancelRequest"` thay vì `"notifications/cancelled"` chuẩn của MCP.<br>4. `SubprocessStdioDriverFactory` sao chép nguyên `process.env` vào tiến trình con và không kiểm tra `realpath`, file thường, execute bit và mode không cho group/world ghi (`0o022`). | **ĐÃ SỬA**: Dùng `Buffer.byteLength(..., "utf8")` cho `maxFrameBytes`; chờ `'drain'` khi `stdin.write` trả về `false`; gửi `"notifications/cancelled"`; xác minh `realpath`, file thường, execute bit, `(mode & 0o022) === 0` và digest SHA-256; làm sạch biến môi trường của child và xác minh mọi binding `secretStore`. |
| **R27-05** | Medium | Giới hạn HTTP Body và bảo vệ Redirect/SSRF (`src/http-server.ts`, `src/service-manager.ts`) | 1. `StreamableHttpGatewayServer.readRequestBody` buffer request body không giới hạn byte.<br>2. `HttpUpstreamDriverInstance.postJsonRpc` cho phép HTTP redirect mặc định. | **ĐÃ SỬA**: Thực thi `maxBodyBytes` (mặc định 4MB, trả về HTTP `413 Payload Too Large`) trong `readRequestBody` và đặt `redirect: "error"` trong `HttpUpstreamDriverInstance.postJsonRpc`. |
| **R27-06** | Medium | Độ phủ xác minh (`test/mcp-gateway.test.ts`) | Scenario 9 dựa vào lỗi R27-01 khi `reconcileCall` trả về `"failed"` ngay sau crash. Cần các regression test cho R27-01 đến R27-05, gồm cả `stdio_mcp` với child process thật. | **ĐÃ SỬA**: Cập nhật Scenario 9 để xác minh reconciliation hai giai đoạn (`"unknown"` khi chưa giải quyết, rồi `"failed"` sau bằng chứng `"not_delivered"`) và thêm Scenario 12 với 4 regression test, trong đó có một subprocess Node thật phục vụ 10 client đồng thời (29/29 test đạt). |

---

## 3. Kết luận nghiệm thu cuối cùng của Argon

- **Trạng thái**: **ACCEPTED (PASS)**
- **Verification Gates**:
  - `pnpm check:deps` — PASS (17 package, 24 cạnh nội bộ, đã xác minh ranh giới leaf package)
  - `pnpm --filter @bflow/mcp-gateway run typecheck` — PASS (0 lỗi)
  - `pnpm --filter @bflow/mcp-gateway run test` — PASS (29/29 test đạt qua 12 scenario suite)
  - `pnpm typecheck` & `pnpm test` — PASS
  - `git diff --check` & `git status --short` — PASS (giới hạn nghiêm ngặt trong `packages/mcp-gateway/**`)
