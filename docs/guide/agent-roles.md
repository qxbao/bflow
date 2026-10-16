# Agent Roles

Tên hiển thị, topology role và contract role không phải lúc nào cũng giống nhau.
Trong `environment.roles[].role`, dùng contract role của bảng này; alias `chat`,
`analyst`, `qa-verifier` dùng ở API topology/profile, không phải giá trị thay thế
trong lifecycle config.

| Vai trò | Topology key | Contract/config role | Trách nhiệm |
| --- | --- | --- | --- |
| chat | `chat` | `conversation` | Giao diện user duy nhất, làm rõ yêu cầu, báo tiến độ, nhận quyết định |
| coordinator | `coordinator` | `coordinator` | Lập spec/DAG, gọi Runtime tools, giao specialist khi cần |
| analyst | `analyst` | `specifier` | Phân tích yêu cầu, criterion IDs, scope và tác động |
| architect | `architect` | `architect` | Thiết kế, API/data/security/rollback và tradeoff |
| planner | `planner` | `planner` | Phân rã task, dependency, traceability và ownership |
| developer | `developer` | `developer` | Thực thi task trong worktree riêng, cung cấp patch/test evidence |
| reviewer | `reviewer` | `reviewer` | Review độc lập, verdict dựa trên exact revision và evidence |
| qa-verifier | `qa-verifier` | `qa` | Verification độc lập, criterion coverage, TDD evidence |

Mẫu CLI tạo bảy permanent roles bằng `codex`, tất cả `required: true`. Ví dụ entry:

```json
{ "role": "specifier", "cli": "codex", "required": true }
```

`cli` phải là supported agent kind trên PATH; P12 không nhận command kèm args hoặc
absolute executable path cho role. Danh sách authoritative ở
[P13 types](../../packages/pane-manager/src/types.ts). Agent đã cài nhưng chưa đăng
nhập có thể blocked; trạng thái đó không phải bằng chứng version không tương thích.

Developer không được thêm vào permanent `environment.roles`: adapter sẽ từ chối.
Runtime/P13 cấp Developer theo task + Git worktree và capacity. Cấu hình cho cả
tám topology roles nằm trong [roles.host.json](../../templates/node-typescript/roles.host.json):
đó là fragment `RolePaneManagerConfig` cho embedder, bổ sung sessionId/projectName/
workspaceRoot thật. CLI không tự nạp fragment này, và P19 workspace factory hiện
không expose tùy chọn `roleConfigs`; muốn dùng fragment cần host composition P13
tường minh. Model/provider/args của P13 API không thành CLI config flag.

Các prompt/profile đã có ở `agents/chat`, `agents/coordinator`, `agents/analyst`,
`agents/architect`; MVP prompts của planner/developer/reviewer/qa nằm trong
`packages/agent-registry/src/prompts.ts`, verifier prompt ở `agents/verifier`.
Host phải đăng ký prompt và tools phù hợp; `up` không tự đọc các file đó.

Conversation không sửa source hoặc dispatch Developer. Coordinator chỉ thực thi
qua Runtime. Analyst/Architect/Planner/Reviewer/QA là read-only theo chính sách;
host phải thi hành quyền ghi ở process/worktree. Prompt và
`readOnlyWorkspace: true` không tạo sandbox của OS. Mọi role gửi dữ liệu qua
[RoleMessage](herdr-communication.md), không ghi file để giả lập mailbox.
