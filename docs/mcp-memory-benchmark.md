# Bflow Platform v3 — Kiến trúc Shared MCP Gateway & Benchmark bộ nhớ thực trên Linux

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](implementation-status.md) trước khi vận hành hoặc giao việc mới.

**Commit baseline đã kiểm thử**: `7133b02` (`main`, sau tích hợp P24–P33)
**Thời điểm đo**: `2026-10-17T14:43:39.461Z`
**Kernel & OS của host**: Linux `x86_64` (`/proc/<pid>/status` `VmRSS` & `/proc/<pid>/smaps_rollup` `Pss`)
**Node.js Runtime**: `v24.10.0` (`/home/baodq/.nvm/versions/node/v24.10.0/bin/node`)
**Bộ E2E tự động**: [`tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts`](../tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts)

---

## 1. Tóm tắt điều hành

Bflow Platform v3 ([`@bflow/mcp-gateway`](../packages/mcp-gateway/src/index.ts) and [`@bflow/mcp-services`](../packages/mcp-services/src/index.ts)) thay thế việc nhân bản MCP server stdio theo từng agent bằng một `BflowMcpGateway` + `GatewayHttpServer` dùng chung (`http://127.0.0.1:<port>/mcp`). Nhiều agent session đồng thời thuộc các provider khác nhau (`claude`, `codex`, `agy`) kết nối tới một process MCP backend dùng chung cho mỗi phạm vi repository/machine, đồng thời vẫn giữ authentication token theo từng client, khả năng hiển thị tool theo capability, exclusive resource lease, tự động phục hồi khi crash và cách ly nghiêm ngặt giữa các project.

Trên một **SDLC session 6 agent** (`1 Claude` Conversation Agent, `1 Codex` Coordinator Agent, `1 Agy` Reviewer Agent và `3 Developer` instance trải trên `claude`, `codex` và `agy`):
- **Giảm số lượng process**: **ít hơn 83.33% MCP backend process** (`1` process dùng chung cho mỗi service thay vì `6` process theo từng agent).
- **Tiết kiệm bộ nhớ thực (`gitnexus 1.6.12`)**:
  - **Shared Gateway (1 backend process)**: **`117,704 kB` (`114.95 MiB`) RSS** / **`78,380 kB` (`76.54 MiB`) PSS**.
  - **Cô lập theo từng agent (6 backend process)**: **`691,968 kB` (`675.75 MiB`) RSS** / **`398,584 kB` (`389.24 MiB`) PSS**.
  - **Tiết kiệm ròng đã đo**: tiết kiệm **`574,264 kB` (`560.80 MiB`, `82.99%`) RSS** và **`320,204 kB` (`312.70 MiB`, `80.34%`) PSS**.

---

## 2. Phương pháp benchmark

Mọi số đo được thu thập từ các OS child process thật trên Linux bằng:
- **Resident Set Size (`VmRSS`)**: Parse trực tiếp từ `/proc/<pid>/status` (`VmRSS:\s+(\d+)\s+kB`) sau khi warm-up đầy đủ JSON-RPC `initialize` (`protocolVersion: "2024-11-05"`), `notifications/initialized`, `tools/list` và `tools/call` trên cả 6 agent client.
- **Proportional Set Size (`Pss`)**: Parse trực tiếp từ `/proc/<pid>/smaps_rollup` (`Pss:\s+(\d+)\s+kB`), chia các page dùng chung (như segment text/rodata của binary `node` dùng chung) theo tỷ lệ giữa các process, cho một chỉ số kế toán RAM vật lý chính xác.
- **Topology session 6 agent**:
  1. `chat-claude-1` (`provider: "claude"`, `role: "conversation"`)
  2. `coord-codex-1` (`provider: "codex"`, `role: "coordinator"`)
  3. `rev-agy-1` (`provider: "agy"`, `role: "reviewer"`)
  4. `dev-claude-1` (`provider: "claude"`, `role: "developer"`)
  5. `dev-codex-2` (`provider: "codex"`, `role: "developer"`)
  6. `dev-agy-3` (`provider: "agy"`, `role: "developer"`)

---

## 3. So sánh bộ nhớ đã đo: Shared Gateway (1 backend) so với cô lập theo từng agent (6 backend)

### 3.1 Bảng tóm tắt (6 agent đồng thời)

| Workload MCP Backend | Kiến trúc | Số backend process | Số kết nối client đang hoạt động | Total `VmRSS` (`kB`) | Total `VmRSS` (`MiB`) | Total `Pss` (`kB`) | Total `Pss` (`MiB`) | `VmRSS` tiết kiệm (`kB` / `%`) | `Pss` tiết kiệm (`kB` / `%`) |
| :--- | :--- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **1. Node.js MCP Server (`shared-code-index`)** | **Shared Gateway** | `1` | `6` | `47,204` | `46.10` | `17,454` | `17.04` | **`220,360 kB` (`82.36%`)** | **`30,916 kB` (`63.92%`)** |
| | Cô lập theo từng agent | `6` | `6` | `267,564` | `261.29` | `48,370` | `47.24` | — | — |
| **2. `gitnexus mcp` (`1.6.12` `dist/cli/index.js mcp`)** | **Shared Gateway** | `1` | `6` | `117,704` | `114.95` | `78,380` | `76.54` | **`574,264 kB` (`82.99%`)** | **`320,204 kB` (`80.34%`)** |
| | Cô lập theo từng agent | `6` | `6` | `691,968` | `675.75` | `398,584` | `389.24` | — | — |

---

### 3.2 Số đo `/proc` theo từng process

#### A. Node.js MCP Server (`shared-code-index`)
- **Backend của Shared Gateway (`1` process phục vụ `6` agent qua `GatewayHttpServer`)**:
  - `PID 2576309`: `VmRSS = 47,204 kB`, `Pss = 17,454 kB`, `Private_Dirty = 12,188 kB`
- **Backend cô lập theo từng agent (`6` stdio process)**:
  - Agent 1 (`PID 2576359`): `VmRSS = 44,500 kB`, `Pss = 8,062 kB`
  - Agent 2 (`PID 2576365`): `VmRSS = 44,536 kB`, `Pss = 8,054 kB`
  - Agent 3 (`PID 2576371`): `VmRSS = 44,752 kB`, `Pss = 8,162 kB`
  - Agent 4 (`PID 2576378`): `VmRSS = 44,616 kB`, `Pss = 8,038 kB`
  - Agent 5 (`PID 2576385`): `VmRSS = 44,492 kB`, `Pss = 7,990 kB`
  - Agent 6 (`PID 2576391`): `VmRSS = 44,668 kB`, `Pss = 8,064 kB`
  - **Tổng (6 cô lập)**: `VmRSS = 267,564 kB`, `Pss = 48,370 kB`

#### B. `gitnexus mcp` (`1.6.12` — `/home/baodq/.nvm/versions/node/v24.10.0/lib/node_modules/gitnexus/dist/cli/index.js mcp`)
- **Backend dùng chung (`1` process)**:
  - `PID 2576450`: `VmRSS = 117,704 kB`, `Pss = 78,380 kB`, `Private_Dirty = 49,332 kB`
- **Backend cô lập theo từng agent (`6` stdio process)**:
  - Agent 1 (`PID 2576462`): `VmRSS = 115,344 kB`, `Pss = 66,447 kB`
  - Agent 2 (`PID 2576473`): `VmRSS = 115,528 kB`, `Pss = 66,574 kB`
  - Agent 3 (`PID 2576484`): `VmRSS = 115,076 kB`, `Pss = 66,184 kB`
  - Agent 4 (`PID 2576495`): `VmRSS = 115,340 kB`, `Pss = 66,460 kB`
  - Agent 5 (`PID 2576506`): `VmRSS = 115,436 kB`, `Pss = 66,515 kB`
  - Agent 6 (`PID 2576517`): `VmRSS = 115,244 kB`, `Pss = 66,404 kB`
  - **Tổng (6 cô lập)**: `VmRSS = 691,968 kB`, `Pss = 398,584 kB`

---

## 4. Tóm tắt xác minh chức năng (yêu cầu Group D)

| Hạng mục xác minh | Kỳ vọng | Thực tế | Trạng thái |
| :--- | :--- | :--- | :--- |
| **D1. Topology đa provider & đa Developer agent** | Khởi chạy ít nhất 1 `claude`, 1 `codex`, 1 `agy` và nhiều instance `developer` (`3` Developer trải trên `claude`, `codex`, `agy` = tổng `6` agent). | Cả `6` agent được đăng ký với bearer token duy nhất và session đang hoạt động trên `GatewayHttpServer` (`http://127.0.0.1:<port>/mcp`). | **PASS** |
| **D2. Tool khả dụng & lọc theo capability** | Mỗi client đã đăng ký chỉ phát hiện các tool được `allowedCapabilities` của nó cho phép. | `tools/list` trả về `["query_index"]` cho các role chỉ đọc và `["query_index", "exclusive_index_rebuild"]` cho các role Developer được cấp capability rebuild. | **PASS** |
| **D3. Shared backend process & số kết nối** | Đúng `1` OS child process dùng chung phục vụ cả `6` kết nối agent đồng thời (`activeClientCount = 6`). | `gateway.getStats()` báo `backendProcessCount: 1`, `activeConnections: 6`, `sharedBackendPids: [2576309]`. | **PASS** |
| **D4. Gọi tool đồng thời & exclusive resource lease** | Cả `6` agent gọi `query_index` đồng thời tới cùng một backend PID; `exclusive_index_rebuild` tuần tự hóa truy cập qua `ResourceLeaseCoordinator`. | Cả `6` phản hồi `tools/call` đồng thời đều trả `backendPid: 2576309` (`uniqueBackendPids = [2576309]`). `exclusive_index_rebuild` đồng thời thứ hai bị từ chối với `resource_busy` cho đến khi lease được release. | **PASS** |
| **D5. Phục hồi khi service crash & restart** | Kill backend process (`SIGKILL`) kích hoạt tự động respawn ở lần gọi kế tiếp với `revision` tăng, đồng thời giữ nguyên các client registration. | Sau `process.kill(2576309, "SIGKILL")`, `tools/call` kế tiếp đã respawn backend (`PID 2576335 !== 2576309`), tăng `revision` từ `1` lên `2` và giữ nguyên cả `6` client registration. | **PASS** |
| **D6. Cách ly giữa các project** | Một agent đăng ký trong `repo-beta` không thể gọi hay kiểm tra MCP service theo phạm vi repository của `repo-alpha` (`svc-code-index-alpha`). | Đăng ký `repo-beta` cho `svc-code-index-alpha` bị từ chối tại ingress (`scope_mismatch`); `tools/call` nhắm tới `svc-code-index-alpha` với token `repo-beta` bị từ chối với HTTP `403` (`service_mismatch`). | **PASS** |
