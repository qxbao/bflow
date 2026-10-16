# Phase P27 (`@bflow/mcp-gateway`) — Argon Code, Protocol & Security Review

## 1. Review Scope & Workflow

- **Workflow**: Plan (Argon) → Implement (Flash subagents `2a6693a6-1250-44b1-89c9-e86a92cd9e98`, `a1a838ab-7e41-4af7-81db-2f88b375dfa0`, `25470f7b-7420-4822-ab34-d77bfd74c8e5`) → Review (Argon) → Fix (Flash subagent `88faf3b5-03f1-4088-b484-270c801e1aa0`) → Final Acceptance (Argon).
- **Reviewed Baseline**: Branch `agent/mcp-gateway/p27-shared-gateway` (descendant of P24 baseline `8dbb0561adbb41235d481e9800c2cb72eae81658`).
- **Owned Paths**: `packages/mcp-gateway/**`.

---

## 2. Argon Review Findings & Flash Fix Remediations

| ID | Severity | Area | Finding in Initial Flash Implementation | Flash Remediation Applied & Verified |
| --- | --- | --- | --- | --- |
| **R27-01** | High | Uncertainty & Reconciliation (`src/stdio-bridge.ts`, `src/gateway.ts`, `src/metrics.ts`) | 1. In `StdioToHttpBridge.callTool`, when `sendJsonRpcRequest` failed with timeout or crash (`!res.ok`), it unconditionally set `reconcileLedger` to `{ status: "failed" }`, overwriting `{ status: "unknown" }` from `triggerCrash` and falsely marking timed-out in-flight calls as `"failed"`.<br>2. Late JSON-RPC responses arriving after client timeout were dropped because `pendingRequests` deleted `upstreamId`.<br>3. `interactive_prompt_blocked` was treated as an uncertain mutating failure instead of returning the deterministic `validation` error.<br>4. Post-dispatch mutating timeouts/cancellations only incremented `unknownToolCalls`. | **FIXED**: Tracked `dispatched` state in `StdioToHttpBridge` to preserve `{ status: "unknown" }` after write and `{ status: "not_delivered" }` before write; added `timedOutUpstreamRequests` map so late responses update `reconcileLedger` for `reconcileCall`; propagated `interactive_prompt_blocked` directly as `err(upstreamRes.error)` with `interactive.blocked` audit entry; recorded `timedOutToolCalls` / `cancelledToolCalls` via `recordMutatingTimeoutOrCancel`. |
| **R27-02** | High | Trust Scope Authority & Lease Fencing (`src/gateway.ts`) | 1. In `BflowSharedMCPGateway.revoke`, `isTrustScopeWithin(operation.scope, reg.scope)` inverted `candidate` and `authority`, preventing a repository- or machine-scoped operator from revoking a child session registration.<br>2. `releaseResource` did not verify caller scope containment, did not reject releasing a quarantined resource, and ignored stale `fencingToken` mismatches. | **FIXED**: Updated `revoke` to `isTrustScopeWithin(reg.scope, operation.scope)`; enforced scope containment, quarantine rejection (`resource_quarantined`), and stale lease/fence rejection (`stale_lease`) in `releaseResource`. |
| **R27-03** | High | Active Client Tracking, `single_client_isolated` & Idle Release Guard (`src/gateway.ts`, `src/service-manager.ts`) | 1. `BflowSharedMCPGateway` did not call `serviceManager.attachClient`/`detachClient`, leaving `activeClientCount` at `0` and bypassing `single_client_isolated` multi-client checks.<br>2. `DefaultMCPServiceManager.release` stopped idle `bflow`-owned processes without checking if uncertain (`status === "unknown"`) calls remained on that partition. | **FIXED**: Wired `attachClient` and `detachClient` across registration, session open/disconnect, revocation, and tool calls; enforced `single_client_isolated` conflict (`single_client_limit`); added `setHasUncertainCallsCheck` so `release` retains processes with unresolved `unknown` calls (`retained_for_reconciliation`). |
| **R27-04** | Medium | Stdio Framing, Drain Backpressure, MCP Cancellation & Subprocess Isolation (`src/stdio-bridge.ts`) | 1. `maxFrameBytes` checked UTF-16 `.length` instead of `Buffer.byteLength`.<br>2. `writeRaw` did not wait for Node stream `'drain'` when `stdin.write(...)` returned `false`.<br>3. `sendCancelNotification` sent `"$/cancelRequest"` instead of MCP standard `"notifications/cancelled"`.<br>4. `SubprocessStdioDriverFactory` copied raw `process.env` into child processes and did not check `realpath`, regular file, execute bit, and non-group/world-writable mode (`0o022`). | **FIXED**: Used `Buffer.byteLength(..., "utf8")` for `maxFrameBytes`; awaited `'drain'` when `stdin.write` returned `false`; sent `"notifications/cancelled"`; verified `realpath`, regular file, execute bit, `(mode & 0o022) === 0`, and SHA-256 digest; sanitized child environment variables and verified all `secretStore` bindings. |
| **R27-05** | Medium | HTTP Body Limit & Redirect/SSRF Protection (`src/http-server.ts`, `src/service-manager.ts`) | 1. `StreamableHttpGatewayServer.readRequestBody` buffered request bodies without a byte limit.<br>2. `HttpUpstreamDriverInstance.postJsonRpc` allowed default HTTP redirects. | **FIXED**: Enforced `maxBodyBytes` (default 4MB, returning HTTP `413 Payload Too Large`) in `readRequestBody` and set `redirect: "error"` in `HttpUpstreamDriverInstance.postJsonRpc`. |
| **R27-06** | Medium | Verification Coverage (`test/mcp-gateway.test.ts`) | Scenario 9 relied on the R27-01 bug where `reconcileCall` immediately returned `"failed"` after crash. Needed regression tests for R27-01 through R27-05 including real child process `stdio_mcp`. | **FIXED**: Updated Scenario 9 to verify two-stage reconciliation (`"unknown"` while unresolved, then `"failed"` after `"not_delivered"` proof) and added Scenario 12 with 4 regression tests including a real spawned Node subprocess serving 10 concurrent clients (29/29 tests passing). |

---

## 3. Final Argon Acceptance Verdict

- **Status**: **ACCEPTED (PASS)**
- **Verification Gates**:
  - `pnpm check:deps` — PASS (17 packages, 24 internal edges, leaf package boundaries verified)
  - `pnpm --filter @bflow/mcp-gateway run typecheck` — PASS (0 errors)
  - `pnpm --filter @bflow/mcp-gateway run test` — PASS (29/29 tests passing across 12 scenario suites)
  - `pnpm typecheck` & `pnpm test` — PASS
  - `git diff --check` & `git status --short` — PASS (strictly confined to `packages/mcp-gateway/**`)
