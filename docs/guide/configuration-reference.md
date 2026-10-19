# Configuration Reference

Bflow dùng `.bflow/config.yml` làm config canonical. Đây là YAML thụt lề có
comment hướng dẫn, parse theo YAML 1.2 giới hạn an toàn; mỗi file có đúng một
document, mapping keys là chuỗi, và explicit tags, merge keys, alias vòng bị từ
chối. File cần `schemaVersion: "1"`, `projectName`, `runtimeId`, `createdAt`,
`storage`, `defaultWorkflow`; lifecycle commands còn cần `environment`. Các lệnh
đọc tương thích với `.bflow/config.yaml` và `.bflow/config.json` cũ. Chạy
`bflow config-migrate` để sao lưu config cũ và chuyển giá trị sang `.bflow/config.yml`.
Không đổi schemaVersion tùy ý.

## Compatibility decision

Theo yêu cầu được project owner phê duyệt, config canonical chuyển sang YAML có comment và thêm hai trường role tuỳ chọn `model`/`effort`; không đổi shape hay schema version của `@bflow/contracts`. Bflow CLI, Runtime/provider adapters và templates cùng đọc các trường mới; bỏ trống vẫn dùng provider defaults. Chuyển tên file và format cũ chỉ xảy ra khi người dùng chạy `bflow config-migrate`, lệnh này giữ bản sao bytes gốc. Khi áp dụng lựa chọn provider/model/effort mới cho host đang chạy, chạy `bflow down` trước rồi build/cập nhật các package liên quan cùng nhau.

| Trường | Dạng/default | Consumer và giới hạn thực tế |
| --- | --- | --- |
| `projectName` | Chuỗi không rỗng | Tên hiển thị; không quyết định session identity |
| `runtimeId` | Chuỗi không rỗng, init sinh theo repo | Legacy workspace Runtime; giữ ổn định khi recovery |
| `createdAt` | Chuỗi timestamp init | Metadata cấu hình |
| `storage.runStorePath` | `.bflow/data/runs.db` | Legacy CLI Runtime; đường dẫn tương đối resolve theo workspace |
| `storage.artifactStoreRoot` | `.bflow/artifacts` | Legacy CLI ArtifactStore |
| `storage.registryStateFile` | `.bflow/registry/state.json` | Legacy CLI file Registry |
| `defaultWorkflow` | `WorkflowDefinition`, schema `"1"` | Legacy CLI run; không phải một workflow library directory |
| `environment.repositoryId` | Hash sinh từ checkout/Git directory | Kiểm tra ownership; không tự sửa để nhận session cũ |
| `environment.workspaceRoot` | Canonical absolute path | Kiểm tra đúng checkout |
| `environment.sessionName` | `bf-` + 20 ký tự hex | Named Herdr session riêng cho checkout |
| `environment.herdrBinary` | `"herdr"` | Binary cho lifecycle commands |
| `environment.roles` | Mảng `{role, cli, model?, effort?, required}` | Role duy nhất; conversation/coordinator phải required. Model/effort tuỳ chọn theo role; Agy chỉ nhận effort gắn trong model name |
| `environment.sdd.minimumLevel` | `"lightweight"` hoặc `"full"` | P12 lưu/validate; chưa tự truyền sang P19 |
| `environment.sdd.approvalRequired` | `true` | P12 lưu/validate; host phải cấu hình approval policy riêng |
| `environment.tdd.policy` | Chỉ `"conditional"` | Không có config toàn cục `always`/`disabled`; P16 đọc assessment từng spec |
| `environment.verification.maxIterations` | 3, integer 1–100 | P12 validate; P19 `propose_workflow` nhận giới hạn riêng 1–10, default 3 |
| `environment.verification.onExhausted` | Chỉ `"require_human"` | Không có retry vô hạn |
| `environment.concurrency.maxConcurrency` | 2, integer 1–64 | P12 truyền làm capacity cho P13; P19 host có `maxDeveloperCapacity` riêng |
| `environment.startupTimeoutMs` | 300000, integer 1–600000 | Deadline lifecycle up |
| `environment.shutdownTimeoutMs` | 30000, integer 1–600000 | Deadline lifecycle down |

P19 `openAgenticWorkspace` mặc định lưu dữ liệu riêng tại
`.bflow/state/agentic/{runs.db,registry.json,artifacts,journal,conversation}`.
`storageDirectory` là host option; ba `storage.*` bên trên không tự đổi các path
này. Không nhập/chuyển state giữa hai Runtime theo tên file giống nhau.

Mẫu [config.fragment.json](../../templates/node-typescript/config.fragment.json)
chỉ chứa các trường portable trong `environment`. Chạy init rồi helper apply để
giữ identity. Ví dụ fragment policy:

```json
{
  "sdd": { "minimumLevel": "lightweight", "approvalRequired": true },
  "tdd": { "policy": "conditional" },
  "verification": { "maxIterations": 3, "onExhausted": "require_human" },
  "concurrency": { "maxConcurrency": 2 }
}
```

Đoạn này thuộc `environment`, không phải một file cấu hình hoàn chỉnh. P12 có thể
chấp nhận policy đó mà chưa có enforcement P19. Host phải đọc policy đã duyệt,
kiểm tra giới hạn của API đích và truyền tường minh vào các port/tool tương ứng;
automatic config-to-P19 policy wiring vẫn **planned**. Không dùng giá trị 100 từ
P12 để gọi API P19 chỉ cho phép tối đa 10.

Mỗi [workflow seed](../../templates/node-typescript/workflows/) là DAG Developer
cho P19: task có `metadata.ownedPaths`, criterion IDs, retry, rework, timeout và
`requiresApproval: true`. `qualityGates: []` trong seed không tắt kiểm tra: P19
chỉ nhận trusted host `taskChecks`/`workflowChecks` và tự chèn gate độc lập.
Các seed không chứa implementation của gate và chưa đủ để bắt đầu chạy AI.

CLI `bflow run "requirement" --workflow /absolute/workflow.json` đã có loader
`WorkflowDefinitionSchema`; nó đi vào **legacy Runtime**, không gọi
`openAgenticWorkspace`. Không dùng command này như P19 launcher. Không có
`--sdd-level`, `--tdd`, `--role-model`, `--max-iterations` CLI flag ở baseline này.

| Cấu hình | Bflow hay Herdr? |
| --- | --- |
| Repository identity, policies, workflow, storage paths, role/provider/model/effort choices | Bflow config.yml |
| Provider authentication, terminal/UI integration and credentials | Herdr/provider configuration ngoài Bflow config |
| `roles.host.json` | Fragment API `RolePaneManagerConfig`; host nạp tường minh, CLI không đọc |
| Spec assessment, TestStrategy, verification checks, approval authentication | Dossier/host inputs, không phải trường tùy ý trong config.yml |

`BFLOW_HERDR_BIN`/`HERDR_BIN` được legacy Runtime factory đọc; lifecycle dùng
`environment.herdrBinary`. `BFLOW_ENVIRONMENT_MODULE` chọn host ESM có quyền chạy
code, chỉ operator đáng tin đặt trong environment. `HERDR_CONFIG_PATH` chọn config
Herdr; các file Bflow mẫu không chứa TOML Herdr hoặc API key.

Effort được validate theo provider khi preflight. Claude hỗ trợ `low`, `medium`,
`high`, `xhigh`, `max`; Codex hỗ trợ `minimal`, `low`, `medium`, `high`, `xhigh`.
Agy không có trường `effort`; encode mức đó trong tên model. Nếu provider không
hỗ trợ lựa chọn model/effort hoặc CLI thiếu cờ cần thiết, preflight chặn launch
thay vì bỏ qua cấu hình.

Implementation tham chiếu:
[config loader](../../apps/cli/src/config.ts),
[environment loader](../../apps/cli/src/environment-config.ts),
[P12 adapter](../../apps/cli/src/pane-manager-integration.ts),
[P19 workspace](../../packages/runtime/src/agentic/workspace.ts).
