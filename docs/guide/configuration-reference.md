# Tham chiếu cấu hình

Cấu hình chuẩn là **`.bflow/config.yml`**, YAML có comment, `schemaVersion: "1"`. Exported platform documents dùng version 3; RoleMessage/SessionManifest vẫn version 2. Không đổi version của config để “nâng cấp platform”. [Environment schema/defaults](../../apps/cli/src/environment-config.ts) và [YAML renderer](../../apps/cli/src/config-format.ts) là nguồn chuẩn.

YAML chỉ nhận một document, string mapping keys, không explicit tag/merge key/circular alias. `bflow config-migrate` chuyển `.yaml`/`.json` cũ, giữ byte gốc trong `.bak`. `bflow init --update` refresh comment/default fields và giữ giá trị cũ; `init --force`/`--yes` thay toàn bộ config bằng defaults.

## Identity, storage và Runtime

| Trường | Giá trị / ý nghĩa |
| --- | --- |
| `projectName` | Tên hiển thị |
| `runtimeId`, `createdAt` | Runtime cũ và metadata, giữ ổn định để recovery |
| `storage.runStorePath` | Mặc định `.bflow/data/runs.db`, **legacy Runtime** |
| `storage.artifactStoreRoot` | `.bflow/artifacts`, legacy |
| `storage.registryStateFile` | `.bflow/registry/state.json`, legacy |
| `defaultWorkflow` | WorkflowDefinition của legacy Runtime; template seed không là accepted P19 dossier |
| `environment.repositoryId`, `workspaceRoot`, `sessionName` | Identity tự sinh theo canonical checkout/Git; không copy giữa worktrees |
| `environment.herdrBinary` | Mặc định `herdr`; lifecycle kiểm tra protocol/hành vi thực tế |

P19 mặc định lưu dưới `.bflow/state/agentic/`; manifest pane dưới `.bflow/state/panes/`. Khi repo không giữ private permissions, Runtime có thể chọn `$XDG_STATE_HOME/bflow/repositories/...` (mặc định `~/.local/state/bflow/repositories/...`) và lưu locator không bí mật pin vị trí. State đã pin nhưng mất/hỏng phải block, không tạo authority thay thế. Các `storage.*` legacy không di chuyển P19 state. [Runtime reference](../../packages/runtime/README.md).

## Roles, model, effort và profile

`environment.roles` gồm các record `{role, cli, required?, model?, effort?, profile-name?, permissionMode?, fallbackCli?, requiredEnv?, skills?, unsupportedFlags?, specialistProfile?, failover?}`. `cli` thường là `claude`, `codex`, `agy`; custom unsupported CLI bị preflight chặn. Conversation và Coordinator là required; Developer là template cấp phát động, không là permanent pane; `sos` là role cứu hộ tùy chọn, xem [BFLOWSOS](#agent-cứu-hộ-bflowsos). Provider mặc định khi init là **Codex**.

```yaml
environment:
  defaults:
    codex:
      profile-name: work
    claude:
      profile-name: personal
  roles:
    - role: conversation
      cli: codex
      required: true
    - role: coordinator
      cli: codex
      required: true
      profile-name: lead
```

Đây là **fragment** để merge vào config được init; giữ các role/policy/identity khác. Profile ở role ưu tiên provider default, phải tồn tại và được đăng nhập trước. Không tự tạo profile/fallback account. Agy Conversation chưa hỗ trợ trusted human input; giữ Conversation trên Claude/Codex.

### Specialist profiles (RP-01)

`environment.specialistProfiles` liệt kê tối đa 128 định nghĩa `{path, pin: {profileId, version, digest}}`; cặp `profileId@version` phải duy nhất. Role specialist (không phải `conversation`/`coordinator`) có thể chọn `specialistProfile` là một pin trong catalog. Coordinator đọc catalog bằng `read_role_profiles` và ghim `roleProfile` trên task; Runtime kiểm tra định nghĩa bất biến, base role, capability, scope, skills và grant trước khi cấp phát. Profile không đổi provider của role và nhãn profile không thay kiểm tra Reviewer độc lập. [Runtime reference](../../packages/runtime/README.md#custom-specialist-profiles-rp-01).

### Provider failover có phê duyệt

`failover` trên một role là policy strict version 3: `role` (phải trùng role chứa nó), `policyVersion`, `candidates` (tối đa 16 ứng viên exact `{provider, model, profile}`, không trùng), `maxSwitches`, `maxRetries` (tổng ≤ 16) và `cooldownMs`. Role khai `failover` phải có `model` và `profile-name` tường minh. Không khai chain thì không có failover tự động; `fallbackCli` chỉ xử lý binary thiếu khi startup, không chuyển task đang chạy. Runtime chỉ nhận failure có cấu trúc từ adapter tin cậy (không đọc text trong pane), chứng minh execution cũ đã dừng trước khi chuyển và báo notice có hành động trong Conversation khi chain cạn. Run có specialist profile không failover. [Decision](../provider-failover-decision.md) · [Contract](../../packages/contracts/src/provider-failover.ts).

### Agent cứu hộ `BFLOWSOS`

Role tùy chọn `sos` nhận `cli`, `model`, `effort`, `profile-name`, `fallbackCli`; không nhận `specialistProfile` hoặc `failover`. `init` sinh role này với `required: false`; nó không là pane cố định, không tham gia startup readiness, pack resolution hay skill checks. Khi người dùng gõ **chính xác** `BFLOWSOS` trong pane Conversation, host xử lý lượt đó như lệnh vật lý (không qua `conversation_decide`), spawn agent trong tab Herdr "SOS" với **quyền provider đầy đủ và không có PreToolUse guard**, kèm ngữ cảnh hiện trường dưới `<host dir>/sos/` (snapshot Runtime, danh sách pane, lệnh herdr dựng sẵn, đường dẫn log). Kết quả ghi vào task activity là `sos_agent_spawned`. Chỉ dùng khi người vận hành cần can thiệp thủ công.

Model/effort bỏ trống dùng default provider; effort Claude: `low|medium|high|xhigh|max`, Codex: `minimal|low|medium|high|xhigh`; Agy đặt effort trong tên model và từ chối field `effort`. Khả năng thực tế vẫn cần provider capability/model access probe. [Provider reference](../../packages/agent-providers/README.md).

## Policy và ngân sách

| Trường | Default mới | Enforcement hiện tại |
| --- | --- | --- |
| `environment.sdd.minimumLevel` | `lightweight` | Truyền vào host; `full` yêu cầu full specification |
| `environment.sdd.approvalRequired` | `true` | Host/dossier yêu cầu approval theo project policy; không thay các human gate khác |
| `environment.tdd.policy` | `conditional` | Required/recommended/not_applicable theo spec/strategy |
| `environment.verification.maxIterations` | `3` | Config schema nhận 1–100; **persistent host chỉ nhận 1–10**, không tự clamp |
| `environment.verification.onExhausted` | `require_human` | Hết lượt phải escalate |
| `environment.verification.reviewTimeoutMs` | `900000` | 60000–3600000 ms; thời gian tối đa chờ một phiên Reviewer/QA độc lập. Host gia hạn lease của review đã nhận trước khi hết hạn và phát một progress note khi chờ tới 80% timeout |
| `environment.verification.regressionScope` | `affected` | `affected` \| `full` \| `mapped_only` (host.json cũ thiếu trường này mặc định `mapped_only`); điều khiển cổng hồi quy tự động `host-regression-<profile.id>` cho JS/TS runner |
| `environment.fastPath.mode` | `auto` | `auto` \| `off` (host.json cũ mặc định `off`); bật fast-path cho thay đổi `trivial` đơn tác vụ ([ADR 0004](../adr/0004-fast-path-review-waiver.md)), nhưng bị hạ cấp dưới bộ cổng mặc định có `host-test-integrity` |
| `environment.concurrency.maxConcurrency` | `2` | Config schema nhận 1–64; **host capacity/policy chỉ nhận 1–32** |
| `environment.startupTimeoutMs` | `300000` | 1–600000 ms; `up --timeout` ghi đè toàn bộ startup budget |
| `environment.shutdownTimeoutMs` | `30000` | 1–600000 ms; deadline shutdown riêng |
| `environment.allowProviderFallback` | `false` | Không tự đổi provider để làm readiness pass |
| `environment.permissions.mode` | `workspace_auto` | `restricted`, `workspace_auto`, `unattended_isolated`; có role override |
| `environment.permissions.isolation` | `provider_policy` | Unattended cần verified full-provider OS sandbox/container |
| `environment.permissions.trustedWorkspace` | `true` | `false` chặn startup; `true` với required Claude/Codex có thể ghi project trust vào config của provider trong môi trường gọi lệnh, xem bên dưới |

Khi `trustedWorkspace: true` và có role Claude bắt buộc, CLI `up` gọi [ensureClaudeWorkspaceTrust](../../apps/cli/src/claude-trust.ts) trước launch: chỉ đặt `projects[<canonical-root>].hasTrustDialogAccepted = true` trong `$CLAUDE_CONFIG_DIR/.claude.json`, hoặc `~/.claude.json` khi không có override. Đây là cập nhật per-project trust trong file cấu hình người dùng của **môi trường gọi CLI**, không phải chỉ ghi scoped launch settings; không thay global hook/MCP/permission policy. Không suy trust này là OS sandbox hoặc bỏ human gate.

Với role Codex bắt buộc (kể cả role chọn profile ai-isolator), `up` nối bảng `[projects."<root>"]` trust vào `config.toml` của Codex home mà role đó dùng: không viết lại file, không ghi đè quyết định có sẵn (kể cả `untrusted`), bỏ qua file không parse được hoặc home không tồn tại. Private Codex home của Bflow ghi trust riêng cho workspace root và cwd của role. Cả Claude lẫn Codex trust chỉ được ghi trong composition Runtime mặc định, không ghi từ composition tùy chỉnh/test.

CLI đã truyền SDD/TDD/verification/concurrency vào persistent host qua [agentic-host](../../apps/cli/src/agentic-host.ts). Chọn giá trị trong giao miền được host hỗ trợ; range rộng của config parser không chứng minh host nhận mọi giá trị. Thay policy/provider/profile cần down/reconcile rồi up; session đang chạy giữ authority đã pin, không nhận quyền mới ngầm.

## Tools và Context7

Các toggle dưới đây là optional defaults hiện tại, kể cả khi chưa khai field trong config. Đặt `enabled: false` để tắt; `required: true` chặn nếu grant/readiness thiếu.

```yaml
environment:
  tools:
    rtk:
      enabled: true
      required: false
    gitnexus:
      enabled: true
      required: false
    mempalace:
      enabled: true
      required: false
      # wing: <approved-wing>   # mặc định repository ID; read-only
      # serviceId: <machine-service-id>
    chrome-devtools-mcp:
      enabled: true
      required: false
  context7:
    enabled: true
    required: false
    cache:
      enabled: false
      ttlSeconds: 3600
      allowAuthenticated: false
```

RTK có `cliCommandProfiles` tùy chọn cho host-authorized runner; không nhận command string tùy ý. MemPalace chỉ search trong wing đã bind; absence dữ liệu không được giả pass. Browser actions dùng lease độc quyền theo từng attempt (`BrowserResourceTransactions`, TTL tối đa 5 phút, tối đa một lease mỗi attempt, `browser_lease_busy` khi gọi đồng thời; chưa có live Chrome SDLC acceptance). Context7 gửi query ra mạng, cache authenticated cần opt-in.

`environment.toolPolicy` là advanced strict v3 policy có identity/scope/digest cùng role/operation/trigger allowlists, thay đường sinh policy từ các toggle. Không tự sửa digest. Legacy `context7.enabled: true` có mặt cùng explicit policy phải khớp exact service/operations/roles/requiredness; conflicting policy bị từ chối. Legacy `requiredTools`/`requiredMcpServices` không có đủ role/operation authority cần migrate. [D-TOOLS-01](../tools-sdlc-integration.md) · [Resolver](../../apps/cli/src/platform-options.ts).

## Skills

- Không khai `role.skills`: dùng approved bundled role bindings.
- `role.skills: []`: bỏ defaults của role, vẫn giữ repository `environment.skills.requiredSkills` hợp lệ cho role đó.
- `environment.skills.required` yêu cầu manifest tối thiểu theo policy; missing required pin/dependency/grant chặn startup.
- Tool-dependent skills chỉ active khi đủ resolved grant; allowed role hoặc dependency không tự cấp tool.
- Startup composition hiện **không hỗ trợ** `environment.skills.catalogDir`/`bindingsPath`; không suy một field parse được nghĩa là path đó đã được load.

Catalog/generation/approval được quản lý qua setup và Runtime. [Skills architecture](../skills-architecture.md).

## Verification và environment selectors

Runtime tự phát hiện runner; `.bflow/verification.json` là owner override tùy chọn, không phải nơi agent gửi argv tùy ý. [Runner guide](../verification-runners.md) mô tả format/OS/coverage limits.

`BFLOW_HOME` chọn isolated machine/provider source; **không trỏ tới source checkout**. Biến ví dụ `BFLOW_SOURCE` chỉ tiện gọi template scripts. `AI_ISOLATOR_HOME` chọn profile root; `CODEX_HOME`/`CLAUDE_CONFIG_DIR` được resolve theo môi trường đã chọn. `BFLOW_ENVIRONMENT_MODULE` là trusted executable module do operator đặt, không phải dữ liệu repo. `HERDR_CONFIG_PATH` thuộc Herdr. [CLI README](../../apps/cli/README.md) có chi tiết profile/source precedence.
