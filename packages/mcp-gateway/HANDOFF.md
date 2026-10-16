# Phase P27 (`@bflow/mcp-gateway`) — Integration Handoff

## 1. Baseline & Branch Identity

- **Phase**: P27 — Shared MCP Gateway (`@bflow/mcp-gateway`)
- **Base Commit (P24 Descendant)**: `e058d1636e9c895b633fe8070d1164f02953cf1a` (retaining P24 baseline `8dbb0561adbb41235d481e9800c2cb72eae81658`)
- **Branch**: `agent/mcp-gateway/p27-shared-gateway`
- **Owned Paths Modified**: `packages/mcp-gateway/**` only.

---

## 2. Implemented Capabilities

1. **MCP Service Registry & Sharing Policy Engine (`src/registry.ts`, `src/security.ts`)**:
   - Validates `MCPServiceDefinitionSchema` (`schemaVersion === 3`, rejecting `cli_only` tools and unsupported versions).
   - Binds each service to an explicit `MCPBackendSharingPolicy` (`transportCapabilities`, `concurrencyModel`, `sessionIsolationPolicy`, `sharedStatePolicy`, `resourceOwnership`, `reconnectBehavior`).
   - Enforces safe sharing & partitioning (`computePartitionKey`, `evaluateSharingCompatibility`): never assumes arbitrary `stdio_mcp` backends can be shared machine-wide; isolates stateful stdio services by repository (`repository_partition`) or session (`session_partition` / `single_client_isolated`), and blocks `unsupported` / `unsafe_unshareable` backends without faking capability.
2. **Streamable HTTP Server on Loopback (`src/http-server.ts`)**:
   - Binds to `127.0.0.1` by default, enforcing `Host` loopback validation, `Origin` browser/CSRF rejection (`403 Forbidden`), `maxBodyBytes` payload protection (`413 Payload Too Large`), and scoped Bearer token authentication (`401 Unauthorized`).
   - Serves MCP Streamable HTTP (`POST /mcp` JSON and SSE streaming, `GET /mcp` SSE keepalive with disconnect cleanup, `DELETE /mcp` session termination, `GET /health`, and `GET /metrics`).
   - Enforces strict session containment (`Mcp-Session-Id` ownership check) so Project A agents cannot access Project B sessions or tool state.
3. **Stdio-to-HTTP Bridge (`src/stdio-bridge.ts`)**:
   - Bridges multi-client HTTP/Gateway calls over a single owned `stdio_mcp` subprocess (`SubprocessStdioDriverFactory` + `StdioToHttpBridge`).
   - Verifies canonical executable path (`realpath`), regular file, execute bit, non-group/world-writable mode (`0o022`), SHA-256 `executableDigest`, and sanitized child environment before spawning.
   - Implements newline-delimited JSON-RPC 2.0 framing with UTF-8 `maxFrameBytes` guard, stream `'drain'` backpressure (`maxPendingWrites`), and request-ID remapping (`gw_<gen>_<seq>_<session>`) so 10+ concurrent clients never collide or leak responses.
   - Intercepts and blocks forbidden interactive prompts (`elicitation/*`, `sampling/createMessage`, `oauth/interactive`, `browser/permissionPrompt`) so user decisions must route through Runtime → Herdr → Conversation.
4. **Lifecycle Management & Backend Reuse (`src/service-manager.ts`)**:
   - Implements `DefaultMCPServiceManager` (`ensure`, `inspect`, `release`, `start`, `stop`, `restart`, `status`, `health`).
   - Single-flights concurrent `ensure` requests per partition, reuses healthy running backends (`activeProcessCount === 1`), enforces bounded `restartLimit`, and preserves external workers (`existing_shared_worker`, `native_remote_mcp`) across `release` and `stop`.
   - Protects `bflow`-owned processes from premature idle stop while uncertain (`status: "unknown"`) mutating calls await reconciliation.
5. **Concurrency, Backpressure, Timeouts, Exclusive Leases & Metrics (`src/gateway.ts`, `src/metrics.ts`)**:
   - Implements `BflowSharedMCPGateway` (`register`, `revoke`, `acquireResource`, `renewResource`, `releaseResource`, `call`, `reconcileCall`).
   - Enforces per-partition `maxConcurrency` semaphore and bounded `maxQueueSize` backpressure.
   - Distinguishes pre-dispatch queue timeouts (`retrySafety: "not_started"`) from post-dispatch mutating timeouts/crashes (`status: "unknown"`, call ledger persistence, late response capture, and exclusive resource quarantine until `reconcileCall`).
   - Enforces exclusive resource leases with monotonic `fencingToken` for browser-affecting tools.
   - Tracks real-time process count, Linux RSS memory (`/proc/<pid>/status`), `maxProcessCount` / `maxMemoryBytes` enforcement, and latency percentiles (`minMs`, `maxMs`, `avgMs`, `p50Ms`, `p95Ms`, `p99Ms`).

---

## 3. Workspace Integration & P30 Runtime Composition

1. Root `tsconfig.json` `references`, `pnpm-lock.yaml` importer, and `README.md` include `@bflow/mcp-gateway`, so root `pnpm build`, `pnpm check:deps`, `pnpm typecheck`, and `pnpm test` cover P27.
2. In P30 (`packages/runtime/**`), compose `BflowSharedMCPGateway`, `DefaultMCPServiceManager`, and `StreamableHttpGatewayServer` into the session lifecycle (`ensure` before agent launch, `register` per role, `revoke`/`release` on session `down`).
