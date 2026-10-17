# Phase P27 (`@bflow/mcp-services`) — Integration Handoff

## 1. Baseline & Ownership

- **Phase**: P27 — OS Services, Resource Management & Dedicated Browser Runtime (`@bflow/mcp-services`)
- **Owned Paths**: `packages/mcp-services/**`

---

## 2. Implemented Capabilities

1. **OS Service Manager (`src/os-service-manager.ts`, `services/**`)**:
   - Supports Linux (`systemd --user`), macOS (`launchd` user agent in `gui/<uid>`), and Windows (`schtasks` user logon with explicit verification gate `windowsVerified`).
   - Implements full lifecycle commands: `install`, `start`, `stop`, `restart`, `enableOnLogin`, `disableOnLogin`, `status`, `logs`, `healthCheck`, `repair`, `recoverIfDead`, and `simulateUserLogin`.
   - Enforces non-root execution (`validateNoRootCommand`, denylisting `sudo`, `su`, `doas`, `pkexec`, `runas`), atomic unit file writes (`writeFileAtomic`), unowned unit file protection (`unowned_unit_file`), and loopback-only health checks (`127.0.0.1`, `localhost`, `[::1]`).
2. **Backend Resource & Lifecycle Manager (`src/resource-manager.ts`)**:
   - Implements `MCPServiceManager` (`ensure`, `inspect`, `release`) from `@bflow/contracts` with boundary validation via `MCPServiceObservationSchema.parse`.
   - Supports user-session initialization (`initializeUserSession`) where `eager` backends start immediately and heavy `lazy` backends (`chrome-devtools-mcp`, `gitnexus`, etc.) remain unstarted (`0` processes, `0 B` RAM) until first tool demand.
   - Multiplexes concurrent agents (`claude`, `codex`, `agy`) onto a single shared backend per partition (`activeProcessCount === 1`) with single-flight startup and `maxConcurrentClients` enforcement.
   - Protects active clients (`retained_active_clients`), in-flight calls (`retained_active_calls`), uncertain mutations (`retained_for_reconciliation`), multi-scope attachments (`retained_attached_scopes`), and adopted `external` workers from premature termination.
   - Implements idle grace window (`idleTimeoutMs`) with warm instance reuse, periodic `sweepIdleBackends()`, process count limits (`maxProcessCount`), and Linux RSS memory monitoring (`sampleMemoryUsage()`).
3. **Dedicated Browser Runtime (`src/browser-runtime.ts`, `src/os-paths.ts`)**:
   - Resolves OS-standard user data directories outside all Git repositories (`repository_profile_forbidden`) and strictly isolated from personal Chrome profiles (`personal_profile_forbidden`).
   - Enforces exclusive profile locks (`.bflow-profile.lock` and Chrome `SingletonLock`), automatically recovering from stale dead-PID locks after crashes.
   - Binds Chrome DevTools debugging endpoints strictly to loopback (`127.0.0.1`), probes Chrome executable availability (`chrome_binary_missing`) and debugging port readiness (`debugging_endpoint_inaccessible`), and supports automatic crash reconnection (`reconnectAfterCrash`).
   - Enforces strict page ownership by `(registrationId, runId, taskId, scope)` across `openPage`, `navigatePage`, `getPageContent`, `setPageContent`, `getCookies`, `setCookies`, `listPages`, and `closePage` (`page_ownership_conflict`), isolating sessions via per-task `browserContextId` or falling back to separate Chrome processes/profiles per task when browser contexts are unsupported.
   - Cleans up task pages, contexts, and dedicated instances on task completion (`cleanupTask`).
