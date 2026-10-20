# Quality Gates & Security Enforcement (`@bflow/quality-gates`)

Kiểm soát chất lượng độc lập, đánh giá command và thực thi bảo mật ở tầng ứng dụng, không bao giờ tin vào các tuyên bố chủ quan của AI agent.

Chạy test từ thư mục gốc repository:
```bash
pnpm exec vitest run packages/quality-gates/test/quality-gates.test.ts
```

---

## 1. Mục đích & Triết lý cốt lõi

Trong vòng đời phát triển phần mềm (SDLC) bằng AI tự động, các agent tự chủ sinh code, thực thi các bước và tuyên bố thành công. Tuy nhiên, thành công do agent tự báo cáo không thể được coi là evidence có thẩm quyền:
- **Zero Trust cho tuyên bố của Agent**: Thành công tự báo cáo (`agentResult.status: "succeeded"`) hay tuyên bố "all tests passed" không bao giờ đủ để vượt qua một quality gate.
- **Thực thi & Evidence độc lập**: Quality gate chạy lại các command xác định (`typecheck`, `lint`, `test`, `build`, hoặc `custom` nằm trong allowlist) trong một subprocess cô lập (`shell: false`), xác minh exit code, luồng stdout/stderr, số lượng test và các evidence artifact có mật mã.
- **Guardrail bảo mật ở tầng ứng dụng**: Việc thực thi được điều chỉnh chặt chẽ bởi các security policy tĩnh, chặn shell injection, command tùy ý do agent cung cấp, thao tác phá hủy đĩa/database, truy cập credential và triển khai production.
- **Kiểm soát truy cập theo vai trò (RBAC) nghiêm ngặt & Human Governance**: Các role tự chủ bị ràng buộc bởi ranh giới đặc quyền tối thiểu (ví dụ reviewer chỉ đọc, developer giới hạn trong worktree, QA giới hạn trong sandbox), và các thao tác delivery (`merge_branch`, `deploy_release`) bắt buộc phải có cả quality gate tự động pass 100% VÀ human approval không thể giả mạo.

---

## 2. Quality Gate Evaluator

Engine đánh giá thực thi các check và chuyển kết quả runtime thành các cấu trúc `QualityGateResult` của `@bflow/contracts`.

### Các loại check được hỗ trợ

| Kind | Mục đích | Command mặc định | Evidence bắt buộc |
| --- | --- | --- | --- |
| `typecheck` | Xác minh TypeScript / compiler tĩnh | `pnpm typecheck` | Exit code 0, output không rỗng |
| `lint` | Thực thi quy tắc và style code tĩnh | `pnpm lint` | Exit code 0, không có finding mức error |
| `unit_test` | Chạy bộ test tự động | `pnpm test` | Exit code 0, số test pass khác 0, không có lỗi |
| `build` | Biên dịch / đóng gói artifact của dự án | `pnpm build` | Exit code 0, output không rỗng |
| `custom` | Tác vụ xác minh nằm trong allowlist tĩnh | `CommandSpec` đã cấu hình | Exit code 0, các assertion output tùy chỉnh |

### Các thành phần chính của Evaluator

- **`CommandQualityGate`**: Triển khai `QualityGate` của `@bflow/contracts`. Đánh giá một `QualityCheckSpec` dựa trên `QualitySecurityPolicy` và `QualityCommandRunner` được inject.
- **`createQualityGate(options)`**: Khởi tạo một `CommandQualityGate` với specification, security policy và runner tùy chỉnh.
- **`createPresetQualityGate(input)`**: Factory tiện lợi cho 5 loại check chuẩn với command preset, xác thực đường dẫn và security policy.
- **`evaluateQualityCheckSuite(gates, context, options?)`**: Thực thi tuần tự một mảng quality gate cho một workflow run/task, tạo ra `QualityCheckSuiteReport` tổng hợp.

### Trạng thái kết quả & Ánh xạ contract

Mỗi quality check tạo ra một `QualityCheckStatus` nội bộ được ánh xạ sang `QualityGateResult` của `@bflow/contracts`:

| Trạng thái nội bộ | Trạng thái contract | Tiêu chí |
| --- | --- | --- |
| `passed` | `"passed"` | Exit code 0, mọi kỳ vọng output được đáp ứng, thu thập được evidence có thể xác minh |
| `failed` | `"failed"` | Exit code != 0, phát hiện pattern output bị cấm, hoặc số test thất bại |
| `skipped` | `"passed"` | Check tùy chọn (`required: false`, `skip: true`) kèm finding mức info `CHECK_SKIPPED` |
| `error` | `"error"` | Lỗi spawn tiến trình, abort signal được kích hoạt, vượt quá timeout, hoặc vi phạm bảo mật |

*Lưu ý*: Nếu một check được đánh dấu `required: true` (hoặc mặc định khi bỏ qua) và `skip: true` được yêu cầu, nó thất bại với finding `REQUIRED_CHECK_SKIPPED_OR_MISSING_EVIDENCE` và trạng thái contract `"failed"`.

### Thu thập Evidence có thể xác minh (`ArtifactProposal`)

Khi một check pass, evidence có thể xác minh được tạo ra:
- Bản ghi thực thi đã serialize gồm command line, thư mục làm việc, exit code, thời lượng thực thi và stdout/stderr.
- `ArtifactProposal` được tạo ra tuân theo `ArtifactProposalSchema`, chứa SHA-256 checksum và kích thước byte chính xác (`expectedIntegrity`).
- ID và checksum của proposal được ghi trong `QualityGateResult.metadata` để đối chiếu với việc ingest `ArtifactStore` ở downstream.

### Báo cáo tường minh task thất bại

Khi thực thi một suite các check qua `evaluateQualityCheckSuite`, các gate thất bại được tổng hợp vào `failedTasks` (`QualitySuiteFailedTaskReport`), nêu chi tiết:
- `taskId`: ID task workflow liên quan.
- `gateId`: Định danh của gate thất bại.
- `checkKind`: Loại check (`typecheck`, `lint`, `unit_test`, `build`, `custom`).
- `status`: `"failed"` hoặc `"error"`.
- `exitCode`: Exit code của tiến trình (hoặc `null` nếu lỗi spawn / timeout).
- `timedOut`: Boolean cho biết tiến trình có vượt quá timeout hay không.
- `summary` & `findings`: Thông báo lỗi chi tiết và các finding chẩn đoán.

---

## 3. Security Policy & Guardrail

`QualitySecurityPolicy` cung cấp các kiểm tra bảo mật phòng thủ nhiều lớp ở tầng ứng dụng trước khi bất kỳ subprocess nào được spawn.

### Các bất biến thực thi

1. **Luôn `shell: false`**: Mọi subprocess được gọi trực tiếp qua `child_process.spawn` với `shell: false` và các đối số được truyền dưới dạng mảng token rời rạc. Các shell interpreter (`sh`, `bash`, `zsh`, `cmd`, `powershell`) bị chặn nghiêm ngặt.
2. **Từ chối command tùy ý của Agent**: Các chỉ thị trong output của agent cố chỉ định shell command, ghi đè command hoặc đặt `skipQualityGates: true` bị chặn và từ chối với finding `UNTRUSTED_AGENT_COMMAND_REJECTED`.
3. **Allowlist executable & đối số**: Chỉ các executable được phê duyệt trước (`pnpm`, `npm`, `npx`, `tsc`, `vitest`, `eslint`, `git`) khớp với các tiền tố đối số cụ thể mới được phép.
4. **Chặn các command phá hủy**:
   - Phá hủy filesystem: `rm`, `rmdir`, `shred`, `unlink`, `mkfs`, `fdisk`, `dd`, `truncate`.
   - Thao tác Git phá hủy: `git reset --hard`, `git clean`, `git push --force`, `git branch -D`, `git checkout --`.
   - Phá hủy database: `dropdb`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`, `prisma migrate reset`, `db:drop`, `db:reset`.
5. **Chặn truy cập secret & exfiltration qua mạng**:
   - Pattern file secret: `.env`, `.ssh`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.aws/credentials`, `/etc/shadow`, `/etc/passwd`, `/proc/self/environ`.
   - Binary exfiltration: `curl`, `wget`, `nc`, `netcat`, `ncat`, `scp`, `sftp`, `ssh`, `ftp`, `socat`.
   - Làm sạch môi trường: `sanitizeExecutionEnvironment` loại bỏ mọi API key nhạy cảm (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, v.v.).
6. **Chặn triển khai production trái phép**:
   - Công cụ deployment bị chặn: `kubectl`, `helm`, `terraform`, `pulumi`, `ansible-playbook`.
   - Command publish bị chặn: `npm publish`, `pnpm publish`, `git push`, `docker push`, `fly deploy`, `vercel --prod`, `netlify deploy --prod`, `serverless deploy`.
7. **Giới hạn phạm vi thư mục**:
   - Xác thực rằng đích thực thi là thư mục hợp lệ, không có đoạn traversal `..` hay byte NUL.
   - Phân giải đường dẫn canonical bằng `fs.realpath` để đảm bảo đường dẫn đích nằm hoàn toàn trong `allowedRootDirs` và trong `assignedWorktreePath`.
   - Từ chối các đường dẫn hệ thống nhạy cảm (`/etc`, `/proc`, `/sys`, `/root`, `/dev`).
   - Phát hiện symlink thoát ra ngoài cây thư mục được ủy quyền.
8. **Xác thực ngân sách timeout**:
   - Xác thực cận số nguyên của timeout (`100ms <= timeoutMs <= 2,147,483,647ms`) để ngăn tràn số nguyên có dấu 32-bit.
   - Thực thi trần policy `maxExecutionTimeoutMs`.
   - Trên POSIX, chạy command trong một process group riêng và gửi tín hiệu cho cả group khi timeout hoặc abort. Sau thời gian ân hạn 250ms, gửi `SIGKILL`, đóng các output pipe, và trả về ngay cả khi một descendant đã thoát ra vẫn giữ pipe. Windows kết thúc child trực tiếp và dùng cùng cách dọn dẹp pipe có giới hạn.

---

## 4. Kiểm soát truy cập theo vai trò (RBAC) & Human Governance

Quality policy định nghĩa sự phân tách nhiệm vụ nghiêm ngặt giữa bốn role SDLC:

### Ma trận ủy quyền theo role

| Role | Chỉ đọc | Hành động được phép | Ràng buộc |
| --- | --- | --- | --- |
| `reviewer` | **Có** | `read_code`, `analyze_code` | Nghiêm cấm sửa file (`modifiedFiles` phải rỗng). |
| `developer` | **Không** | `read_code`, `analyze_code`, `modify_code`, `run_local_check` | Việc sửa file và check phải nằm hoàn toàn trong `assignedWorktreePath`. Không thể merge hay deploy. |
| `qa` | **Có** | `read_code`, `analyze_code`, `execute_test_suite`, `evaluate_quality_gate` | Chỉ được phép trong môi trường non-production được ủy quyền (`test`, `ci`, `qa-sandbox`). Cấm sửa file. |
| `delivery` | **Không** | `read_code`, `merge_branch`, `deploy_release` | Yêu cầu quality gate tự động pass 100% VÀ quyết định human approval hợp lệ. |

### Phân tách nghiêm ngặt giữa Check tự động & Human Governance

Hàm `evaluateAutomatedVsHumanGovernance` thực thi rằng:
- **Agent không tự phê duyệt**: Human approval bắt buộc không thể được cấp bởi AI agent hay bot tự động (nhận diện qua `isHumanApprover`, hàm này từ chối các định danh có tiền tố `agent:`, `ai:`, `bot:`, `llm:`, v.v., hoặc `metadata.automatedOnly: true`).
- **Hai điều kiện cho Delivery**: `canProceedToDelivery: true` bắt buộc phải có:
  1. `allAutomatedGatesPassed: true` (không có automated gate nào thất bại hoặc lỗi).
  2. Nếu cần human approval, `humanApprovalStatus === "approved"` được ký bởi một human actor đã xác minh.
- **Bất biến Fail-Safe**: Chỉ riêng human approval không thể ghi đè hay che giấu các quality gate tự động đang thất bại. Cả hai điều kiện đều phải được thỏa mãn.

---

## 5. Hạn chế bảo mật ở tầng ứng dụng

> [!WARNING]
> Xác thực policy ở tầng ứng dụng **KHÔNG** phải là sandbox kernel hệ điều hành, container (Docker/Podman), máy ảo, hay cơ chế cô lập seccomp/AppArmor/cgroup.

Theo báo cáo của `getSecurityControlLimitationsReport()` và định nghĩa trong `APPLICATION_SECURITY_LIMITATIONS`:

1. **Đặc quyền tiến trình host**: Khi một binary trong allowlist (`node`, `pnpm`, `vitest`, `tsc`) bắt đầu chạy, tiến trình con chạy với cùng quyền người dùng OS như tiến trình host. Nó có thể truy cập bất kỳ file hay socket nào mà tài khoản người dùng OS có quyền đọc hoặc ghi.
2. **Thực thi code không tin cậy trong công cụ**: File test, script dự án, compiler plugin hay build script do một runner trong allowlist thực thi có thể chứa code tùy ý được runtime bên dưới thực thi.
3. **Time-of-Check to Time-of-Use (TOCTOU)**: Việc canonical hóa đường dẫn trước khi thực thi (`fs.realpath`) xác minh đường dẫn nằm trong thư mục được phép trước khi khởi chạy, nhưng không thể ngăn race condition khi một tiến trình đang chạy đồng thời thay đổi symlink trong lúc thực thi.
4. **Filesystem so với làm sạch môi trường**: Làm sạch `process.env` ngăn API key bị kế thừa qua biến môi trường, nhưng không ngăn các tiến trình con đọc các file cấu hình không mã hóa trên filesystem cục bộ nếu người dùng đọc được.
5. **Vòng đời tiến trình cháu (grandchild)**: Việc kết thúc process group trên POSIX bao phủ các descendant thông thường. Các descendant tạo session hoặc process group mới có thể thoát khỏi việc kết thúc và sống lâu hơn command; việc kết thúc trên Windows chỉ bao phủ child trực tiếp. Việc dọn dẹp pipe có giới hạn ngăn các descendant đó chặn việc hoàn tất của runner, nhưng không cung cấp cô lập cgroup của OS.

**Defense-in-Depth khuyến nghị**:
Trong môi trường production và CI không tin cậy, package quality gate ở tầng ứng dụng này phải được đặt bên trong các sandbox cấp OS (ví dụ container không phải root, rootless Podman, Linux namespace hoặc VM cô lập).
