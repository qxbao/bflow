# Portable Node.js/TypeScript templates

Các mẫu không chứa secret, credential, approval receipt hoặc trusted artifact giả.
Chúng được đối chiếu với implementation tại baseline ghi trong
[VALIDATION.md](VALIDATION.md). Xem [Configuration Reference](../../docs/guide/configuration-reference.md)
để phân biệt config CLI và host API; CLI không tự nạp thư mục này.

| Asset | Consumer / trạng thái |
| --- | --- |
| `config.fragment.json` | Merge tường minh vào config do init sinh; P12 đọc role/lifecycle fields, validate policy fields |
| `apply.mjs` | Helper cho checkout đã init và chưa có lifecycle state; giữ identity/storage/runtimeId, backup rồi thay workflow/policy |
| `roles.host.json` | Fragment `RolePaneManagerConfig`, đủ tám topology roles; host composition riêng, không được CLI/P19 factory tự nạp |
| `workflows/{feature,bugfix,refactor,docs}.json` | `WorkflowDefinition` v1 với Developer-only DAG cho P19; chưa có runner/check implementation |
| `sdd/*.assessment.json` | `ChangeAssessmentSchema` đầu vào P15 |
| `specifications/*.spec.json` | Draft `SpecificationDocumentSchema` v2; P15 metadata, P16 assessment và strategy đã resolve |
| `messages/task-status.json` | `RoleMessageSchema` v2 minh họa; IDs giả minh họa, không phải physical receipt |
| `verify.mjs` | Schema/loader/policy và CLI probes trong disposable Git repositories |

Từ một Bflow checkout đã install/build, với `BFLOW_HOME` là absolute path:

```sh
node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name my-project
node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix
node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json
```

Thay `bugfix` bằng `feature`, `refactor`, `docs`. Helper chủ động thay
`defaultWorkflow` và toàn bộ key thuộc fragment `environment`; không phải merge
giữ các giá trị role/policy tùy chỉnh cũ. Backup ở `.bflow/data/`, được init ignore.
Không chạy helper đồng thời với thao tác lifecycle/config khác. Nếu đã có
`.bflow/state`, helper từ chối để operator review thay đổi; không xóa state để lách.

Các draft dùng `example-*` run IDs, `example-session`, timestamp cố định và bài tập
cụ thể của [portable-node](../../examples/portable-node/README.md). Trước workflow
thật, host rebind run/session, sửa scope/criteria/assessment theo yêu cầu intake,
resolve lại strategy/decision IDs, đưa qua P15 review/approval và freeze dossier.
Seed feature chỉ chứa một tiêu chí ban đầu; yêu cầu đầy đủ ở `requests/feature.md`
cần thêm criteria trước khi chấp nhận. Không chỉnh sửa JSON approved hoặc tự đặt
artifact URI. Không có command tự import/approve các spec mẫu vào Runtime.

`environment.verification.maxIterations: 3` là policy được lưu, chưa tự truyền
vào Runtime. Host gọi `propose_workflow` với `maxIterations: 3` riêng, cấu hình
taskChecks/workflowChecks, deterministic runners và human/authenticated evidence
ports. `requiresApproval: true` trong task seed bảo vệ task; không thay thế design
approval hoặc delivery approval. Các trường SDD/TDD không cho phép bỏ các gate đó.

Mỗi task seed có `metadata.ownedPaths` là literal repository prefixes; điều chỉnh
cho dự án thật và spec. Không biến chúng thành glob hoặc cho phép Developer ghi
root/config/secret tùy tiện. P19 chỉ nhận implementation DAG Developer; specialist
được giao bằng Runtime tool. QA/Reviewer checks thuộc trusted host, không phải node
do agent thêm để tự review.

Kiểm tra assets sau build:

```sh
node "$BFLOW_HOME/templates/node-typescript/verify.mjs"
```

Script parse exported schemas, resolve/validate policy và gọi CLI init thật trên
hai repo cùng basename, kiểm tra identity isolation, repeat/subdirectory init,
template merge, moved config/YAML rejection và guard không sửa repo đã có state.
Nó cũng xác nhận `init --force` **ghi đè** theo code thực tế, khác help hiện tại.
Nó không chạy agent, tự phê duyệt, tạo PR/push/merge hoặc triển khai host P19.
