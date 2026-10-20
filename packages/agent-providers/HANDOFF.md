# Phase P25 (`@bflow/agent-providers`) — Bàn giao tích hợp

## 1. Baseline và danh tính branch

- **Phase**: P25 — Provider Adapters (`@bflow/agent-providers`)
- **Base Commit (P24)**: `8dbb0561adbb41235d481e9800c2cb72eae81658` (`feat(p24): freeze platform v3 runtime architecture and contracts`)
- **Branch**: `agent/agent-providers/p25-adapters`
- **Owned Paths đã sửa**: chỉ `packages/agent-providers/**`.

---

## 2. Các capability đã triển khai

1. **Provider Registry (`src/registry.ts`)**:
   - `AgentProviderRegistry` và `createDefaultProviderRegistry` hỗ trợ `claude`, `codex` và `agy`.
   - Validate ingress `schemaVersion === 3` (lỗi `unsupported_version` khi không khớp) và validate bằng Zod schema.
2. **Binary Discovery, Canonicalization và Attestation (`src/attestation.ts`)**:
   - `resolveAndVerifyExecutable` resolve executable qua `PATH` hoặc đường dẫn tường minh, xác minh là regular file, execute bit, các bit không-ghi `0o022`, owner UID và digest SHA-256.
   - `createSignedLaunchAttestation` và `verifyLaunchAttestation` triển khai ký/xác minh Ed25519 trên `"bflow.agent-launch-attestation.v3\n" + canonicalReceiptJson(body)`.
3. **Authentication và Minimal Readiness Probe (`src/base-adapter.ts`, `src/*-adapter.ts`)**:
   - `claude`: `claude auth status --json` + `claude --print --permission-mode dontAsk [--model <m>] ping`
   - `codex`: `codex login status` + `codex exec [--model <m>] ping`
   - `agy`: `agy models` + `agy --print [--model <m>] ping`
4. **Capability Detection và Permission Modes (`src/permissions.ts`)**:
   - Parse output `--version` và `--help` để phát hiện động các cờ và subcommand được hỗ trợ.
   - Biên dịch các mode `restricted`, `workspace_auto` và `unattended_isolated` cho `claude`, `codex` và `agy`.
   - Bắt buộc xác minh OS sandbox (`/usr/bin/bwrap`) cho `unattended_isolated` với `claude`/`codex`, và báo `agy_unattended_unsupported` (`status: "unsupported"`) cho `agy`.
5. **Environment Builder và Herdr Command Builder (`src/environment.ts`, `src/herdr-command.ts`)**:
   - `validateProviderEnvironment` và `buildProviderEnvironment` dựng môi trường session cô lập (`PATH`, `HOME`, `XDG_*`, `BHOME`, `BFLOW_*`, map endpoint MCP, đường dẫn workspace/worktree và các thư mục cấu hình riêng của provider).
   - `buildHerdrAgentStartCommand` sinh `herdr agent start <name> --kind <provider> --pane <paneId> [--timeout <ms>] -- <argv...>`.
6. **Fake Provider Runner và bộ test toàn diện (`src/runner.ts`, `test/agent-providers.test.ts`)**:
   - 32 test bao phủ cả 3 provider, cả 8 kịch bản lỗi (`missing binary`, `outdated version`, `auth expired`, `permission denied`, `invalid flag`, `environment missing`, `incompatible model`, `agent blocked`), startup attestation Ed25519 và các kiểm tra hardening của Argon.

---

## 3. Đề xuất wiring tích hợp cho P30 / Integrator

Theo `AGENTS.md`, leaf package không sửa `tsconfig.json` gốc, `pnpm-lock.yaml` hay `packages/pane-manager/**`. Trong integration gate P25–P28 và wiring P30:
1. Thêm `{ "path": "./packages/agent-providers" }` vào `references` của `tsconfig.json` gốc.
2. Cập nhật `pnpm-lock.yaml` tại integration gate để các workspace dependency của `@bflow/agent-providers` được khóa.
3. Ở P30 (`packages/runtime/**`, `packages/pane-manager/**`), thay các lời gọi `buildProviderStartArguments` cũ bằng `AgentProviderRegistry.checkHealth` (`preflight` trước khi launch, `activated` sau startup receipt) và `AgentProviderRegistry.prepareLaunch` + `buildHerdrAgentStartCommand`.
