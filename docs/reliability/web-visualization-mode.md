# Bflow Web Visualization Mode — xác nhận ngày 2026-11-02

Trạng thái: **chưa đủ điều kiện nghiệm thu/phát hành**. Không push, merge hay tạo PR. Báo cáo gồm source, test cục bộ, phép đo fixture GPU thật và các lần V9 live với hai Developer thật; phiên Golden đang được phục hồi sau fault, chưa có nghiệm thu SDLC đầu-cuối.

## Phạm vi và revision

- Nhánh `agent/web/visualization-mode`, baseline `247faf9c`, HEAD đầu phiên `15cc644bc9eb1353d7ee5651f0ca91f8902724e3`.
- Đọc plan trong checkout chính, áp phần “Điều chỉnh 2026-11-02” và “Tham chiếu hình ảnh”; giữ Three.js thuần `0.187.0`, CSP, Classic mặc định và token tối trong `.office-3d`.
- Hai bản sửa Web sau xác nhận: projection chỉ đọc không gán identity cũ sang agent mới theo role và không khớp identity sai role; stage abort và hủy renderer trả về muộn sau context-loss. Hai bản sửa Web không thêm điều phối/quyền Runtime hay đổi hợp đồng; các sửa CLI/Runtime được owner mở phạm vi sau đó ghi riêng ở phần V9.
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

## V9 — phiên live Golden đang tiếp tục

Chủ dự án đã bỏ phép so thời gian với Classic; không chạy Classic và không tính mục này là thiếu nghiệm thu. Tất cả thao tác nghiệp vụ tạo việc, làm rõ, xem/duyệt thiết kế và phục hồi công việc dùng panel trong 3D. Lệnh CLI chỉ phục vụ quan sát telemetry và vận hành/phục hồi phiên. Không sửa journal live hay gọi API ghi thay cho UI.

Herdr `0.9.5`, protocol 22; Codex `0.166.0`, profile `personal`, **gpt-6-luna** cho toàn bộ role, `maxConcurrency=2`. Golden: Coordinator effort `high`, Reviewer `medium`, các role khác `low`. Đây chỉ là phạm vi một provider. Cấu hình specialist `required=false` không giảm topology: vẫn có bảy pane thường trực; không tuyên bố chỉ chạy bốn pane.

HOME/BFLOW_HOME/Herdr/XDG cô lập tại `/tmp/bfo-v9-9r739p5a`, dùng CLI build từ worktree. Hook trust được owner cho phép riêng trong kho approval V9, ghi/thu hồi bằng public API; không sửa approval hoặc hook dùng chung. Policy đang được giữ vì session Golden vẫn up và chưa thể teardown an toàn; phải thu hồi bằng public API sau khi dừng được phiên.

### Các lần trước và blocker đã xử lý

| Run / source | Kết quả có bằng chứng |
| --- | --- |
| `f21b68bf` / `e44b451f` | Full SDD/TDD required, năm mốc đối chiếu; drift trước Developer dispatch. Reload trang và restart riêng Web owner phục hồi đúng run. |
| `fa604881` / `ea2effaf` | Hai Developer thật đồng thời working. Fixture thiếu thư mục cha làm cả hai bị chặn trước fault pane, nên không quy lỗi cho recovery. Đã cancel qua UI. |
| `94bb021c` / `ea2effaf` | Red/Green/Refactor thật, một task qua gate độc lập; task còn lại bị test frozen mâu thuẫn TypeError/RangeError. Giữ blocked, không sửa/waive test. |
| Golden `12b3147a` / `8b7ada8b` → `b6a1b543` | Hai task số học với test phẳng cố định; cả hai có authenticated succeeded result, triple qua independent gate. Double kẹt writer sau đóng pane; đang phục hồi cùng checkpoint bằng bản sửa được owner duyệt. |

CLI native trust drift được sửa tại `ea2effaf`, follow-up an toàn `8b7ada8b`: chỉ chuẩn hóa read-only bảng trust Bflow tạo khi có Git receipt/backlink đúng, giữ mọi nội dung model/quyền/hook khác trong digest. Sonnet scoped re-review **APPROVE**. Full CLI clean-env **1166 PASS / 7 SKIP**; targeted cuối **31 PASS**, deps/typecheck/build PASS. Không thay schema, lockfile hay root config. Giới hạn fail-closed/coverage xem review trong ledger.

### Run Golden cần theo dõi

- Repo: `/tmp/bfo-v9-9r739p5a/repo-golden`.
- Session: `bf-84d92b8752a8f6103dec`.
- Run: `run-web-12b3147a-8411-4f65-b020-76f3c9bb0fdc`.
- Hai task `double-task`, `triple-task`, không phụ thuộc nhau, source tách biệt; owner-provided test ở baseline gồm bảy cặp input/output mỗi hàm. QA chạy Red thật rồi mới authorize implementation; Green/Refactor chạy thật. Không dùng baseline self-check làm independent evidence.
- Các bộ checkpoint `n2-design`, `n3-implementation`, `n4-verifying`, `n5-writer-blocked` có DOM mirror/workforce/manifest/telemetry. `n1-intake` chưa đủ DOM/workforce, không tính đủ năm mốc.
- Fault lúc `2026-11-02T13:42:38.802912Z`: đóng pane Developer `w2:p2` sau khi `implementation.submitted` của double được persist received, trước writer settlement/verification. Đây là fault tại durable handoff boundary, không phải phục hồi giữa lúc chỉnh code. Message `b6fd1273-7dfb-4eb1-b002-2f5a77aca3c3`.

### Runtime writer-stop: sửa hẹp được owner cho phép

Normal successful completion trước đây chỉ chờ pane ready/matching, nên pane đã mất khiến writer giữ mãi dù result xác thực. Run escalated; checkpoint `down --yes` thành công, không cancel run hay tạo fixture mới.

Commit `b6a1b543` chỉ dùng capability `stopDeveloperExecutionScope` hiện hữu khi health xác nhận đúng pane đã mất. Binding phải thuộc exact execution; proof phải parse đúng Linux namespace, handle và thời điểm. Process-scope manager seal/stop và persist proof trước metadata-only release. Uncertain delivery giữ allocation/lease; thiếu/sai proof hoặc lỗi stop giữ writer. Busy/unknown/replacement không bị stop. Evidence, lease/fence, independent Reviewer/QA và human gates giữ nguyên.

Regression ban đầu RED→GREEN; **83 test liên quan PASS**. Sau một vòng Sonnet finding/fix/re-review, **11 test hẹp PASS**, typecheck/build/diff-check PASS; Sonnet không thấy Critical/Important mới. Test thêm mất acknowledgement sau metadata release rồi restart/tick và stop throw. Test native unknown delivery chạy rào cản top-level; guard outbound tường minh chưa có test nhánh riêng. Lỗi stop hiện dùng thông điệp fail-closed chung. Kiểm chứng live sau resume đã ghi proof `linux_pid_namespace` đúng double execution `a9212c69-6483-40b7-9259-719c959c4511` lúc `14:26:39.133Z`; writer được nhả, changeSet thu được và verification độc lập bắt đầu. Đây là chứng cứ live cho phạm vi fault này, riêng test unit vẫn dùng fake ports.

### Phần còn lại của Golden

Live exact stop proof đã xác nhận. Sau đó Reviewer duyệt double; QA từ chối vì thiếu behavioral observation lúc review dù host behavioral auto-unit chạy 1/1 PASS đúng candidate ở bước sau. Runtime giữ gate và mở rework; Developer đã nộp lại kết quả, chưa có verdict cuối. Không can thiệp sửa test hay buộc gate pass. Cycle2 bị Reviewer/QA từ chối: Developer chỉ đổi thứ tự toán hạng và chưa chứng minh repair cho finding. Host behavioral auto-unit vẫn PASS đúng candidate `cebc7cbc3b9a54c75a091e10f7976607327ff7c9`. Rework generation2 Developer báo blocked, chưa có authenticated result; Coordinator đã xác nhận mâu thuẫn evidence/aggregate. Trạng thái run có thể chuyển escalated → implementing theo auto-resume có giới hạn, chưa phải tiến triển hay thành công.

Sáu mốc `n2`–`n7` khớp instance IDs workforce/manifest, nhãn/số nhân viên DOM (Developer đánh số theo `boundAt`) và telemetry đúng run. `n1` không đủ. Timestamp riêng mỗi nguồn được giữ; các snapshot là quan sát gần nhau, không phải transaction nguyên tử.

Reload trang giữa verification giữ nguyên URL run và 3D. Restart riêng Web owner ghi nhận UI đang kết nối lại/dữ liệu có thể cũ; Runtime vẫn sống. Sau pairing mới phục hồi đúng run và mode. Một lần driver chuyển URL quá sớm hủy bootstrap khiến hết phiên; sửa harness chờ bootstrap POST 200 rồi mới điều hướng, không phát lại mã cũ hay nghiệp vụ.

Audit 101 cue accepted-walk đã capture (54 handoff IDs duy nhất) khớp receipt outbox accepted/released/trusted delivery hoặc inbox applied. ArtifactReference `evidence` không phải receipt vận chuyển nên không dùng việc array rỗng để kết luận thiếu receipt. Wrapper có khoảng trống lúc bootstrap/reload, không capture desk indicators; chưa tuyên bố bao phủ mọi cue toàn phiên.

Còn double independent gate, workflow integration/verification và duyệt bàn giao. Chưa tuyên bố V9 đạt.

Owner đã duyệt tiếp đề xuất `v9-review-evidence-proposal.md`. Commit `3d04ff6a` bổ sung view chỉ đọc của các receipt candidate đã có; không thay gate, thứ tự kiểm chứng, lease/fence hay ngân sách. Phải phân biệt `sourceRevision` của candidate với `testRevision` frozen; không lấy self-check thay independent evidence hay ép Reviewer/QA đổi verdict.

Bản sửa evidence: task `inspect_review` nay trả `candidateBehavioralEvidence`, pin run/task/sourceRevision/spec/decision, giữ attempt gốc và phân biệt testRevision frozen. Phase receipts phải xác thực và artifact phải đọc/hash đúng; gate receipts phải xác thực, đúng behavioral executor và fingerprint. Self-check, revision/task/spec khác hoặc thiếu artifact bị loại. View giới hạn ba entry, 4 MiB mỗi artifact/12 MiB mỗi lần đọc; không chạy thêm test hay mint kết quả. Private review context giữ snapshot; khi xin ngoại lệ test-integrity, host gỡ riêng field mới để giữ guard context gốc.

Regression RED→GREEN; targeted 62 PASS, sau review 66 PASS, kiểm tra candidate cuối 12 PASS; typecheck/build/diff-check PASS. Sonnet finding Important ở đường owner exception đã sửa và scoped re-review không còn Important. Runtime forced build được kiểm tra chứa source cuối. Không chạy lại full CLI hay Playwright cho thay đổi host-only này.

Host được nạp lại qua owner-loss recovery: SIGTERM riêng host cũ, không dừng Herdr/Developer, không tạo graceful-down receipt giả. Built `up` exit0, bảy role pane thường trực được tạo lại; Developer binding giữ nguyên. UI 3D resume cùng run. Chẩn đoán chỉ đọc trên receipt live cho candidate `cebc7cbc…` trả available, receipt `d0be6277-2465-4998-8199-261091a09eed`, checksum digest và test name đúng; đây chưa phải verdict live mới. Coordinator đã xác nhận routing bị chặn: `prepareRoleToolMessage` cấm gửi trực tiếp tới specialist; path explicit resume hiện chỉ đánh thức Developer khi có đúng một Red receipt. Rework đã đủ ba phase không nhận task notice, nên Developer chưa được đánh thức để submit dossier và chưa có lượt review live mới. Đây là blocker tiếp theo, không ghi view đã có verdict mới. Owner đã duyệt sửa và cho phép xử lý các blocker cần thiết tiếp theo. Bản resume `7d0f38f5` đã commit: chỉ đánh thức holder của đúng blocker sau policy evidence hoàn tất, dưới quyền resume Web/Conversation có receipt; giữ Red-only và recovery phase cũ. Lease hết hạn dùng cơ chế reacquire hiện hữu, fence tăng, giới hạn ba lần giữ nguyên. Busy/replaced/missing/unknown, resume tự động hoặc do model không cấp notice; không đổi pendingAction khi lỗi tạm thời. Không tạo assignment, không đổi evidence hay verification budget. Regression RED→GREEN, cuối 65/65 test PASS; typecheck/build/diff-check PASS, Sonnet re-review không còn Critical/Important. Thêm test mất acknowledgement sau acquire rồi restart: cùng fence và đúng một notice. Minor còn lại: marker lỗi tạm thời trên parent có thể còn sau lần resume thành công; chưa tác động acceptance.

Lệnh checkpoint `down --yes` sau blocker mới **exit 1**: guard báo Developer chưa có correlated result, không dừng gì. Không dùng `--force` hoặc cancel để làm đẹp teardown vì sẽ mất attempt hiện tại. Session vẫn **up**, worktrees/run được giữ nguyên; scoped hook policy chưa revoke khi session còn up. Đây là giới hạn teardown thực tế, không ghi là đã checkpoint thành công. Web/Chrome/observer chiến dịch được giữ cho cùng-run continuation; không đụng process của người dùng. Thời gian run gồm cả điều tra/sửa và downtime, không phải benchmark thời gian hoàn tất.

Bằng chứng gốc ở `/tmp/bfo-v9-9r739p5a/golden-attempt/evidence/`, các snapshot chiến dịch cũ trong ledger `v9-live/`, `v9-fixed-live/`. Không sao chép bootstrap/cookie/browser storage vào báo cáo.

## Nơi giữ bằng chứng và ruling

Ledger ngoài Git (không xóa): `.superpowers/sdd/2026-11-02-web-visualization-mode/` tại checkout chính.

- `progress.md`: chỉ nối thêm, giữ tất cả ruling cũ và mới.
- `resume-review-findings.md`, `resume-deferred-triage.md`, `resume-fix-rereview.md`: self-review/triage/re-review đợt sửa.
- `resume-rulings-index.md`: chỉ mục đủ 28 dòng Ruling nguyên văn có trong ledger khi kết thúc rà soát.
- `resume-scoped-review-sonnet.md`, `resume-whole-review-sonnet.md`: lỗi quota, không phải review PASS.
- `verification-15cc644b/`: các log gốc, error index, kết quả đo JSON và machine context.
- `resume-F1-red.log`, `resume-F1-green.log`, `resume-F2-red.log`, `resume-F2-green.log`: chứng cứ hồi quy.
- `verification-final/`: xác nhận sau đợt sửa.
- `v9-preflight/`: preflight cũ; `v9-live/`, `v9-fixed-live/`: các chiến dịch trước.
- `v9-golden-live/evidence/`: Golden checkpoints, concurrent Developer tool witness, fault/recovery, exact writer-stop proof, cue/receipt audit, evidence contradiction và lỗi teardown.
- `writer-stop-{sonnet-review,sonnet-rereview}.md`, `writer-stop-checks/`, `writer-stop-review-green-final.log`: scoped review và kiểm chứng sửa Runtime.
- `v9-review-evidence-proposal.md`: phạm vi evidence đã được owner duyệt và sửa tại `3d04ff6a`; `v9-resume-holder-proposal.md`: blocker resume đã được duyệt và sửa tại `7d0f38f5`.

Ruling mới: giữ ledger theo lệnh owner; timeout 240s là trần test tổng; không đổi screenshot khi chưa tái hiện flaky; không thay review độc lập bằng self-review/quota fallback; không gọi phép đo fixture hay catalog access là live acceptance. Chi phí: còn gate review, full suite và V9 trước khi owner quyết định merge/phát hành.

## Tích hợp theo yêu cầu chủ dự án

Chủ dự án yêu cầu tăng tốc, để fix phụ về sau, merge vào main và pull main mới nhất rồi xử lý conflict. Việc này thay thế lệnh dừng trước merge ban đầu. V9 vẫn chưa có verdict cuối cho double, workflow gate/integration và phê duyệt bàn giao; bản resume mới chưa được xác nhận bằng một lượt submit live sau sửa. Các giới hạn hiệu năng, full affected và review toàn nhánh ở trên không được đổi thành PASS. Giữ run/worktrees/ledger, không force-down và không tạo fixture mới. Host đã nạp build `7d0f38f5` và đã thử business resume trên 3D trong lúc tích hợp. Lệnh tới đúng holder nhưng preflight từ chối pinned skill approval/integrity sau host reload, trước khi reacquire lease; không tạo assignment_resume/fence mới và không sử dụng lease hết hạn. Source audit cho thấy readPinnedInstructions dựa vào các map Developer instruction/launch của từng host; việc phục hồi các pin này cần xác minh/sửa tiếp. Giữ guard và ghi blocker cho đợt sau theo ưu tiên merge của owner.

Main integration: đã pull `origin/main` từ `247faf9c` lên `f39082f7`, gộp feature head `97357614`. Một conflict trong `execution-binding.ts` được giải bằng cách giữ normalizer Codex trust và constant/documentation repository snapshot mới từ main. Trên cây đã hợp nhất: deps/typecheck/build/diff-check PASS; Web **375/375**, Runtime selected **194/194** (7 files) PASS, gồm self-service upstream, execution snapshot/trust, recovery/notices, writer-stop và host review. Không chạy lại full affected, Playwright hoặc phép đo GPU trong đợt tích hợp này; các gate chưa đóng phía trên vẫn còn. Owner plan untracked được giữ nguyên từng byte. Worktree/ledger/live run giữ lại để xử lý sau; không push/PR.
