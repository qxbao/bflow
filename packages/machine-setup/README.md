# @bflow/machine-setup

`@bflow/machine-setup` triển khai **Machine Setup Backend** (Phase P26 của Bflow Platform v3).
Package cung cấp execution engine và setup service facade để kiểm tra, lập plan, duyệt, áp dụng và sửa chữa môi trường máy host trên Linux và macOS.

Package này được `apps/cli` sử dụng để điều khiển:
- `bflow setup`: Setup đầy đủ (observe → plan → approve → apply → doctor kiểm tra sau).
- `bflow setup --check`: Quan sát không ghi và machine doctor check.
- `bflow setup --dry-run`: Sinh plan và preview thay đổi dễ đọc cho người, không ghi gì.
- `bflow setup --repair`: Lập plan và sửa config do bflow sở hữu bị sai định dạng (`.bashrc`, `mcp.json`), đối soát hoặc retry các bước journal bị gián đoạn/không rõ.
- `bflow setup --yes`: Tự động duyệt các bước không cần nâng quyền đã có trong plan.

## Input setup đã resolve và managed command

`MachineSetupService` nhận `platform` đã resolve (tùy chọn) và `config` đã được validate bằng schema.
Platform kiểm soát mọi đường dẫn setup, gồm cả các root cô lập. Machine configuration hiện có không hợp lệ
vẫn chặn apply và yêu cầu repair. Việc áp dụng manifest đã duyệt lưu lại
cấu hình đã resolve vào `<config>/machine.json`, backup file hợp lệ nếu có thay đổi;
check và dry-run vẫn chỉ đọc.

Tùy chọn `launcher: { nodeBinary, entrypoint }` cài một wrapper `bflow` POSIX do bflow sở hữu vào
`managedBin` như một phần của bước PATH đã duyệt. Khi `~/.local/bin` đã nằm trên PATH hiện tại,
setup cũng đặt wrapper vào đó để dùng ngay ở các thư mục khác. File hiện có không thuộc sở hữu,
symlink và launcher của UID khác được giữ nguyên. Nội dung và mode của launcher
tham gia vào các kiểm tra read-back và idempotency. Nếu không, setup báo file shell nào
cần reload, hoặc yêu cầu người dùng mở terminal khác.

Các tool pin đã cấu hình là các quan sát bắt buộc. Các executable archive và npm được quản lý
được probe dưới `<data>/tools/<toolId>` và thư mục `node_modules/.bin` của nó. Báo cáo cuối
làm mới các quan sát sau khi cài đặt. Một tool nằm ngoài PATH của process chỉ khỏe mạnh
khi managed shell block thực tế bao phủ thư mục của nó; báo cáo giữ `path_missing`
và cảnh báo reload shell. Native plugin không có executable CLI tổng hợp: caller có thể
cung cấp `additionalToolObservations(platform, config)` cho các native probe chỉ đọc đã được validate.
Các pin bắt buộc không được hỗ trợ vẫn hiển thị và không khỏe mạnh.

Việc cấu hình component độc lập tiếp tục sau các lỗi installer không liên quan. Service
yêu cầu bước cấu hình MCP thực tế trong plan thành công trước khi kích hoạt. Các MCP component đã thỏa hoặc
vắng mặt không thêm dependency. Khi cấu hình MCP không thể quan sát hoặc lập plan,
hoặc cần repair ngoài repair mode, service bị loại khỏi plan và doctor báo
lỗi lập plan. Manifest giữ các dependency tiền nhiệm của nó; tiền nhiệm thất bại hoặc không rõ sẽ chặn nó.
Doctor vẫn chạy và các lỗi lập plan vẫn là health check thất bại.

Environment manifest đã lưu gán nhãn inventory `tools` gốc, được approval bao phủ, là
`toolsSnapshotPhase: "before_setup"`. Một snapshot `afterSetupTools` bổ sung chứa kết quả probe
thực tế sau cấu hình, thời điểm quan sát, phase `after_setup` tường minh và checksum đã validate riêng của nó.
Nó được lấy mẫu bên trong bước apply manifest đã duyệt sau các bước tiền nhiệm
và trước doctor cuối. Các trường theo plan gốc giữ nguyên phạm vi digest ngữ nghĩa;
quan sát bổ sung là bằng chứng mô tả và không xác lập thành công của workflow.
Check và dry-run không bao giờ làm mới nó hay ghi manifest; setup đã thỏa lặp lại giữ
thời điểm quan sát bất biến trước đó.

Các test cài đặt và
native-probe dùng fixture có kiểm soát; các test shell của launcher thực thi Bash và
Node thật trong home tạm. Các test này không xác lập acceptance provider thật hay SDLC đầy đủ.

---

## Ranh giới kiến trúc và quyền sở hữu

Theo [AGENTS.md](../../AGENTS.md) và [docs/runtime-architecture-v3.md](../../docs/runtime-architecture-v3.md):
- **Owned Scope**: chỉ `packages/machine-setup/**`.
- **Không có CLI Parser**: P29 (`apps/cli/**`) sở hữu việc parse argument CLI và giao diện terminal. `@bflow/machine-setup` export các mode của `MachineSetupService`.
- **Không có Tool Installer cụ thể**: Các installer của package manager riêng lẻ (`npm`, `homebrew`, `verified_archive`, v.v.) thuộc P26 `@bflow/tool-installer` / các triển khai installer. `@bflow/machine-setup` cung cấp `ToolInstallerRegistry` để nhận các triển khai contract được inject.
- **Ranh giới schema Version 3 nghiêm ngặt**: Mọi tài liệu trao đổi (machine config, environment manifest, journal, approvals, doctor report) được validate theo Zod schema nghiêm ngặt với `schemaVersion: 3`. Version không được hỗ trợ trả về lỗi `unsupported_version` (`supportedVersions: [3]`).

---

## Ngữ nghĩa các Mode

| Mode | Cho phép ghi? | Gọi Approver? | Chạy Doctor? | Mục đích |
|---|---|---|---|---|
| `check` | **Không ghi** (store chỉ đọc) | Không | Có (chỉ đọc) | Đánh giá sức khỏe máy hiện tại và trạng thái cấu hình. |
| `dry_run` | **Không ghi** (store chỉ đọc) | Không | Có | Sinh plan và preview dạng văn bản mà không có side effect. |
| `apply` | Ghi vào state & config do bflow sở hữu | Có (hoặc `AssumeYesApprover`) | Có (trước & sau) | Áp dụng thay đổi theo plan một cách idempotent, có rollback & backup. |
| `repair` | Ghi vào state & config do bflow sở hữu | Có (hoặc `AssumeYesApprover`) | Có (trước & sau) | Backup & khôi phục config sai định dạng, sửa block hỏng, retry các bước không rõ. |

---

## Các invariant về an toàn và bảo mật

1. **Không leo thang đặc quyền OS**:
   - `sudo`, `doas`, `su`, `runas`, `pkexec` bị denylist nghiêm ngặt khỏi `CommandRunner`.
   - Tool descriptor đánh dấu `requiresElevation: true` được lập plan dưới dạng hướng dẫn thủ công.
   - `--yes` (`AssumeYesApprover`) **không bao giờ** duyệt các bước nâng quyền.
2. **Quyền file riêng tư & ghi atomic**:
   - Thư mục state của Bflow được tạo `0700`, file `0600`.
   - Thư mục state là symlink hoặc của UID khác bị từ chối ngay (`validation`).
   - Việc ghi là atomic (file tạm tạo trong cùng thư mục, fsync, rename atomic).
3. **Backup tự động**:
   - Mọi sửa đổi file đều được đi trước bằng một backup bất biến dưới `$XDG_STATE_HOME/bflow/backups/<timestamp>-<hash>/<basename>`.
   - Một index append-only ghi `{original, backup, sha256, createdAt}`.
4. **Cô lập secret**:
   - Secret thô bị cấm trong plan, manifest, receipt, journal, log hay unit file.
   - Secret được xử lý duy nhất qua tham chiếu `secret://` (`SecretReferenceSchema`).
5. **Idempotency**:
   - Chạy lại setup trên host đã thỏa chỉ tạo receipt `already_satisfied` và không ghi gì ngoài setup state store.
   - Các file rc shell chứa một managed PATH block đánh dấu rõ ràng duy nhất.

---

## Cấu trúc file

```
packages/machine-setup/
├── src/
│   ├── index.ts               # Public exports
│   ├── types.ts               # PlatformProfile, SetupComponent, SetupContext
│   ├── canonical.ts           # Canonical JSON serialization & SHA-256 digest
│   ├── errors.ts              # ContractError construction helpers
│   ├── platform.ts            # Host detection, XDG paths, shell detection
│   ├── runner.ts              # NodeCommandRunner & findExecutable
│   ├── state-store.ts         # SetupStateStore (locks, journal, receipts, backups)
│   ├── tools.ts               # Tool catalog (node, pnpm, git, herdr, CLIs) & probeTools
│   ├── installer-registry.ts  # ToolInstallerRegistry & ToolInstallDescriptor
│   ├── machine-config.ts      # MachineConfigSchema (v3) & default loader
│   ├── path-manager.ts        # PathComponent (managed shell rc blocks)
│   ├── mcp-registry.ts        # McpConfigComponent (mcp.json v3 management)
│   ├── service-manager.ts     # SystemdUserServiceManager & LaunchdServiceManager
│   ├── skills.ts              # SkillsSynchronizer port & SkillsComponent adapter
│   ├── doctor.ts              # BuiltinSetupDoctor & MachineDoctorReport (v3)
│   ├── plan.ts                # Plan builder, topological sorter, preview renderer
│   ├── approval.ts            # SetupApprover, AssumeYesApprover, verifyApproval
│   ├── manifest.ts            # EnvironmentManifestComponent & manifest schema (v3)
│   ├── executor.ts            # executePlan engine (lock, journal, reconcile, rollback)
│   └── setup-service.ts       # MachineSetupService facade
└── test/
    ├── platform.test.ts       # Platform & runner tests
    ├── runner-fixes.test.ts   # Process tree kill & executable detection
    ├── state-store.test.ts    # Store, backup, lock & journal tests
    ├── tools.test.ts          # Tool probing & installer registry tests
    ├── path-manager.test.ts   # PATH block & rc manipulation tests
    ├── mcp-services.test.ts   # MCP registry & OS service manager tests
    ├── doctor.test.ts         # Builtin doctor checks
    ├── plan.test.ts           # Plan builder & preview tests
    ├── executor.test.ts       # Execution engine & interruption resume tests
    ├── setup-service.test.ts  # MachineSetupService mode tests
    └── scenarios.test.ts      # 11 end-to-end integration scenarios
```

---

## Hỗ trợ Platform và trạng thái Windows

- **Linux (`linux`)**: Hỗ trợ đầy đủ (systemd user unit, `.bashrc`, `.profile`, fish config).
- **macOS (`darwin`)**: Hỗ trợ đầy đủ (`launchd` user launch agent, `.zshrc`, `.bash_profile`, `.profile`, fish config).
- **Windows (`win32`)**: Mô hình hóa các interface và platform profile ở mức `designed_unverified`. Các mode `check` và `dry_run` đánh giá an toàn. Mọi bước có thay đổi đều được báo là `blocked` với chẩn đoán `windows support not verified`.

---

## Port và tích hợp bên ngoài

- **P27 (`@bflow/mcp-gateway`)**: Dùng `<config>/mcp.json` do `McpConfigComponent` quản lý cho việc proxy tool cục bộ.
- **P26 tool-installer / P28 skills (`@bflow/skills` / `@bflow/tool-installer`)**: Cung cấp các triển khai `ToolInstaller` cụ thể được đăng ký vào `ToolInstallerRegistry`, và `SkillsSynchronizer` được inject vào `createSkillsComponent`.
- **P29 (`apps/cli`)**: Bọc `MachineSetupService` thành các subcommand `bflow setup` và render văn bản `SetupPreview`.
- **P30 (`packages/runtime`)**: Nối các health check khi khởi động runtime với `MachineDoctorReport` và `EnvironmentManifest`.

---

## Wiring hiện tại

Root TypeScript references và lockfile đã chứa package. CLI setup inject installer, skill synchronizer, launcher và Gateway component; Runtime P30 đọc platform inventory/readiness. Không thêm lại bootstrap wiring. [Setup guide](../../docs/setup-guide.md) mô tả đường sử dụng; [implementation status](../../docs/implementation-status.md) phân biệt local tests và hồ sơ probe thật.

## Hạn chế và trạng thái xác minh

- **Installer được inject**: Unit tests dùng fake installer; CLI đã ghép `@bflow/tool-installer`. Download/probe thật chỉ được xác nhận trong phạm vi báo cáo riêng.
- **OS Services**: Unit file và plist launchd được xác minh qua `CommandRunner` mock; việc spawn OS service thật cần môi trường tích hợp.
- **Concurrency**: Locking của state store được xác minh với tranh chấp PID sống vs stale; lock trên distributed filesystem không được hỗ trợ hay tuyên bố.
- **Windows**: Chưa được xác minh trên các host test POSIX.

Launcher `bflow` do bflow sở hữu cũng thêm các thư mục tool được quản lý đã duyệt vào
PATH của chính process của nó. Điều này giúp các lệnh `bflow` tiếp theo resolve được các
agent CLI mới cài ngay cả khi terminal cha chưa reload cấu hình shell.
Systemd user service được enable bằng đường dẫn unit tuyệt đối do bflow sở hữu, hỗ trợ
các vị trí cấu hình XDG tùy chỉnh mà không yêu cầu chúng nằm trong đường dẫn tìm kiếm của systemd.
