# P26 — Kế hoạch triển khai Machine setup backend (`bflow setup`)

Spec (thẩm quyền ràng buộc): yêu cầu P26 của project owner (được tóm tắt trong Global Constraints),
`AGENTS.md` (invariant P24 / V3), `docs/runtime-architecture-v3.md` §4, §7, §9, và các
contract đã freeze `packages/contracts/src/{setup,platform,mcp,skills,commands,errors}.ts`.

## Bối cảnh

`@bflow/machine-setup` (package mới, `packages/machine-setup/**`, thuộc sở hữu P26) là
backend mà một CLI tương lai (`apps/cli`, P29) gọi để triển khai:

- `bflow setup` (plan → approve → apply → doctor), `--check` (quan sát chỉ đọc +
  doctor, không ghi), `--dry-run` (plan + preview cho người, không ghi), `--repair`
  (plan đồng thời sửa config do bflow sở hữu bị sai định dạng, đối soát các bước `unknown`), `--yes`
  (tự động duyệt CHỈ các bước đã có trong plan; không bao giờ nâng quyền, không bao giờ login).

Không thêm CLI parser (P29 sở hữu `apps/cli/**`). Các triển khai `ToolInstaller` cụ thể cho từng tool
KHÔNG được viết ở đây — package định nghĩa một `ToolInstallerRegistry` nhận
các triển khai được inject của interface `ToolInstaller` trong contract.

## Global Constraints

- Chỉ owned paths: `packages/machine-setup/**`. Không sửa `packages/contracts/**`,
  `package.json` gốc, `tsconfig.json` gốc, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`,
  `docs/**` hay bất kỳ package nào khác. (Wiring gốc là thay đổi tích hợp; hãy báo cáo.)
- Package `@bflow/machine-setup`, ESM, layout giống hệt `packages/agent-providers`
  (`package.json` với `main ./dist/index.js`, `types ./dist/index.d.ts`, exports `.`;
  `tsconfig.json` extends `../../tsconfig.base.json`, composite, rootDir `src`, outDir
  `dist`, references `../contracts`). Dependencies: chỉ `@bflow/contracts: workspace:*`,
  `zod: ^3.24.2`; mọi thứ khác từ các built-in `node:`.
- Test nằm trong `packages/machine-setup/test/*.test.ts` (vitest), chạy bằng
  `pnpm --filter @bflow/machine-setup test` hoặc
  `pnpm exec tsc -b packages/machine-setup && pnpm exec vitest run packages/machine-setup/test`.
  Test dùng thư mục tạm làm HOME/XDG root giả và các `CommandRunner` giả được inject; chúng
  không bao giờ được chạm vào home thật, file rc shell thật, service thật hay mạng.
- Mọi giá trị đi qua ranh giới package được parse bằng Zod schema contract đã export
  (`SetupStepSchema`, `MachineSetupPlanSchema`, `SetupReceiptSchema`,
  `SetupApplyRequestSchema`, `ToolInstallRequestSchema`, `MCPServiceDefinitionSchema`, …).
  Các tài liệu cục bộ của package (machine config mong muốn, environment manifest, journal, approval
  receipt, doctor report) là Zod schema nghiêm ngặt với `schemaVersion: 3`; version không biết
  trả về `ContractError` `unsupported_version` (supportedVersions `[3]`), v3 sai định dạng trả về
  `validation`. Không bao giờ mặc định version thiếu thành 3.
- Kết quả dùng các shape `OperationResult<T>` / `ContractError` của contract; không ném lỗi
  qua public API trừ lỗi lập trình.
- Lệnh chỉ được thực thi qua `CommandRunner` được inject với mảng argv và
  `shell: false`. Không bao giờ dựng chuỗi shell, không bao giờ pipe download vào shell, không bao giờ
  gọi `sudo`/`doas`/`runas`/`pkexec`. Một bước cần nâng quyền OS được báo là
  `blocked` kèm lệnh thủ công chính xác; `--yes` không thay đổi điều đó.
- Setup không bao giờ đăng nhập vào provider CLI và không bao giờ chấp nhận prompt trust/update; thiếu auth
  là một phát hiện của doctor kèm hướng dẫn thủ công.
- Version pin: bước cài đặt chỉ được lập plan cho descriptor có version pin chính xác
  (không range, không `latest`), nguồn `https:` và toàn vẹn SHA-256. Tool không pin/thiếu
  nhận chẩn đoán hướng dẫn thủ công, không có bước cài. Không phát hành pin/checksum bịa đặt.
- Tương thích Herdr KHÔNG được đánh giá từ release label: setup chỉ kiểm tra sự hiện diện và
  ghi chuỗi version làm chẩn đoán.
- Mức tối thiểu runtime yêu cầu: Node `>=22.13.0`; pnpm chính xác `12.5.1` (`packageManager`
  gốc); Git `>=2.30.0`; Herdr hiện diện (bất kỳ chuỗi version nào). Provider CLI
  `claude`, `codex`, `agy` được phát hiện; chúng chỉ bắt buộc khi được liệt kê trong `providers`
  của machine config mong muốn.
- Đường dẫn: XDG với mặc định khi chưa đặt — config `$XDG_CONFIG_HOME/bflow` (mặc định
  `~/.config/bflow`), data `$XDG_DATA_HOME/bflow` (`~/.local/share/bflow`), state
  `$XDG_STATE_HOME/bflow` (`~/.local/state/bflow`), trên cả Linux và macOS. Thư mục
  do bflow sở hữu được tạo `0700`, file `0600`; thư mục bflow sở hữu là symlink hoặc thuộc
  uid khác bị từ chối (`validation`). Việc ghi là atomic (file tạm trong cùng thư mục, fsync,
  rename). Mọi sửa đổi file hiện có đều được đi trước bằng một backup dưới
  `$XDG_STATE_HOME/bflow/backups/`.
- Idempotency: chạy lại setup không được nhân đôi entry MCP, entry/block PATH,
  plugin/skill, định nghĩa OS service, và không được ghi lại byte ngoài vùng/file
  do bflow sở hữu. Chạy lại trên máy đã thỏa chỉ tạo receipt `already_satisfied`
  và không ghi file nào ngoài journal/receipt/manifest dưới thư mục state của bflow.
- Secret: không giá trị secret nào được ghi vào plan, manifest, receipt, journal, log hay
  config; secret chỉ là tham chiếu `secret://` (`SecretReferenceSchema`).
- Platform: Linux và macOS được hỗ trợ; Windows (`win32`) được mô hình hóa trong interface và
  báo là `designed_unverified` — check/dry-run hoạt động, các bước có thay đổi bị `blocked` với
  chẩn đoán `windows support not verified`.
- Không thêm triển khai no-op/luôn-thành-công để thỏa test; fake chỉ nằm trong test.

## Interface dùng chung (định nghĩa ở Task 1, dùng ở các task sau)

```ts
// src/types.ts
export type SupportStatus = "supported" | "designed_unverified" | "unsupported";
export interface PlatformProfile {
  os: "linux" | "darwin" | "win32" | "other"; arch: string; supportStatus: SupportStatus;
  shell: "bash" | "zsh" | "fish" | "sh" | "pwsh" | "cmd" | "unknown"; shellPath: string | null;
  uid: number | null; gid: number | null; isRoot: boolean; elevationAvailable: boolean;
  homeDir: string; hostname: string; machineId: string;
  paths: { config: string; data: string; state: string; managedBin: string };
  pathEntries: string[];
}
export interface HostEnvironment {             // injectable; default reads node:os/process
  platform: NodeJS.Platform; arch: string; env: Record<string, string | undefined>;
  homeDir: string; hostname: string; uid: number | null; gid: number | null;
}
export interface CommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }
export interface CommandRunner {
  run(argv: readonly string[], options?: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<CommandResult>;
}
export interface ComponentObservation { stateDigest: string | null; valid: boolean; diagnostics: string[]; }
export interface ComponentDesiredState {
  digest: string; summary: string; targets: string[]; machineWide: boolean;
  repairNeeded: boolean;                      // owned config malformed; only applied in repair mode
}
export interface SetupContext {
  platform: PlatformProfile; runner: CommandRunner; mode: "check" | "dry_run" | "apply" | "repair";
  now(): Date; signal?: AbortSignal;
}
export interface SetupComponent {
  readonly componentId: string;
  readonly action: "configure" | "register_mcp" | "resolve_skills" | "verify";
  readonly rollback: "restore_owned_config" | "remove_owned_install" | "manual" | "none";
  observe(ctx: SetupContext): Promise<ComponentObservation>;
  desired(ctx: SetupContext): Promise<ComponentDesiredState>;
  apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }>;
}
```
`machineId` = `m-` + 24 ký tự hex đầu của sha256(`hostname\0uid\0homeDir`).
`digest(value)` = sha256 hex của canonical JSON (key object được sắp xếp đệ quy, không có khoảng trắng).

## Task 1: Scaffold package, canonical digest, phát hiện platform, command runner

Tạo `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts` (các interface ở trên),
`src/canonical.ts` (`canonicalJson`, `digest`), `src/errors.ts` (các helper dựng giá trị
`ContractError`: `validationError`, `unsupportedVersion`, `conflictError`,
`timeoutError`, `notFound`, `corruption`), `src/platform.ts`
(`defaultHostEnvironment()`, `detectPlatform(host): PlatformProfile`, `resolveXdgPaths`),
`src/runner.ts` (`NodeCommandRunner` dùng `child_process.execFile` với `shell:false`,
`windowsHide`, `maxBuffer` có giới hạn 1 MiB, timeout → kill + `timedOut:true`, từ chối argv
rỗng / byte NUL / argv[0] trong denylist `sudo, doas, su, runas, pkexec`; cùng `findExecutable(name,
pathEntries, platform)` thực hiện tra cứu PATH với kiểm tra `X_OK` và `PATHEXT` của Windows).

Phát hiện shell: basename của `$SHELL` trên POSIX (`bash|zsh|fish|sh|dash→sh`), trên win32 là `pwsh` nếu
`PSModulePath` được đặt và `ComSpec` vắng mặt hoặc không được ưu tiên, nếu không thì `cmd`; còn lại `unknown`.
`isRoot` = uid 0. `elevationAvailable` = tìm thấy `sudo` trên PATH (chỉ để tham khảo; không bao giờ chạy).
`supportStatus`: linux/darwin `supported`, win32 `designed_unverified`, còn lại `unsupported`.
`managedBin` = `<data>/bin`. Giá trị XDG tương đối bị bỏ qua (theo spec XDG) → dùng mặc định.

Test (`test/platform.test.ts`): fixture host linux/darwin/win32; XDG đặt/chưa đặt/tương đối;
độ ổn định của machineId; bảng phát hiện shell; runner: echo qua `process.execPath -e`, kill khi
timeout, argv0 trong denylist bị từ chối, NUL bị từ chối; canonical digest không phụ thuộc thứ tự key.

## Task 2: State store — thư mục riêng tư, ghi atomic, backup, lock, journal, receipt, approval

`src/state-store.ts`: `class SetupStateStore(paths, { uid, now })` với
`ensurePrivateDir(path)` (mkdir 0700 recursive; lstat: từ chối symlink, từ chối uid không khớp
khi biết uid, chmod về 0700 nếu lỏng hơn), `writeFileAtomic(path, data, mode=0o600)`,
`backupFile(path) → backupPath | null` (sao chép file hiện có vào
`<state>/backups/<ISO-timestamp-with-dashes>-<sha8 of content>/<basename>` và nối một dòng vào
`<state>/backups/index.jsonl` `{original, backup, sha256, createdAt}`; không bao giờ ghi đè backup),
`acquireLock() → OperationResult<Lock>` (`<state>/setup.lock` tạo bằng `wx`, nội dung
`{pid, hostname, startedAt}`; lock hiện có với pid đã chết trên cùng hostname là stale → bị thay thế;
còn sống → lỗi `conflict`; `Lock.release()` chỉ xóa nếu nội dung vẫn là của ta),
journal (`<state>/setup/journal.json`, schema v3 nghiêm ngặt:
`{schemaVersion, planId, planDigest, revision, steps: Record<stepId, {status: "started"|"finished", startedAt, idempotencyKey}>}`),
receipt (`<state>/setup/receipts.jsonl`, mỗi dòng được parse bằng `SetupReceiptSchema`; dòng
hỏng → lỗi `corruption` nêu số dòng; `latestReceipt(idempotencyKey)`),
approval receipt (`<state>/setup/approvals/<receiptId>.json`, schema v3 nghiêm ngặt:
`{schemaVersion, receiptId, planId, planDigest, machineId, stepIds, approvedBy: "operator"|"assume_yes", approvedAt}`),
change log (`<state>/setup/changes.jsonl`: `{at, planId, stepId, kind, target, machineWide}`).
Các đường code `check`/`dry_run` không bao giờ tạo thao tác ghi: expose cờ `readOnly` khiến mọi
phương thức có thay đổi trả về lỗi `validation` "read-only mode".

Test (`test/state-store.test.ts`): quyền 0700/0600; thư mục state là symlink bị từ chối; ghi atomic
không để lại file tạm; backup được tạo trước thay đổi và là duy nhất; tranh chấp lock giữa pid sống và
stale; round-trip journal/receipt; dòng receipt hỏng → corruption; schemaVersion
không biết → unsupported_version; readOnly từ chối ghi.

## Task 3: Tool catalog, probing, installer registry, machine config mong muốn

`src/tools.ts`: catalog `TOOL_CATALOG` gồm các entry `{toolId, kind: "runtime"|"provider_cli",
executables: {posix: string[], win32: string[]}, versionArgs, versionPattern, requirement:
{type:"min", version} | {type:"exact", version} | {type:"present"}, defaultRequired,
knownInstallDirs(platform) , manualGuidance: Record<os, string>}` cho `node, pnpm, git, herdr,
claude, codex, agy` dùng các giá trị ở Global Constraints. `manualGuidance` nêu các kênh
chính thức (nodejs.org / Homebrew / trình quản lý package của distro, `corepack`/npm cho pnpm, git-scm /
Homebrew / distro, trang release của Herdr, tài liệu chính thức của provider) và không bao giờ là dòng `curl | sh`.
`probeTools(platform, runner, { required })` → `ToolObservation[]`
`{toolId, status: "present"|"missing"|"version_mismatch"|"path_missing"|"unparseable_version"|"probe_failed",
resolvedPath, realPath, version, binaryDigest, required, diagnostics}`: tra cứu PATH qua
`findExecutable`; nếu vắng khỏi PATH nhưng có trong `knownInstallDirs` (ví dụ `~/.local/bin`,
`~/.npm-global/bin`, `<pnpm home>`, `/opt/homebrew/bin`, `/usr/local/bin`, `<managedBin>`) →
`path_missing` kèm thư mục đó; version qua runner với timeout 10 s; binaryDigest = sha256
streamed của realPath.

`src/installer-registry.ts`: `ToolInstallDescriptor` schema v3 nghiêm ngặt `{toolId, installerId,
method: "npm"|"pnpm"|"homebrew"|"winget"|"verified_archive", version (semver chính xác, không
range/latest), source (URL https), integrity (sha256), platforms: ("linux"|"darwin"|"win32")[],
requiresElevation: boolean}`; `ToolInstallerRegistry` với `register(installer: ToolInstaller)`
(installerId trùng → conflict), `resolve(toolId, platform, descriptors)` → descriptor đầu tiên
cho platform có installer đã đăng ký, thứ tự ưu tiên darwin: homebrew, npm, pnpm,
verified_archive; linux: npm, pnpm, verified_archive, homebrew; win32: winget, npm, pnpm,
verified_archive; `buildInstallRequest(descriptor, platform)` → request hợp lệ theo `ToolInstallRequestSchema`
(`scope {kind:"machine", machineId}`, destination `<managedBin>` cho verified_archive
còn lại là method id, idempotencyKey `install:<machineId>:<toolId>:<version>:<integrity>`).

`src/machine-config.ts`: machine config mong muốn tại `<config>/machine.json`, schema v3 nghiêm ngặt:
`{schemaVersion, providers: AgentProviderId[], toolPins: ToolInstallDescriptor[], mcpServices:
MCPServiceDefinition[], services: ServiceDefinition[], skills: {catalogRef: string|null},
secrets: Record<string, SecretReference>}` trong đó `ServiceDefinition` = `{serviceId (identifier
[a-z0-9-]), program: absolute path, args: string[], env: Record<string, SecretReference|plain
non-secret string>, keepAlive: boolean}`. `loadMachineConfig(path)` → `{status: "absent"|"valid"|
"invalid"|"unsupported_version", config?, error?}`; absent → mặc định (danh sách rỗng,
providers `[]`). Bất kỳ giá trị chuỗi nào trông giống credential (`/(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]/`
hoặc key tên `token|secret|password|apiKey` có giá trị không phải `secret://`) → invalid.
`defaultMachineConfig()`.

Test (`test/tools.test.ts`): máy sạch (không tìm thấy gì); một phần (node cũ, git ổn);
đã có (tất cả hiện diện & khớp); PATH thiếu (claude trong `~/.local/bin` không nằm trên PATH);
version không parse được; probe timeout → probe_failed; herdr chấp nhận mọi version; registry
trùng/ưu tiên resolve/descriptor không pin bị từ chối/nguồn http bị từ chối; config absent/valid/
JSON không hợp lệ/literal secret bị từ chối/version không biết.

## Task 4: PATH manager

`src/path-manager.ts`: `PathComponent implements SetupComponent` (componentId `path`,
action `configure`, rollback `restore_owned_config`). Input: platform, dir mong muốn =
`[managedBin, ...dirs của tool path_missing]` khử trùng lặp, giữ thứ tự, lọc các dir
chưa có trong `platform.pathEntries`... (luôn giữ managedBin trong block). Target theo shell:
zsh → `${ZDOTDIR:-~}/.zshrc`; bash → `~/.bashrc` trên linux, `~/.bash_profile` trên darwin;
sh/unknown → `~/.profile`; fish → `<XDG_CONFIG_HOME|~/.config>/fish/conf.d/bflow.fish`
(toàn bộ file do bflow sở hữu); pwsh/cmd/win32 → chỉ interface `WindowsPathEditor`, `apply` trả về
chẩn đoán unsupported. Managed block nằm giữa các dòng chính xác `# >>> bflow managed PATH >>>` và
`# <<< bflow managed PATH <<<`; thân POSIX cho mỗi dir:
`case ":$PATH:" in *":'<dir>':"*) ;; *) PATH='<dir>':"$PATH" ;; esac` rồi `export PATH`
(fish: `contains -- '<dir>' $PATH; or set -gx PATH '<dir>' $PATH`). Dir chứa `'`,
xuống dòng, NUL, hoặc không tuyệt đối → lỗi validation. observe: parse file; đúng một
block hợp lệ → digest của thân block; không có → null; >1 block hoặc chưa đóng → `valid:false`,
`repairNeeded` trong desired. apply: backup, thay block hiện có tại chỗ (hoặc nối thêm với
một dòng trống đứng đầu), giữ mọi byte khác giống hệt, ghi atomic giữ nguyên mode file gốc; ở chế độ
không-repair với block không hợp lệ → trả chẩn đoán và không ghi (executor
đánh dấu blocked). Repair: xóa mọi block bflow / marker treo, ghi một block.

Test (`test/path-manager.test.ts`): không có file rc → tạo mới với block; rc hiện có với nội dung
người dùng được giữ nguyên từng byte; chạy lại → không ghi (mtime/byte không đổi) và digest bằng nhau;
block trùng lặp → invalid, repair khử trùng; sửa block chưa đóng; file fish do bflow sở hữu; dir
có dấu nháy bị từ chối; win32 unsupported; backup được tạo trước khi sửa file hiện có.

## Task 5: MCP registry, ServiceManager, port skills synchronizer, doctor

`src/mcp-registry.ts`: `McpConfigComponent implements SetupComponent` (componentId
`mcp-config`, action `register_mcp`) duy trì `<config>/mcp.json` schema v3 nghiêm ngặt
`{schemaVersion, services: Record<serviceId, MCPServiceDefinition>, external: unknown
(giữ nguyên verbatim nếu có)}`. Desired = config.mcpServices khóa theo `serviceId` (tên trường
theo `MCPServiceDefinitionSchema`; trùng lặp trong input → validation). Apply merge: entry
do bflow sở hữu được thay theo id, entry không thuộc tập desired của bflow nhưng hiện có thì được giữ
(entry không mang marker sở hữu bên trong object contract, nên theo dõi id sở hữu trong
trường anh em `managedIds: string[]`); chạy lại → byte giống hệt, không ghi. JSON/schema không hợp lệ → `valid:false`;
repair: backup rồi ghi lại từ desired + mọi entry còn hợp lệ. Không bao giờ chạm vào file settings người dùng của
provider (Claude/Codex/Agy).

`src/service-manager.ts`: interface `ServiceManager` `{ kind: "systemd-user"|"launchd"|
"windows-unverified"; unitPath(serviceId); render(def): string; inspect(serviceId) →
{installed, digest, active}; install(def) → ownedPaths; }` với `SystemdUserServiceManager`
(`<XDG_CONFIG_HOME>/systemd/user/bflow-<id>.service`, sau đó runner `systemctl --user
daemon-reload` và `systemctl --user enable --now bflow-<id>.service`) và
`LaunchdServiceManager` (`~/Library/LaunchAgents/dev.bflow.<id>.plist`, runner `launchctl
bootout gui/<uid>/dev.bflow.<id>` bỏ qua nếu vắng rồi `launchctl bootstrap gui/<uid> <plist>`),
cả hai chỉ ở user-scope, render một cách xác định với giá trị env là tham chiếu secret
KHÔNG được inline (render thành `BFLOW_SECRET_REF_<NAME>=secret://…`). `ServicesComponent implements
SetupComponent` (componentId `services`, action `configure`): một unit cho mỗi service id,
nội dung giống hệt → không ghi lại, không reload; unit tiền tố bflow cũ không thuộc tập desired
được báo cáo (không xóa) trừ khi repair. `selectServiceManager(platform)`.

`src/skills.ts`: port `SkillsSynchronizer` `{ observe(ctx) → ComponentObservation; desired(ctx)
→ ComponentDesiredState; sync(ctx) → {ownedPaths, diagnostics} }` (do P28 triển khai) và
adapter `SkillsComponent` (componentId `role-skills`, action `resolve_skills`); khi không có
synchronizer được inject → component bị loại khỏi plan với chẩn đoán `skills synchronizer not
configured` (không bao giờ giả thành công).

`src/doctor.ts`: `MachineDoctorReport` schema v3 nghiêm ngặt `{schemaVersion, machineId, healthy,
checkedAt, checks: {checkId, status: "passed"|"warning"|"failed"|"skipped", summary,
remediation?}[]}`; port `SetupDoctor` `{ run(ctx, input) → MachineDoctorReport }` và
`BuiltinSetupDoctor` (chỉ đọc): check tool từ các observation (thiếu bắt buộc → failed),
PATH block hợp lệ, mcp.json hợp lệ, inspect service, machine config hợp lệ, gợi ý auth của provider
dưới dạng `warning` "login not verified by setup; run `<cli>` interactively". healthy = không có failed.

Test (`test/mcp-services.test.ts`, `test/doctor.test.ts`): MCP thêm/chạy lại không trùng/giữ
entry ngoại lai/sửa JSON không hợp lệ kèm backup; render+install systemd và launchd qua fake
runner (argv được assert, không sudo), chạy lại không cài lại, secret không bị inline; component skills
vắng khi không có synchronizer; trạng thái doctor.

## Task 6: Plan builder, preview, approval

`src/plan.ts`: `buildSetupPlan(input: {platform, observations, config, components:
SetupComponent[], registry, mode, previousRevision, now}) → OperationResult<{plan:
MachineSetupPlan, preview: SetupPreview, diagnostics}>`. Thứ tự bước (topo):
các bước install_tool (một bước cho mỗi tool có status missing/version_mismatch mà có descriptor
đã pin và resolve được; do `installer.plan(request)` tạo ra và được validate: componentId ===
toolId, scope bằng nhau, action install_tool, requiresApproval true — không khớp → validation), rồi
`path`, `role-skills`, `mcp-config`, `services`, `environment-manifest` (configure; phụ thuộc
mọi bước trước), `doctor` (verify; phụ thuộc manifest; requiresApproval false). Component có
digest observe bằng digest desired và hợp lệ vẫn được đưa vào chỉ cho `verify`?
Không: component đã thỏa bị loại khỏi plan (được báo là `satisfied` trong preview);
component `repairNeeded` chỉ được đưa vào ở repair mode (nếu không preview đánh dấu
`needs_repair`). Mọi bước: level/scope machine, `requiresApproval` true trừ verify,
stepId `<action>:<componentId>`, `desiredStateDigest` từ desired, `expectedStateDigest`
từ observe (null nếu vắng), idempotencyKey `setup:<machineId>:<stepId>:<desiredDigest>`.
planDigest = digest(plan không có `planDigest`); planId `plan-<planDigest[0..16]>`; revision
`previousRevision + 1`. Parse plan cuối bằng `MachineSetupPlanSchema`. Windows: plan được dựng;
preview đánh dấu các bước có thay đổi là `unsupported_platform`.

`SetupPreview`: `{steps: {stepId, action, componentId, summary, targets, machineWide,
requiresApproval, requiresElevation, commandPreview?: string[]}[], satisfied: string[],
manual: {toolId, guidance}[], needsRepair: string[], machineWideChanges: string[]}` cùng
`renderPreview(preview): string` (văn bản thuần, xác định).

`src/approval.ts`: port `SetupApprover` `{ approve(plan, preview) → Promise<{approved:true,
receipt} | {approved:false, reason}> }`; `AssumeYesApprover` (ghi approvedBy
`assume_yes`, stepIds = đúng các bước cần approval của plan, loại trừ các lần cài
`requiresElevation`, vốn vẫn chưa được duyệt); `InteractiveApprover(confirm:
(text)=>Promise<boolean>)`; `NonInteractiveApprover` (luôn từ chối: "approval required;
rerun with --yes or interactively"). Receipt được lưu qua state store; `verifyApproval(store,
plan, step, receiptId)` kiểm tra planId, planDigest, machineId và stepId thuộc tập.

Test (`test/plan.test.ts`): shape & thứ tự & tính hợp lệ schema của plan máy sạch; máy đã thỏa
→ chỉ bước `doctor`; digest ổn định giữa các lần chạy và thay đổi khi desired thay đổi;
tool không pin → entry manual, không có bước; descriptor nâng quyền → requiresElevation, không
được --yes tự duyệt; installer.plan trả bước không khớp bị từ chối; approval receipt
cho digest plan khác bị từ chối; assertion render preview không dùng snapshot.

## Task 7: Executor và facade MachineSetupService (các mode)

`src/executor.ts`: `executePlan(plan, deps: {store, components, registry, approvalReceiptId,
ctx, stepTimeoutMs = 600000})` → `SetupReceipt[]`. Validate plan (schema + digest tính lại
→ `validation` nếu không khớp), lấy lock, ghi journal (planId/digest/revision). Với mỗi bước theo
thứ tự: dependency không `applied|already_satisfied` → `blocked`; platform không `supported` và
action ≠ verify → `blocked` "windows support not verified"; approval được xác minh cho các bước
yêu cầu (nếu không thì `blocked`); quan sát lại: observed == desired → `already_satisfied` (không apply);
observed ≠ expected (drift kể từ plan) → `blocked` "state changed since plan; re-plan";
journal `started` (được lưu trước side effect); install_tool → `installer.apply(
SetupApplyRequest)` (parse bằng `SetupReceiptSchema`; receipt của nó được xác minh lại qua
read-back `installer.reconcile`) — bước component → `component.apply` rồi quan sát lại; mọi
timeout/abort/throw sau `started` → `unknown`; chỉ thành công nếu digest read-back == desired,
nếu không `failed`; journal `finished`; nối dòng receipt và change-log (target `machineWide`).
Resume: một bước journal `started` không có receipt cho cùng idempotencyKey → đối soát trước
(installer.reconcile / component.observe): observed == desired → `applied` (chẩn đoán
"reconciled after interruption"); observed == expected → retry an toàn; ngược lại `unknown` và
không retry trừ khi mode `repair`. Lock luôn được nhả (finally).

`src/manifest.ts`: `EnvironmentManifest` schema v3 nghiêm ngặt `{schemaVersion, machineId,
generatedAt, platform: {os, arch, shell, supportStatus}, paths, tools: {toolId, status,
version, resolvedPath, binaryDigest}[], pathBlock: {target, dirs}|null, mcpServiceIds,
serviceIds, skillsDigest|null, lastPlan: {planId, planDigest, revision}|null}` được ghi vào
`<state>/environment.json` bởi component `environment-manifest` (không chứa giá trị env hay
secret).

`src/setup-service.ts`: `MachineSetupService` được dựng với `{host?, runner?, registry?,
skills?, doctor?, serviceManager?, approver, components?}`; `run({mode: "check"|"dry_run"|
"apply"|"repair", assumeYes?: boolean, signal?})` → `SetupRunReport {mode, platform,
observations, configStatus, plan|null, preview|null, receipts, doctor, machineWideChanges,
outcome: "healthy"|"changes_pending"|"applied"|"partially_applied"|"failed"|"blocked"|
"approval_declined"|"unsupported_platform"}`. check: observe + doctor, store readOnly, không
ghi. dry_run: + plan/preview, không ghi. apply: machine config không hợp lệ → `blocked`
("run setup --repair"), plan → approver (`assumeYes` → AssumeYesApprover) → execute → doctor.
repair: machine config không hợp lệ/unsupported → backup + ghi lại mặc định; plan ở repair mode;
các bước journal unknown đủ điều kiện retry. `outcome` suy ra từ receipt + doctor.

Test (`test/executor.test.ts`): apply happy path với fake installer; dependency thất bại
chặn các bước phụ thuộc; thiếu approval → blocked; drift → blocked; timeout → unknown rồi
đối soát khi chạy lại; resume bước bị gián đoạn (journal started, không receipt); lock bị giữ → conflict;
check/dry-run không ghi (snapshot đệ quy của HOME tạm trước/sau).

## Task 8: Bộ kịch bản, README, handoff

`test/scenarios.test.ts` — end-to-end qua `MachineSetupService` với HOME/XDG tạm và một
thế giới giả (`CommandRunner` giả + `ToolInstaller` giả hiện thực hóa executable trong một
thư mục bin tạm): (1) mô phỏng máy sạch, (2) cài đặt một phần, (3) cài đặt có sẵn
(tất cả đã thỏa → chỉ doctor, không ghi config), (4) PATH thiếu (tool trong
`~/.local/bin` → PATH block, chạy lại không trùng), (5) cài đặt thất bại (installer thất bại →
`failed`, phụ thuộc bị blocked, outcome failed, backup còn nguyên), (6) setup bị gián đoạn (abort
giữa bước → `unknown`; chạy lại đối soát), (7) repair (PATH block sai định dạng + mcp.json không hợp lệ +
bước unknown được `repair` sửa), (8) chạy lại idempotent (apply lần hai: tất cả `already_satisfied`,
byte rc/mcp/unit giống hệt, một block, một entry MCP, một unit), (9) cấu hình global không hợp lệ
(apply bị blocked, check báo failed, repair backup & khôi phục), cộng với
`--yes` không duyệt các bước nâng quyền và không chuỗi secret nào từ env xuất hiện trong bất kỳ file nào
dưới HOME tạm.

Tài liệu: `packages/machine-setup/README.md` (mục đích, ngữ nghĩa mode, cấu trúc file, ranh giới
sở hữu, quy tắc an toàn, trạng thái Windows, các port do P28/P27/P29/P30 cung cấp, wiring tích hợp
cần thiết: tham chiếu `tsconfig.json` gốc + importer lockfile, hạn chế / các mục NOT VERIFIED:
không có installer thật, không chạy systemd/launchd thật, không Windows, không stress multi-process đồng thời
ngoài các test lock). Chạy các lệnh validation đầy đủ từ AGENTS.md và báo cáo
commit đã test, lệnh, kết quả, giả định và yêu cầu tích hợp trong kết quả công việc.
