# Nghiệm thu sau P22 — 2026-10-16

**Phân loại: Not ready cho Agentic SDLC MVP v2.** Chưa có feature hoặc bugfix
hoàn thành qua chuỗi Conversation → Coordinator → Runtime → Developer →
Reviewer/QA → Git verification → human delivery approval bằng agent/model thật.
Build và test thành phần thành công không đủ để gỡ quyết định này. Không xác
nhận production-ready.

## Follow-up sửa blocker theo yêu cầu chủ dự án

**Đã sửa được bootstrap/delegation infrastructure và shutdown CLI**; trạng thái
phát hành toàn MVP vẫn **Not ready** vì full AI SDLC chưa được chứng minh và
behavioral feature/bugfix runners chưa có trong default host. Không dùng lại hai
blocker cũ như thể chưa sửa.

Implementation follow-up được test: `3aecb60b00580ad6daf1e5f4f31fab9d0fc044c5`,
branch/worktree giữ nguyên. Các sửa chính:

- `init --provider claude`, auth preflight, launch-local native session hooks và
  role-scoped MCP; default host từ chối provider hooks chưa verify.
- Persistent host chuẩn bị trước startup, activation ACK trước ready, scheduler
  và native inbox pump riêng; Coordinator có planning references từ shipped assets.
- Native routing bind named session + socket realm; exact runtime request/role/
  pane/native session được đối chiếu. Conversation Gateway failure không được ACK
  như accepted. Chat/Coordinator không có native tools để sửa source/shell.
- Startup intent/partial manifests cho phép retry sau trust prompt không tạo trùng;
  activation từ chối pane cũ chưa chạy đúng Bflow launch-local hook.
- `down` quiesce/checkpoint/P13 shutdown/named-server stop/host shutdown thật.
  SIGKILL inactive host phục hồi socket chỉ khi recorded owner đã chết; không sửa
  dispatch journal hay tự resend unknown_delivery. Socket mất ACK không treo vô hạn.
- Documentation/role prompt/ADR/file reads dùng confined reader; tổng prompt budget
  bao cả governance/criteria và fail-closed khi vượt. Background log relay xử lý
  chunk boundaries/PEM; host diagnostics redact trước ghi log.

**Lifecycle thật mới:** `/tmp/bfhost-cwyfwygw/repo`, session ID và mọi command nằm
trong `lifecycle-results.json`. Lần up đầu gặp Claude trust prompt; chỉ tin đúng
repo/profile disposable rồi retry. Sau đó **up/status/down/up/down đều exit 0**,
server stopped sau down, Git HEAD giữ nguyên. Có hai permanent role Claude và
native launch receipts. Không gửi model prompt hoặc tạo workflow trong probe này;
không gọi đó là active-workflow checkpoint/recovery PASS. Các session và host thử
được dừng; bản copy credentials được xóa, profile gốc không đổi.

**Ngân sách:** sau khi user chọn smoke tối đa 1 USD, chỉ thêm một model call với
hard cap `--max-budget-usd 0.10` trong print mode. Claude trả
`BFLOW_BUDGET_SMOKE_OK`, exit 0, provider báo `total_cost_usd=0.0085535`
(list-price basis). Không suy đoán hóa đơn hoặc tổng chi phí các probe trước lúc
user đặt giới hạn. Không gửi thêm interactive model prompts sau giới hạn đó.
Probe Claude native-session/MCP đã chạy trước giới hạn chứng minh provider/tools,
không được dùng làm full AI SDLC evidence.

Chủ dự án đã cho phép Coordinator tự accept spec rủi ro thấp; human-required
project/design/task/delivery gates vẫn giữ nguyên. Đây là điều chỉnh tiêu chí
RR-12, không phải tự bỏ approval khi gặp lỗi.

Validation cuối tại source HEAD trên, `TMPDIR=/tmp`, `VITEST_MAX_FORKS=4
VITEST_MIN_FORKS=1` (integration/native chọn một worker):

| Lệnh / phạm vi | Exit | Kết quả follow-up |
| --- | --- | --- |
| `pnpm build` | 0 | PASS |
| `pnpm check:deps` | 0 | PASS, 15 package/22 cạnh acyclic |
| `pnpm typecheck` | 0 | PASS |
| `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | 0 | PASS |
| `pnpm test` | 0 | **1318 PASS, 0 FAIL, 3 SKIP**; 60 files PASS/3 SKIP |
| `pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=/tmp/bflow-fix-evidence/final-integration-results.json` | 0 | **38 PASS**, 0 FAIL/SKIP; subset của root suite |
| `pnpm test:e2e --reporter=json --outputFile=/tmp/bflow-fix-evidence/final-e2e-results.json` | 0 | **63 PASS**, 0 FAIL/SKIP; fake transport |
| Native Herdr command như audit ban đầu, output root đổi thành `/tmp/bflow-fix-evidence/` | 0 | **2 PASS**, 0 FAIL/SKIP; không model |
| `node tests/acceptance/local-fault-probe.mjs` | 0 | PASS real subprocess/Git/artifact faults; retained path trong final-fault.log |
| `git diff --check` và `git diff --cached --check` | 0 | PASS; kiểm tra lại trước commit tài liệu |
| `git status --short` | 0 | Chỉ docs/README follow-up trước commit; kiểm tra sạch sau commit |

Ba SKIP của root suite gồm hai native tests đã chạy riêng và opt-in interactive
Claude provider test. Không chạy lại interactive provider test sau giới hạn ngân
sách; model smoke mới dùng print hard cap, không thay thế MCP/full workflow test.
Commands/HEAD/exits/timestamps lưu tại `final-validation.json`; scripts, native
logs, lifecycle JSON và budget response được giữ ngoài Git. Không cộng subset hoặc
lần chạy lại thành coverage mới.

Các digest bằng chứng mới:

| File | SHA-256 |
| --- | --- |
| final-validation.json | `437cd74c0798107c4803e814806896d5d3b03a0e08aba90df9bde9c1c1095272` |
| final-test.log | `7b8e494e8dc3ff5d4b554db1c98e67222f3cde22ff06ddd09402c6273170dc4c` |
| final-integration-results.json | `77e9248c0f208c3a5c5f6c83f156e2c9a2d6d38c7fed0baef6053fa8320fff92` |
| final-e2e-results.json | `53bda0a328dddcd6e1377dd2b6516270cbe280ffd9f763156f5be738782d2e37` |
| final-live.log | `53f84ee606bc6a08174b26ad1826a25780de59584452a6f6cda0534421d5a127` |
| lifecycle-results.json | `d1bd85414e356a5b9db8f7df7e906ca7aadcf87d98072d1d04cb2d8a0cb68059` |
| budget-model-smoke.json | `07adc0f7d635420feda51dd34bf0ebc37f4a1cab8406738c2df8ec25192f0c92` |
| distribution-results.json | `26da84286330812d5c322d133f0bce2083a4d70033f126fc90b1aebe030cba9f` |


Archive distribution cuối được extract/install offline, CLI --help exit 0, import
đủ 14 library packages và có đủ sáu planning-reference assets. Chưa publish release
hoặc chạy GitHub Actions/hosted provider. Không đổi contracts, root manifest,
lockfile hoặc migration. Evidence follow-up ở `/tmp/bflow-fix-evidence/`;
archive `/tmp/bflow-fix-evidence.tar.gz`, checksum từng file trong `SHA256SUMS`.

Các phần sau lưu nguyên bằng chứng audit ban đầu để đối chiếu trước/sau; bảng gốc
không thay thế kết quả follow-up ở trên.

## Baseline và phạm vi audit ban đầu

- Baseline bàn giao theo chỉ định của chủ dự án:
  `9a38742e7e6aacbcd9703014ac5c1fc5780646aa`. Thông điệp commit ghi P11–P21;
  tên giai đoạn P22 không được dùng thay cho bằng chứng implementation.
- Đã kiểm tra HEAD, index/working tree sạch, refs, ancestry, patch equivalence
  và worktrees trước khi chọn baseline. Cached `origin/main` là `12ff251`, nằm
  trong ancestry; `git cherry origin/main main` chỉ có patch QA `9a38742`.
  Không fetch hoặc xác nhận trạng thái remote hiện tại.
- Worktree nghiệm thu: `/tmp/bflow-p22-release-review`, branch
  `integration/p22-release-review`; không đổi checkout/worktree của agent khác.
  Chủ dự án đã cho phép sửa lỗi, tạo bốn báo cáo và commit cục bộ. Không push,
  tạo PR, merge main/protected branch, deploy hoặc publish release.
- Implementation được kiểm thử cuối: `58a70a0fdb942b494aaa5170bdf9892c1af54b88`.
  Commit báo cáo sau đó chỉ bổ sung tài liệu, không thay source đã kiểm thử.
- Linux/local filesystem, Node `24.16.0`, pnpm `12.5.1`, Vitest `2.1.9`,
  Herdr `0.9.5`, protocol `22`, wire schema `1`. Không dùng release allowlist.
- Kiểm tra trực tiếp source, exported schemas, ADR, dependency graph, package
  manifests và test assertions. Không có graphify-out; executable graphify trên
  máy lỗi `ModuleNotFoundError`, nên không dùng kết quả graph làm bằng chứng.

## Quy tắc đọc kết quả

**LOCAL**: unit/integration, SQLite/ArtifactStore/Git thật nhưng transport,
authentication callbacks hoặc verdict có thể do fixture cung cấp.
**HERDR**: binary/server/plugin thật, custom native actor; không phải AI SDLC.
**CLI LIVE**: CLI/P13/Herdr và pane process thật; màn hình đăng nhập không phải
model đã xác thực. **BLOCKED**: thiếu điều kiện để chạy, không quy thành PASS
hoặc một test bị skip. Bằng chứng model Claude từ QA trước được dẫn riêng tại
[báo cáo bàn giao](acceptance/2026-10-16-p11-p21.md); không gọi đó là lần chạy mới.

## Ma trận 15 hạng mục

| Hạng mục | Kết quả và bằng chứng | Giới hạn nghiệm thu |
| --- | --- | --- |
| 1. Architecture compliance | PARTIAL: dependency checker xác nhận 15 package/22 cạnh acyclic; Core không nhập Herdr; Runtime có composition qua contracts và dynamic loading của các implementation | CLI chưa boot host P19; các reliability services chủ yếu là API xuất ra |
| 2. Contracts compatibility | LOCAL PASS sau sửa timeout RR-07: build/typecheck, contract tests, E2E typecheck; không sửa contracts, event/checkpoint version hoặc migration | Không chứng nhận mọi external host/version chưa thử |
| 3. Herdr-only communication | LOCAL PASS các RoleMessage/outbox/ingress; HERDR PASS signed native plugin message | Chưa có trao đổi AI liên-role hoàn chỉnh; socket ingress là adapter của plugin Herdr, không được thay bằng polling artifacts |
| 4. Conversation-only interaction | LOCAL PASS attach target/Conversation gateway; QA trước có PTY attach thật | Legacy CLI approve/run vẫn tồn tại; model tools và OS permissions chưa enforce độc quyền user interface |
| 5. Coordinator delegation | LOCAL PASS host-injected principal, DAG/gate/role validation, không tool deploy hoặc source edit | Chat/Coordinator thật chưa được đăng ký host tools; prompt không phải sandbox |
| 6. Role-to-pane isolation | LOCAL PASS leased panes/worktrees riêng; CLI LIVE tạo Chat và Coordinator khác pane | `readOnlyWorkspace` là metadata; cùng UID vẫn có quyền ghi ngoài vai trò |
| 7. Session lifecycle | HERDR PASS hai session và selective stop; CLI LIVE repeat init/status; sửa close-pane fail-closed | `down` default vẫn exit 1 an toàn; startup blocked chưa có CLI recovery hoàn chỉnh |
| 8. SDD | LOCAL PASS accepted immutable spec, criteria mapping, anti-weakening và checksum/fingerprint | Low-risk design autoaccept được chủ dự án cho phép sau audit 2026-10-16; human-required gates vẫn phải độc lập |
| 9. Conditional TDD | LOCAL PASS required Red trước authorize, Green/Refactor đủ evidence, not_applicable cần alternative evidence | Host phải xác thực evidence và kiểm soát quyền ghi trước Red; local probe Red/Green là QA sửa fixture |
| 10. Verification termination | LOCAL PASS default 3 vòng, reject vòng tiếp, inconclusive/blocked escalate; không gửi Developer tiếp sau exhaustion | Không có vòng AI live hoàn tất; host runners vẫn cần deadline thực |
| 11. Git worktree isolation | LOCAL PASS Git thật, scope từng commit, conflict giữ lại, safe cleanup; sửa P13 false-clean RR-05 | Cùng UID không phải security sandbox; filesystem/network guarantees không mở rộng |
| 12. Human approval | LOCAL PASS revision/generation/target/time/human callback, rejection, sửa parallel approvals RR-03 | Callback cần host trusted; low-risk autoaccept còn mở RR-12; hosted branch protections chưa kiểm tra |
| 13. Crash recovery | LOCAL PASS SIGKILL/SQLite/checkpoint/outbox replay, unknown_delivery không resend mù | Chưa chạy crash active AI workflow từ CLI; stale locks cần operator; không chứng nhận power-loss |
| 14. Logging/redaction | LOCAL PASS helper regressions RR-08; sửa context selection RR-09 | Logger chưa compose toàn tuyến; raw Herdr logs/prompt argv và context budget còn giới hạn |
| 15. E2E evidence | LOCAL E2E chạy lại; HERDR smoke thật chạy riêng; CLI LIVE và fault probe giữ evidence | Full Agentic SDLC AI E2E BLOCKED; không suy ra MVP từ test transport giả |

Chi tiết các lỗi đã sửa và rủi ro còn lại ở [security-review](security-review.md).

## Quan sát thực tế mới

Probe CLI tại `/tmp/bf22-1IID4N/repo`, session
`bf-72d524de83e19f0c3a17`, chỉ bật hai role bắt buộc bằng Codex để kiểm tra
lifecycle, không gửi model task. `init`, repeat init, `up`, `status` exit 0.
Chat `w1:p1` hiển thị màn hình đăng nhập/API key dù transport báo idle.
Không có `.bflow/state/agentic/runs.db` hoặc legacy RunStore. Cả `down` và
`down --yes` exit 1: Runtime unavailable. Uncommitted source, state sentinel và
Git HEAD đều giữ nguyên. Cuối probe dùng Herdr stop đúng session thử riêng và
xác nhận `running=false`; đây không phải graceful shutdown PASS của Bflow.
Script và output: `/tmp/bflow-p22-evidence/lifecycle-probe.mjs`,
`lifecycle-results.json`.

Native smoke nhận signed `task.status`, nhưng `submissionStatus=unknown_delivery`,
`nativeSessionObserved=false`, `bindingVerified=false`, Core task vẫn `running`.
Hai smoke PASS chỉ chứng minh đúng các điều kiện này và named-session isolation.
Không gửi lại uncertainty hoặc tạo AgentResult giả để đổi thành success.

Local fault probe có evidence lần đầu ở `/tmp/bfqa-faults-wlWUDx/evidence.json`;
đường dẫn lần validation cuối được lưu trong `final-fault.log`: failing/passing
`node --test` qua CommandQualityGate, trusted artifact bytes, conflict Git và
missing-blob rejection. Đây là local real-component verification, không phải
Developer/Reviewer AI hay complete Red-Green-Refactor qua Runtime.

Archive CD cũ được tạo và giải nén đúng recipe: offline install exit 0 nhưng
`node apps/cli/dist/bin.js --help` exit 1/ERR_MODULE_NOT_FOUND cho pane-manager.
Sau sửa, cùng phép thử exit 0, có đủ package v2 và host prompts/templates.
Manual release nay checkout đúng ref, đối chiếu tag với HEAD, chạy unit/E2E và
smoke distribution trước publication. Chưa chạy GitHub Actions hay publish thật;
không chứng nhận environment reviewers hoặc branch protection trên GitHub.

## Validation cuối

Các lệnh chạy từ worktree root với `TMPDIR=/tmp`,
`VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1`; integration/live chọn một worker.
Raw evidence và exit metadata nằm tại `/tmp/bflow-p22-evidence/`;
`final-validation.json` giữ argv, HEAD, timestamps, duration và exit từng lệnh.

| Lệnh | Exit | Kết quả |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile giữ nguyên; install.log |
| `pnpm build` | 0 | final-build.log |
| `pnpm check:deps` | 0 | 15 packages, 22 internal edges, acyclic; final-deps.log |
| `pnpm typecheck` | 0 | final-typecheck.log |
| `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` | 0 | final-e2e-typecheck.log |
| `pnpm test` | 0 | 56 files PASS, 2 files SKIP; **1287 PASS, 0 FAIL, 2 SKIP**; final-test.log |
| `pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=/tmp/bflow-p22-evidence/final-integration-results.json` | 0 | **38 PASS, 0 FAIL, 0 SKIP**, 2 files; subset của root suite, không cộng coverage |
| `pnpm test:e2e --reporter=json --outputFile=/tmp/bflow-p22-evidence/final-e2e-results.json` | 0 | **63 PASS, 0 FAIL, 0 SKIP**, 10 files, fake transport |
| Live command bên dưới | 0 | **2 PASS, 0 FAIL, 0 SKIP**, 2 files; native actor, không model |
| `node tests/acceptance/local-fault-probe.mjs` | 0 | Real local assertions PASS; retained /tmp/bfqa-faults-V1IxO5/evidence.json |
| `git diff --check` / `git diff --cached --check` | 0 | Kiểm tra lại cả staged reports trước commit |
| `git status --short` | 0 | Trước docs commit chỉ bốn report; kiểm tra sạch sau commit |

```sh
BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp \
  pnpm exec vitest run apps/cli/test/environment-live.test.ts \
  packages/runtime/test/agentic/live-herdr.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose --reporter=json \
  --outputFile=/tmp/bflow-p22-evidence/final-live-results.json
```

Hai opt-in test SKIP trong root suite đã chạy riêng. Full AI SDLC E2E vẫn
**BLOCKED**, không nằm trong số 63 LOCAL PASS hoặc 2 HERDR PASS.


Lượt đầu `pnpm test` ở đầu audit exit 1: 1269 PASS, 3 FAIL, 2 SKIP. Hai lỗi
timeout nằm ở P19 integration (30s và poll 2.5s), một assertion CLI giả định đã
vào shutdown trong deadline 500ms. Lượt đó chạy cùng các probe/build khác;
không bỏ qua hoặc gọi là PASS. Validation cuối giới hạn workers và chạy các
suite tuần tự; không tăng timeout production hoặc tắt assertion để làm xanh test.
Regression mới cho approval/self-review cũng được tái hiện FAIL trước sửa rồi
PASS sau sửa. Lượt đọc chéo sau validation tại `6bb17e7` còn tìm thấy exception
của verifier đồng thời ghi đè human rejection: regression tái hiện `failed` thành
`escalated`. Commit `58a70a0` giữ nguyên terminal status/reason qua restart; toàn
bộ validation được chạy lại trên revision này. Không cộng các lần chạy lại vào coverage mới.

Kiểm tra recipe CD bằng YAML parser và `bash -n` trên từng run block exit 0;
archive smoke sau sửa tại `6bb17e7` được ghi trong `distribution-fixed-results.json`;
chạy lại trên tested HEAD bằng `/tmp/bflow-p22-evidence/distribution-probe.py`
exit 0 (`distribution-final-results.json`), kể cả import tất cả 14 compiled
library packages ngoài source tree. Exact
workspace pack command `pnpm --filter './packages/*' --filter './apps/*' exec pnpm
pack --pack-destination /tmp/bflow-p22-evidence/release-assets` exit 0. Tag-identity
step được chạy trong Git repo disposable: matching tag PASS; missing tag, invalid
tag và tag/HEAD mismatch bị reject đúng cả ba trường hợp (`tag-identity-results.json`).
Đây không thay thế CI trên GitHub hoặc kiểm tra distribution trên máy sạch
không có pnpm cache. `dist`, databases, logs, archive, credentials và fixture
repositories không được commit. Không có migration/upcaster/contract amendment.


Ownership diff tích hợp: 5 file `packages/pane-manager/**`, 9 file
`packages/runtime/**`, `.github/workflows/cd.yml` và bốn report được yêu cầu trong
`docs/**` (19 file tổng). Không thay `packages/contracts/**`, root package/config,
lockfile, README hoặc AGENTS. Các implementation commits: `05a54aa`, `5d3130a`,
`5b57f88`, `6bb17e7`, `58a70a0`. Policy decision RR-12 đã được chủ dự án chấp nhận sau audit: cho phép low-risk
spec autoaccept, giữ human-required gates. Không thay public contract.

Bằng chứng được giữ ở `/tmp/bflow-p22-evidence/` và archive
`/tmp/bflow-p22-evidence.tar.gz`; `SHA256SUMS` ghi checksum từng file. ArtifactStore
và conflict worktree của fault probe ở `/tmp/bfqa-faults-V1IxO5/`, nằm ngoài
archive logs và phải được bảo toàn riêng. Các digest chính:

| File | SHA-256 |
| --- | --- |
| final-test.log | `361cea89ac8093aed465ae84a45253891c0abb48330055680ae2286c14de9c7e` |
| final-validation.json | `5cdcb652681d8840739a8c56f5d54c7f2a9c86a7eec9c05060696d29409b566f` |
| final-integration-results.json | `336d4a33eec0fac5daf7bc8f2c9d3f07f0855e0a8f3289fb8b398cf45236cc89` |
| final-e2e-results.json | `1386a81dcd669ae97714b5d1019e8e3386d5b868e0bf1a7b702a541408bb7fac` |
| final-live.log | `150b76a6a40da085d6af094255115fcd2beadafe8e1dd1753b05c633a0d54336` |
| local-fault-evidence.json | `8524d5962f1827dc31a44224f5d696e6028202632c0b8f481d948391276894d1` |
| lifecycle-results.json | `0f6ea23bb7e6176116a6504d56ec576a27a1d1531b1f67c1bf9f0c3fc5067d76` |
| distribution-final-results.json | `9eee7250226dfac3d941cd00bab81ea98e896aee7c2d723fd68188b63c243c1a` |
| context-documentation-results.json | `a9f16c1ec1f530a2d2a1de91b0a1afd60badcd2e1a339ffb58232dd149f5b803` |

## Quyết định phát hành

| Mức | Quyết định |
| --- | --- |
| Ready for personal use | Chưa xác nhận cho trải nghiệm Agentic SDLC MVP v2 qua CLI |
| Limited pilot | Chỉ phù hợp thử nghiệm thành phần/host tự compose trong repo disposable, có kỹ sư giám sát; không nâng hạng sản phẩm |
| **Not ready** | **Phân loại phát hành hiện tại** vì behavioral runner scope, active-workflow recovery/isolation và AI E2E chưa đủ |

Điều kiện xét lại, theo thứ tự và owner đề xuất, nằm ở
[next-roadmap](next-roadmap.md). Không tạo tag, publish hay merge protected branch
chỉ dựa trên báo cáo này.
