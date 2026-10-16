# Security & Approval

Repository config/template không được chứa token, API key, cookie, password,
private signing key hoặc credential-bearing URL. Đưa credentials vào cơ chế
provider/host bên ngoài source control. `.bflow/.gitignore` do init tạo có các
rule cho state/logs/secrets/env/data/artifacts/registry/DB; ignore không mã hóa dữ
liệu và không gỡ secret đã từng commit. Artifact và logs cũng có thể nhạy cảm.

Chỉ dùng template/agent/host module đáng tin. `BFLOW_ENVIRONMENT_MODULE` là ESM
có quyền thực thi code, do operator chọn qua environment, không lấy từ repo
config. `HERDR_CONFIG_PATH` là config Herdr riêng; Bflow không quản lý credential
provider trong config.yaml. Prompt có thể đi qua argv/process inspection; không
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

Leaf packages không hứa hẹn sandbox hostile same-user. Read-only role flags,
filesystem permissions, branch ownership và command policy cần host kiểm tra;
prompt không cưỡng chế OS permission. Network filesystems, distributed leases,
multi-host và power-loss guarantees vẫn chưa được chứng minh.

Runtime không có tool tự deploy, push, merge protected branch, đổi secret hoặc
access. Không suy ra các quyền đó từ approval task. Worktree cleanup cần writer
đã dừng và scope sạch; `unknown_delivery`/accepted interrupt không chứng minh điều
kiện này. Xem [Session Recovery](session-recovery.md).
