# 10. Kiểm tra kết quả trước khi hợp nhất mã

> **Phạm vi legacy P00–P10.** Trang này giữ API/demo và đánh giá integration ở thời điểm trước P19.
> Dùng [hướng dẫn hiện tại](README.md) cho onboarding, lifecycle/config.yaml và P19.
> Không áp dụng các nhận định integration cũ hoặc thao tác Core trực tiếp để bypass policy P19.

bflow **không tự merge hay deploy**. Run `succeeded` chỉ có nghĩa là workflow đã đi hết các bước với bằng chứng được ghi lại; người duyệt vẫn quyết định merge. Không coi Herdr `done`, ảnh chụp terminal, hay việc một artifact đã được lưu là bằng chứng task thành công.

## Danh sách kiểm tra

1. **Trạng thái run là `succeeded`** và mọi task `succeeded` (`service.getRun`). Không có approval đang mở.
2. **Mọi quality gate bắt buộc `passed`.** Đọc event `quality_gate.evaluated`: `payload.status`, `payload.findings`, `payload.metadata.command`, `metadata.exitCode`, `metadata.workingDirectory`, `metadata.independentOfAgentClaims`. Xác nhận gate chạy đúng lệnh trên đúng thư mục bạn sắp merge.
3. **Approval của con người hợp lệ.** `approval.decided` có `decision: "approved"` và `decidedBy` là định danh người (không bị `isHumanApprover` từ chối). Quyết định của reviewer (`decidedBy: "reviewer"`) là quyết định tự động, không thay cho người duyệt.
4. **Artifact khớp với thay đổi sẽ merge.** Đọc patch/test-result bằng `ArtifactStore.get` (đã kiểm tra checksum) và so với diff thực tế của nhánh. Artifact chỉ chứng minh nội dung được lưu nguyên vẹn, không chứng minh nó đúng.
5. **Tự chạy lại kiểm tra trong worktree sẽ merge**, không dựa vào báo cáo của agent.
6. **Xem lại diff bằng mắt**, đặc biệt là thay đổi về bảo mật, bí mật, cấu hình, migration.

## Công cụ

`examples/runtime-demo/inspect-run.mjs` in phần *Pre-merge governance* bằng `evaluateAutomatedVsHumanGovernance` (`@bflow/quality-gates`) trên event đã lưu:

```text
Pre-merge governance:
  automated gates: passed
  human approval:  approved by demo-operator
  run status:      succeeded
  ready for merge review: YES
```

Với run `--skip-fix` cùng công cụ cho `automated gates: failed`, `run status: blocked`, `ready for merge review: NO` — dù approval của con người đã có. `evaluateAutomatedVsHumanGovernance` chỉ cho `canProceedToDelivery: true` khi **cả hai** điều kiện độc lập đều đạt: mọi gate tự động `passed` **và** có quyết định `approved` của con người. Approval không che được gate fail.

Lưu ý: trong template `feature`/`bugfix`, approval của con người được yêu cầu cho task `review`, tức là **trước** khi QA chạy. Vì vậy vẫn cần kiểm tra kết quả gate QA ở bước 2 sau khi run kết thúc.

## Kiểm tra lại trong repository này

Khi thay đổi chính repository bflow, chạy từ thư mục gốc (theo [AGENTS.md](../../AGENTS.md)):

```bash
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Ghi lại lệnh, exit code, số test pass/fail/skip và commit đã kiểm tra. Kết quả test trên nhánh tính năng không chứng minh trạng thái sau khi hợp nhất từ xa. Trên macOS xem [ghi chú môi trường](02-environment.md#macos).

## Kiểm tra lại với repo mẫu

```bash
cd examples/sample-repo
pnpm test
pnpm repro:bug                                   # chỉ pass sau khi BUG-001 đã được sửa
cd ../..
pnpm exec tsc -p examples/sample-repo/tsconfig.json
```

Demo chạy trên bản sao trong state directory; kiểm tra lại ở `<DIR>/workspace` nếu muốn xác nhận thay đổi mà demo đã áp dụng (`cd <DIR>/workspace && pnpm test`).
