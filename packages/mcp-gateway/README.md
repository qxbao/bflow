# @bflow/mcp-gateway

Shared loopback HTTP gateway, stdio-to-HTTP bridge, and resource arbiter for the Model Context Protocol (MCP) in the Bflow Agentic SDLC platform.

## Package Status

- **Platform Version**: Version 3 (`CURRENT_PLATFORM_SCHEMA_VERSION = 3`)
- **Protocol Baseline**: Model Context Protocol Specification `2025-11-25`
- **Package Type**: ESM (`type: module`)
- **Status**: Implemented with deterministic package-local test scenarios (see the matrix below).

## Architectural Purpose & Boundary Invariants

The MCP Gateway provides a high-throughput, multiplexing connection hub for MCP tools. It enables multiple provider agents (`claude`, `codex`, `agy`) running across distinct SDLC roles (`coordinator`, `developer`, `reviewer`, `qa`, `tester`) to connect to shared or isolated MCP services over loopback HTTP or stdio without credential leakage, port exhaustion, or unmanaged process collisions.

> [!IMPORTANT]
> **Tool Connectivity Only**: The MCP Gateway manages tool connections and exclusive tool resources ONLY. It is **NEVER** an inter-role communication transport for `RoleMessage` envelopes. All inter-agent communication must continue to traverse Workflow Runtime and Herdr.

> [!IMPORTANT]
> **No Direct User Elicitation**: All upstream MCP interactive prompt requests (`elicitation/*`, `sampling/*`, `oauth/interactive`) are intercepted and blocked at the gateway boundary. User decisions must be routed exclusively through Workflow Runtime $\to$ Herdr $\to$ Conversation Agent.

---

## Core Components

1. **`BflowSharedMCPGateway`** (`src/gateway.ts`):
   Central arbiter implementing `SharedMCPGateway`. Manages client registrations, bearer tokens, tool authorization scopes, concurrency semaphores, call ledgers, exclusive resource leases with monotonic fencing tokens, and call reconciliation.
2. **`StreamableHttpGatewayServer`** (`src/http-server.ts`):
   Loopback Node.js HTTP/1.1 server serving `POST /mcp`, `GET /mcp` (SSE keepalive), `DELETE /mcp`, `/health`, and `/metrics`. Enforces Host/Origin validation, bearer token authentication, and session containment.
3. **`StdioToHttpBridge`** (`src/stdio-bridge.ts`):
   Bridges gateway calls to upstream subprocess stdio MCP workers over newline-delimited JSON-RPC 2.0. Translates and remaps JSON-RPC IDs to `gw_<gen>_<seq>_<session>`, enforces frame size limits (`maxFrameBytes`), write backpressure (`maxPendingWrites`), and blocks unauthorized elicitation prompts.
4. **`DefaultMCPServiceManager`** (`src/service-manager.ts`):
   Manages partition lifecycles (`ensure`, `inspect`, `release`, `start`, `stop`, `restart`, `status`, `health`), generation counters, crash recovery, and bounded `restartLimit`. Never terminates adopted external workers on release or stop.
5. **`MCPServiceRegistry`** (`src/registry.ts`):
   Registers service definitions, computes SHA-256 configuration digests, validates revision monotonic ordering, and binds default or customized `MCPBackendSharingPolicy` profiles.
6. **`GatewayMetricsCollector`** (`src/metrics.ts`):
   Tracks active processes, client sessions, queue depths, backpressure rejections, process/memory limit terminations, and latency percentiles (`minMs`, `maxMs`, `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`).
7. **`GatewaySecretStore` & `security.ts`** (`src/security.ts`):
   Cryptographically issues and rotates bearer tokens, validates loopback `Host` and `Origin` headers, computes partition keys, and scrubs secrets (`Bearer`, `secret://`, `sk-...`, `ghp_...`).

---

## Streamable HTTP Protocol Overview

Detailed specifications can be found in [PROTOCOL.md](PROTOCOL.md).

### Summary of Routes

- `POST /mcp`: JSON-RPC 2.0 dispatch (`initialize`, `tools/list`, `tools/call`, `ping`, `notifications/initialized`, `notifications/cancelled`). Supports JSON and Server-Sent Events (`Accept: text/event-stream`).
- `GET /mcp`: Long-lived SSE keepalive connection for client sessions with `Mcp-Session-Id`.
- `DELETE /mcp`: Clean disconnect of an active client session.
- `GET /health`: Loopback health check reporting `status: "ok"`.
- `GET /metrics`: Full gateway operational metrics snapshot.

### Security Invariants

- **Bearer Token Auth**: All endpoints require `Authorization: Bearer <token>`.
- **Session Containment**: Rejects any request attempting to use an `Mcp-Session-Id` belonging to another client or project partition with `403 Forbidden`.
- **Origin Rejection**: Browser origins (`Origin: https://...` or `Origin: http://localhost:...`) are rejected with `403 Forbidden` to prevent cross-site request forgery from local browsers.
- **Host Validation**: Requests with non-loopback `Host` headers are rejected with `403 Forbidden`.

---

## Sharing & Isolation Policy Matrix

| Policy Dimension | `stdio_mcp` | `existing_shared_worker` | `native_remote_mcp` | Exclusive / Browser |
|---|---|---|---|---|
| `transportCapabilities` | `stdio: true` | `streamableHttp: true, sse: true` | `streamableHttp: true, sse: true` | Inherits connection |
| `concurrencyModel` | `multiplexed` | `multiplexed` | `multiplexed` | `exclusive_lease` |
| `sessionIsolationPolicy` | `repository_partition` | `protocol_session` | `protocol_session` | `repository_partition` |
| `sharedStatePolicy` | `partitioned_by_repo` | `stateless` | `stateless` | `mutable_shared_exclusive` |
| `resourceOwnership` | `bflow_managed` | `external_adopted` | `external_remote` | `exclusive_lease_bound` |
| `reconnectBehavior` | `reinitialize_session`| `stateless_retry` | `stateless_retry` | `quarantine_on_disconnect` |

---

## Exclusive Resource Leases & Monotonic Fencing

For browser-affecting tools or stateful exclusive hardware/devices:
1. Client must acquire an `MCPResourceLease` via `gateway.acquireResource()`.
2. Each lease receives a monotonically increasing `fencingToken`.
3. Stale fencing tokens, expired leases, or leases belonging to other registrations are rejected pre-dispatch with `details: { diagnosticCode: "stale_lease" }`.
4. If a mutating tool call times out or the backend crashes mid-call, the call outcome is flagged as `status: "unknown"` and the exclusive resource is quarantined (`diagnosticCode: "resource_quarantined"`).
5. The resource remains locked fail-closed until resolved via `gateway.reconcileCall()`. **Mutating tool calls are never automatically replayed.**

---

## Runnable Commands

From repository root:

```bash
# Typecheck
pnpm --filter @bflow/mcp-gateway run typecheck

# Build TypeScript to dist/
pnpm --filter @bflow/mcp-gateway run build

# Run deterministic verification test suite
pnpm --filter @bflow/mcp-gateway run test
```

---

## Verification Test Suite Matrix

The test suite in [`test/mcp-gateway.test.ts`](test/mcp-gateway.test.ts) covers the following core architecture scenarios:

- **Scenario 1**: 10 Concurrent Clients Connecting Simultaneously without ID collision or response leakage.
- **Scenario 2**: Reusing a Running Backend with single driver creation (`activeProcessCount === 1`).
- **Scenario 3**: Full Backend Lifecycle (`start`, `status`, `health`, `restart`, `stop`), `restartLimit` enforcement (`restart_limit_exceeded`), and external worker survival.
- **Scenario 4**: Client Disconnect & Revocation via `DELETE /mcp` and `gateway.revoke()`.
- **Scenario 5**: Repository-level stdio partition isolation, unsupported sharing rejection, and monotonic fencing token checks.
- **Scenario 6**: Pre-dispatch queue timeout (`retrySafety: "not_started"`) vs post-dispatch mutating timeout (`status: "unknown"` and resource quarantine).
- **Scenario 7**: Concurrency semaphore (`maxConcurrency: 2`) and backpressure rejection (`maxQueueSize: 3`).
- **Scenario 8**: Session leakage protection, unauthorized tool hiding/rejection, `Origin` and `Host` rejection, secret scrubbing, and interactive prompt blocking.
- **Scenario 9**: Upstream crash handling (`triggerCrash`), quarantine, and clean reconciliation (`reconcileCall`).
- **Scenario 10**: `maxProcessCount` limits, `maxMemoryBytes` RSS enforcement, and latency percentiles.
- **Scenario 11**: Schema version 3 enforcement, frame size limit enforcement, `/health`, `/metrics`, and SSE streaming.
