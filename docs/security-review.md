# Security review sau P22

Follow-up lỗi Ctrl+C/readiness/layout/original prompts đã được sửa; kết quả và
giới hạn riêng ở [lifecycle startup UX](acceptance/2026-10-16-lifecycle-startup-ux.md).
Các số liệu/baseline bên dưới giữ đúng phạm vi nghiệm thu P22 trước follow-up.

**Kết luận: các lỗi đã xác nhận trong phạm vi sửa local đã được xử lý; chưa đủ
bằng chứng để nghiệm thu toàn Agentic SDLC MVP v2.** Review không phải pentest
hoặc chứng nhận production. Baseline, source HEAD và kết quả validation cuối ở
[release-readiness](release-readiness.md).

## Trust model

Runtime/host, issuer keys, operator, installed system/toolchain và local filesystem
là trusted computing base. Model không được cung cấp principal, executable/argv,
approval, measurement hoặc xác thực result bằng các boolean do nó tự khai báo.
Herdr done chỉ kết thúc turn. Task success cần correlated authenticated AgentResult,
trusted ArtifactStore bytes, independent task/workflow verification và approval.

All role traffic dùng RoleMessage qua native Herdr/plugin. Private MCP/control
socket là API của host, không là mailbox thay ArtifactStore. Ingress parse exported
schemas và native Ed25519 evidence; session/socket realm, pane/agent/workspace và
native session phải khớp. Dispatch ghi intent trước send, kiểm lease/fencing hiện
tại, giữ unknown_delivery đến khi reconcile được proven not_delivered.

Conversation/Coordinator native tools bị tắt. Developer dùng scoped Edit/Write qua
PreToolUse và structured host Git operations; không có Bash/push/reset/clean/merge.
Provider role process vẫn chung UID: hook/tool policy không bảo vệ trước process
cùng UID bị compromise đọc token, inject terminal hoặc sửa host files ngoài API.
Không nâng giới hạn này thành OS separation toàn hệ thống.

## Behavioral runner isolation

Review tái hiện được test code ghi ra ngoài detached checkout dù `isolated:true`.
Đã thay bằng mandatory Linux Bubblewrap namespace: empty root, read-only `/usr`,
Node executable, `/etc/hosts`, explicit canonical `node_modules` và trusted reporter;
chỉ bind writable measurement checkout, private `/tmp`, PID/network namespaces.
Host home/.bflow/Git metadata/sockets không được mount; không fallback chạy trực tiếp
khi sandbox lỗi. Runner không truyền credentials hoặc inherited Node/Git overrides.

Owner config pin exact command labels/argv/test identities/dependencies trước startup.
Runtime đo committed revision, reject checkout mutation/generated files, timeout,
truncation, missing reporter completion, zero/skip/todo và runtime errors. Required
Red phải là mapped target assertion; exact test blobs giữ nguyên qua Green/Refactor.
Developer feedback không được mint independent acceptance. Reviewer/QA còn phải xem
spec và exact diff, vì TAP/JSON PASS không chứng minh test intent đúng.

Sandbox không là cgroup/resource hoặc kernel-exploit containment. Dependencies/system
binaries do owner cài vẫn là trusted inputs. Read-only dependency mount không cho
truy cập symlink target ngoài namespace. Supported platform/scope ở
[verification runners](verification-runners.md).

## Findings đã sửa

| ID / mức | Lỗi hoặc gap xác nhận | Sửa và bằng chứng |
| --- | --- | --- |
| RR-01/02 / P1 | Default CLI không boot P19; down chưa compose Runtime drain | Persistent host/MCP/hooks/scheduler, activation fence, real checkpoint/down; hai vòng Claude idle lifecycle thực |
| RR-03 / P1 | Parallel task approval ghi đè slot; late verification revive rejection | Durable deferred outcomes, sequential independent approvals; restart/parallel rejection regression |
| RR-04 / P1 | Repair implementer chưa nằm trong frozen plan, có thể self-review | So gate executor với mọi actual task.assignment; regression chống Developer mới đóng vai Reviewer |
| RR-05 / P1 | Git false-clean với hidden index flags/ignored files/GIT_* | Scrub overrides, index/ignored/untracked check; giữ bytes/flags, không auto-clear/delete |
| RR-06 / P1 | P13 close timeout/error vẫn persist down | Parse close result, fail-closed và preserve partial state; targeted failure fixtures |
| RR-07 / P2 | Runtime timeout trả retrySafety ngoài contract và tự retry uncertain work | Contract-valid unknown_delivery/nonretryable/manual intervention; one-invocation regression |
| RR-08 / P2 | Structured envelope/chunked logs có thể lộ secret | Scrub envelope/buffer/sink, detached background relay, host diagnostics; synthetic secret tests |
| RR-09/17 / P2 | Cached selection/document reads theo symlink/special file; stale checksum | Confined no-follow/nonblocking regular descriptor, containment/inode/byte recheck; symlink/FIFO regressions |
| RR-10/11 / P1 release | Archive thiếu packages; manual tag không pin source và thiếu gates | Full package/assets distribution smoke; checkout ref/tag identity + unit/E2E gates. Hosted approval chưa chứng minh |
| RR-14/15 / P1 | Idle bị coi là auth; partial startup không recover được | Provider login riêng, exact launch receipt, persisted intent và reconciliation không duplicate panes |
| RR-18 / P2 | Total context budget không bao hết governance/spec | Bound complete formatted prompt; fail-closed thay vì cắt criteria |
| RR-19 / P1/P2 | Authentication ledgers chỉ memory, native retry thiếu durable intent | Private immutable fsynced observations/human/gate/evidence/native receipts; restart và ACK-loss/conflicting receipt tests |
| RGR-01 / P1 | Required-TDD không có đường runner/Developer-resume thực | Node/Vitest host measurement, scoped tools, borrowed-lease notices; real connected local pipeline |
| RGR-02 / P2 | Registry renew/release commit trước journal save làm retry sai args | Persist exact renew/release requests trước side effect; reopen+clock-advance crash tests |
| RGR-03 / P2 | Crash sau phase lease release làm mất failure outcome, task không thể tiếp tục | Persist failure trước release, automatic recovery + single deterministic repair notice; idempotent replay regression |
| RGR-04 / P1 | Test subprocess có quyền ghi/read host ngoài checkout | Mandatory Bubblewrap namespace và adversarial host file/socket/network probes; không dựa vào env scrubbing để gọi là sandbox |
| HOST-01 / P2 | Long profile TMPDIR làm Unix socket EINVAL | Byte-bound short private socket directory; long-TMPDIR host regression |

Không sửa public contract/schema/migration để vượt policy hoặc hợp thức hóa result.
Compatibility của private owner config và journal giữ trường optional mới; config
cũ không behavioralCommands vẫn normalize thành empty list. Host authority thay đổi
không được silently adopt. Old signed handles không được rewrite để fake correlation.

## Các kiểm tra đặc biệt

| Yêu cầu | Kết quả và giới hạn |
| --- | --- |
| Conversation không vượt Coordinator | Role-filtered tools và Gateway chỉ delegate; native source/shell disabled. Local/native wiring PASS |
| Coordinator không tự approve việc của mình | Dedicated human hook + exact target/revision/generation/time + durable provenance. Low-risk spec autoaccept là ngoại lệ owner cho phép; delivery/human-required không thuộc ngoại lệ |
| Developer không đổi accepted spec để hợp thức hóa | Immutable stored bytes/fingerprint/anti-weakening, scoped commit/edit, Red-test freeze; test sandbox không thấy host state. Không claim chống compromised provider process cùng UID |
| Reviewer không chỉ tin explanation | inspect captures exact committed diff/dossier trước verdict; observations/evidence immutable, actual principal independent, sửa repair self-review |
| Verification không vô hạn | Default max 3, bounded phase repair, reject failed same revision, infrastructure escalation; no extra Developer dispatch sau exhaustion |
| Retry không tạo trùng | Stable message/idempotency, durable send intent/ACK, exact renew/release replay, unknown delivery không blind resend; phase notice dùng lease cũ, không reserve task thứ hai |
| down giữ dữ liệu | Quiesce/checkpoint barrier, safe dirty/ignored preservation, close failure không báo down giả. Idle live PASS; active-model drain/crash còn cần live test |
| attach đúng session | Canonical repo identity, named session/socket realm, manifest/Conversation target và native occupant validation. Không auto-adopt foreign pane |
| Git không phá hủy mặc định | Structured scoped commits, independent integration branch, conflict giữ lại; không reset/clean/force push. Force-remove chỉ disposable measurement checkout riêng |
| Không deploy/protected merge thiếu approval | Coordinator host không có action tool deploy/protected merge; human delivery gate bắt buộc. Không chứng nhận hosted protections/settings chưa kiểm |

## Recovery và approval

Human decision phải có trusted UserPromptSubmit provenance và matching request;
Conversation cache không tự tạo approval. Recovered decisions chỉ restore sau durable
host authentication. Thay đổi binding/session hoặc immutable judgment bị từ chối.
Native uncertain send không được replay chỉ vì MCP timeout; signed late ACK có thể
resolve intent gốc. Phase assertion failures và transport uncertainty là hai domain
khác nhau. Failed phase diagnostics được lưu artifact, không được coi là P16 success.

Các regression xác nhận process-crash windows trên local Linux. Chưa chạy fault
campaign xuyên suốt live AI workflow hoặc chứng minh SQLite/filesystem/transport là
một transaction. Không chứng nhận power-loss, NFS/distributed leases hay exactly-once
arbitrary remote side effects.

## Target filesystem probe

Checkout gốc trên fuseblk không giữ chmod 0700/0600: mode thực là 0777, owner
UID 0 trong khi caller UID 1000. Probe chỉ dùng synthetic bytes và đã xóa.
Private host-file checks không được hạ xuống để chạy trên mount này. Lifecycle
và security receipts được nghiệm thu ở POSIX /tmp, không phải runtime state trên
mount gốc. Dùng POSIX repository/worktree hoặc thực hiện external-state design/
migration riêng trước khi chạy host ở đó. Raw evidence:
`/tmp/bflow-fix-evidence/target-filesystem-permissions.json`.

## Residual release risks

Full AI SDLC evidence, active-run drain/recovery, global provider OS separation,
operational redaction/metrics và hosted release protections còn mở. P02-RA01 thuộc
Herdr Adapter và P03-RA01 thuộc ArtifactStore vẫn OPEN. Chi tiết owner/điều kiện đóng
ở [known limitations](known-limitations.md). Không tự deploy hoặc merge protected
branch để lấy bằng chứng; không quảng bá production-ready.
