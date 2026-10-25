# Nghiệm thu Bflow sau P22 — 2026-10-16

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](implementation-status.md) trước khi vận hành hoặc giao việc mới.

Follow-up lỗi Ctrl+C/readiness/layout/original prompts đã được sửa; kết quả và
giới hạn riêng ở [lifecycle startup UX](acceptance/2026-10-16-lifecycle-startup-ux.md).
Các số liệu/baseline bên dưới giữ đúng phạm vi nghiệm thu P22 trước follow-up.

**Phân loại: Not ready cho Agentic SDLC MVP v2.** Các blocker code được mô tả ở
bản bàn giao trước đã được sửa và có kiểm thử thực của Git, storage, runner và
provider hook. Chưa có một feature/bugfix do các model thật hoàn tất xuyên suốt
Conversation → Coordinator → Runtime → Developer → Reviewer/QA → integrated
verification → human delivery approval. Không xác nhận MVP v2 hoặc production-ready
chỉ từ fixture, smoke provider hay tổng số test PASS.

## Cập nhật sau P24: P25–P29 (2026-10-17)

Kết luận **Not ready** không đổi. Từ baseline P24 (`8dbb056`) source đã bổ sung P25
`agent-providers`, P26 `machine-setup`/`tool-installer`, P27 `mcp-gateway`/`mcp-services`,
P28 `skills`/`skills/**`, P29 CLI (`setup`, `mcp status`, `tool status`, `skills sync|list`,
`agent check`, `repo inspect`, `task plan|implement`, `verify`, `git prepare`, `up`/`doctor` mở
rộng) và agent system prompt/behavior policy. Bảng validation bên dưới vẫn chỉ thuộc nghiệm thu
P22 và các follow-up đã nêu; **không** được dùng làm bằng chứng cho P25–P29 vì chúng chưa
được chạy lại cho hồ sơ này.

| Phase | Source | Local test (theo README package) | Live provider/Herdr/OS | Full SDLC |
| --- | --- | --- | --- | --- |
| P25–P28 | Có | Có, với fake runner/driver/installer | Chưa có hồ sơ | Không |
| P29 | Có | Có (`apps/cli/test`) | Chưa có hồ sơ | Không |
| P30 Runtime integration | **Chưa** (runtime/pane-manager/conversation không import các package mới) | — | — | — |
| P31 acceptance | **Chưa** (thư mục test không tồn tại) | — | — | — |

Chi tiết và giới hạn ở [hồ sơ trạng thái P25–P29](acceptance/2026-10-17-p25-p29.md),
[known limitations](known-limitations.md) (PV3-*), [security review](security-review.md) và
[roadmap](next-roadmap.md). Command accepted của P29 không phải workflow accepted. Không nâng
mức personal use/limited pilot; điều kiện pilot vẫn gồm P30, P31, live happy-path và active
recovery.

## Baseline, quyền và source được nghiệm thu

- P22 theo chỉ định owner: `9a38742e7e6aacbcd9703014ac5c1fc5780646aa`.
  Đã kiểm tra HEAD/index/worktrees/refs/ancestry/patch equivalence trước khi làm;
  không fetch hoặc khẳng định remote closure từ cached refs.
- Worktree tích hợp: `/tmp/bflow-p22-release-review`, branch
  `integration/p22-release-review`. Source cuối được kiểm thử: **3c170726845bee8a2d3f35c367b63a001e7f400c**.
  Commit bàn giao sau đó chỉ cập nhật báo cáo/tài liệu.
- Main checkout được bảo toàn ở baseline; không push, tạo PR, merge protected
  branch, deploy hoặc publish release. Owner đã cho phép sửa lỗi và commit local.
- Không sửa frozen contracts, root manifest, lockfile, schema migration hoặc
  upcaster để hợp thức hóa implementation. Dist/database/artifact/log không commit.
- Linux/local filesystem; Node 24.16.0, pnpm 12.5.1, Vitest 2.1.9;
  Herdr 0.9.5/protocol 22/schema 1, Bubblewrap 0.9.0. Behavioral sandbox cần Linux
  namespaces. Không dùng allowlist theo nhãn phiên bản Herdr.

Mount của checkout gốc là `fuseblk`; probe không chứa credential xác nhận chmod
0700/0600 vẫn trả 0777 và UID 0, khác caller UID 1000. Đây không đáp ứng private
host-state precondition. Source/worktree và lifecycle fixtures ở POSIX `/tmp`;
không chứng nhận runtime state trên mount gốc. Xem
`target-filesystem-permissions.json` (probe đã xóa) và RR-26. Để chạy Agentic host,
dùng repository/worktree trên POSIX filesystem; không bỏ permission checks.

## Những blocker đã sửa

1. Default CLI boot persistent Claude host, role MCP/native hooks, authenticated
   ingress và scheduler; `init --provider claude`, provider login check và exact
   native launch receipt trước ready. Startup partial intent được phục hồi không
   nhân đôi pane/process. Native routing pin session và socket realm.
2. `down` nối quiesce/checkpoint/pane shutdown/named-server stop/host shutdown;
   không báo success khi close lỗi. Inactive host restart kiểm recorded owner đã
   chết; giữ dispatch journal và delivery uncertainty. Host tự chọn socket path ngắn
   nếu TMPDIR vượt giới hạn Unix socket.
3. Node TAP và **Vitest 2.1 JSON** chạy thật trong detached checkout, với exact
   test names, revision, exit/counters và trusted runtime-error reporter. Không
   coi syntax/import/runtime error, test skip/todo hoặc zero test là Red.
4. Developer chỉ có scoped Edit/Write và host Git tools; trước Red chỉ testPaths
   được phép đổi. Red test blobs bị freeze; Green/Refactor đo độc lập trên commit.
   `check_work` không được coi là acceptance. QA trả kết quả qua Herdr; Runtime
   dùng task notice trên lease hiện tại để đánh thức đúng Developer.
5. Behavioral commands chạy trong **Bubblewrap filesystem/PID/network namespaces**;
   không mount host home/state/socket hoặc root filesystem. Dependency roots do
   owner chọn chỉ là canonical `node_modules`, read-only. Không có fallback bỏ sandbox.
6. Native intent/ACK, human-hook provenance, review observations và evidence/gate
   authentication được lưu private/fsynced; restart không lấy dialogue cache làm
   bằng chứng approval. Renew/release lease giữ exact args/idempotency qua crash.
7. Failed phase outcome được ghi trước release và phục hồi đúng một repair notice.
   Failed revision không enqueue lại; assertion repair bounded, infrastructure lỗi
   escalate, verification exhaustion không dispatch tiếp. Không biến uncertain
   delivery thành test failure rồi resend.
8. Giữ các sửa trước về parallel approvals, rejection race, repair self-review,
   confined reads, total context budget, log redaction, distribution và release ref.

Xem [security review](security-review.md) và [cấu hình runner](verification-runners.md).
Owner cho phép Coordinator tự accept **spec rủi ro thấp**; ngoại lệ không áp dụng
cho project-required/design/task gates hoặc delivery approval của người dùng.

## Validation cuối

Chạy tuần tự từ worktree root, `TMPDIR=/tmp VITEST_MAX_FORKS=4
VITEST_MIN_FORKS=1`; integration/native chọn một worker. TMPDIR ngắn vẫn cần cho
một số Herdr/POSIX socket paths ngoài host. Không cộng subset hoặc lần chạy lại
thành coverage mới.

| Lệnh / phạm vi | Exit | Kết quả |
| --- | --- | --- |
| `pnpm build` | 0 | PASS |
| `pnpm check:deps` | 0 | PASS |
| `pnpm typecheck` | 0 | PASS |
| `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | 0 | PASS |
| `pnpm test` | 0 | 1382 PASS, 0 FAIL, 3 SKIP |
| Integration command bên dưới | 0 | 44 PASS, 0 FAIL, 0 SKIP; subset root suite |
| `pnpm run test:e2e --reporter=json --outputFile=/tmp/bflow-fix-evidence/final-e2e-results.json` | 0 | 63 PASS, 0 FAIL, 0 SKIP; fake transport |
| Native Herdr command bên dưới | 0 | 2 PASS, 0 FAIL, 0 SKIP; không model |
| `node tests/acceptance/local-fault-probe.mjs` | 0 | PASS |
| `git diff --check`, staged diff check | 0 | PASS trước commit bàn giao |

```sh
TMPDIR=/tmp pnpm exec vitest run   packages/runtime/test/agentic/integration.test.ts   packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts   --maxWorkers=1 --minWorkers=1 --reporter=json   --outputFile=/tmp/bflow-fix-evidence/final-integration-results.json

BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp   pnpm exec vitest run apps/cli/test/environment-live.test.ts   packages/runtime/test/agentic/live-herdr.test.ts   --maxWorkers=1 --minWorkers=1 --reporter=verbose --reporter=json   --outputFile=/tmp/bflow-fix-evidence/final-live-results.json
```

Lượt full-suite trước tại `7c5dfd2` có 1381 PASS / 1 FAIL / 3 SKIP:
missing executable bị chặn bằng ENOENT sớm trong sandbox thay vì thông điệp
infrastructure failure mà test yêu cầu. Commit `3c17072` chuẩn hoá lỗi preparation;
giữ nguyên test âm tính và chạy lại full suite. Log FAIL nằm trong
`round-before-infra-diagnostics/`. Lượt harness thử `pnpm test --reporter=verbose`
exit 2 do flag của pnpm, chưa chạy test; đã đổi về `pnpm test`, log giữ riêng.

Integration riêng chạy tại `7c5dfd2`; full suite trên source cuối chạy lại cùng
các integration cases. E2E/native/build/typecheck cũng chạy lại trên source cuối.

Root suite có 64 files PASS / 3 files SKIP. Ba test opt-in SKIP gồm hai native
tests chạy riêng và một interactive provider test không chạy lại. Root suite opt-in skips được ghi riêng; native tests chạy lại với env ở trên,
interactive Claude provider test không được tính PASS từ skip. Connected
Node/Vitest tests dùng Git/Core/Registry/SQLite/ArtifactStore/policies thật,
transport/panes và lời đánh giá Reviewer được fixture điều khiển. Đây là
integration evidence, chưa phải multi-model AI acceptance.

## Bằng chứng live và ngân sách

- CLI lifecycle thật trên source cuối: `/tmp/bfhost-63m6gzvc/repo`;
  up/status/down/up/down exit 0, đúng named server stopped và HEAD không đổi.
  Partial startup qua trust prompt đã có evidence ở vòng trước
  (`round-before-runner/lifecycle-results.json`); không trộn các session. Không
  có workflow/model turn trong lifecycle probe; không gọi đó là active-run recovery.
- Claude print smoke mới dùng **hook do host sinh**, tool Write thật và hook event
  thật: native PreToolUse từ chối unassigned Developer; file đích không được tạo.
  Probe này dùng inactive host và transport fixture để cô lập hook, không phải
  Herdr multi-role E2E. Provider báo **0.0064368 USD**, hard cap 0.10 USD.
- Tổng chi phí model biết chính xác kể từ lúc đặt giới hạn: **0.0225011 USD**.
  Một lần gọi có cap 0.10 USD bị mất response trong lỗi cleanup; tính cả trần đó,
  tổng dự phòng là **0.1225011 USD theo cap đã cấu hình**; chi phí thực của lần mất response chưa xác minh. Không tính lần lỗi trước khi gọi provider là
  model spend; không dùng safe-mode probe làm bằng chứng hook. User sau đó cho
  phép vượt nhẹ nếu cần; đợt này vẫn nằm dưới giới hạn ban đầu 1 USD.
- Provider native-session/MCP smoke trước giới hạn chứng minh provider integration;
  không dùng lại nó để tuyên bố full SDLC mới đã hoàn tất.

Raw commands/HEAD/exits/times nằm ở `/tmp/bflow-fix-evidence/final-validation.json`;
JSON test reports, model-budget-summary, native-edit-guard-smoke, lifecycle và
fault/distribution probes cùng thư mục. Evidence gốc ở `/tmp/bflow-p22-evidence/`.
Các vòng validation cũ được giữ trong thư mục vòng trước; SHA256SUMS và archive
`/tmp/bflow-fix-evidence.tar.gz` được tạo lại sau nghiệm thu. Đây là artifact local
cần bảo toàn trước cleanup/reboot, chưa upload vào hệ thống lưu trữ lâu dài.

## Ma trận kiểm toán 15 hạng mục

| Hạng mục | Bằng chứng | Kết luận / giới hạn |
| --- | --- | --- |
| 1. Architecture compliance | Dependency checker, Core không nhập Herdr, Runtime composition và default host wiring | LOCAL PASS; context/metrics helpers chưa tự compose mọi tuyến |
| 2. Contracts compatibility | Build/typecheck, exported ingress schemas, contract và migration tests | LOCAL PASS; frozen contract không đổi |
| 3. Herdr-only communication | RoleMessage/outbox/signature tests, native named-session/plugin probes | PASS theo phạm vi; private control/MCP socket là host API, ArtifactStore không làm mailbox |
| 4. Conversation-only user interaction | Chat gateway, scoped tools, attach Conversation target; trusted UserPromptSubmit | Agentic path PASS; legacy CLI workflow API vẫn tồn tại riêng |
| 5. Coordinator boundaries | Host-injected principal, Runtime-only dispatch, DAG/approval gates | LOCAL PASS; chưa có full live model run |
| 6. Role-to-pane isolation | Dedicated bindings/native session pin, current lease/fencing, worktrees | LOCAL/NATIVE PASS; provider process cùng UID chưa là OS sandbox toàn role |
| 7. Session lifecycle | Real idle up/down/restart, partial intent, close-error refusal, short socket path | Idle PASS; active AI graceful drain/fault campaign chưa chạy |
| 8. SDD | Immutable approved bytes/fingerprint, explicit criteria/task mapping, anti-weakening | LOCAL PASS; low-risk autoaccept được owner cho phép |
| 9. Conditional TDD | Real Node/Vitest RGR, scoped edits/frozen Red tests, not_applicable alternative evidence | LOCAL PASS trong runner scope; mixed criteria/coverage chưa hỗ trợ |
| 10. Verification termination | Bounded cycles/phase repairs, failed-revision idempotency, exhausted escalation | LOCAL PASS; uncertainty không tự retry |
| 11. Git worktree isolation | Real Git, scoped commits, dependency integration, conflict preservation, sandboxed measurements | LOCAL PASS; không destructive cleanup Developer mặc định |
| 12. Human approval | Exact target/revision/generation/time, durable hook provenance, recovered decisions/rejections | LOCAL PASS; chưa live crash giữa human approval của AI run |
| 13. Crash recovery | SIGKILL/checkpoint/outbox replay, exact renew/release args, phase-outcome crash regression | LOCAL PASS; không power-loss/multi-host guarantee |
| 14. Logging/secret redaction | Structured helper, background relay/host scrub, confined reads/budgets; sandbox hides host secrets | PARTIAL; arbitrary encoded secrets và raw artifacts/provider logs chưa được đảm bảo che hết |
| 15. E2E evidence | Local E2E, real components, native Herdr và Claude hook probe | PARTIAL; thiếu full AI SDLC run với human delivery approval |

## Quyết định phát hành

| Mức | Quyết định |
| --- | --- |
| Ready for personal use | Chưa xác nhận complete workflow mặc định bằng model thật |
| Limited pilot | Chỉ nên mở sau full happy-path AI run và active recovery probe với giới hạn được ghi nhận |
| **Not ready** | **Kết luận hiện tại cho toàn Agentic SDLC MVP v2**; thiếu live acceptance evidence, không còn lấy runner/memory-only receipts làm blocker cũ |

Những bước đóng còn lại và giới hạn cụ thể ở [roadmap](next-roadmap.md) và
[known limitations](known-limitations.md). Không yêu cầu sửa lại các module đã có
chỉ để thay nhãn readiness. Không quảng bá production-ready.
