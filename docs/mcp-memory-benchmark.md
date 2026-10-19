# Bflow Platform v3 — Shared MCP Gateway Architecture & Real Linux Memory Benchmark

> **Ghi chú (lịch sử):** Tài liệu này ghi lại bằng chứng đo tại thời điểm đó, trong đó có Claude-Mem. Bflow không còn hỗ trợ Claude-Mem (thay bằng MemPalace cài thủ công); các số liệu và đường dẫn liên quan đến `claude-mem` chỉ còn giá trị lịch sử và không thể tái tạo từ mã hiện tại.

**Tested Baseline Commit**: `7133b02` (`main`, post P24–P33 integration)
**Measurement Timestamp**: `2026-10-17T14:43:39.461Z`
**Host Kernel & OS**: Linux `x86_64` (`/proc/<pid>/status` `VmRSS` & `/proc/<pid>/smaps_rollup` `Pss`)
**Node.js Runtime**: `v24.10.0` (`/home/baodq/.nvm/versions/node/v24.10.0/bin/node`)
**Automated E2E Suite**: [`tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts`](../tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts)

---

## 1. Executive Summary

Bflow Platform v3 ([`@bflow/mcp-gateway`](../packages/mcp-gateway/src/index.ts) and [`@bflow/mcp-services`](../packages/mcp-services/src/index.ts)) replaces per-agent stdio MCP server duplication with a shared `BflowMcpGateway` + `GatewayHttpServer` (`http://127.0.0.1:<port>/mcp`). Multiple concurrent agent sessions across heterogeneous providers (`claude`, `codex`, `agy`) connect to a single shared MCP backend process per repository/machine scope while preserving per-client authentication tokens, capability-scoped tool visibility, exclusive resource leases, automatic crash recovery, and strict cross-project isolation.

Across a **6-agent SDLC session** (`1 Claude` Conversation Agent, `1 Codex` Coordinator Agent, `1 Agy` Reviewer Agent, and `3 Developer` instances across `claude`, `codex`, and `agy`):
- **Process Count Reduction**: **83.33% fewer MCP backend processes** (`1` shared process per service instead of `6` per-agent processes; `2` processes instead of `12` for a 2-service stack).
- **Combined Real Memory Savings (`claude-mem 12.1.3` + `gitnexus 1.6.12`)**:
  - **Shared Gateway (2 backend processes)**: **`195,384 kB` (`190.80 MiB`) RSS** / **`125,266 kB` (`122.33 MiB`) PSS**.
  - **Per-Agent Isolated (12 backend processes)**: **`1,156,344 kB` (`1,129.24 MiB`) RSS** / **`589,283 kB` (`575.47 MiB`) PSS**.
  - **Measured Net Savings**: **`960,960 kB` (`938.44 MiB`, `83.10%`) RSS saved** and **`464,017 kB` (`453.14 MiB`, `78.74%`) PSS saved**.

---

## 2. Benchmark Methodology

All measurements were collected from real OS child processes on Linux using:
- **Resident Set Size (`VmRSS`)**: Parsed directly from `/proc/<pid>/status` (`VmRSS:\s+(\d+)\s+kB`) after full JSON-RPC `initialize` (`protocolVersion: "2024-11-05"`), `notifications/initialized`, `tools/list`, and `tools/call` warm-up across all 6 agent clients.
- **Proportional Set Size (`Pss`)**: Parsed directly from `/proc/<pid>/smaps_rollup` (`Pss:\s+(\d+)\s+kB`), which divides shared pages (such as shared `node` binary text/rodata segments) proportionally across processes, providing an exact physical RAM accounting metric.
- **6-Agent Session Topology**:
  1. `chat-claude-1` (`provider: "claude"`, `role: "conversation"`)
  2. `coord-codex-1` (`provider: "codex"`, `role: "coordinator"`)
  3. `rev-agy-1` (`provider: "agy"`, `role: "reviewer"`)
  4. `dev-claude-1` (`provider: "claude"`, `role: "developer"`)
  5. `dev-codex-2` (`provider: "codex"`, `role: "developer"`)
  6. `dev-agy-3` (`provider: "agy"`, `role: "developer"`)

---

## 3. Measured Memory Comparison: Shared Gateway (1 Backend) vs. Per-Agent Isolated (6 Backends)

### 3.1 Summary Table (6 Concurrent Agents)

| MCP Backend Workload | Architecture | Backend Process Count | Active Client Connections | Total `VmRSS` (`kB`) | Total `VmRSS` (`MiB`) | Total `Pss` (`kB`) | Total `Pss` (`MiB`) | `VmRSS` Saved (`kB` / `%`) | `Pss` Saved (`kB` / `%`) |
| :--- | :--- | :---: | :---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **1. Node.js MCP Server (`shared-code-index`)** | **Shared Gateway** | `1` | `6` | `47,204` | `46.10` | `17,454` | `17.04` | **`220,360 kB` (`82.36%`)** | **`30,916 kB` (`63.92%`)** |
| | Per-Agent Isolated | `6` | `6` | `267,564` | `261.29` | `48,370` | `47.24` | — | — |
| **2. `claude-mem` (`12.1.3` `memory-mcp.js`)** | **Shared Gateway** | `1` | `6` | `77,680` | `75.86` | `46,886` | `45.79` | **`386,696 kB` (`83.27%`)** | **`143,813 kB` (`75.41%`)** |
| | Per-Agent Isolated | `6` | `6` | `464,376` | `453.49` | `190,699` | `186.23` | — | — |
| **3. `gitnexus mcp` (`1.6.12` `dist/cli/index.js mcp`)** | **Shared Gateway** | `1` | `6` | `117,704` | `114.95` | `78,380` | `76.54` | **`574,264 kB` (`82.99%`)** | **`320,204 kB` (`80.34%`)** |
| | Per-Agent Isolated | `6` | `6` | `691,968` | `675.75` | `398,584` | `389.24` | — | — |
| **4. Combined Production Stack (`claude-mem` + `gitnexus`)** | **Shared Gateway** | **`2`** | **`12`** (`6 × 2`) | **`195,384`** | **`190.80`** | **`125,266`** | **`122.33`** | **`960,960 kB` (`83.10%`)** | **`464,017 kB` (`78.74%`)** |
| | Per-Agent Isolated | `12` | `12` (`6 × 2`) | `1,156,344` | `1,129.24` | `589,283` | `575.47` | — | — |

---

### 3.2 Per-Process `/proc` Measurements

#### A. Node.js MCP Server (`shared-code-index`)
- **Shared Gateway Backend (`1` process serving `6` agents via `GatewayHttpServer`)**:
  - `PID 2576309`: `VmRSS = 47,204 kB`, `Pss = 17,454 kB`, `Private_Dirty = 12,188 kB`
- **Per-Agent Isolated Backends (`6` stdio processes)**:
  - Agent 1 (`PID 2576359`): `VmRSS = 44,500 kB`, `Pss = 8,062 kB`
  - Agent 2 (`PID 2576365`): `VmRSS = 44,536 kB`, `Pss = 8,054 kB`
  - Agent 3 (`PID 2576371`): `VmRSS = 44,752 kB`, `Pss = 8,162 kB`
  - Agent 4 (`PID 2576378`): `VmRSS = 44,616 kB`, `Pss = 8,038 kB`
  - Agent 5 (`PID 2576385`): `VmRSS = 44,492 kB`, `Pss = 7,990 kB`
  - Agent 6 (`PID 2576391`): `VmRSS = 44,668 kB`, `Pss = 8,064 kB`
  - **Total (6 isolated)**: `VmRSS = 267,564 kB`, `Pss = 48,370 kB`

#### B. `claude-mem` (`12.1.3` — `/home/baodq/.claude/plugins/cache/thedotmack/claude-mem/12.1.3/scripts/memory-mcp.js`)
- **Shared Backend (`1` process)**:
  - `PID 2576398`: `VmRSS = 77,680 kB`, `Pss = 46,886 kB`, `Private_Dirty = 26,644 kB`
- **Per-Agent Isolated Backends (`6` stdio processes)**:
  - Agent 1 (`PID 2576410`): `VmRSS = 76,656 kB`, `Pss = 31,419 kB`
  - Agent 2 (`PID 2576418`): `VmRSS = 76,696 kB`, `Pss = 31,375 kB`
  - Agent 3 (`PID 2576424`): `VmRSS = 77,900 kB`, `Pss = 32,202 kB`
  - Agent 4 (`PID 2576430`): `VmRSS = 77,744 kB`, `Pss = 32,020 kB`
  - Agent 5 (`PID 2576437`): `VmRSS = 77,676 kB`, `Pss = 31,847 kB`
  - Agent 6 (`PID 2576443`): `VmRSS = 77,704 kB`, `Pss = 31,836 kB`
  - **Total (6 isolated)**: `VmRSS = 464,376 kB`, `Pss = 190,699 kB`

#### C. `gitnexus mcp` (`1.6.12` — `/home/baodq/.nvm/versions/node/v24.10.0/lib/node_modules/gitnexus/dist/cli/index.js mcp`)
- **Shared Backend (`1` process)**:
  - `PID 2576450`: `VmRSS = 117,704 kB`, `Pss = 78,380 kB`, `Private_Dirty = 49,332 kB`
- **Per-Agent Isolated Backends (`6` stdio processes)**:
  - Agent 1 (`PID 2576462`): `VmRSS = 115,344 kB`, `Pss = 66,447 kB`
  - Agent 2 (`PID 2576473`): `VmRSS = 115,528 kB`, `Pss = 66,574 kB`
  - Agent 3 (`PID 2576484`): `VmRSS = 115,076 kB`, `Pss = 66,184 kB`
  - Agent 4 (`PID 2576495`): `VmRSS = 115,340 kB`, `Pss = 66,460 kB`
  - Agent 5 (`PID 2576506`): `VmRSS = 115,436 kB`, `Pss = 66,515 kB`
  - Agent 6 (`PID 2576517`): `VmRSS = 115,244 kB`, `Pss = 66,404 kB`
  - **Total (6 isolated)**: `VmRSS = 691,968 kB`, `Pss = 398,584 kB`

---

## 4. Functional Verification Summary (Group D Requirements)

| Verification Item | Expected | Actual | Status |
| :--- | :--- | :--- | :--- |
| **D1. Multi-Provider & Multi-Developer Agent Topology** | Launch at least 1 `claude`, 1 `codex`, 1 `agy`, and multiple `developer` instances (`3` Developers across `claude`, `codex`, `agy` = `6` agents total). | All `6` agents registered with unique bearer tokens and active sessions on `GatewayHttpServer` (`http://127.0.0.1:<port>/mcp`). | **PASS** |
| **D2. Tool Availability & Capability Filtering** | Each registered client discovers only the tools permitted by its `allowedCapabilities`. | `tools/list` returns `["query_index"]` for read-only roles and `["query_index", "exclusive_index_rebuild"]` for Developer roles granted rebuild capability. | **PASS** |
| **D3. Shared Backend Process & Connection Count** | Exactly `1` shared OS child process serves all `6` concurrent agent connections (`activeClientCount = 6`). | `gateway.getStats()` reported `backendProcessCount: 1`, `activeConnections: 6`, `sharedBackendPids: [2576309]`. | **PASS** |
| **D4. Concurrent Tool Invocation & Exclusive Resource Leases** | All `6` agents invoke `query_index` concurrently against the same backend PID; `exclusive_index_rebuild` serializes access via `ResourceLeaseCoordinator`. | All `6` concurrent `tools/call` responses returned `backendPid: 2576309` (`uniqueBackendPids = [2576309]`). Second concurrent `exclusive_index_rebuild` rejected with `resource_busy` until lease release. | **PASS** |
| **D5. Service Crash & Restart Recovery** | Killing the backend process (`SIGKILL`) triggers automatic respawn on next invocation with incremented `revision`, while preserving client registrations. | After `process.kill(2576309, "SIGKILL")`, next `tools/call` respawned backend (`PID 2576335 !== 2576309`), incremented `revision` from `1` to `2`, and preserved all `6` client registrations. | **PASS** |
| **D6. Cross-Project Isolation** | An agent registered in `repo-beta` cannot invoke or inspect `repo-alpha`'s repository-scoped MCP service (`svc-code-index-alpha`). | `repo-beta` registration for `svc-code-index-alpha` rejected at ingress (`scope_mismatch`); `tools/call` targeting `svc-code-index-alpha` with `repo-beta` token rejected with HTTP `403` (`service_mismatch`). | **PASS** |
