# Phase P25 (`@bflow/agent-providers`) — Review code và bảo mật của Argon

## 1. Phạm vi review và workflow

- **Workflow**: Plan (Argon) → Implement (Flash subagent `144eefc9-ce1f-4561-a90e-53220d987e0b`) → Review, Harden và Verify (Argon).
- **Baseline đã review**: Commit `8dbb0561adbb41235d481e9800c2cb72eae81658` (`feat(p24): freeze platform v3 runtime architecture and contracts`).
- **Owned Paths**: `packages/agent-providers/**` trên branch `agent/agent-providers/p25-adapters`.

---

## 2. Phát hiện của Argon và các khắc phục

| ID | Mức độ | Khu vực | Phát hiện trong bản triển khai Flash ban đầu | Khắc phục Argon đã áp dụng |
| --- | --- | --- | --- | --- |
| **R25-01** | High | Binary Discovery & Trust (`src/attestation.ts`, `src/base-adapter.ts`) | `BaseProviderAdapter` gọi `computeFileSha256(executable)` trực tiếp trên tên executable trần (`"claude"`, `"codex"`, `"agy"`) mà không resolve `PATH`, canonicalize, xác minh execute bit hay từ chối group/world-writable. | Triển khai và nối `resolveAndVerifyExecutable`: resolve binary trần qua `PATH`, resolve `realpath`, xác minh regular file (`O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK`), bắt buộc execute bit `(mode & 0o111) !== 0`, từ chối binary group/world-writable `(mode & 0o022) !== 0`, kiểm tra owner UID (`0` hoặc `process.getuid()`), và đặt `AgentLaunchProfile.executable` thành `canonicalPath`. |
| **R25-02** | High | Thực thi cờ Capability (`src/permissions.ts`, `src/*-adapter.ts`) | Các permission compiler phát ra cờ CLI (`--restricted`, `--sandbox`, `--ask-for-approval`, `--mode`, `--add-dir`) mà không xác minh sự hiện diện của chúng trong `capabilities.supportedFlags` được parse từ `--help`. | Cập nhật `compileClaudePermissions`, `compileCodexPermissions`, `compileAgyPermissions` và `compileArgv` của adapter để xác minh mọi cờ bắt buộc với `capabilities.supportedFlags` và thất bại với `code: "invalid_flag"` khi thiếu bất kỳ cờ bắt buộc nào. |
| **R25-03** | Medium | Phân biệt Provider của Fake Runner (`src/runner.ts`, `src/base-adapter.ts`) | Khi `executablePath` trỏ tới đường dẫn mock binary chung (ví dụ `/tmp/.../mock-binary`), `createFakeProviderRunner` fallback về `"claude"` cho các lời gọi `--version` và `--help`. Ngoài ra `minimumVersion` mặc định là `"1.0.0"` cho mọi provider thay vì mức tối thiểu riêng của từng provider. | Truyền `env: { BFLOW_PROVIDER: this.descriptor.provider }` trong các lời gọi runner của adapter, cập nhật `createFakeProviderRunner` ưu tiên `BFLOW_PROVIDER` và các subcommand, và đặt `DEFAULT_MIN_VERSIONS` (`claude: "2.0.0"`, `codex: "0.150.0"`, `agy: "1.0.0"`). |
| **R25-04** | High | Độ chính xác cờ & Settings của Antigravity CLI (`agy`) (`src/agy-adapter.ts`, `src/permissions.ts`, `src/base-adapter.ts`) | `AgyProviderAdapter.compileArgv` luôn nối thêm `--mcp-config`, vốn không phải cờ đã được xác minh trong `--help` của `agy` 1.4.0, và `prepareLaunch` không ghi `permissions.allow` / `workspaceTrust` vào `<role>.settings.json`. | Gỡ `--mcp-config` vô điều kiện khỏi `AgyProviderAdapter.compileArgv` (chỉ truyền nếu phát hiện trong `supportedFlags`), và ghi `permissions.allow`, `permissions.deny`, `workspaceTrust`, `systemPromptFile` và `mcpConfigFile` vào `<role>.settings.json` cục bộ theo launch của Agy. |
| **R25-05** | Medium | Phát hiện Bypass & tách biệt Approval/Sandbox (`src/permissions.ts`) | Cần báo cáo tường minh `detectsDangerouslySkipPermissions` và guard tường minh chống `allowGlobalPermissionBypass`. | Thêm `detectsDangerouslySkipPermissions` vào `CompiledPermissionResult`, từ chối `allowGlobalPermissionBypass: true`, và xác minh `--ask-for-approval never` của Codex tách biệt hoàn toàn với `--sandbox read-only\|workspace-write`. |
| **R25-06** | Medium | Validate MCP & SkillManifest (`src/base-adapter.ts`) | `checkHealth` chỉ kiểm tra sự hiện diện của `serviceIds` cho MCP và sự bằng nhau của `digest` cho `SkillManifest`. | Thêm validate đầy đủ `MCPClientRegistrationSchema` và `MCPServiceObservationSchema` (kiểm tra scope provider/role/session, expiration, transport được hỗ trợ và service `status === "ready"`), cùng validate `SkillManifestSchema` và khớp role. |
| **R25-07** | Medium | Attestation giai đoạn Activated & Live Observation (`src/base-adapter.ts`, `src/attestation.ts`) | Giai đoạn `activated` không kiểm tra `launchProfile.expiresAt`, `liveObservation.paneId === launchAttestation.paneId`, tính nhất quán của `liveObservation.nativeSession`, hay việc giữ nguyên mode `0o600` của file config trên đĩa. | Thêm kiểm tra `launchProfile.expiresAt`, khớp environment/fingerprint, giữ nguyên mode `0o600` và digest SHA-256 của file config, khớp `paneId` và khớp `nativeSession`. |

---

## 3. Các invariant bảo mật và contract đã xác minh

1. **Không tự đăng nhập hay sửa credential**: Adapter không bao giờ gọi `login`, `setup-token` hay ghi credential thay cho người dùng.
2. **Không rò rỉ secret**: `validateProviderEnvironment`, `buildHerdrAgentStartCommand` và `scrubDiagnosticText` ngăn token thô (`sk-*`, `Bearer *`, `AIza*`, `ghp_*`), URI `secret://` hoặc email xuất hiện trong `environmentVariables`, `argv` hay chẩn đoán health.
3. **Readiness != Process đang chạy**: Một process đang chạy với `transportState: "starting" | "blocked"` hoặc `interactiveReady: false` không đạt readiness `activated` (`status: "blocked"`).
4. **Ranh giới sở hữu nghiêm ngặt**: Chỉ các file dưới `packages/agent-providers/**` được tạo hoặc sửa.
