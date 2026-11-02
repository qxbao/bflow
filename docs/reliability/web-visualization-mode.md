# Bflow Web Visualization Mode — xác nhận ngày 2026-11-02

Trạng thái: **chưa đủ điều kiện nghiệm thu/phát hành**. Không push, merge hay tạo PR. Báo cáo gồm source, test cục bộ, phép đo fixture GPU thật và một phiên V9 live bị chặn trước dispatch Developer; chưa có nghiệm thu SDLC đầu-cuối.

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

## V9 — đã chạy thật, chưa nghiệm thu đầu-cuối

Source chạy: `e44b451f`; Herdr `0.9.5`, protocol 22; Codex `0.166.0`, profile `personal`, model **GPT-6-Luna** cho toàn bộ role. Conversation/Planner/Specifier/Developer effort `low`; Coordinator/Architect/Reviewer/QA `medium`; `maxConcurrency=2`. Đây chỉ là phạm vi một provider.

- Named session: `bf-3faa1d4b158d16b5d0ea`.
- Run: `run-web-f21b68bf-e49d-442a-acec-a3de32e2107f`.
- Repo dùng một lần, HOME/BFLOW_HOME/Herdr/XDG riêng ở `/tmp/bfo-v9-9r739p5a`. Chạy binary build từ worktree. Không chạy setup với HOME thật.
- Thời gian chiến dịch từ bấm tạo yêu cầu đến manifest down: 10:23:36–10:41:37 UTC, 1081 giây. Bao gồm các lần bị chặn và thời gian điều tra/điều khiển; **không phải thời gian hoàn thành workflow**. Chưa có phép so Classic.

### Việc đã chứng minh bằng phiên thật

1. Khắc phục preflight cũ bằng đường dẫn local ngắn và `bflow skills sync --provider codex --allow-machine-scope` với exact pin; doctor exit 0 / healthy. Không phát lại bước tool install GitNexus từng bị gián đoạn.
2. Khởi động Web thật qua PTY; ghép nối, đăng ký repo, chọn 3D, khởi động phiên, tạo yêu cầu, gửi làm rõ, chỉnh yêu cầu và duyệt đặc tả đều qua component HTML trong panel 3D. Không gọi API ghi thay cho thao tác UI, không sửa journal.
3. Hook symlink của `personal` bị preflight chặn. Chủ dự án **đã cho phép** policy hook chỉ trong kho V9 cô lập. Policy được ghi bằng public API vào `/tmp/bfo-v9-9r739p5a/b/state`, không ghi approval store dùng chung. Runtime sau đó kích hoạt 7 role thật. Đã đọc terminal Coordinator thấy `GPT-6-Luna medium` và các cuộc gọi MCP thật. Herdr idle/done không được dùng làm bằng chứng thành công.
4. Có ít nhất năm mốc đủ DOM mirror + workforce + manifest + `bflow status <run-id> --telemetry`: `m1-intake`, `m2-browser-reload`, `m3-server-restart`, `m5-plan-drift`, `m6-after-resume`. Workforce/manifest cùng 7 identity; DOM cùng bảy nhãn vai trò. `m4-request-revised` chỉ có telemetry/manifest, không tính là bộ đối chiếu DOM đầy đủ. **Chưa có Developer nào** ở các mốc này.
5. Chủ động reload trang giữa phiên; 3D vẫn dùng cho thao tác nghiệp vụ. Chủ động SIGINT rồi mở lại riêng Web owner, Runtime host vẫn sống; dùng pairing mới trở về đúng run, không gửi lại create. Locator chờ một câu offline trong harness không khớp câu UI và timeout, nên không ghi assertion thông báo offline là PASS; log kết nối bị cắt/refused và phục hồi run được giữ.
6. Runtime nhận đặc tả full, TDD required, hai task `parse-duration` và `format-duration`, `dependencies=[]`, ownedPaths tách biệt. Gói thiết kế được đọc và duyệt qua Web 3D. Đây là **phê duyệt thiết kế**, chưa phải phê duyệt bàn giao.

Một lần driver bị chờ locator không có timeout đã được khởi động lại; Web/Runtime không đổi. Browser mới dùng bootstrap mới từ owner reuse; không phát lại bootstrap một lần đã dùng. Các lỗi điều khiển này ghi riêng, không coi là lỗi provider hay bằng chứng acceptance.

### Blocker live được tái hiện

**B1 — mixed criteria bị từ chối ở cấp workflow.** Host gọi `HostVerification.assertSupported` trên toàn bộ spec trước per-task checks; `host-verification.ts:433` từ chối khi có cả `manual_review` và behavioral criteria dù thông báo yêu cầu tách task. Yêu cầu sandbox được chỉnh công khai qua `revise_request`: chỉ tiêu chí chức năng thư viện/README dùng unit test; điều kiện hai Developer thật, Reviewer/QA và human approval vẫn giữ trong ràng buộc chiến dịch. Không đổi Runtime, không waive tiêu chí hay tắt gate. Revision 3 qua admission.

**B2 — native Codex workspace trust tự gây execution-plan drift.** Sau duyệt thiết kế, Runtime tạo worktree parse đầu tiên rồi escalates trước dispatch: `ExecutionPlanDriftError`, component `inputs.native-profile-settings-119`. Không có message `task.assignment` và không có Developer pane.

Đối chiếu read-only chứng minh:

- Nguồn là `personal/home/.codex/config.toml`, được `apps/cli/src/execution-preview.ts` ghim toàn bộ bytes.
- `packages/agent-providers/src/codex-trust.ts` thêm bảng trust cho worktree mới theo opt-in `trustedWorkspace` của repo. Không phải agent điều tra tự sửa file để vượt prompt.
- Hash đã chấp nhận: `94082083500da5eec62ac4d18687c379abfc17cd8ec62c0964390c5644ad14b3`.
- Hash sau tạo trust: `6cba0abb128c2430bbb1929097a2175061fa334966900b9426ffea37912ca28b`.
- Loại riêng bảng trust vừa sinh và newline phân cách **trong bộ nhớ** khôi phục chính xác hash đã chấp nhận; không ghi file native. Bằng chứng `plan-drift-root-cause.json`.
- `bflow task preview --run <id> --json` exit 0; sau đó nút **Tiếp tục** vẫn lặp đúng drift. Giữ guard, không sửa trạng thái/receipt và không tự rebind kế hoạch.

Cần quyết định owner mở phạm vi sửa CLI và test hồi quy cho B2. Hướng dự kiến: phân biệt đúng phần trust Bflow tạo cho worktree đã xác minh với thay đổi cấu hình model/quyền/hook của người dùng; không loại toàn bộ native config khỏi guard. Chưa có implementation sửa B2.

### Những tiêu chí V9 chưa đạt

- Hai Developer thực thi song song: **chưa đạt**, zero task assignments.
- Đóng một pane Developer khi đang chạy: **chưa thực hiện**, chưa có pane phù hợp.
- Truy vết mọi cue đã vẽ tới handoffId: **chưa đủ**; có log workforce/receipts thật nhưng chưa có audit từng cue hiển thị.
- Verification/integration và phê duyệt bàn giao: **chưa đến**.
- So thời gian hoàn tất với Classic: **chưa có**.

### Teardown và giữ bằng chứng

Đã dừng phiên bằng SessionActions trong 3D theo luồng checkpoint thông thường: manifest `down`, named Herdr `not_running`; run escalated và một worktree vẫn được giữ. Đã thu hồi policy hook V9 bằng public API (`policiesRemaining=0`), dừng riêng Web/Chrome/observer của chiến dịch. Không đụng phiên khác, không xóa ledger hay worktree. Bảng trust native do Bflow tạo được giữ làm bằng chứng, không tự sửa ngược cấu hình dùng chung.

Snapshot/log đã sao chép vào ledger `v9-live/evidence/`; không sao chép bootstrap, cookie hay browser storage. Các thử setup trước đó vẫn giữ riêng trong `v9-preflight/`.

## Nơi giữ bằng chứng và ruling

Ledger ngoài Git (không xóa): `.superpowers/sdd/2026-11-02-web-visualization-mode/` tại checkout chính.

- `progress.md`: chỉ nối thêm, giữ tất cả ruling cũ và mới.
- `resume-review-findings.md`, `resume-deferred-triage.md`, `resume-fix-rereview.md`: self-review/triage/re-review đợt sửa.
- `resume-rulings-index.md`: chỉ mục đủ 28 dòng Ruling nguyên văn có trong ledger khi kết thúc rà soát.
- `resume-scoped-review-sonnet.md`, `resume-whole-review-sonnet.md`: lỗi quota, không phải review PASS.
- `verification-15cc644b/`: các log gốc, error index, kết quả đo JSON và machine context.
- `resume-F1-red.log`, `resume-F1-green.log`, `resume-F2-red.log`, `resume-F2-green.log`: chứng cứ hồi quy.
- `verification-final/`: xác nhận sau đợt sửa.
- `v9-preflight/`: các thử preflight cũ; `v9-live/`: doctor/skills readiness và bằng chứng live, blocker, checkpoints, teardown.

Ruling mới: giữ ledger theo lệnh owner; timeout 240s là trần test tổng; không đổi screenshot khi chưa tái hiện flaky; không thay review độc lập bằng self-review/quota fallback; không gọi phép đo fixture hay catalog access là live acceptance. Chi phí: còn gate review, full suite và V9 trước khi owner quyết định merge/phát hành.
