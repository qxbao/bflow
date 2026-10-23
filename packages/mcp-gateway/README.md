# @bflow/mcp-gateway

Gateway HTTP loopback dùng chung, stdio-to-HTTP bridge và bộ phân xử resource cho Model Context Protocol (MCP) trong nền tảng Bflow Agentic SDLC.

## Trạng thái package

- **Platform Version**: Version 3 (`CURRENT_PLATFORM_SCHEMA_VERSION = 3`)
- **Protocol Baseline**: Model Context Protocol Specification `2025-11-25`
- **Package Type**: ESM (`type: module`)
- **Trạng thái**: Đã triển khai cùng các kịch bản test cục bộ của package mang tính xác định (xem ma trận bên dưới).

## Mục đích kiến trúc và bất biến ranh giới

MCP Gateway cung cấp một hub kết nối ghép kênh thông lượng cao cho các MCP tool. Nó cho phép nhiều provider agent (`claude`, `codex`, `agy`) chạy trên các SDLC role khác nhau (`coordinator`, `developer`, `reviewer`, `qa`, `tester`) kết nối tới các MCP service dùng chung hoặc cô lập qua HTTP loopback hoặc stdio mà không rò rỉ credential, cạn kiệt port hay xung đột tiến trình không được quản lý.

> [!IMPORTANT]
> **Chỉ kết nối Tool**: MCP Gateway CHỈ quản lý kết nối tool và các exclusive tool resource. Nó **KHÔNG BAO GIỜ** là transport giao tiếp liên role cho các envelope `RoleMessage`. Mọi giao tiếp giữa các agent vẫn phải đi qua Workflow Runtime và Herdr.

> [!IMPORTANT]
> **Không elicitation trực tiếp từ người dùng**: Mọi request prompt tương tác của MCP upstream (`elicitation/*`, `sampling/*`, `oauth/interactive`) bị chặn và ngăn tại ranh giới gateway. Các quyết định của người dùng chỉ được định tuyến qua Workflow Runtime $\to$ Herdr $\to$ Conversation Agent.

---

## Các thành phần cốt lõi

`agy-stdio-http-cli` là client shim cho Agy: cấu hình chỉ chứa endpoint,
registration, service IDs và tên biến môi trường token. Shim giữ session HTTP có
xác thực, kiểm tra correlation response/call và không tự gửi lại mutation khi kết
quả `unknown`. Shim không thay Herdr, không cấp quyền role và không chứng minh
provider đã activated-ready.

1. **`BflowSharedMCPGateway`** (`src/gateway.ts`):
   Bộ phân xử trung tâm triển khai `SharedMCPGateway`. Quản lý đăng ký client, bearer token, scope ủy quyền tool, semaphore concurrency, call ledger, exclusive resource lease với fencing token đơn điệu, và reconciliation lời gọi.
2. **`StreamableHttpGatewayServer`** (`src/http-server.ts`):
   Server HTTP/1.1 Node.js trên loopback phục vụ `POST /mcp`, `GET /mcp` (SSE keepalive), `DELETE /mcp`, `/health` và `/metrics`. Thực thi validate Host/Origin, xác thực bearer token và ngăn cách session.
3. **`StdioToHttpBridge`** (`src/stdio-bridge.ts`):
   Bridge các lời gọi gateway tới các subprocess stdio MCP worker upstream qua JSON-RPC 2.0 phân tách bằng newline. Chuyển đổi và ánh xạ lại JSON-RPC ID thành `gw_<gen>_<seq>_<session>`, thực thi giới hạn kích thước frame (`maxFrameBytes`), backpressure ghi (`maxPendingWrites`), và chặn các prompt elicitation trái phép.
4. **`DefaultMCPServiceManager`** (`src/service-manager.ts`):
   Quản lý vòng đời partition (`ensure`, `inspect`, `release`, `start`, `stop`, `restart`, `status`, `health`), bộ đếm generation, phục hồi crash, và `restartLimit` có giới hạn. Không bao giờ chấm dứt các external worker đã tiếp nhận khi release hoặc stop.
5. **`MCPServiceRegistry`** (`src/registry.ts`):
   Đăng ký các service definition, tính digest cấu hình SHA-256, validate thứ tự đơn điệu của revision, và gắn các profile `MCPBackendSharingPolicy` mặc định hoặc tùy chỉnh.
6. **`GatewayMetricsCollector`** (`src/metrics.ts`):
   Theo dõi các tiến trình đang hoạt động, client session, độ sâu hàng đợi, các lần từ chối do backpressure, các lần chấm dứt do giới hạn tiến trình/bộ nhớ, và các phân vị độ trễ (`minMs`, `maxMs`, `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`).
7. **`GatewaySecretStore` & `security.ts`** (`src/security.ts`):
   Phát hành và xoay vòng bearer token bằng mật mã, validate các header `Host` và `Origin` loopback, tính partition key, và xóa bí mật khỏi nội dung (`Bearer`, `secret://`, `sk-...`, `ghp_...`).

---

## Tổng quan giao thức Streamable HTTP

Đặc tả chi tiết có trong [PROTOCOL.md](PROTOCOL.md).

### Tóm tắt các route

- `POST /mcp`: dispatch JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`, `notifications/cancelled`). Hỗ trợ JSON và Server-Sent Events (`Accept: text/event-stream`).
- `GET /mcp`: kết nối SSE keepalive sống lâu cho client session với `Mcp-Session-Id`.
- `DELETE /mcp`: ngắt kết nối sạch một client session đang hoạt động.
- `GET /health`: health check loopback báo `status: "ok"`.
- `GET /metrics`: snapshot đầy đủ các metric vận hành của gateway.

### Bất biến bảo mật

- **Bearer Token Auth**: Mọi endpoint yêu cầu `Authorization: Bearer <token>`.
- **Session Containment**: Từ chối mọi request cố dùng `Mcp-Session-Id` thuộc về client hoặc project partition khác với `403 Forbidden`.
- **Origin Rejection**: Các origin của trình duyệt (`Origin: https://...` hoặc `Origin: http://localhost:...`) bị từ chối với `403 Forbidden` để ngăn cross-site request forgery từ trình duyệt cục bộ.
- **Host Validation**: Các request có header `Host` không phải loopback bị từ chối với `403 Forbidden`.

---

## Ma trận chính sách chia sẻ và cô lập

Các upstream từ xa (`native_remote_mcp`, `existing_shared_worker`) dùng `HttpUpstreamDriverInstance` (`src/http-upstream.ts`):
Streamable HTTP với response JSON hoặc SSE, `Mcp-Session-Id` tùy chọn, một handshake dùng chung cho mọi caller, retry có giới hạn với
backoff cho các tool mà host khai báo là chỉ đọc (`DefaultMCPServiceManagerOptions.policyOverrides`), lỗi có cấu trúc và
metric `upstreamHttp`. Xem `docs/shared-mcp-architecture.md` để biết các quy tắc.

| Policy Dimension | `stdio_mcp` | `existing_shared_worker` | `native_remote_mcp` | Exclusive / Browser |
|---|---|---|---|---|
| `transportCapabilities` | `stdio: true` | `streamableHttp: true, sse: true` | `streamableHttp: true, sse: true` | Kế thừa kết nối |
| `concurrencyModel` | `multiplexed` | `multiplexed` | `multiplexed` | `exclusive_lease` |
| `sessionIsolationPolicy` | `repository_partition` | `protocol_session` | `protocol_session` | `repository_partition` |
| `sharedStatePolicy` | `partitioned_by_repo` | `stateless` | `stateless` | `mutable_shared_exclusive` |
| `resourceOwnership` | `bflow_managed` | `external_adopted` | `external_remote` | `exclusive_lease_bound` |
| `reconnectBehavior` | `reinitialize_session`| `stateless_retry` | `stateless_retry` | `quarantine_on_disconnect` |

---

## Exclusive Resource Lease và Monotonic Fencing

Với các tool tác động đến trình duyệt hoặc thiết bị/phần cứng độc quyền có trạng thái:
1. Client phải lấy một `MCPResourceLease` qua `gateway.acquireResource()`.
2. Mỗi lease nhận một `fencingToken` tăng đơn điệu.
3. Fencing token lỗi thời, lease hết hạn, hoặc lease thuộc về đăng ký khác bị từ chối trước khi dispatch với `details: { diagnosticCode: "stale_lease" }`.
4. Nếu một lời gọi tool mutating bị timeout hoặc backend crash giữa lời gọi, kết quả lời gọi được gắn cờ `status: "unknown"` và exclusive resource bị quarantine (`diagnosticCode: "resource_quarantined"`).
5. Resource vẫn bị khóa theo kiểu fail-closed cho đến khi được giải quyết qua `gateway.reconcileCall()`. **Các lời gọi tool mutating không bao giờ được tự động phát lại.**

## Grant, input schema và journal phục hồi

Control registration nội bộ có thể gắn `ResolvedToolGrant[]` đã được host xác thực mà không đổi
`MCPClientRegistration`. Gateway kiểm lại role, session scope, tool catalog ID, service ID và
operation trước khi đọc receipt hay gọi upstream. Registration có grant sẽ preflight đúng các
input schema đã thương lượng; thiếu schema, schema mặc định hoặc keyword mà validator chưa hỗ trợ
sẽ chặn registration. Ở runtime, operation còn phải nằm trong `service.tool.operations` và input
được kiểm tra lại ngay trước dispatch. Resource lease phải khớp cả resource key và fencing token.

Khi CLI cấp `callLedgerPath`, Gateway giữ journal riêng theo machine state. Journal version 2 chỉ
lưu call/registration/service/operation IDs, digest request/output, schema pins, trạng thái và
timestamp; query và output body không được ghi vào đây. `intent` được fsync trước side effect;
lock writer kiểm tra lại state mới nhất để ngăn hai Gateway process claim cùng call ID. File và
thư mục phải owner-only, regular, bounded và không phải symlink. Sau restart, kể cả receipt đã
hoàn tất chỉ được trả dưới dạng `unknown` với mã `gateway_response_unavailable_after_restart`,
vì body response không được giữ trong ledger. Call đang dở cũng giữ `unknown`; Gateway không tự
gọi lại upstream. Schema digest được pin theo service revision, cùng revision nhưng khác schema
sẽ block cho tới khi một revision mới được duyệt.

---

## Các lệnh chạy được

Từ thư mục gốc repository:

```bash
# Typecheck
pnpm --filter @bflow/mcp-gateway run typecheck

# Build TypeScript to dist/
pnpm --filter @bflow/mcp-gateway run build

# Run deterministic verification test suite
pnpm --filter @bflow/mcp-gateway run test
```

---

## Ma trận Verification Test Suite

Test suite trong [`test/mcp-gateway.test.ts`](test/mcp-gateway.test.ts) bao phủ các kịch bản kiến trúc cốt lõi sau:

- **Scenario 1**: 10 Concurrent Client kết nối đồng thời mà không xung đột ID hay rò rỉ response.
- **Scenario 2**: Tái sử dụng một Running Backend với việc tạo driver duy nhất (`activeProcessCount === 1`).
- **Scenario 3**: Vòng đời Backend đầy đủ (`start`, `status`, `health`, `restart`, `stop`), thực thi `restartLimit` (`restart_limit_exceeded`), và external worker còn sống sau đó.
- **Scenario 4**: Client Disconnect & Revocation qua `DELETE /mcp` và `gateway.revoke()`.
- **Scenario 5**: Cô lập stdio partition cấp repository, từ chối chia sẻ không được hỗ trợ, và kiểm tra fencing token đơn điệu.
- **Scenario 6**: Timeout hàng đợi trước dispatch (`retrySafety: "not_started"`) so với timeout mutating sau dispatch (`status: "unknown"` và quarantine resource).
- **Scenario 7**: Semaphore concurrency (`maxConcurrency: 2`) và từ chối do backpressure (`maxQueueSize: 3`).
- **Scenario 8**: Bảo vệ chống rò rỉ session, ẩn/từ chối tool trái phép, từ chối `Origin` và `Host`, xóa bí mật, và chặn interactive prompt.
- **Scenario 9**: Xử lý upstream crash (`triggerCrash`), quarantine, và reconciliation sạch (`reconcileCall`).
- **Scenario 10**: Giới hạn `maxProcessCount`, thực thi RSS `maxMemoryBytes`, và các phân vị độ trễ.
- **Scenario 11**: Thực thi schema version 3, thực thi giới hạn kích thước frame, `/health`, `/metrics` và SSE streaming.
