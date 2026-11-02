# Bflow Web: trạng thái handoff UX-01..UX-28

**Cập nhật:** 30/10/2026. **Mức bằng chứng:** source và test cục bộ; chưa chạy live với Herdr/provider thật và chưa thử giao diện bằng tay.

## Trạng thái

| Trạng thái | Mục | Ghi chú |
|---|---|---|
| Đã xử lý | UX-03, 06, 07, 09, 13, 14, 15, 17, 18, 19, 21, 22, 23, 24, 27, 28 | UX-09 đã có sẵn trong source. UX-28 mới có test tự động, chưa thử tay. |
| Một phần | UX-01 | Chỉ có quy tắc trong prompt Coordinator, chưa có chặn cứng; Runtime chưa có đường tạo vòng Red mới có lineage. |
| Một phần | UX-02 | Có blocker và bước đang chờ; lease hết hạn mà Runtime chưa ghi nhận thì trang vẫn báo “Đang xử lý”. |
| Một phần | UX-04 | Xem lại được gói đã duyệt; Runtime chỉ giữ approval mới nhất nên thiết kế cũ mất khi có approval của task hoặc bàn giao. Chưa có DAG và chưa mở theo revision. |
| Một phần | UX-08 | Có giải thích lỗi đọc dữ liệu, chưa phân loại được nguyên nhân. |
| Một phần | UX-10 | Có giải thích trạng thái chuyển tin, chưa có mốc Runtime đã nhận. |
| Một phần | UX-11, UX-12 | Lọc chat theo công việc; không có nguồn thông báo riêng để gom nhóm. |
| Một phần | UX-16 | Có tuổi snapshot, chưa biết trạng thái thuộc role nào. |
| Một phần | UX-25 | Gợi ý model từ các vai trò khác; chưa kiểm tra trước khi lưu, chưa có preset. |
| Một phần | UX-26 | Có hướng dẫn onboarding, chưa có liên kết tới đúng pane. |
| Chưa làm được | UX-05, UX-20 | Có “Bước hiện tại”, nhưng tiến độ Red/Green/Refactor và tiến độ QA cần thêm trường vào contract chung. |

## Việc còn mở

- **Cần chủ dự án quyết định:** thêm trường vào `WebRunView` và `WebTransportSummary` để làm tiếp UX-05, UX-20 và phần role của UX-16. `AGENTS.md` yêu cầu duyệt mọi thay đổi contract chung.
- **Tài liệu chưa đối chiếu:** `WORK-LOG.md`, `UX-NOTES.md` và `UX-HANDOFF.md` không có trong repo. Ở mục 5 của handoff, chỉ mới xác nhận giới hạn journal 64 MB và sửa chat cold start có trong source.

## Kiểm chứng tại `457f2fc` cộng thay đổi của đợt này

Chạy trên macOS với `TMPDIR=$(realpath "$TMPDIR")`; thiếu biến này sẽ fail 114 test Vitest, phần lớn do thư mục tạm.

- `pnpm check:deps`, `pnpm typecheck`, `git diff --check`: đạt.
- `pnpm --filter @bflow/web test`: 87/87 pass.
- `vitest run` toàn repo: 6199 pass, 11 fail, 466 skip.
  - 8 fail cũng có ở bản gốc: `policy-prompt` (4), `interaction/events` (2), `interaction/artifacts` (1), `gateway-control-client` (1).
  - 3 fail chỉ xuất hiện khi chạy song song: `integration-p19-conflicts-reviews` (2), `behavioral-runner-output` (1). Chạy riêng hai file này: 38/38 pass.
- Playwright: 8 pass, 2 fail, 1 skip. `build.spec` dùng `script -c` của Linux nên fail trên macOS cả ở bản gốc. `chat.spec` fail 5/5 khi chạy lặp ở bản gốc và chỉ thỉnh thoảng pass.
