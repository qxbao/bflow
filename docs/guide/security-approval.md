# Security & Approval

Repository config/template không được chứa token, API key, cookie, password,
private signing key hoặc credential-bearing URL. Đưa credentials vào cơ chế
provider/host bên ngoài source control. `.bflow/.gitignore` do init tạo có các
rule cho state/logs/secrets/env/data/artifacts/registry/DB; ignore không mã hóa dữ
liệu và không gỡ secret đã từng commit. Artifact và logs cũng có thể nhạy cảm.

Chỉ dùng template/agent/host module đáng tin. `BFLOW_ENVIRONMENT_MODULE` là ESM
có quyền thực thi code, do operator chọn qua environment, không lấy từ repo
config. `HERDR_CONFIG_PATH` là config Herdr riêng; Bflow config.yml cho phép chọn
provider/model/effort theo role nhưng không quản lý credential provider. Prompt có thể đi qua argv/process inspection; không
nhúng bí mật vào requirement/instruction.

Các gate độc lập và danh tính human phải do trusted host thực thi. Không thay
authentication bằng callback luôn `true`, agent-supplied `humanOverrideApproved`
hoặc một chữ "approved" trong terminal. Các mẫu đều là draft, không có artifact
URI/approval receipt giả và không tự cấp quyền implementation.

| Điểm chặn | Consumer thực thi |
| --- | --- |
| Spec/design acceptance và project implementation approval | P15/P19, human decision bind dossier bundle qua Conversation |
| Required TDD trước ghi implementation | P16/P19 và host write boundary, cần independent Red |
| Task `requiresApproval: true` | Core/P19 chặn completion/dependent dispatch theo decision đúng task revision/generation |
| Independent task/workflow verification | P17 với trusted host checks/Reviewer/QA, exact revision/evidence |
| Delivery approval | P19, sau post-integration verification và kiểm tra clean pinned revision |

V2 nhận approval qua Conversation Gateway và trusted `authorizeHuman` của host.
Các giá trị `ApprovalStatus` gồm pending/approved/changes_requested/rejected/
expired/cancelled/superseded. Rejection dừng scheduling tiếp; changes_requested
không bỏ rework/iteration bounds. Một approval không cấp quyền cho hành động khác.

Legacy CLI có cú pháp đã triển khai:

```sh
bflow approve review --run run-123 --decision approved --by alice
bflow approve review --run run-123 --decision changes_requested --by alice --reason "Bổ sung bằng chứng edge case"
```

Phải dùng task/run/revision/generation có thật, đúng approval đang chờ. `--by`
không phải đăng nhập/SSO. Command này ghi legacy task decision, không phải API
approval dossier P19. Không dùng CLI legacy để bỏ host approval authentication.

## Duyệt hook global của Codex

Operator duyệt hook bằng một luồng setup riêng, trước khi chạy role Codex:

```sh
bflow setup --codex-hooks --plan
bflow setup --codex-hooks --apply
bflow setup --codex-hooks --check
```

`--plan` chỉ đọc và hiển thị event, command, file phụ thuộc, SHA-256 và digest của
toàn bộ snapshot. `--apply` hiển thị bản review rồi hỏi xác nhận trong terminal.
Khi không có terminal tương tác, phải truyền cả `--yes` và digest vừa review:

```sh
bflow setup --codex-hooks --apply --yes --hook-digest <snapshot-digest>
```

`setup --yes` thông thường không duyệt hook. Hook mode không cài tool/plugin,
không sửa config global của provider và không chạy hook trong lúc review.
`--check` trả exit code khác 0 nếu hook chưa được duyệt hoặc không hỗ trợ.

Phê duyệt được lưu trong state riêng của Bflow tại
`${XDG_STATE_HOME:-$HOME/.local/state}/bflow/codex-hook-approvals.json`, với file
`0600` và thư mục cha private. Setup cô lập qua `BFLOW_HOME` dùng
`$BFLOW_HOME/state/codex-hook-approvals.json` cùng Codex home cô lập. Record gắn
với đúng Codex home và digest; repo config không chọn được trust store này.

`up`, probe và launch dùng cùng `HOME`/`CODEX_HOME` đã kiểm tra. Thay đổi command,
hook, script, interpreter được pin hoặc đường dẫn Orca sẽ làm snapshot cũ không
khớp. Bflow kiểm tra trước probe, trước khi trả launch profile và khi activation.
Metadata native `hooks.state` không thay thế phê duyệt Bflow. Chỉ phần hook thực
thi của TOML được đưa vào digest; credential và cấu hình MCP không được đưa vào.

Dạng shell chưa hỗ trợ, nguồn file có quyền ghi theo nhóm/người khác, hoặc state
không private tiếp tục bị chặn. Operator cần kiểm tra quyền của đúng file/thư mục
được báo rồi chạy lại plan; Bflow không tự chmod Codex home. Orca chỉ được hỗ trợ
với command wrapper và nội dung script đã nhận diện; bản Orca mới chưa nhận diện
cần cập nhật bộ kiểm tra. Nếu `ORCA_AGENT_HOOK_ENDPOINT` chọn file shell động,
luồng này vẫn chặn và không đọc nội dung token trong file đó.

Phê duyệt cho phép chạy đúng hook đã review trong quyền hiện có của role; nó
không cấp thêm quyền, không bỏ các gate SDLC và không chứng minh sandbox toàn
process hay tính bất biến của mọi dependency gián tiếp. Hook approval không phải
task/spec/delivery approval qua Conversation.

Quyết định tương thích: theo yêu cầu project owner, đây là cấu hình setup/provider
bổ sung. Giữ nguyên `@bflow/contracts`, event/checkpoint codec và permission modes;
không có migration database. Cập nhật CLI, provider và Runtime cùng nhau, dừng host
cũ trước khi đổi platform configuration. Bằng chứng hiện tại là source và local
tests; chưa phải live Codex/Herdr hoặc full SDLC acceptance.

Leaf packages không hứa hẹn sandbox hostile same-user. Read-only role flags,
filesystem permissions, branch ownership và command policy cần host kiểm tra;
prompt không cưỡng chế OS permission. Network filesystems, distributed leases,
multi-host và power-loss guarantees vẫn chưa được chứng minh.

Runtime không có tool tự deploy, push, merge protected branch, đổi secret hoặc
access. Không suy ra các quyền đó từ approval task. Worktree cleanup cần writer
đã dừng và scope sạch; `unknown_delivery`/accepted interrupt không chứng minh điều
kiện này. Xem [Session Recovery](session-recovery.md).
