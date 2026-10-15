# Hướng dẫn sử dụng bflow

Bộ tài liệu này mô tả những gì **đã được triển khai** trong repository và cách dùng chúng. Những phần chỉ mới được thiết kế được ghi rõ là **chưa hỗ trợ**. Tài liệu hợp đồng công khai vẫn là [docs/contracts.md](../contracts.md) và [ADR](../adr/); bộ hướng dẫn này không thay đổi hợp đồng.

| # | Chủ đề |
| --- | --- |
| 1 | [Tổng quan kiến trúc](01-architecture-overview.md) |
| 2 | [Yêu cầu môi trường](02-environment.md) |
| 3 | [Cài đặt và cấu hình Herdr](03-herdr-setup.md) |
| 4 | [Cài đặt và khởi tạo bflow](04-install-and-init.md) |
| 5 | [Cấu hình vai trò và mô hình AI](05-roles-and-models.md) |
| 6 | [Chạy workflow feature](06-feature-workflow.md) |
| 7 | [Chạy workflow bugfix](07-bugfix-workflow.md) |
| 8 | [Đọc trạng thái và artifact](08-status-and-artifacts.md) |
| 9 | [Xử lý blocked, timeout, retry và resume](09-blocked-timeout-retry-resume.md) |
| 10 | [Kiểm tra kết quả trước khi hợp nhất mã](10-pre-merge-verification.md) |

Ví dụ chạy được: [examples/sample-repo](../../examples/sample-repo/README.md) và [examples/runtime-demo](../../examples/runtime-demo/README.md).

## Ma trận tính năng

| Khả năng | Trạng thái |
| --- | --- |
| Build, typecheck, test toàn workspace (`pnpm check`) | Hỗ trợ |
| Workflow engine (DAG, retry, rework, approval, gate, recovery) — `@bflow/core` | Hỗ trợ (thư viện) |
| SQLite RunStore, filesystem ArtifactStore, file-backed AgentRegistry | Hỗ trợ (thư viện, một máy, filesystem cục bộ) |
| MVP roles, workflow template `feature`/`bugfix`/`refactor`, prompt rendering, kiểm tra output | Hỗ trợ (thư viện) — `@bflow/agent-registry` |
| Quality gate chạy lệnh (`typecheck`/`lint`/`unit_test`/`build`/`custom`), security policy, RBAC | Hỗ trợ (thư viện) — `@bflow/quality-gates` |
| `createRuntimeService`: start, drive, approve, cancel, resume/recover, watch | Hỗ trợ (thư viện) — `@bflow/runtime` |
| Herdr CLI transport (`createHerdrAdapter`) | Có mã nguồn và unit test với runner giả; **chưa kiểm chứng với Herdr thật** |
| Chạy end-to-end Runtime + Herdr + AI agent thật | **Chưa hỗ trợ** — xem [giới hạn](09-blocked-timeout-retry-resume.md#giới-hạn-đã-biết) |
| Tự thu kết quả agent từ transport (Runtime đọc `wait`/`read`) | **Chưa hỗ trợ** — người gọi phải báo kết quả bằng `completeTaskExecution` |
| CLI thực thi (`bflow init`, `run`, `status`, `approve`, `resume`, `cancel`) | Hỗ trợ — `@bflow/cli` |
| Tự động merge/deploy | **Không hỗ trợ** theo thiết kế; merge cần người phê duyệt |
| Bộ hẹn giờ timeout/retry trong Runtime | **Chưa hỗ trợ** — người gọi phải gọi lại `driveRun`/`resume` |
| Nền tảng đã kiểm chứng | Linux, filesystem cục bộ. macOS: xem [môi trường](02-environment.md#macos) |
