# Bflow Web Visualization Mode — xác nhận ngày 2026-11-02

Trạng thái: **chưa đủ điều kiện nghiệm thu/phát hành**. Không push, merge hay tạo PR. Đây là báo cáo source, test cục bộ và phép đo fixture trên GPU thật; chưa có live SDLC V9.

## Phạm vi và revision

- Nhánh `agent/web/visualization-mode`, baseline `247faf9c`, HEAD đầu phiên `15cc644bc9eb1353d7ee5651f0ca91f8902724e3`.
- Đọc plan trong checkout chính, áp phần “Điều chỉnh 2026-11-02” và “Tham chiếu hình ảnh”; giữ Three.js thuần `0.187.0`, CSP, Classic mặc định và token tối trong `.office-3d`.
- Hai bản sửa sau xác nhận: projection chỉ đọc không gán identity cũ sang agent mới theo role và không khớp identity sai role; stage abort và hủy renderer trả về muộn sau context-loss. Không thêm điều phối hay quyền Runtime, không đổi hợp đồng.
- Không sửa `AGENTS.md` hay `docs/guide/**`. Bộ GLB vẫn là tài nguyên khởi đầu, còn việc chốt bộ cuối/giấy phép trước phát hành.

## Xác nhận đúng tại 15cc644b

Chạy tuần tự, không chồng Playwright. Node `24.16.0`, pnpm `12.5.1`.

| Lệnh | Kết quả |
| --- | --- |
| `pnpm check:deps` | PASS |
| `pnpm typecheck` | PASS |
| `git diff --check 247faf9c..HEAD` | PASS |
| `pnpm run build` | PASS |
| `pnpm --filter @bflow/web test` | 374/374 PASS |
| `pnpm --filter @bflow/local-server test` | 65/65 PASS |
| `npx vitest run packages/contracts packages/runtime/test/interaction` | 391/391 PASS |
| `pnpm test:affected --base 247faf9c --run` | FAIL: mở rộng thành full; 479 file pass / 38 fail / 7 skip; 6956 test pass / 126 fail / 89 skip, 933,79 giây Vitest |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web test:e2e` | 31 PASS, 1 SKIP, 1 FAIL, 3,2 phút |

Lỗi E2E ở `direct-actions.spec.ts:84`, cùng kỳ vọng link “Mở công việc hiện hành →” đã ghi trong ledger baseline; tệp này giống từng byte với baseline. Tất cả `office-*` PASS, kể cả ảnh camera equality, a11y bốn kích thước, recovery, CSP và 50 lần đổi mode. Một lần chạy không chứng minh hết flaky.

Full affected có lỗi guard sở hữu/quyền thư mục, hook/profile kế thừa và timeout. Không phân loại toàn bộ 126 lỗi là baseline hoặc vô hại. Danh sách và output đầy đủ nằm trong ledger; chưa có full-suite green nên không tuyên bố branch xanh.

## Xác nhận sau đợt sửa

Chạy lại tuần tự: `check:deps`, `typecheck`, `git diff --check`, build PASS; web **375/375**, contracts + Runtime interaction **393/393**, Local Server **65/65** PASS. Full Playwright lần cuối **31 PASS / 1 SKIP / 1 FAIL**, 3,2 phút, vẫn chỉ `direct-actions.spec.ts:84`; tất cả `office-*` PASS. Không thay timeout hay phép so ảnh để đạt kết quả này.

Không chạy lại full affected sau đợt sửa: lượt full gốc đã có 126 lỗi ngoài các regression được sửa, nên gate full-suite vẫn đỏ; không dùng các suite scoped để tuyên bố toàn nhánh xanh. Output ở `verification-final/`. Self re-review diff F1/F2 không thấy regression thêm; độc lập Sonnet/Haiku vẫn chưa có verdict.

## Đo lại sau compileAsync/yield (V8.6)

Chrome headed trên `ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (ADL-S GT1), OpenGL 4.6)`, 1280×800, 30 agent fixture, 20 lần đổi mode, build tại `15cc644b`. Không có test/Playwright khác do phiên này chạy chồng phép đo; máy vẫn có các ứng dụng người dùng khác, snapshot tài nguyên giữ trong ledger. Không coi fixture này là live Herdr/provider.

| Chỉ số | Kết quả mới | Ngân sách / verdict |
| --- | ---: | --- |
| Chunk đồ họa gzip | 171,1 KiB | <250 KiB: PASS |
| GLB tổng | 0,657 MiB | <4 MiB: PASS |
| Moving cả cửa sổ | 22,14 fps | 30 fps: **FAIL** |
| Burst liên tiếp (chỉ tham khảo) | 29,51 fps | Không dùng làm verdict |
| Idle | 7,87 fps | ≤8: PASS; bị giới hạn timer, không đo sức GPU |
| Tab ẩn mô phỏng | 0 frame | 0: PASS cho handler mô phỏng |
| Long task lúc vào cảnh | 2; lớn nhất 411 ms | ≤50 ms: **FAIL** |
| Long task sau load | 0 | PASS trong cửa sổ đo |
| Heap sau đóng cảnh, forced GC | 7,78 → 8,99 MiB / 20 toggles | Quan sát, chưa chứng minh không rò dài hạn |
| Context WebGL sống sau mỗi lần rời cảnh | 0 | PASS trong mẫu đo |

Không nới ngưỡng. `compileAsync` chưa giải quyết ngân sách load; `build()` vẫn schedule RAF trước khi warm hoàn tất, và character material chỉ xuất hiện khi apply model. Chưa có trace phân bổ chi phí chi tiết từng bước hay phép đo high-tier riêng.

## Review và đợt sửa

Hai review độc lập Sonnet (scoped V8 fixes, toàn nhánh) không tạo được verdict. Lần đầu dùng nhầm HOME của Codex; kiểm tra lại thấy Claude đã đăng nhập ở `/home/baodq/.claude`. Khi gọi đúng thư mục, Claude báo hết usage 5 giờ, reset lúc 19:00 Asia/Bangkok; chủ dự án đã xác nhận quota cạn. Không đổi sang model ngoài Sonnet/Haiku. Self-review có ghi rõ phạm vi, không thay thế review độc lập.

- **F1 Important:** explicit agentId cũ không còn trong manifest bị fallback sang uniqueByRole. Hai test RED rồi GREEN (20/20 workforce), pin cả việc lẫn endpoint handoff. Sửa chỉ projection, không thay authority Runtime.
- **F2 Important:** context-loss lúc factory pending vẫn nhận late renderer, làm giữ tài nguyên sau fallback. Test RED rồi GREEN (17/17 stage); kiểm abort, destroy đúng một lần và không apply.
- **Timeout workflow 240s:** giữ như trần tổng kịch bản nhiều bước/cửa sổ theo dõi hiệu ứng, mỗi điều kiện vẫn timeout riêng. Không dùng làm budget latency sản phẩm.
- **Ảnh a11y tuyệt đối:** giữ nguyên, đã qua E2E mới; còn rủi ro máy chậm/settling, chưa có bằng chứng tái hiện flaky lần này.
- **Minors:** triage đủ 12 dòng lịch sử trong `resume-deferred-triage.md`, phân biệt đã được xử lý/superseded với các mục còn để lại. F3 mới: Activity lấy 8 dòng cuối của trang newest-first; còn mismatch tên “gần đây”. Các thiếu sót coverage, duplicate Activity aria-label và canvas focus opener vẫn deferred.

Re-review bản sửa: xem ledger; review độc lập vẫn mở đến khi có quota Sonnet/Haiku.

## V9 — chưa nghiệm thu

Không có run ID V9, không có đối chứng 5 mốc, chưa có hai Developer thật song song, chưa chạy fault campaign và chưa đo thời gian đối chứng Classic. Không mượn live run lịch sử của nhánh khác để đóng V9.

Đã chuẩn bị repo Git dùng một lần, tất cả role `codex`, model `gpt-6-luna`, profile `personal`; Conversation/Planner/Specifier/Developer/SOS effort `low`, Coordinator/Architect/Reviewer/QA `medium`, `maxConcurrency=2`. Herdr cài trên máy `0.9.5`, Codex `0.166.0`. Profile `personal` qua linked backend được xác nhận bằng catalog access, **chưa là bằng chứng inference/task success**.

Preflight chỉ dùng CLI build từ worktree với HOME/BFLOW_HOME riêng:

1. Setup trên scratch NTFS bị guard từ chối vì thư mục trả uid=0 trong khi process uid=1000; không thay guard.
2. Chuyển filesystem local; setup timeout 180s trong bước `install-gitnexus`. Receipt giữ trạng thái `started`; không tự phát lại uncertain mutation, không tự đánh dấu setup hoàn tất.
3. `init --provider codex --no-gitnexus` thành công; doctor thấy config đúng, auth Codex và sandbox verification sẵn sàng nhưng báo thiếu exact skill pins và lỗi độ dài socket Herdr trong HOME cô lập. Doctor tổng thể không healthy.
4. Probe `bflow web --no-open` có log URL nhưng endpoint không truy cập được sau đó; không coi dòng log hay process sống ở mốc 35s là server ready. Chưa khởi động provider pane/workflow V9 qua UI.

Cần hoàn tất readiness ở môi trường local với đường dẫn socket ngắn và exact skills, giữ nguyên policies/human gates; sau đó mới chạy toàn bộ §8.4 và ghi run IDs/evidence thật.

## Nơi giữ bằng chứng và ruling

Ledger ngoài Git (không xóa): `.superpowers/sdd/2026-11-02-web-visualization-mode/` tại checkout chính.

- `progress.md`: chỉ nối thêm, giữ tất cả ruling cũ và mới.
- `resume-review-findings.md`, `resume-deferred-triage.md`, `resume-fix-rereview.md`: self-review/triage/re-review đợt sửa.
- `resume-rulings-index.md`: chỉ mục đủ 28 dòng Ruling nguyên văn có trong ledger khi kết thúc rà soát.
- `resume-scoped-review-sonnet.md`, `resume-whole-review-sonnet.md`: lỗi quota, không phải review PASS.
- `verification-15cc644b/`: các log gốc, error index, kết quả đo JSON và machine context.
- `resume-F1-red.log`, `resume-F1-green.log`, `resume-F2-red.log`, `resume-F2-green.log`: chứng cứ hồi quy.
- `verification-final/`: xác nhận sau đợt sửa.
- `v9-preflight/`: plan/setup receipts reference, cấu hình, doctor và log khởi động; chưa là V9 live.

Ruling mới: giữ ledger theo lệnh owner; timeout 240s là trần test tổng; không đổi screenshot khi chưa tái hiện flaky; không thay review độc lập bằng self-review/quota fallback; không gọi phép đo fixture hay catalog access là live acceptance. Chi phí: còn gate review, full suite và V9 trước khi owner quyết định merge/phát hành.
