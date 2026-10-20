# Phase P26 (`@bflow/machine-setup`) — Bàn giao tích hợp

## 1. Baseline và danh tính branch

- **Phase**: P26 — Machine Setup Backend (`@bflow/machine-setup`)
- **Baseline Commit**: `15bb288` (gồm P24 `8dbb056` freeze + P25 `15bb288`)
- **Current Head Commit**: `5daea2b` + hoàn thành Task 8
- **Branch**: `agent/machine-setup/p26-setup-backend`
- **Owned Paths đã sửa**: chỉ `packages/machine-setup/**`. Cấu hình gốc, contracts và các package khác không bị động tới.

---

## 2. Các capability và module đã triển khai

1. **Platform Profile & Safe Command Runner (`src/platform.ts`, `src/runner.ts`)**:
   - `detectPlatform(host)`: Resolve OS, kiến trúc, shell (`bash`, `zsh`, `fish`, `sh`, `pwsh`, `cmd`), đường dẫn XDG (`$XDG_CONFIG_HOME/bflow`, `$XDG_DATA_HOME/bflow`, `$XDG_STATE_HOME/bflow`), và suy ra `machineId` ổn định (`m-` + sha256).
   - `NodeCommandRunner`: Thực thi lệnh với `shell: false`, output buffer có giới hạn (1 MiB), kết thúc cả process tree khi timeout, và denylist các binary leo thang đặc quyền (`sudo`, `doas`, `su`, `runas`, `pkexec`).
   - `findExecutable`: Tìm trong các thư mục của PATH và các thư mục cài đặt đã biết, có xác minh executable bit (`X_OK`) và xử lý `PATHEXT` của Windows.

2. **Setup State Store & kiểm soát bảo mật (`src/state-store.ts`)**:
   - `SetupStateStore`: Quản lý thư mục riêng tư (mode `0700`, từ chối symlink và UID của owner khác) và ghi file atomic (mode `0600`, sync trước khi rename).
   - Lấy lock (`acquireLock`): Lockfile atomic có kiểm tra PID và hostname; phát hiện và thay thế các lock cũ (stale) của process đã chết.
   - Backup tự động: Tự động lưu trữ mọi file hiện có trước khi sửa vào `<state>/backups/<timestamp>-<sha8>/<basename>` với index theo dõi append-only.
   - Codec Version 3 nghiêm ngặt: Triển khai lưu trữ có version cho journal (`setup/journal.json`), receipt (`setup/receipts.jsonl`), approval (`setup/approvals/<id>.json`) và change log (`setup/changes.jsonl`). Schema version không biết trả về lỗi `unsupported_version`.

3. **Tool Catalog, Probing & Installer Registry (`src/tools.ts`, `src/installer-registry.ts`, `src/machine-config.ts`)**:
   - Tool catalog cho `node` (>=22.13.0), `pnpm` (chính xác 12.5.1), `git` (>=2.30.0), `herdr` (kiểm tra hiện diện) và các provider CLI (`claude`, `codex`, `agy`).
   - `probeTools`: Phát hiện trạng thái tool (`present`, `missing`, `version_mismatch`, `path_missing`), parse version, và stream digest SHA-256 của binary theo real-path.
   - `ToolInstallerRegistry`: Resolve tool descriptor theo ưu tiên platform; chấp nhận các triển khai `ToolInstaller` được inject.
   - `MachineConfigSchema` (v3 nghiêm ngặt): Validate `<config>/machine.json` và từ chối literal credential thô.

4. **PATH Manager (`src/path-manager.ts`)**:
   - `PathComponent`: Cấu hình các file rc shell của người dùng (`.bashrc`, `.bash_profile`, `.zshrc`, `.profile`, fish conf.d) bằng các managed marker block (`# >>> bflow managed PATH >>>`).
   - Idempotent và an toàn: Giữ nguyên nội dung người dùng hiện có, khử trùng lặp entry thư mục, và sửa các block sai định dạng hoặc trùng lặp.

5. **MCP Config Registry & OS Service Managers (`src/mcp-registry.ts`, `src/service-manager.ts`)**:
   - `McpConfigComponent`: Quản lý `<config>/mcp.json` (v3 nghiêm ngặt), giữ nguyên các entry ngoại lai không được quản lý đồng thời giữ các entry service của bflow đồng bộ.
   - `SystemdUserServiceManager` & `LaunchdServiceManager`: Render và cài đặt một cách xác định các service unit cấp người dùng mà không leo thang đặc quyền OS; gắn secret qua tham chiếu `secret://`.

6. **Doctor, Plan Builder & Approvals (`src/doctor.ts`, `src/plan.ts`, `src/approval.ts`)**:
   - `BuiltinSetupDoctor`: Bộ đánh giá chỉ đọc sinh `MachineDoctorReport` (v3 nghiêm ngặt) trên trạng thái tool, path block, config và service.
   - `buildSetupPlan`: Sinh plan được sắp xếp topo (`MachineSetupPlanSchema`), preview thay đổi, và phát hiện các component đã thỏa.
   - `SetupApprover` & `AssumeYesApprover`: Quản lý approval receipt của operator. Thực thi tường minh rằng `--yes` **không bao giờ** duyệt các bước cần nâng quyền (`requiresElevation: true`).

7. **Plan Executor & Facade Service (`src/executor.ts`, `src/manifest.ts`, `src/setup-service.ts`)**:
   - `executePlan`: Điều phối thực thi plan dưới lock của state store; ghi trạng thái journal trước khi apply; xử lý retry an toàn và đối soát khi bị gián đoạn.
   - `EnvironmentManifestComponent`: Sinh `<state>/environment.json` (v3 nghiêm ngặt) và cập nhật khi cấu hình không biến động thay đổi.
   - `MachineSetupService`: Facade thống nhất cung cấp các mode `check` (không ghi), `dry_run` (không ghi), `apply` (plan, approve, execute, verify) và `repair` (backup tự động, khôi phục config, sửa block, retry bước không rõ).

8. **Bộ kịch bản End-to-End (`test/scenarios.test.ts`)**:
   - 11 kịch bản tích hợp toàn diện xác minh mô phỏng máy sạch, cài một phần, đã cài sẵn, thiếu thư mục PATH, rollback khi cài thất bại, resume và đối soát bước bị gián đoạn, repair mode, chạy lại idempotent, xử lý config không hợp lệ, bảo mật nâng quyền và cô lập secret.

---

## 3. Kết quả validation

Thực thi trong worktree `/Users/quanganh/AI Learning/bflow-p26-setup`:

1. **Dependency Graph & ranh giới package**:
   ```bash
   pnpm check:deps
   # Output: Workspace dependency graph is acyclic (17 packages, 24 internal edges).
   # Leaf package dependency boundaries and non-escaping relative import rules verified.
   # Exit code: 0
   ```

2. **Biên dịch TypeScript**:
   ```bash
   pnpm exec tsc -b packages/machine-setup
   pnpm typecheck
   # Exit code: 0 (clean compilation)
   ```

3. **Bộ test của package**:
   ```bash
   pnpm exec vitest run packages/machine-setup/test
   # Output:
   # Test Files  11 passed (11)
   # Tests       155 passed | 1 skipped (156)  [1 skipped: optional fish test on host without fish]
   # Duration    5.18s
   # Exit code: 0
   ```

---

## 4. Yêu cầu tích hợp cho Integrator / P27 / P28 / P29 / P30

1. **Cấu hình build gốc (`tsconfig.json`)**:
   - Thêm `{ "path": "./packages/machine-setup" }` vào `references` của `tsconfig.json` gốc.
2. **Đồng bộ lockfile (`pnpm-lock.yaml`)**:
   - Cập nhật lockfile của monorepo tại integration gate để workspace dependency `@bflow/machine-setup` được theo dõi.
3. **P28 (Skills & Tool Installers)**:
   - Cung cấp các triển khai `ToolInstaller` cụ thể để đăng ký với `ToolInstallerRegistry`.
   - Cung cấp `SkillsSynchronizer` để inject vào `createSkillsComponent`.
4. **P27 (MCP Gateway)**:
   - Trỏ loader MCP daemon cục bộ để đọc `<config>/mcp.json` do `McpConfigComponent` tạo ra.
5. **P29 (CLI)**:
   - Nối các lệnh `bflow setup` (`--check`, `--dry-run`, `--repair`, `--yes`) để gọi `MachineSetupService.run()`.
6. **P30 (Runtime Host)**:
   - Tích hợp `MachineDoctorReport` và `EnvironmentManifest` vào các preflight readiness của host.
