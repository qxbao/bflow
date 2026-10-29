# @bflow/runtime

## Local web interaction port (W01–W05)

`openUserInteractionClient({repositoryPath, sessionId})` connects to an existing
agentic host for scoped projections; it never starts or prepares one. Structured
commands require owner-registered Local Server composition:

1. Canonicalize the repository and use `interactionProjectId(canonicalPath)`.
2. Call `registerUserInteractionIssuer({repositoryPath, sessionId}, registration)`
   through private owner IPC. Registration binds `issuerId`, `keyId`, Ed25519
   public PEM, project/host session and `principalId: local-user-<uid>`. Its
   returned credential stays inside trusted server code and cannot call role
   tools or host lifecycle methods. Re-register after host restart.
3. Supply `interaction: {credential, sign(command)}` to the client factory.
   The signer returns a strict `WebPrincipal` from `@bflow/contracts/web-host`,
   signed over `canonicalWebJson` of all fields except signature. Include the
   parsed command fingerprint, real browser session, unique nonce, and proof
   lifetime at most 60 seconds. Keep signing material, credential and private
   IPC details out of browser DTOs/logs/storage. HTTP session/CSRF enforcement
   remains Local Server's boundary.

`execute` admits create/revise/clarification/decision/resume/cancel through
Conversation deterministically, without a model or fabricated native turn.
Versions bind exact questions, approval evidence/generation and pending action.
`readOperation` observes the original command ID after lost acknowledgements;
never generate a replacement key to retry uncertain delivery. Same ID/different
body conflicts. Human decisions share settlement with native input. An approval
operation remains running until actual Runtime effect evidence establishes its
result/lineage; cancel applied means the control request was admitted, not proof
that every process stopped. Runtime retains independent gates, lease/fence,
test-integrity, retry/rework bounds and uncertain transport receipts.

Web receipts use a separate private version-2 store; native-v1 files/provenance
are unchanged. Historical accepted receipts survive browser TTL, while new
submissions require live owner-registered proof. Downgrade with retained web
interaction state is unsupported: older strict Conversation readers cannot
read its additive private receipt ledger. No automatic receipt pruning or
uncertain-command resend is performed. Guarantees are host-local on Linux/local
POSIX filesystems, not multi-host, power-loss or hostile same-UID isolation.

W05 implements `events`, `readArtifact` and `acknowledgeNotice`. Events use an
in-memory projection ring of at most 1000 entries, with scoped epoch:sequence
cursors. Missing/expired/foreign/restarted cursors yield `reset`; reload authoritative
snapshots. Periodic generic invalidation is not a durable domain event or proof
of a command's success. Reading/reconnecting never acknowledges a notice.

Artifacts resolve from the active host's trusted store and must belong to a run
in its repository/Conversation scope. Store verification/deadlines precede byte
streaming; chunks are at most 64 KiB, transfers at most 64 MiB and 30 seconds.
Inline previews are restricted to plain text/JSON/Markdown up to 1 MiB. HTTP serves
these as inert plain text; HTML/SVG/other types are downloads. No arbitrary URI
fetch or filesystem path is accepted. Missing/stopped hosts stay unavailable.

Notice display acknowledgement requires the dedicated owner-registered web
credential and explicit authenticated UI POST for the exact ID. It records the
existing display receipt idempotently and never approves/answers/resumes a run.
Native notices/watchdog and pending decision authority remain unchanged. The frozen
web DTOs do not yet expose general notice content; UI must not acknowledge IDs
merely received in the feed. The W05 handoff includes an integrator proposal.

W08 adds host-private durable chat delivery, exact nonce/session/pane correlation,
normalized Claude/Codex history and immutable assistant receipts. Web turns retain
local_web provenance and their run/session; they never fabricate physical hooks.
Uncertain delivery is observation-only; queued drafts replaced before dispatch
retain conclusive not-delivered state. Chat approval authority is pinned to the
original approval context and still passes independent Runtime gates. Agy Conversation
remains unsupported. Source/local and browser-fixture tests are separate from
isolated real provider/Herdr adapter probes; none establishes full workflow acceptance. See [W02](test/interaction/W02-HANDOFF.md) and
[W05](test/interaction/W05-HANDOFF.md) handoffs.

## Custom specialist profiles (RP-01)

Standard governance roles remain unchanged. Coordinator discovers the configured catalog
with `read_role_profiles` and supplies an exact `roleProfile` pin on Developer tasks or
`request_specialist`. Runtime validates the immutable definition, base role, capabilities,
scope, skills and grants before allocation and dispatch. Review/QA defaults are pinned with
the accepted workflow; conditional evidence uses dedicated profiled QA allocations too.
Instructions append to the original role prompt. Profile labels never establish independent
review: native executor identity and the full implementation assignment history are checked.

Profiled runs use private agentic journal **v7**, rejected by older binaries. Missing pins,
snapshots or executor proof block recovery; no legacy fallback is inferred. Existing unprofiled
v1–v6 journals remain readable. Source/policy drift blocks the next effect, including changes
during awaited preparation or skill checks. Transport turn completion releases a lease but
retains specialist context until a correlated result is applied and native deliveries drain.

Model/effort preferences override unlocked base defaults; exact pack locks still apply.
Changing the configured provider through a profile is explicitly unsupported because native
login, ingress and Gateway setup are provider-bound. Process-tree read/deny restrictions,
remaining network allowlists and unmediated native write subtrees are unsupported where the
backend cannot enforce them. Developer feedback subprocesses with narrowed write scope are
blocked; independent owner verification retains its own policy. Profiles never grant tools.

Known limits and operating notes:

- **Instruction trust.** A profile's `additionalInstructions` and its exact pin both live in the
  repository. The pin detects change, not authenticity; unlike skills there is no machine-owned approval
  receipt. Anyone who can write the repository can add instructions to any specialist, including
  Reviewer/QA. Profiles still only narrow permissions and never replace independent gates, but treat
  profile files like prompts and review them as code.
- **Write scopes.** `restrictions.writablePaths` is enforceable only where the backend can mediate it:
  `restricted` mode (read-only), an empty intersection (read-only), or Agy host-mediated writes. A
  non-empty writable subtree on Codex/Claude in `workspace_auto` is rejected as unsupported.
- **Policy digest.** `baseRolePolicyDigest` binds the installed prompt and compiled host/provider policy
  bytes and is computed once per process. Rebuilding or upgrading changes it for new processes, so
  pinned snapshots are re-resolved rather than silently accepted; rebuild between sessions, not during.
- **Dynamic launches are process-local.** Profiled launches, tool allocations and retained specialist
  launches live in host memory. After a daemon restart they are retired, not recreated; a retired
  profiled pane requires fresh startup/reconciliation. A launch prepared for an allocation that cannot be
  bound to a pane is revoked immediately.
- **Release order.** A profiled specialist is marked released in the session manifest before its pane is
  closed, so an interrupted release recovers as a released allocation instead of blocking recovery.
- **Wider behavior.** Non-conversation, non-coordinator roles now receive the original built-in prompt
  first and host instructions after it, and every Reviewer/QA/Tester dispatch checks executor
  independence against implementation history, with or without profiles.

Daemon restart keeps pinned workflow/snapshot evidence but preserves the existing retirement
of previous live launch authority; it does not recreate tokens or prove a process stopped.
See [the approved design](custom-role-profiles-design.md) and
[validation evidence](custom-role-profiles-evidence.md). Evidence is source plus local tests,
not full live Herdr/provider or SDLC acceptance.

## Linux verification sandbox prerequisites

`bflow up` requires a working Bubblewrap namespace sandbox when automated verification
runners are configured. `bflow doctor` runs the same real execution probe and reports
`runtime-verification-sandbox`; an installed `bwrap` binary alone does not pass it.
The probe never installs tools, changes kernel settings or falls back to running tests
without isolation. It distinguishes a missing executable from a launcher failure and
includes bounded stderr diagnostics. Failed PATH entries resolving to the same binary
are probed only once.

On Ubuntu with `kernel.apparmor_restrict_unprivileged_userns=1`, Bubblewrap can fail with
`setting up uid map: Permission denied` or `loopback: Failed RTM_NEWADDR: Operation not permitted`
when its AppArmor `userns` permission is missing. First install the distribution
`bubblewrap` package if needed. An administrator should inspect existing AppArmor profiles
for `/usr/bin/bwrap`: repair an existing distribution profile rather than adding a duplicate.
For a host with no such profile, review [support/bflow-bwrap.apparmor](support/bflow-bwrap.apparmor)
and explicitly install/load it from the repository root:

```sh
apparmor_parser --skip-kernel-load --skip-cache packages/runtime/support/bflow-bwrap.apparmor
sudo install -o root -g root -m 0644 packages/runtime/support/bflow-bwrap.apparmor /etc/apparmor.d/bflow-bwrap
sudo apparmor_parser --replace /etc/apparmor.d/bflow-bwrap
bflow doctor
bflow up
```

The profile persists across reboot and grants user namespace creation to the system
Bubblewrap binary only. Security trade-off: every local user can then create unconfined user
namespaces through `/usr/bin/bwrap`, which partly bypasses the system-wide restriction; the
administrator must accept that before installing it. The profile does not cover a Bubblewrap
found elsewhere on `PATH` (for example `/usr/local/bin/bwrap`); doctor names the probed launcher. Keep the system-wide restriction enabled; do not make `bwrap`
setuid or change provider permission modes to avoid this check. Other namespace restrictions
(for example container policy) still need host administrator diagnosis. A failed startup
does not prove existing roles stopped: preserve `.bflow` and reconcile with `bflow doctor`;
use `bflow down --yes` only when intentionally stopping the current session.

`RuntimeServiceImpl`, dispatcher, MVP orchestrator và workspace factory hiện có vẫn khả dụng.
P19 bổ sung `AgenticWorkflowRuntime`, `CoordinatorTools`,
`createAgenticConversationHost` và `openAgenticWorkspace` cho luồng SDLC v2.
`bflow up` đã khởi động persistent P19 host và tích hợp platform P30 cùng môi trường P12/P13;
setup/install là bước riêng. Bootstrap một lần qua `node apps/cli/dist/bin.js setup`, sau đó dùng
launcher `bflow`. Xem [trạng thái hiện tại](../../docs/implementation-status.md),
[tool policy](../../docs/tools-sdlc-integration.md) và [runner matrix](../../docs/verification-runners.md).

## Bổ sung sau mốc docs 355a998

Đối chiếu upstream mốc `a7686be` ngày 2026-10-25: [commit audit](../../docs/main-updates-2026-10-25.md) ghi phạm vi source và bằng chứng.

- [Rework causality](../../docs/rework-causality.md): assignment mang finding identity/revision/generation; submission cần `findingResolutions`, host lưu dossier và reviewer có `findingVerdicts`. Mọi finding trong `reworkContext.findings` của generation hiện hành cần verdict độc lập hợp lệ trước pass. Observation/receipt ghim task, attempt, generation và submitted revision; thiếu/invalid evidence không phải lỗi implementation và không tự tạo rework. Verdict `rejected` vẫn tạo finding lỗi theo bounded rework. Settlement chỉ đóng finding được xác nhận tường minh. Journal/dossier cũ vẫn đọc được, nhưng receipt cũ thiếu binding/verdict không được nâng thành bằng chứng pass; cần kiểm chứng lại qua lifecycle hiện có. Đây là enforcement source/local tests, chưa phải live provider/Herdr acceptance; shared reference document còn mô tả giới hạn cũ. Fast-path miễn manual review không miễn verdict cho rework: plan đã đóng băng thiếu kênh verdict sẽ dừng `inconclusive`, không tạo delivery approval; cần evidence/plan độc lập qua governance hiện có.
- [Conversation cards](../../docs/guide/conversation-updates.md): thẻ tiếng Việt, mã `#n`, nhãn `Việc #k`, alias receipts qua restart, structured notice detail trong Log. Không suy display ACK thành human approval.
- [NFR/risk-based references](../../docs/nfr-and-test-design.md): instruction được pin hỗ trợ oracle/conditions/check mapping, không tạo runner, quyền tool hoặc gate mới.

`read_updates` là tool của Conversation trên Bflow host MCP. Gọi `{}` nhận bounded `{updates: [{messageId, kind, text}], remaining}`; mỗi `text` là card đã render. MCP server trả reply trước rồi ACK các message đã surfaced cho model. Các đợt chưa hiển thị có thể được đọc/nhắc lại; nếu còn `remaining`, lấy đợt tiếp theo.

Gọi `{ref: "#3", detail: true}` hoặc `{ref: "Việc #2", detail: true}` nhận một `{detail, note}` riêng, không lặp detail trong danh sách updates. Detail query là đọc chẩn đoán, không acknowledge display hoặc cấp quyền; theo work alias chọn notice liên quan gần nhất. Không có subcommand CLI `bflow read_updates`.

Hook không nhúng raw notice list vào context thường lệ. Lượt người dùng vẫn có private structured context/provenance; phần này không phải nội dung để trích ra màn hình. Stop refusal cần mang card plaintext trước khi mark surfaced, để không mất nội dung khi model chưa gọi tool. Display matching dùng whole tokens và giữ exact legacy IDs nếu receipt chưa có alias; append alias được serialize trong host hiện tại, không phải distributed/multi-host allocation.

Chỉ callback `conversation_notices_surfaced` có thể thiếu native-session argument trong đường ACK sau reply; current authenticated pane vẫn phải có binding/session. Các endpoint khác giữ kiểm tra native session, và ACK này không thể nộp human decision. Prompt tiếng Việt và local hook tests không chứng nhận provider thật đã tuân thủ hoặc toàn bộ live workflow đã pass.

## Workflow chỉ phân tích nghiệp vụ (BA-only, extension)

`AnalysisWorkflowRuntime` (`src/analysis/**`) chạy một DAG gồm khảo sát được phép, elicitation, specification,
review độc lập và publication. Nó tái dùng Core engine, RunStore, ArtifactStore, pack `WorkflowPack` được pin và
quyết định Conditional TDD `not_applicable` kèm alternative verification. Workflow này không tạo task
implementation, deploy, install hay Git integration. Role không có quyền ghi hay chạy lệnh. Chỉ Runtime ghi hai file
bàn giao Markdown sau khi người duyệt đúng digest tài liệu; phê duyệt đó không phải nghiệm thu sản phẩm.

`AgenticWorkflowRuntime.proposeWorkflow` bắt buộc DAG chỉ gồm Developer task và kết thúc bằng workflow verification
trên change đã tích hợp Git. Vì vậy BA-only được tách thành luồng tương thích riêng, không giả lập implementation.

Chi tiết về pack, provenance, các kiểm tra, recovery, revision, phần tích hợp host/CLI còn lại và giới hạn: xem
[ANALYSIS-ONLY-WORKFLOW.md](ANALYSIS-ONLY-WORKFLOW.md). Pack mẫu: [support/analysis-only-pack.json](support/analysis-only-pack.json).
Mức bằng chứng: source cộng test local với role giả lập; chưa nối host/Herdr/Conversation/CLI.

## Workflow chỉ kiểm thử (QA-only, extension)

`QaWorkflowRuntime` (`src/qa/**`) kiểm thử một hệ thống có sẵn mà không sửa nó. DAG cố định: thiết kế test → review
độc lập (người duyệt đúng digest thiết kế) → thực thi → phân xử kết quả → báo cáo bug/evidence. Role không có quyền ghi,
chạy lệnh hay truy cập mạng. Chỉ Runtime chạm vào target, qua tool có grant, kiểm tra readiness, giữ lease môi trường
có fencing token suốt transaction và chỉ ghi test asset/báo cáo vào workspace được cấp. Origin, hành động, tài khoản,
dữ liệu và cleanup đều do intake khai báo. Mutation bị timeout được đối soát bằng probe chỉ đọc, không bao giờ gửi lại.
Kết quả được phân loại thành passed, product_failure, test_defect, environment_failure, blocked hoặc inconclusive.
Phát hiện bug không cấp quyền sửa sản phẩm.

Chi tiết và giới hạn: xem [QA-ONLY-WORKFLOW.md](QA-ONLY-WORKFLOW.md). Mức bằng chứng: source cộng test local chạy trên
app fixture HTTP thật (process riêng) với role giả lập; browser adapter mới là port; chưa nối host/Herdr/Conversation/CLI.

## Composition và thực thi

Coordinator và Developer cùng các specialist đọc policy và skill đã pin qua
`read_pinned_instructions` của MCP Bflow, theo native pane và launch hiện tại.
Danh sách skill do provider tự phát hiện ngoài manifest không tạo prerequisite cho
Bflow; manifest rỗng không yêu cầu đọc plugin trong HOME. Công cụ chỉ trả nội dung
đã xác minh hoặc policy của role, không nhận đường dẫn tùy ý và không mở quyền đọc
`.codex`. Các gate SDD/TDD, verification, delivery và phê duyệt vẫn áp dụng.

`openAgenticWorkspace(options)` mở một session P12/P13 hiện có đang chạy (up), xác thực
repository binding của nó, dùng RolePaneManager thực tế và Herdr CLI adapter,
rồi ghép Core, file Registry, SQLite RunStore, filesystem
ArtifactStore và các engine P14–P18 đã triển khai. Nó không tạo các permanent role trùng lặp.
Các lệnh Herdr dùng `HERDR_SESSION` riêng cho từng repository, xóa các ghi đè
định tuyến pane/socket được kế thừa theo cách giống P12. Preflight CLI/protocol chạy
trước khi mở tài nguyên bền vững hay cấp phát Developer.

Developer dùng platform launch phải có native session thực tế được lưu trong manifest và
đã kết thúc lượt startup trước khi cấp phát thành công, kể cả khi không có Gateway registration.
Runtime đối soát quan sát Herdr rồi trả binding hiện tại; outbox giữ assignment ở hàng đợi
trước khi lấy lease hoặc gọi transport nếu platform binding chưa có session. Handle đã được
chấp nhận mà thiếu session từ bản cũ vẫn bất biến và không được tự gắn session hay gửi lại;
trường hợp đó cần đối soát riêng, không phải bằng chứng tác vụ hoàn tất.

Với Node TAP hoàn chỉnh và đúng danh tính test, exception trong thân test không phải
assertion được lưu thành quan sát không được chấp nhận và gửi lại Developer để sửa test
theo giới hạn rework hiện có. Nó không phải bằng chứng Red và không cấp quyền sửa mã sản phẩm.
Output thiếu/sai danh tính, lỗi hook, timeout hoặc sandbox vẫn là lỗi hạ tầng cần đối soát.

Sau một explicit resume cho phase bị lỗi hạ tầng, Runtime gửi notice retry về đúng Developer
đang giữ execution; không yêu cầu Coordinator gọi công cụ chỉ dành cho Developer. Nếu host
ngừng quá TTL lease, Runtime chỉ cấp lease tiếp nối qua Registry sau khi đối chiếu native session,
worktree, capability và Core execution hiện tại. Fence phải tăng; assignment, request và handle
gốc giữ nguyên. Intent cấp lease và lịch sử lease riêng được lưu để replay đúng idempotency key
sau crash; tối đa ba lần tiếp nối cho một assignment. Human gate, cancellation, unknown delivery,
session bị thay hoặc không có native binding đều chặn đường này. Không có SQL/public-contract migration;
bản cũ không hỗ trợ tiếp nối phải đối soát thay vì gửi lại assignment.

Continuation tường minh sau một auto-resume có message ID riêng: receipt tự động không được
nuốt yêu cầu tiếp tục qua Conversation. Wake cũ và trạng thái delivery của nó giữ nguyên;
retry tường minh cùng blocker trả về receipt riêng, tính một lượt manual và giữ trạng thái
business đang chạy. Các fence diagnostic hiện hữu được đưa vào wake để đối soát; chúng
không phải ACK, phê duyệt hoặc quyền bỏ qua bằng chứng TDD. Không thay public contracts.

Quyết định tích hợp riêng cho lần live 2026-10-23: chủ dự án chọn giữ run và thêm fence cho
diagnostic cũ thay vì hủy run. Chỉ lệnh người dùng vật lý qua Conversation
`fence diagnostic <operation-id>` có thể hủy một `task.status: blocked` từ pane Coordinator
đã nghỉ, gửi tới Conversation, còn unknown và chưa có inbox/ACK. Không có model tool thực hiện
thao tác này. Intent gốc vẫn unknown, không được gửi lại; tombstone lưu người quyết định và
message ID của lượt người dùng, đồng thời từ chối mọi bản đến muộn trước khi đổi business state.
Assignment, result, approval và diagnostic từ pane hiện tại không được fence theo đường này.

Owner/compatibility: lựa chọn của chủ dự án trong vòng live này cho phép thêm fence diagnostic.
Chỉ Runtime host, Conversation intake và journal riêng của Runtime bị ảnh hưởng; callback
host tùy chọn mặc định từ chối, nên composition cũ không được cấp quyền fence ngầm.
Journal riêng của Runtime vẫn đọc v1; lần fence đầu tiên ghi v2 trong cùng
lần lưu tombstone. Binary cũ từ chối v2. Không upcast v1 thành bằng chứng fence; v1 có fence
bị từ chối. Shared `@bflow/contracts`, `RuntimeService`, Core event/checkpoint codecs và SQLite schema không đổi.
Không downgrade một session đã fence về binary cũ; giữ journal và dùng Runtime có hỗ trợ v2.

Retire một policy phase là quyết định riêng qua lệnh vật lý Conversation
`retire policy phase <request-id>`, không được suy diễn từ fence diagnostic, resume hoặc duyệt thiết kế.
Host chỉ chấp nhận request đã có blocker xác thực đúng verifier/correlation/causation, pane/native session verifier
đã thay, lease hết hạn và không có receipt kết quả cần đối soát hoặc phép đo đang chạy trong host.
Thiếu receipt không chứng minh phép đo chưa chạy: disposition là `retired_without_measurement_claim`.
Giữ nguyên request, handle, blocker và grant lease cũ; Registry không hỗ trợ release lease hết hạn,
nên không tạo receipt release giả. Tombstone được lưu trước khi loại request khỏi dispatch/renewal.
Mọi verification.result cũ, kể cả inbox received replay, bị từ chối. Chỉ sau resume vật lý được host xác thực qua Conversation (lưu đúng user message ID), Runtime thông báo
Developer hiện hữu yêu cầu đo cùng phase/revision bằng request ID mới; không gửi lại assignment.

Quyết định compatibility riêng cho sửa lỗi live: chỉ Runtime host/intake/outbox/journal thay đổi;
public contracts/Core codec/SQLite giữ nguyên. Journal đọc v1/v2 như trước, và ghi v3 khi retire phase.
Binary v1/v2 từ chối v3; không downgrade session đã retire. Fence diagnostic sau đó không hạ version.
Retirement được chặn bởi approval/user-decision/unknown delivery/cancellation và giới hạn riêng
`maxIterations` theo run/task/implementation-attempt/phase qua các revision. Replay không tiêu thêm lượt;
retirement không là measurement, Red hoặc repair failure, và không reset giới hạn verification/TDD.
Cancellation không release giả grant đã hết hạn của retirement; vẫn dừng Developer/Core bình thường và báo riêng outcome lịch sử chưa được xác nhận.
Quyền áp dụng từng retirement phải đến từ chủ dự án qua command vật lý chính xác; model không có tool cấp quyền.

Control client giới hạn phản hồi thông thường ở 4 MiB; riêng RPC `checkpoint` nhận tối đa
16 MiB để không mất acknowledgement của aggregate checkpoint đã lưu vượt 4 MiB.
Checkpoint lớn hơn vẫn bị từ chối và phải đối soát id/checksum đã lưu trước khi retry;
việc vượt giới hạn phản hồi không chứng minh thao tác ghi thất bại. Public checkpoint codec không đổi.

Khi phép đo bị từ chối, phản hồi QA trả đúng request/phase/revision, summary, loại repair và
ArtifactReference đã lưu nếu có, kể cả replay. `phaseRecorded: false` và `implementationAuthorized: false`
phân biệt outcome bị từ chối với bằng chứng TDD được chấp nhận; lifecycle status riêng không đủ
để kết luận thiếu output hoặc xin đo lại. Runtime vẫn giữ quyền điều phối repair/resume có giới hạn.

`assignment_context` đặt `policyEvidence` gọn trước dossier đầy đủ: receipt TDD đã được
Runtime chấp nhận tách khỏi outcome bị từ chối, giữ nguyên phase/revision/verification ID
và ArtifactReference/checksum. Chỉ xuất các run đã thuộc assignment hiện tại của pane;
không suy luận bằng chứng từ progress, transport state hay nội dung agent tự khai.

Sau resume vật lý qua Conversation, Runtime gửi một task notice tiếp nối riêng cho
Developer hiện hữu nếu cùng Core execution vẫn running, lease còn hiệu lực và required TDD
đã có đúng Red được chấp nhận. Notice không cấp Red hay approval mới và không sửa test;
retry cùng resume giữ nguyên ID. Các gate, cancellation, unknown delivery và giới hạn resume
được kiểm tra trước đó như cũ; resume tự động hoặc Coordinator không tạo notice này.

QA workflow sử dụng `inspect_review` để quan sát diff và chạy command do host đã cấu hình
trên đúng commit tích hợp. Kết quả test và ArtifactReference/checksum được lưu cùng observation
host bất biến, trả gọn qua `qaBehavioralObservation`; không dùng tool phase TDD cho gate này.
`complete_review` vẫn yêu cầu judgment độc lập cho từng criterion và không thể pass nếu test
thực tế thất bại. Observation diff-only cũ không được nâng thành bằng chứng test; phải inspect
lại qua host. Test tiếp tục chạy trong sandbox verification hiện hữu, không nhận argv/revision
hay output từ agent. Gate timeout/bounds/approval không đổi và không sinh thêm TDD receipt.
Tổng ngân sách setup/prepare/test được giới hạn theo thời gian gate còn lại, có margin cho ACK; chỉ giảm timeout tối đa, không đổi command/argv. Batch không còn đủ ngân sách bị từ chối trước execution. Completed submission replay xác thực receipt trước khi đọc worktree; completion đầu tiên vẫn kiểm tra source, kể cả sau restart.

Verification retry sau restart dựng plan bằng journal state được truyền tường minh trong
transaction, không phụ thuộc state tạm chỉ tồn tại trong `tick`. Implementer IDs được giữ
đúng từ execution gốc cho kiểm tra độc lập; commit tích hợp, task evidence và các giới hạn
retry/approval không đổi. Cùng đường này phục vụ explicit resume và `retry_verification`.

Gate retry tạo request ID mới sau một verdict đã áp dụng hoặc blocker `task.status: blocked`
được xác thực đúng request/run/correlation/agent/pane. Request cũ và outcome giữ nguyên;
không giả verdict hay ACK. Blocker có thể đến trước khi lease được release: lượt mới chỉ
được queue, còn Registry và kiểm tra pane vẫn chặn dispatch tới khi capacity sẵn sàng.
Sending/unknown delivery không được coi là một attempt đã đối soát; các giới hạn verification
và phê duyệt hiện hữu không đổi.

Agy specialist nhận envelope từ transcript native theo launch, pane/session và
prefix đã ghim. Lời gọi MCP giữ anchor và đúng vị trí tool trong planner qua cả
hook lẫn host; sự kiện cũ không được gắn sang turn mới. Raw Stop vẫn không chứng
minh turn/task thành công. Turn mới được Runtime cho phép chỉ thay quyền thao tác
của turn cũ, không discharge kết quả hoặc phê duyệt. Host đưa schema MCP trực tiếp
vào prompt Agy vì native file/shell vẫn bị từ chối. Output lớn bị Agy lưu thành file
có thể cần truy vấn lại bằng tool với giới hạn nhỏ; native đọc các file này chưa được cấp.

Developer có `read_workspace_file` và `write_workspace_file` để thao tác UTF-8
trong ownership của task dưới lease/fencing và TDD hiện tại. Ghi đè cần SHA-256 đã
đọc; tạo file cần `expectedSha256: null`, parent đã tồn tại. Giới hạn 128 KiB và
descriptor-relative traversal trên Linux và macOS từ chối symlink, hardlink, special file và
workspace read-only. Không hỗ trợ tạo thư mục, ghi binary, crash-atomic replacement
hoặc cô lập process cùng UID thù địch. Các test cục bộ không chứng minh Developer
Agy thực hiện được toàn bộ SDLC trên provider thật.

Review bổ sung cho macOS: `forbiddenPaths` và control paths dùng so sánh Unicode case mappings
bao gồm ſ/s, ß/ss và ligature ﬂ/fl, không chỉ lowercase. File test đã có phải được nhận diện
bằng cùng device/inode (bigint) trước khi cấp quyền sửa qua alias; phép so sánh deny bảo thủ
không tự cấp quyền TDD. Native edit cũng từ chối binding read-only. Cache helper bị xóa được
biên dịch lại trước thao tác; mọi lỗi chuẩn bị được loại khỏi cache sau khi trả lỗi, với tối đa
một lần sửa cache thiếu trong một request. Không replay một thao tác đã gọi helper. Xem
[review sau bàn giao](../../docs/acceptance/2026-10-24-macos-portability-review.md).

Trên macOS, Runtime biên dịch helper C đi kèm bằng `/usr/bin/clang` của Apple Command
Line Tools trong thư mục tạm riêng mode 0700; không tải dependency, không dùng shell
hay thay đổi provider settings. Source nằm trong `workspace-file-darwin-source.ts`,
được mang theo bản build TypeScript, không phụ thuộc ABI addon Node. Helper dùng
`openat`/`O_NOFOLLOW` cho từng component, `F_GETPATH` để phát hiện directory bị dời,
và descriptor riêng cho leaf; SHA-256 dùng CommonCrypto của macOS. Binary được giữ
riêng cho process và dọn khi process thoát bình thường; thư mục còn sau crash không
được tái sử dụng. `prepare` thử tạo/đọc/thay file thực trước launch; Developer dispatch
thử lại capability trước khi giao việc. Thiếu compiler chặn startup với hướng dẫn
`xcode-select --install`. Không suy diễn rằng `workspace_status` thành công là bằng
chứng thao tác file đã hoạt động. Xem [báo cáo macOS](../../docs/acceptance/2026-10-24-macos-portability.md).

Spike chỉ đọc đã được kiểm chứng với Codex Conversation và Agy Coordinator/Architect:
giao việc thực tế, đọc nguồn qua MCP, signed reply được Runtime áp dụng đúng
correlation/causation và kết quả quay về Conversation. Launch cũ bị host đang chạy
từ chối. Bằng chứng này không phải acceptance cho Developer Agy hoặc workflow SDLC đầy đủ.

Các đầu vào host bắt buộc là tường minh: định danh repository/session, role capability,
định nghĩa check của task/workflow, deterministic gate runner, ingress thông điệp/result/evidence
Herdr có xác thực và phê duyệt của con người có xác thực. Không có
stub thành công cho production hay callback xác thực mặc định. Check ID của Review được
ghép thành `runtime.herdrQualityGate(id)`, hàm này gửi `verification.requested`
qua Herdr outbox bền vững và chờ một `review.verdict` có xác thực
chứa `QualityGateResult`. P17 xác minh quan sát của nó, revision chính xác,
ánh xạ criterion, tính độc lập và cửa sổ thực thi. Các deterministic gate phải là
host runner thật, được cô lập, cấu hình cho các check ID tương ứng.

Host dùng các interface được trả về như sau:

```ts
const host = await openAgenticWorkspace({
  repositoryPath, sessionId,
  taskChecks, workflowChecks, deterministicGates, roleCapabilities,
  authenticateMessage, authenticateResult, authenticateEvidence,
  authenticateGateResult, authorizeHuman,
  projectApprovalRequired
});

// Authenticated user interaction goes only to the actual P14 Conversation Gateway.
await host.conversation.handleUserTurn(userTurn);
await host.runtime.flushOutbound();

// A separate trusted inbound pump delivers envelopes AFTER physical Herdr receipt.
await host.runtime.receiveHerdr(coordinatorOrRuntimeEnvelope);
await host.conversation.receiveHerdr(conversationEnvelope);

// The Coordinator's provider host injects its principal; never read it from tool arguments.
await host.tools.invoke("propose_workflow", {
  runId, specification, definition, maxIterations: 3
}, { role: "coordinator" });
await host.tools.invoke("tick", {}, { role: "coordinator" });
```

Tool `tick` của Coordinator lên lịch công việc nền và trả về ngay lập tức.
Coordinator phải nhường lượt của mình thay vì polling khi pane của chính nó đang bận.
`tick_status` báo cáo lỗi scheduler của host; `CoordinatorTools.drain()` là một lần chờ
lifecycle của host, và `close()` drain các công việc do Coordinator lên lịch còn tồn đọng.
Inbound pump phải luôn khả dụng trong khi Runtime `tick()` chờ xác minh từ xa.
Không await một lượt agent từ bên trong mailbox handler của chính nó. Tiếp tục tick/drain
các thông điệp outbound độc lập với lượt của người dùng. Dừng lên lịch và hoàn tất các
thao tác host còn tồn đọng trước khi `host.close()` đóng các storage handle. Việc đăng ký prompt
và tool gốc của provider thuộc về trusted agent host; nạp
`agents/coordinator/system-prompt.md` vào pane Coordinator của nó.

Composition Conversation giữ nguyên việc lưu context của P14, correlation ID,
hàng đợi inbound bận, nguồn gốc phê duyệt và ủy quyền hủy. Trong persistent
host, Chat xác định ý định thông thường qua `conversation_decide`; Gateway
xác thực quyết định có cấu trúc và quản lý trạng thái bền vững cùng việc giao nhận.
Các phương thức delegation/approval outbound của nó xếp hàng qua P19. Lối tắt callback
progress/approval cục bộ của bridge cũ bị vô hiệu hóa trong composition này. Một
mục hàng đợi đã lưu chỉ xác nhận việc enqueue cục bộ, không phải việc nhận prompt từ xa.

Provider prompt ingress chấp nhận đúng một wrapper `pasted_content` hoàn chỉnh của provider
quanh một RoleMessage theo schema đã export. Nó vẫn yêu cầu đúng thông điệp Runtime outbox đã pin,
pane người nhận và native session trước khi có Herdr ingress đã ký; văn xuôi xung quanh,
nhiều wrapper và envelope bị thay đổi không thể tạo handoff đáng tin cậy.

Tool `send_role_message` công bố các trường của RoleMessage v2 và yêu cầu
`artifact_references` (dùng `[]` nếu chưa có artifact đã lưu). Native ingress còn yêu cầu
`idempotency_key` ổn định; host kiểm tra trước khi ghi native intent hoặc gọi plugin.
Host không tự thêm mảng artifact hoặc tạo khóa cho payload thiếu trường. Prompt của role
có ví dụ envelope đã được xác thực; `assess` và `propose_workflow` công bố các trường của
Specification v2, kể cả criterion `status`/`evidenceArtifactIds`. Các Zod contract vẫn xác
thực nghiêm ngặt và kiểm tra các ràng buộc giữa trường tại ingress.

Riêng `assess` yêu cầu impact assessment tường minh tại `specification.metadata.sdd.assessment`.
Một `Specification` hợp lệ theo shared contract vẫn có thể thiếu dữ liệu P15 này. Tool discovery
công bố các trường assessment; tool boundary và direct Runtime caller đều từ chối object thiếu
với schema path và hướng dẫn đọc `planning_reference(section="specification")`. Policy P15 được
nạp qua adapter vẫn xác thực các impact flags; Runtime không tự điền hoặc suy đoán chúng.
`assess` chỉ trả phân loại/gợi ý role, không sửa classification trong draft, duyệt spec, tạo DAG
hay dispatch. Khi chuẩn bị proposal, Coordinator phải cập nhật draft theo kết quả policy và giữ
nguyên các acceptance criteria đã được ủy quyền.

Native intent thiếu ACK giữ trạng thái uncertain và chặn gửi lại cùng operation.
`reconcile_delivery` chỉ đối soát Runtime outbox; chưa có API xác nhận `not_delivered`
cho native intent. ACK/application đến muộn có thể giải quyết trạng thái uncertain;
Runtime giữ riêng các native intent chưa xác nhận trong journal, kể cả khi run đã bị
schema blocker hoặc đang chờ phê duyệt. Host khôi phục các intent cũ trước khi tự resume;
resume, thay đổi yêu cầu và dispatch công việc mới phải chờ đối soát. Một ACK chỉ giải quyết
đúng intent của nó. Kết quả specialist đến muộn trong lúc pause chỉ được nhận nếu trùng
toàn bộ native intent và assignment đã bind; việc nhận này không resume hay phê duyệt run.
`resume_run` tiếp tục run hiện hữu, không xác nhận giao nhận hay cho phép resend.
`inspect_native_delivery(operationId)` của Coordinator/Conversation đối soát chỉ đọc native intent,
ACK, refusal trước admission và Runtime inbox. Tool này khác `reconcile_delivery` của transport outbox:
nó không gửi lại, resume, sửa criteria hoặc xác nhận task thành công. Intent cũ thiếu key nhưng không
có receipt từ chối vẫn là `unknown_delivery`; không tạo hồi tố bằng chứng `not_delivered` từ lỗi schema.
Signed native ingress lưu riêng refusal khi `idempotency_key` không hợp lệ trước khi gọi Runtime;
chữ ký sai và lỗi xảy ra sau admission không tạo loại bằng chứng này. Restart chỉ giải quyết intent
khớp refusal đã quan sát, giữ nguyên blocker nghiệp vụ và các human gate; không tự giao assignment mới.
Inbox `received` có xác thực là bằng chứng giao nhận bền vững, chưa phải kết quả nghiệp vụ được chấp nhận.
Khi run pause, outcome của execution đã bind được giữ ở `received` và phản hồi deferred; chỉ sau resume
mới chạy lại đầy đủ validator/gate để apply một lần. Báo cáo ACK cũ dùng cùng fingerprint cho phép thay
chữ ký binding của native host, nên không tạo lại intent đã nhận. Stop của specialist cũng được giữ riêng
theo execution ngay khi còn uncertainty; chỉ retry khi delivery đã rõ, capacity đã release và chưa có result.
`inspect` chỉ đọc journal, không tự restore Core hay chạy các thao tác recovery nghiệp vụ.
Inbox `rejected` sau admission cũng giải quyết đúng native intent đã nhận và bị từ chối; không giải quyết
nghĩa vụ trả kết quả của assignment hoặc cho phép gửi lại envelope đó. Native ingress vẫn kiểm tra đầy đủ
envelope, kể cả array `artifact_references` và key; producer mới có thể dùng `message_id` làm key ổn định
trước khi ghi intent. Không chuẩn hóa hoặc sửa lại intent cũ khi recovery. Retry verification tự động và
tường minh đều giữ guard đối với native uncertainty và outbox `sending`/`unknown_delivery`.
Watchdog phân biệt delivery `accepted`/`released`, thời điểm transport accepted và thời điểm
run ngừng có hoạt động; thông báo chứa role/pane/task/attempt. Cảnh báo hoặc resume không
phải bằng chứng cho phép tạo attempt mới. Stop phải khớp agent, native session và thời điểm.
Conversation nudge `[bflow]` không được dùng lại user turn trước đó để quyết định hoặc resume;
user turn thật tiếp theo có boundary riêng và vẫn phải được xử lý đúng một lần.
Các kiểm thử schema, host RPC và receipt ở đây là kiểm thử cục bộ, không phải nghiệm thu Herdr/provider live.

Host tương quan bền vững các quan sát prompt/Stop của Coordinator với đúng delegation
đó. Một lượt kết thúc mà không có phản hồi có cấu trúc tiếp theo sẽ xếp hàng một thông báo
tắc nghẽn có tương quan tới Conversation qua Herdr outbox hiện có. Điều này
cũng bao gồm một prompt đã giao mà Runtime ingress đã ký của nó chưa bao giờ được áp dụng.
Các baseline phản hồi riêng tư phân biệt các lượt trước đó; progress đã xếp hàng, phản hồi gốc
đang chờ và các quyết định bắt buộc của con người giữ nguyên trạng thái chờ hiện có. Thông báo
chỉ báo cáo phản hồi còn thiếu, không bao giờ là chẩn đoán provider hay kết quả task;
nó không tạo/replay ingress, không gửi lại delivery không chắc chắn, và không hoàn thành/làm fail một run.
Các đường này có test subprocess/fake-transport cục bộ và test Gateway thật, không có
bằng chứng nghiệm thu provider/Herdr live.

Các thông điệp outbox gửi tới Conversation không bao giờ được gõ vào ô nhập của Conversation. Lượt
outbox có khóa chỉ ghi chúng trước dưới dạng `sending` (không lease, không transport send); Runtime
sau đó áp dụng chúng trong cùng process vào Conversation Gateway (`deliverToConversation`) sau khi
nhả journal lock, vì Gateway có thể drain một lượt người dùng đang xếp hàng, và lượt đó enqueue ngược
vào Runtime. Gateway khử trùng lặp theo `message_id`, nên một lần giao bị lỗi hoặc gián đoạn được
xếp hàng lại và thử lại, kết thúc ở trạng thái terminal `delivered`. Mỗi thông điệp được áp dụng
được giữ như một notice bền vững (summary giới hạn 4096 ký tự) cho đến khi model đã
thấy nó qua card plaintext của hook/Stop hoặc tool `read_updates` sau một lần nhắc inbox `[bflow]`. Raw notice list không còn được nhúng vào context thường lệ; private user-turn/provenance context vẫn là dữ liệu nội bộ. Inbox được kiểm tra mỗi 2 s (`BFLOW_INBOX_CHECK_MS`,
500 ms–30 s): nó hiển thị một thông báo Herdr và chỉ gửi lần nhắc khi Conversation
agent đang idle và ô nhập Claude của nó được xác minh là trống. Ô nhập được đọc dưới dạng ANSI để gợi ý
prompt kế tiếp mờ (SGR 2) của Claude được tính là trống trong khi bản nháp đã gõ thì không. Một
notice chưa hiển thị được nhắc lại sau 5/10/20/60 s; layout/provider không được nhận diện sẽ fail closed. Đường hiện tại hỗ trợ nhận diện Conversation Claude/Codex (xem phần workflow liveness bên dưới). Notice chỉ là bằng chứng
về việc giao nhận, không bao giờ là task thành công, và lần nhắc không bao giờ tạo lượt người dùng hay phê duyệt. Việc phát hiện
ô nhập trống, thông báo và tiếp tục Stop-hook chưa được xác minh live.

### Hiển thị notice của Conversation, notice từ chối và hang watchdog

- **Structured decision notices.** A user decision notice stores bounded fields (approval id, role,
  question up to 2000 characters, at most 10 options of 500 characters, deadline) beside the
  4096-character summary, so a long question stays answerable. Receipts written before this field
  still render from their summary, or degrade to a generic update that says it was cut short.
- **Display acknowledgement.** Final assistant text is checked against the rendered card/work identity and its content rules. Current receipts use whole-token `#n`/`Việc #k`; legacy receipts keep their exact IDs. `#1`, `#12` and `Việc #1` are distinct. Undisplayed notices retain bounded Stop reminders; reading/surfacing a notice never approves it or proves human attention. Last assistant text is read back to the genuine user prompt, skipping tool-result entries.
- **Rejected workflow proposals.** `propose_workflow` pre-checks (project policy, then verification
  support) return a structured error `{ code, reason, methods?, criteria?, options }` to the
  Coordinator. Runtime retains a validated private rejection record while allowing correction
  in the same turn. On Coordinator STOP, the rejection becomes a durable manual blocker;
  restart/watchdog do not retry the unchanged configuration. Explicit resumes retain the existing
  limits and delivery/approval fences, with a distinct idempotent action per recurrence.
  User-facing codes: `no_test_runner_detected` (unknown ecosystem found no
  supported runner; options: the Coordinator adds a setup task, or the run is cancelled), plus
  `unsupported_verification` and `policy_violation`; `missing_behavioral_runner` remains only for
  owner-configured runners. Coordinator-fixable codes are returned to the Coordinator as the tool error
  and are never sent to Conversation: `runner_setup_required` (a recognized ecosystem needs a reviewed runner/reporter setup task), `missing_test_paths` (no test file in `affectedPaths`),
  `missing_test_mapping` (missing or ambiguous identities, owned test scope, or task execution budget), `unknown_test_command` (a target
  command is not a detected label, or the label is missing from `infrastructure.commands`) and
  `unsupported_method` (no runner for the criterion's method) and `invalid_specification` (the specification,
  workflow definition or P16 `metadata.conditionalTdd` assessment fails its schema; the reason lists each invalid
  field by full path). The options are informational; nothing
  is applied automatically, and the specification and its criteria are never changed by Runtime.
  Whole-spec runner binding checks individual command budgets; before admitting a DAG, Runtime
  resolves each task's actual strategy and ownership, requires every automated criterion to bind,
  and enforces the aggregate 540s task budget. Detection and binding do not prove sandbox readiness
  or test success: independent execution and authenticated evidence remain required.
  Automatic detection is retried on each proposal while unsupported and refreshed after repository HEAD changes. Dynamic checks/gates use the same VerificationEngine when each plan is frozen, so no host restart is needed.
  Policy-required methods need real measurements: in automatic mode `auto:static` is only `git diff --check`
  plus a syntax check of changed JavaScript (`node --check`) and JSON files, and fails when another code file
  changed; each required behavioral method needs an accepted criterion mapped to committed tests. A policy
  requiring `manual_review` alongside automated criteria is refused at proposal time, because behavioral
  verification never records manual review evidence.
  An owner-configured runner (`.bflow/verification.json`, optional override) is pinned when the host is
  created (`docs/verification-runners.md`), so changing that file later requires quiescing the host.
- **Hang watchdog** (`src/agentic/run-watchdog.ts`, pure `evaluateWatchdog`; host timer every 15 s).
  It (a) recreates a pending user decision's notice receipt from the pending request when none exists,
  after 60 seconds, then re-registers with Conversation; (b) resurfaces a user decision that stays
  undisplayed for 60 seconds, at most three times, after which one `workflow_blocked` notice is emitted
  per approval; (c) reports a live run as `run_stalled` once per episode, when it has no pending
  decision, human gate or non-terminal handoff, every role pane is `idle`, `done` or `unknown`, and
  there has been no non-Conversation activity for 180 seconds. A Herdr `done` or `idle` means only
  "not working", never success. Activity is the `occurred_at` of non-Conversation messages for the run,
  falling back to the delegation time. Limits: an unreadable pane is treated as working, and a design
  approval that never reached Conversation is not reconciled by the watchdog. Resurfacing counts
  unsurfaced notices as well, so a busy Conversation pane can reach the blocked notice.
- **Not live-verified.** The host timer, the Herdr notifications and the Stop-hook display acknowledgement
  depend on a live Herdr and Claude Code session. Tests cover the pure logic, the receipt epochs, the Runtime
  reports and the Gateway wiring with a fake transport; the host closure itself is only type-checked.

## Policy và vòng đời

Coordinator có thể đánh giá yêu cầu, chỉ yêu cầu các specialist hữu ích, tự chuẩn bị
specification/DAG, hoặc yêu cầu chuyên môn Analyst/Architect/Planner qua
Herdr. Không có chuỗi role cố định. DAG triển khai hiện chứa các node
Developer; công việc chuẩn bị/chuyên gia chỉ đọc dùng `request_specialist`.
Không có tool thay đổi đồ thị tùy ý hay sửa source nào được expose cho Coordinator.

`proposeWorkflow` xác thực các schema Specification/WorkflowDefinition đã đóng băng thực tế,
chính sách tác động và traceability của P15, giữ nguyên các criterion được ủy quyền, kiểm tra
quyền sở hữu đường dẫn literal và yêu cầu các dependency thành công. P16 phân giải
workflow và các strategy theo từng task; P15 lưu/review các dossier bất biến. Các specification
đầu vào đầy đủ bao gồm các trường design, security, rollback, decision và
strategy bắt buộc. `metadata.conditionalTdd` của task có thể cung cấp một đánh giá cụ thể;
nếu không, đánh giá tổng thể được chuyên biệt hóa cho task ID đó. Việc chấp nhận spec rủi ro thấp
là tự động chỉ khi P15 và project policy cho phép. Design phức tạp
và các phê duyệt triển khai do dự án bắt buộc quay lại Conversation. Một approval
ràng buộc toàn bộ bundle dossier; các quyết định spec nội bộ giữ bundle ID đó.

Kết quả verification của các task song song chờ bền vững phía sau phê duyệt task của con người
đang hoạt động. Chúng tiếp tục sau quyết định đó, kể cả qua restart; một
outcome muộn hơn không thể thay thế approval đang hoạt động hay làm sống lại một run bị từ chối.

Mọi task Developer đều nêu `metadata.ownedPaths` (các prefix repository literal), với
`forbiddenPaths` và `requiredCapabilities` tùy chọn. Các định nghĩa gate do agent kiểm soát
bị từ chối: các check dự án đáng tin cậy được cấu hình qua `taskChecks` và
`workflowChecks`. `requiresApproval` của task cũng được thực thi trước khi các task phụ thuộc
được chạy. Việc người dùng từ chối dừng việc lên lịch tiếp. Các thao tác hủy hoại, merge
protected branch, deployment và thay đổi secret/quyền truy cập không có tool thực thi trong
Runtime này, nên một approval không liên quan không thể cấp các capability đó.

Core sở hữu DAG/concurrency và các chuyển đổi hợp lệ. Runtime ràng buộc pane ID thực tế,
capability, lease và fencing token, lưu transport intent, rồi dispatch
các assignment `RoleMessage` qua Herdr. Cần một lần gia hạn Registry hiện hành
ngay trước khi gửi và trước khi chấp nhận một implementation result mang tính kết luận.
Các lease Developer đã được chấp nhận được gia hạn ở các tick tiếp theo. Chạy scheduler thường xuyên hơn
TTL lease năm phút; một lease hết hạn/cũ đòi hỏi reconcile tường minh, không phải giả định đã gia hạn.

TDD bắt buộc cần Red độc lập trước `authorize_implementation`, tiếp theo là
bằng chứng Green/Refactor được P16 xác thực. `not_applicable` vẫn cần bằng chứng thay thế.
Thiếu bằng chứng policy sẽ giữ task lại và báo cáo nghĩa vụ còn thiếu.
Host phải thực thi ranh giới capability ghi và xác thực các phép đo;
chỉ prompt không thể ràng buộc quyền OS của agent. Việc chấp nhận P17 cũng yêu cầu
các check độc lập thực tế. Hoạt động terminal có xác thực không phải là nguồn gốc của phép đo,
và bằng chứng hợp lệ về schema không phải là chứng minh cô lập vật lý.

Một Developer result thành công đã xác minh chờ phía sau một completion gate độc lập bắt buộc.
Runtime chỉ nhả writer allocation của nó sau khi có pane sẵn sàng, khớp và các
kiểm tra clean-worktree của P13, rồi thu thập change set P18 thực tế. P17 xác minh
ngoài Runtime journal lock, cho phép phản hồi của Reviewer và việc hủy
đến được. Các lỗi check/review đã biết có thể kích hoạt các lần sửa Developer có phạm vi;
số iteration tối đa, outcome inconclusive/blocked và các lần thử triển khai đã cạn
sẽ escalate. Verification plan giữ đóng băng qua các lần sửa. Runtime cũng từ chối
bằng chứng gate nêu tên bất kỳ implementer workflow thực tế nào, kể cả các Developer
được cấp phát sau khi plan đã đóng băng. Trusted host phải xác thực các
định danh này và loại các alias của implementer khỏi thẩm quyền reviewer.

Metadata gate tùy chọn `boundedVerificationRetry: true` của Core chỉ bật retry
cho một gate `before_completion` độc lập bắt buộc bị fail trên một attempt thành công
đã được xác minh trước đó. Live execution và authoritative event replay thực thi cùng
các giới hạn và lịch retry. Các workflow thông thường giữ hành vi gate trước đây.
Không thay đổi shared schema, migration, event shape hay method signature nào. Retry triển khai
và sửa verification dùng chung ngân sách attempt hữu hạn của task, trong khi P17
giới hạn riêng các iteration verification thực tế.

Sau task verification, P18 tích hợp các branch đã pin theo thứ tự dependency vào một
integration branch riêng. Xung đột bảo toàn công việc và escalate; các giải quyết có phạm vi
đã commit có thể được xác nhận bằng `accept_conflict_resolution`. Runtime thu thập
Git diff tích hợp hoàn chỉnh thực tế, bao gồm các commit merge/resolution, lưu
patch của nó qua ArtifactStore, và gọi P17 với phạm vi workflow và nguồn gốc
tích hợp chính xác. Kết quả task không bao giờ thay thế kiểm tra này. Workflow-level
failure escalate để có một kế hoạch sửa có phạm vi tường minh/ủy quyền mới đã được chấp nhận;
Runtime không ngầm thay đổi một đồ thị đã duyệt để sửa một revision đã tích hợp.
Workflow verification thành công được ghi ngược lại vào P18. Delivery vẫn cần phê duyệt
của con người, bằng chứng đọc được và một lần kiểm tra mới revision tích hợp đã pin, sạch.
Progress envelope cuối cùng của Conversation mang completion và evidence đã xác minh.

## Độ bền và khôi phục

Trạng thái riêng tư của host/provider/runtime thông thường nằm dưới `.bflow/state`.
Trước khi tạo credential, Runtime thăm dò xem filesystem của repository đó có thực sự
thực thi được file `0600` và thư mục `0700` hay không. Trên các mount không thể (ví dụ
NTFS/FUSE với quyền cố định `0777`), nó tự động dùng
`$XDG_STATE_HOME/bflow/repositories/<sha256(canonical-repository-path)>/state`, hoặc
`~/.local/state/bflow/repositories/<hash>/state` khi `XDG_STATE_HOME` chưa đặt hoặc là
đường dẫn tương đối. Vị trí state của người dùng và các thư mục cha của nó phải qua kiểm tra
ownership, symlink và quyền. Runtime không bao giờ nới lỏng việc xác thực file riêng tư.

Credential của host, khóa ký, vật liệu launch của provider, platform state, SQLite,
artifact và journal P19 dùng vị trí đã chọn một cách nhất quán qua
khởi động, kích hoạt, truy vấn và shutdown/recovery. Một locator
`.bflow/state/private-runtime-state.json` không bí mật, được xác thực schema, pin thẩm quyền bên ngoài
trước khi credential được tạo, kể cả qua các thay đổi XDG và thay đổi hỗ trợ
quyền của repository. Storage được pin bị thiếu/không hợp lệ sẽ chặn khởi động thay vì
tạo state thay thế. Việc công bố locator và config host ban đầu là nguyên tử
và độc quyền; các reader khởi động đồng thời không bao giờ đọc JSON dở dang. Cấu hình repository,
lifecycle lock/receipt và manifest pane P13 giữ nguyên đường dẫn và định danh session hiện có.
`bflow doctor` báo cáo vị trí Runtime riêng tư đã chọn.
Một `host.json` cũ không dùng còn lại từ lỗi quyền riêng tư ban đầu được bảo tồn và
token bị lộ của nó không bao giờ được sao chép hay tái sử dụng. Quyền sở hữu host hiện có/các file host khác,
endpoint chưa ràng buộc, agentic storage hoặc platform state sẽ chặn việc tự động di dời và
đòi hỏi reconcile; Runtime không âm thầm migrate thẩm quyền recovery.
Một config không dùng được giữ lại có thể nêu tên cùng socket ổn định hiện do private host đã pin
phục vụ. Nó không chặn việc mở lại khi cả hai config khớp đúng
repository/session và socket, thư mục legacy khớp vị trí gốc của nó,
và private host dùng một credential khác. Các binding lạ, credential bị sao chép/lộ
và endpoint không có thẩm quyền riêng tư được pin vẫn chặn recovery.
Hành vi này không di dời cấu hình lưu trữ Runtime legacy tường minh và không
tuyên bố nghiệm thu provider/Herdr trên mọi filesystem.

Một workflow Reviewer đã nhận request chắc chắn nhưng chưa có verdict có thể được thay
bằng đúng một invocation read-only mới sau lệnh vật lý `replace workflow review <message-id>`
qua Conversation. Lệnh này cần quyền riêng của người dùng; resume/design/task/delivery approval
không cấp quyền đó. Chỉ áp dụng trên workflow có các task đã kiểm chứng, writer đã release,
Core task succeeded, TDD evidence đầy đủ và commit/spec tích hợp không đổi. Các gate và
unknown delivery vẫn chặn; số lần thay bị giới hạn theo maxIterations, không reset counter.

Quyết định lưu marker private journal **v4** trước khi ngừng waiter cục bộ. Binary cũ phải từ
chối v4; marker không sửa request/handle/status gốc, không khẳng định provider đã dừng hoặc
review cũ đã/chưa xảy ra và không tạo ACK/verdict. Mọi ingress/replay theo causation gốc và
completion từ observation cũ đều bị fence. Invocation mới dùng đúng context/capability, có
request ID liên kết riêng, chỉ dispatch tới native Reviewer read-only khác qua preflight/lease
hiện hữu. Request mới chưa rõ delivery không được gửi lại qua restart. Đây là bảo đảm từ
source và kiểm thử hồi quy cục bộ; không tự chứng minh một run live đã hoàn tất.
Cùng lệnh vật lý hỗ trợ workflow QA đã nhận request nhưng lease hết hạn, kể cả khi
Registry từ chối release. QA replacement ghi **v5** để binary v4 từ chối marker này.
Request/handle/status/leaseRelease cũ giữ nguyên; outbox không giả release thành công,
không renew/resend request đã fence. QA mới phải chạy test tại commit tích hợp qua host
như cũ. Role, command và test evidence không được nới quyền bởi replacement.

Journal P19 riêng tư nằm dưới `<selected-state>/agentic/journal`. Nó
dùng tuần tự hóa trong cùng process cộng với `flock` trên Linux/macOS, fsync file, rename nguyên tử và
fsync thư mục. Nó bị ràng buộc với repository và từ chối state hỏng/không được hỗ trợ.
Nó không phải kênh giao tiếp ArtifactStore. Mọi việc giao agent thực tế đều dùng
Herdr; journal lưu trạng thái scheduling/outbox/inbox và receipt.

Message ID và idempotency key từ chối việc tái sử dụng với payload xung đột. Người nhận bận
vẫn nằm trong hàng đợi mà không chặn các pane khác. Dispatch intent đi trước transport;
`sending` sau crash trở thành `unknown_delivery`. Timeout, lỗi transport bị ném
và receipt sai định dạng không bao giờ chứng minh không được giao. Chỉ reconcile tường minh với
`not_delivered` mới cho phép gửi lại đúng AgentRequest gốc. Một pane, fingerprint
của request hay lease bị thay đổi không bị âm thầm thay thế. Các thông điệp mơ hồ giữ
lease và không tự động gửi lại qua restart.

CoreSession phục hồi từ aggregate checkpoint mới nhất đã qua bộ kiểm tra tương thích,
kiểm tra run/version/sequence và decoder aggregate, sau đó chỉ đọc event tail bằng cursor
được dùng trong recovery hiện hữu. Không có checkpoint thì đọc lịch sử đầy đủ. Checkpoint
hỏng hoặc khác run không được bỏ qua để nhận projection; command outcomes, approval,
fencing, retry và cancellation tiếp tục thuộc aggregate của Core. Cách này tránh replay toàn
bộ lịch sử ở mỗi RPC khi lịch sử dài. Các bảo đảm này có kiểm thử cục bộ, không thay một
verdict live hay phê duyệt của người dùng.

Trong khi phép kiểm chứng độc lập do Runtime sở hữu còn đang chạy, báo cáo blocked của
Coordinator hay specialist được lưu như chẩn đoán; kết quả verification vẫn quyết định phase. Blocker đến
muộn từ specialist đã có verdict xác thực không thay thế lineage/counter hiện có. Request
user decision và cancellation vẫn dùng đường riêng và giữ nguyên authority/gate.

Các Core event batch được journal trước khi SQLite append và được retry idempotent.
Aggregate checkpoint được giữ lại; authoritative complete event replay khôi phục
trạng thái approval, retry, gate và cancellation. Projection RunStore được duy trì
không được dùng thay thế aggregate. Các outcome P17 đã hoàn thành có một
application journal write-ahead, nên lỗi SQLite có thể khôi phục outcome mà không chạy lại
check. Nếu việc thực thi bị gián đoạn trước khi outcome đó đến Runtime journal,
cờ pending của nó đòi hỏi host reconcile tường minh với receipt đã lưu của P17;
Runtime không tự động bắt đầu một lần thực thi verification khác.

Hủy lưu intent trước các interrupt, từ chối các task assignment mới,
hủy các lần chờ verification cục bộ, và giữ lại worktree/binding không chắc chắn. Một
interrupt được chấp nhận không phải là xác nhận đã dừng. Core có thể ở trạng thái `cancelling` trong khi miền SDLC
ghi nhận intent hủy. Verification muộn không thể làm sống lại run đó. Không tự động
dọn dẹp mang tính hủy hoại, protected merge, remote push hay production deploy nào được thực hiện.
Một Registry mutation đã được xác nhận trước khi một lần ghi journal cục bộ bị mất cũng có thể
đòi hỏi host reconcile idempotency receipt đã lưu của nó; Runtime dừng khi gặp
lỗi stale-version/fingerprint và không giả định mutation đó đã được rollback.
Các giả định Linux/filesystem cục bộ vẫn giữ nguyên; không bổ sung đảm bảo network-filesystem, same-user thù địch,
multi-host hay power-loss. P02-RA01/P03-RA01 hiện có vẫn mở.

## Receipt host Herdr có xác thực

Label release CLI là metadata chẩn đoán. Khởi tạo thăm dò protocol 22 /
schema 1 và mỗi thao tác xác thực phản hồi của nó. Không có allowlist release
hay cờ bypass phiên bản. Một phiên bản đã cài đặt được kiểm thử trực tiếp; chỉ sự không tương thích
wire thực tế mới là căn cứ để từ chối.

Submission handle của CLI vẫn chưa được xác minh và bất biến. ADR 0003, được chủ dự án
phê duyệt, bổ sung `AuthenticatedWorkflowEngine.verifyAgentBinding` và một
RoleMessage `execution.receipt`. Runtime xác thực sender/assignment và
lease của nó, ingest receipt đã ký canonical qua ArtifactStore, và ghi
Core proof event trước khi chấp nhận một result có tương quan. Core xác minh Ed25519
dựa trên `bindingReceiptKeys`, handle/target/session gốc chính xác và hash của receipt;
issuer không xác định, chữ ký giả mạo, proof xung đột và execution đã hủy/terminal
bị từ chối. Các handle cũ chưa xác minh không có proof vẫn không thể thành công.

Native plugin là `agents/coordinator/herdr-receipts/herdr-plugin.toml`. Action
`deliver` của nó nhận RoleMessage có cấu trúc trong invocation context của Herdr,
xác thực sender dựa trên manifest P13 của host, và với binding receipt
kiểm tra lại agent/session Herdr thực tế trước khi ký. Nó chuyển tiếp RoleMessage đã ký
tới ingress của Runtime host. Không có terminal snapshot nào được nâng thành
proof. Một binding đã ký xác nhận request; P17 vẫn xác minh độc lập
việc triển khai. Các callback xác thực phép đo của host/phê duyệt của người dùng vẫn
bắt buộc và không được thay bằng các hàm thành công vô điều kiện.

Cấu hình khóa công khai của issuer đáng tin cậy qua `bindingReceiptKeys` trên
Core engine hoặc `openAgenticWorkspace`. Đặt `nativeIngressSocket` để bật native
host adapter. Liên kết plugin qua cùng session Herdr có tên. Trong thư mục config
do Herdr tạo của plugin, tạo một `host.json` riêng tư:

```json
{
  "issuerId": "project-native-host",
  "privateKeyFile": "/private/native-host-key.pem",
  "runtimeSocket": "/short/path/bflow-ingress.sock",
  "manifestFile": "/project/.bflow/state/panes/session.manifest.json"
}
```

Khóa ký phải là một file khóa Ed25519 riêng tư thông thường, ngoài source control
và model prompt. Khóa công khai được cấu hình trong Core phải khớp issuer của nó. Việc ký
của native host không phải là tool hướng tới agent/model. Hạn chế quyền truy cập plugin/config như
một phần của ranh giới host cục bộ đáng tin cậy; không tuyên bố cô lập same-user thù địch.

Gọi action bằng Herdr API đã cài đặt `plugin.action.invoke`, với
`plugin_id: "bflow.receipts"`, `action_id: "deliver"`, và invocation context
chứa `selected_text` (JSON RoleMessage), `focused_pane_id`, `workspace_id`
và `correlation_id` bằng message ID của assignment. Payload `execution.receipt`
mang handle gốc và thời điểm quan sát; host chọn issuer và transport correlation của nó
và thay chữ ký đầu vào. Các xác nhận bị mất vẫn đòi hỏi reconcile; không bao giờ retry mù quáng một body đã bị thay đổi.

Handle bất biến nằm trong `agent.execution_bound`; `agent.binding_verified`
và command receipt của nó dùng event envelope v2. Các aggregate mang receipt dùng
aggregate codec v2. Các run cũ vẫn đọc được và không có bằng chứng bị bịa ra;
reader cũ từ chối event/codec mới thay vì đoán. Bố cục lưu trữ SQLite
không đổi. Giữ sẵn các khóa công khai lịch sử của issuer cho authoritative replay.

Các smoke test native transport cố ý dùng một custom host process và
Herdr plugin thật, không có model/provider. Trên binary 0.9.5 đã cài đặt, custom
actor đó không có `agent_session` gốc nào được expose và chưa sẵn sàng cho các prompt agent
thông thường; việc giao prompt của nó vẫn chưa xác minh/không chắc chắn. Smoke xác minh
khởi tạo protocol và việc giao RoleMessage có cấu trúc đã ký qua
plugin, không phải attestation binding thành công cho custom actor đó. Các
binding receipt không có session bị từ chối; việc chấp nhận signing/Core/checkpoint được bao phủ trong
các integration test riêng. Các tích hợp agent chính thức phải cung cấp
định danh native session thực tế của chúng cho receipt attestation. Việc chúng pass không thiết lập được việc triển khai
do AI sinh ra live, review model độc lập hay một delivery SDLC đầy đủ.
Host cục bộ mặc định được expose qua `ensureAgenticHost`. Nó khởi động một
process tách rời trước khi launch provider và chuẩn bị MCP/native hook theo từng provider.
Kích hoạt yêu cầu manifest `up` đầy đủ và các receipt SessionStart gốc khớp,
bao gồm session locator `herdr:claude` thực tế của Herdr.
Các pane provider trần legacy phải được dừng/tạo lại; chỉ tên process
không thiết lập được một role đã cấu hình. Scheduler của host và inbound Herdr prompt
pump chạy độc lập với các lượt model. `close()` ngắt kết nối một CLI client;
`quiesce()`, `checkpoint()` aggregate và `shutdown()` là các thao tác lifecycle
riêng biệt. Shutdown yêu cầu server Herdr có tên đã dừng. Công việc thất bại hoặc
không chắc chắn giữ lại worktree của nó và đòi hỏi reconcile.

Host `prepare(options)` chấp nhận lifecycle deadline, timeout và cancellation
signal. Việc chuẩn bị provider dùng deadline đó thay vì timeout control RPC mặc định
ngắn. Một lần chuẩn bị bị ngắt kết nối sẽ bị hủy; quiesce và shutdown
chờ nó drain trước khi nhả các launch registration. Không lần chuẩn bị hết hạn hay bị hủy nào
cho phép launch pane. Chuẩn bị độc lập không có option bị
giới hạn mười phút; khởi động CLI cung cấp ngân sách cấu hình còn lại của nó.
`openPersistedAgenticHost` mở lại một host cho shutdown/recovery bằng platform,
policy và behavioral authority đã lưu; nó không yêu cầu thay đổi cấu hình.
Khi thử lại một lần khởi động đang chờ trong cùng daemon, host kiểm tra lại profile,
binary/config, skill đã pin, Gateway và preflight nhưng giữ nguyên generation, launch
và token; cổng activated health cuối cùng vẫn bắt buộc. Không phục hồi cache launch
qua daemon restart, và không tự đổi launch khi material đã hết hạn hoặc bị drift.
Yêu cầu sửa đổi từ Conversation được gắn vào run ngay khi host tiếp nhận vào outbox,
trước khi chuyển tới Coordinator. Việc này không tạo receipt Herdr nhận lại hay
phê duyệt thiết kế; replay cùng revision giữ nguyên lịch sử và các cổng human.
Các quan sát provider của permanent role chạy tối đa ba cái cùng lúc, sau khi chuẩn bị
tuần tự environment/skills/Gateway. Mỗi provider subprocess nhận
cancellation signal của thao tác và deadline còn lại; việc chuẩn bị launch
vẫn chờ tất cả verdict preflight bắt buộc.

Entrypoint stdio MCP chỉ expose các tool orchestration cho Coordinator, và
việc ủy quyền/nộp triển khai chỉ cho Developer. Bằng chứng thay thế của Tester/QA
và verdict của Reviewer/QA gắn với các diff đã commit chính xác do host thu thập
và các criterion đã chấp nhận. Xác thực của host so sánh các receipt chính xác đã phát hành;
các cờ `independentExecution` hay approval do model cung cấp không cấp thẩm quyền nào. Các
thông điệp role gốc vẫn đi qua Herdr plugin thực tế; control socket
mang các thao tác của host, thay vì giao assignment giữa các agent.

Cấu hình verification mặc định hỗ trợ tài liệu (`.md`, `.txt`,
`.rst`) với acceptance criterion thủ công. Nó chạy `git diff --check` trên các revision
task và tích hợp chính xác, yêu cầu phán đoán độc lập của Reviewer và QA,
và yêu cầu bằng chứng thay thế của Tester/QA trước khi chấp nhận task. Kiểm tra toàn vẹn Git này
không thiết lập hành vi ứng dụng tùy ý. Các thay đổi hành vi và TDD bắt buộc
cần các measurement runner được cấu hình và fail closed trong host mặc định.
Delivery và các phê duyệt do dự án bắt buộc vẫn là quyết định của con người;
chính sách specification rủi ro thấp đã duyệt có thể chấp nhận một lightweight spec.

Chỉ hook UserPromptSubmit cục bộ theo launch của Conversation ghi lại các lượt raw của người dùng
đã xác thực, ràng buộc với pane/native session chính xác của chúng và một message ID bền vững. Hook
trả về ID đó và context Conversation có giới hạn (session, quyết định đang chờ, workflow và 20 thông điệp mới nhất không kèm metadata) cho Chat. Chat nộp một quyết định có cấu trúc
`conversation_decide`; Runtime chèn nội dung gốc và nguồn gốc đã lưu,
xác thực các tham chiếu trạng thái, và gọi Gateway. Lượt không xác định/cũ,
principal bị thay đổi và quyết định xung đột bị từ chối. Các quyết định đã hoàn thành replay
kết quả bền vững của chúng; xác nhận FIFO vẫn pending cho đến khi Gateway xử lý
lượt đó. Các quyết định bị gián đoạn giữ timestamp và ID ổn định cho việc reconcile Gateway/outbox,
kể cả khi một lượt người dùng thông thường mới hơn đã đến. Conversation không thể bypass điều này bằng một
`delegation.request` trực tiếp qua `send_role_message`.

Các phản hồi phê duyệt của con người thực tế đang chờ vẫn nằm trên đường hook đáng tin cậy.
Schema quyết định của Chat loại trừ các phản hồi approval. Các lần giao RoleMessage Runtime
chính xác được xử lý như transport, và các role envelope không thể trở thành văn bản phê duyệt
của con người. Không có MCP tool nào phê duyệt thay mặt người dùng. Khóa/cấu hình riêng tư của host và Unix
socket có quyền chỉ owner. Kích hoạt yêu cầu một native Bflow
launch receipt chính xác; các pane cũ không có host hook không bị âm thầm tiếp nhận. Đây là các kiểm soát tin cậy host
cục bộ, không phải cô lập OS same-user thù địch. Launch provider live, ràng buộc native-session,
role-message receipt, triển khai task và delivery cuối là các mảnh
bằng chứng riêng biệt; chỉ riêng host test cục bộ không chứng minh một lần chạy SDLC live đầy đủ.

## Validation

Build trước các test có mục tiêu, vì chúng ghép các implementation `dist` của package thật:

```sh
pnpm build
# Integration được tách thành nhiều file (dùng chung test/helpers/agentic-integration-fixture.ts) để Vitest chạy song song.
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/integration-
TMPDIR=/tmp pnpm exec vitest run packages/runtime/test packages/core/test
pnpm check:deps
pnpm typecheck
TMPDIR=/tmp pnpm test
git diff --check
git status --short
```

Các test P19 dùng Core/Registry/SQLite/ArtifactStore/P15/P16/P17/P18 thật và các
Git repository tạm thời thật, với pane vật lý/Herdr transport giả lập và các check runner
độc lập được inject. Chúng xác minh composition/policy. Các native transport test opt-in riêng thực thi
Herdr plugin/giao chữ ký thực tế, không tuyên bố hành vi AI live hay
live binding attestation cho một custom host không có định danh session. `TMPDIR=/tmp` tránh giới hạn độ dài đường dẫn Unix-domain-socket trong một
fixture POSIX ArtifactStore hiện có dưới đường dẫn temp mặc định dài của môi trường này.

Một lần cài đặt sạch, cô lập cũng làm lộ việc P14 import Zod trực tiếp mà thiếu
dependency trong manifest. Sửa tích hợp chỉ thêm `zod` vào manifest của package đó
và importer trong lockfile; không thay đổi implementation P14 hay shared contract nào.

Để thực thi binary đã cài đặt trong một session có tên tạm thời, sau khi build:

```sh
BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1
```

Test này sở hữu các đường dẫn XDG/socket ngắn và cấu hình shell riêng, đăng ký một
custom native host process (không phải AI model), và chỉ dừng session test của chính nó.

## Khôi phục session, quản lý context, observability và resilience

### Activity log của task

Runtime ghi một JSONL activity log tại `task-activity.jsonl` trong private Runtime state đã được resolve (thường là `.bflow/state/agentic/task-activity.jsonl`; khi workspace cần state riêng tư bên ngoài repo, dùng vị trí private được pin thay thế). Retention mặc định giữ tối đa 1000 entries và 512 KiB. Log giữ các milestone đã quan sát như admission, thay đổi trạng thái, assignment, verification, approval và kết quả agent đã xác thực. Đây là bản ghi chẩn đoán có giới hạn; nó không lưu prompt, argv, tool input/output hay private model reasoning. Terminal output và nhãn transport vẫn là dữ liệu không tin cậy; Herdr `done` không chứng minh task thành công.

Trong một host đã activate, pane `task-log` hiển thị các dòng mới nhất trong tab Logs. Các role có thể gọi `read_task_log`; Conversation và Coordinator đọc theo session/run, còn specialist phải lọc theo run/task được giao. `log_task_step` ghi một dòng tiến độ ngắn gắn với assignment hiện tại. Các dòng tự báo cáo và log không phải approval, receipt hay verification evidence. Nội dung đã được redaction, chuẩn hóa một dòng, giới hạn kích thước/dung lượng; lỗi ghi log không làm thay đổi kết quả nghiệp vụ.

Lỗi `assess` ghi diagnostic có schema path đã biết và hướng dẫn `planning_reference` thay vì chỉ tên `Error`;
viewer rút gọn reason/artifacts trong dòng chẩn đoán có giới hạn; notice rows có shortId, runLabel, messageType, reason và artifact refs. Không ghi tool arguments hoặc coi dòng log là full payload. Các pha chưa chạy không có
bằng chứng từ log: intake/planning/blockage không chứng minh implementation, verification
hay review đã hoàn tất. Milestone riêng cho thay đổi `run.workflowCycle` hiện chưa được ghi
(khác với task verification cycle); cần bổ sung và kiểm thử trước khi khẳng định log bao phủ
đầy đủ vòng verification/rework cấp workflow.

Viewer đọc đủ snapshot trong giới hạn lưu trữ, giữ các lần xuất hiện lặp và không phát lại lịch sử khi file được thay thế nguyên tử. Bản ghi mới có ID riêng; khóa lọc theo run/task gốc được giữ riêng với chuỗi hiển thị đã rút gọn hoặc redaction. Khi Herdr khởi động lại và dùng lại pane ID cho terminal khác, Runtime bỏ binding cũ và tạo pane log mới, giữ nguyên terminal thay thế. Việc đóng pane yêu cầu process-info khớp đúng pane và chỉ có tiến trình viewer dự kiến ở foreground.

`@bflow/runtime` cũng export các dịch vụ độ tin cậy cục bộ tùy chọn cho các repository thật:

- **Session Recovery (`SessionRecoveryService`)**: Phân biệt `graceful_shutdown`, `crash` và `transient_disconnect` qua `bflow down` / `bflow up`; flush và khử trùng lặp state của `AgenticJournal` và SQLite `RunStore`; khôi phục các run chưa hoàn tất từ aggregate checkpoint cộng event tail; reconcile SQLite với các pane/role Herdr để phát hiện các sai lệch `agent_lost`, `agent_replaced` và `orphan_agent`; thu hồi lease cũ; kiểm tra Git worktree/commit mà không dùng lệnh hủy hoại; cấm gửi lại prompt mù quáng khi lần thực thi trước không chắc chắn (`unknown_delivery` hoặc worktree bị sửa); và không bao giờ đánh dấu task succeeded khi không có `AgentResult` có tương quan, đã xác minh và các gate đạt.
- **Context Management (`ProjectContextService`)**: Phân tích cấu trúc repository và workspace package mà không cần vector database, đọc tài liệu dự án và chỉ dẫn role, lưu và truy vấn architectural decision record (ADR), chọn tất định các file liên quan đến task trong ngân sách byte/file nghiêm ngặt, theo dõi phiên bản `Specification` và `ArtifactReference`, chuẩn bị các context bundle có giới hạn theo role với việc scrub secret, và phát hiện context/spec drift qua các lần restart.
- **Observability (`ObservabilityTracker`)**: Theo dõi thời lượng run, thời lượng theo task và theo attempt, agent assignment, verification cycle, số lần retry/rework, các episode thời gian blocked, tỷ lệ test pass/fail, kích thước context bundle, và metric token/chi phí model đã xác minh chỉ khi `source: "provider_reported"` (không bao giờ ước lượng token hay chi phí khi không có telemetry của provider).
- **Resilience (`BoundedConcurrencyLimiter`, `StructuredLogger`, `redactSecrets`, `executeWithRetry`, `withOperationTimeout`)**: Cung cấp bounded concurrency với drain barrier `quiesce()`, structured JSONL logging với tự động redact secret (bảo tồn các định danh miền như `fencingToken` và bộ đếm token), và các helper backoff/timeout chặn tự động retry khi `unknown_delivery` cho đến khi reconcile hoàn tất.

Các dịch vụ này là các building block được export; `openAgenticWorkspace` và CLI không
tự động ghép context service, structured logger hay observability
tracker. Stdout/stderr Herdr nền của CLI nay đi qua một relay redact theo dòng
tách rời, có giới hạn; chẩn đoán của host cũng scrub các dạng secret đã biết. Redaction nhận diện các pattern đã cấu hình
và các dạng credential dạng văn bản; nó không thể đảm bảo loại bỏ các secret tùy ý không có nhãn,
đã mã hóa hay nhị phân. Giữ secret ngoài requirement và prompt, vì
Herdr CLI nhận chúng qua đối số process.

`withOperationTimeout` trả về `unknown_delivery` do contract định nghĩa với
`retryable: false` và `manualInterventionRequired: true` khi timeout cục bộ của nó
hết hạn: hủy việc chờ không chứng minh một thao tác đã bắt đầu đã dừng. Tùy chọn
`onTimeoutCode` đã deprecated vẫn được chấp nhận để tương thích source nhưng
không thể ghi đè sự không chắc chắn đó. `executeWithRetry` sẽ không gửi lại nó.

Việc đọc context repository (bao gồm tài liệu, role prompt, ADR và việc chọn
file) kiểm tra lại containment của đường dẫn đã phân giải, bao gồm symlink của thư mục cha,
từ chối special file bằng các lần mở descriptor nonblocking/no-follow, và tính
kích thước/checksum từ các byte đã đọc thay vì từ phân tích đã cache. Điều này không
tuyên bố bảo vệ khỏi một process same-user thù địch liên tục thay thế đường dẫn.
`prepareRoleTaskContext` cũng thực thi `maxTotalBytes` trên toàn bộ prompt,
bao gồm chỉ dẫn, specification và tóm tắt ADR. Context quá khổ fail
với lỗi có thể hành động thay vì âm thầm cắt bớt governance hay criterion.
Ngân sách output này không giới hạn mọi cấp phát bộ nhớ khi phân tích.

Các lệnh verification có mục tiêu:

```sh
pnpm exec vitest run packages/runtime/test/unit/resilience-observability.test.ts
pnpm exec vitest run packages/runtime/test/unit/project-context-service.test.ts
pnpm exec vitest run packages/runtime/test/scenarios/09-session-recovery-reliability.test.ts
```

## Verification của host đã cấu hình và xác thực bền vững

The default host discovers Runtime-private adapters for JS/TS (Vitest 1/2/3,
Jest, Mocha, Node TAP), Python/pytest, Go, Rust, Maven/Gradle, .NET, Ruby
(RSpec/Minitest), PHPUnit and configured CTest. Unit/integration/E2E labels expose
exact naming rules through planning_reference; nested JS and multiple language projects can coexist. Criterion names are partitioned per selected runner and retained by the independent gates.
Owner-configured Node TAP/Vitest commands remain an optional override.

Executable/argv, offline settings, mounts and parsers come from Runtime. Manifest,
script, runner configuration, imported Gradle/MSBuild definitions and helper blobs are pinned to the committed original
revision; selected test files freeze after independent Red. Structured leaf results,
assertion/error discrimination and independent Quality Gates remain mandatory.

`verification.reviewTimeoutMs` (optional, 60000..3600000 ms, default 900000) sets the `executionTimeoutMs` of the independent `host-reviewer`/`host-qa` native review gates through `defaultHostChecks(policy)`; `DEFAULT_HOST_CHECKS` keeps the default. Runtime's review reply wait uses that gate timeout.

`verification.regressionScope` controls host regression gates (`affected` default for new configs,
`full`, `mapped_only`; a persisted `host.json` missing `regressionScope` defaults to `mapped_only`).
When `affected` or `full`, `HostVerification` adds one required gate `host-regression-<profile.id>` per
detected automatic JS/TS runner (`vitest_json` or `node_tap` without a polyglot `adapter`) using a
3-tier widening order (`graph` via GitNexus `IMPORTS` closure when the index is proven fresh at `base`
before and after the query → `package` for non-code/non-doc files, nested `package.json`, or unavailable/stale
index → `full` for root configs/lockfiles/workspace manifests; docs-only diffs pass with `scope: "none"`).
Test failures at `head` are re-measured per failing file at `base` to classify `pre_existing` warnings vs
`regression_failure` errors. Limits: regression gates apply to automatic JS/TS runners only (polyglot adapters
are recorded as `unsupported_runner`), and the verification gate never invokes `gitnexus analyze` or refreshes
the GitNexus index.

Linux Bubblewrap is discovered on PATH and actually probed. macOS uses deny-default
Seatbelt and probes both a system binary and the actual Node runtime. When configured
or detected checks require verification, `prepare` refuses an unavailable sandbox before
launching roles; measurement never falls back to host execution. External
toolchains/caches mount narrowly and read-only, without whole homes or credentials.
Only public integrity-pinned npm lock v2/v3 warming is implemented, in a separate
no-script network sandbox with capability-probed slirp4netns egress, disabled host loopback/DNS proxy and an owned writable cache; measurement
then remains offline. Other ecosystems require installed dependencies/caches.

See [runner architecture, matrix and threat model](../../docs/verification-runners.md)
for exact formats, platform limits and agent setup routing. Evidence on the implementation
host is source plus local parser/fixture tests: the real Bubblewrap namespace probe is
blocked (`RTM_NEWADDR: Operation not permitted`), so successful sandbox measurements
and live Herdr/provider behavior are **not verified**. Native Windows/container
backends, macOS polyglot adapter mounts, Elixir/Swift/Dart adapters and universal safe dependency warming remain open.

Các receipt fsync riêng tư bảo tồn nguồn gốc human-hook, các quan sát review độc lập,
xác thực gate/evidence và native send intent/acknowledgement.
Restart khôi phục các approval và receipt đáng tin cậy mà không coi dialogue đã cache
hay việc hoàn thành transport là thẩm quyền. Đối số lease renew/release và kết quả phase
thất bại được ghi trước các side effect, với recovery idempotent chính xác.
Khi khôi phục Coordinator Stop, host phân biệt chính xác receipt `coordinator-stop`
và `coordinator-stop-handled`; giữ nguyên cả hai để restart không phát lại Stop đã xử lý.
Các kiểm tra định danh file, phạm vi session và checksum vẫn áp dụng.
Các task notice mượn lease assignment đang hoạt động và không thể reserve/release một
Developer slot thứ hai. Đây là các đảm bảo crash process cục bộ dưới mô hình tin cậy
Linux/filesystem đã nêu, không phải bằng chứng fault-campaign AI live hay power-loss.

## Kiểm tra ứng dụng thật (`appChecks`, gate `host-app-<suiteId>`)

Owner khai báo `appChecks` trong `.bflow/verification.json` (schemaVersion vẫn là 1). Mỗi suite tạo một
gate bắt buộc `host-app-<suiteId>` (evaluator `host-app-check`, method `e2e_test`, command `app:<suiteId>`).
Mỗi check có định danh test `app:<suiteId>:<checkId>`, và chỉ định danh này được dùng trong
`criterionMappings` của tiêu chí `e2e_test`. Parser (`parseAppChecks`) dùng Zod strict: khóa lạ, đường dẫn
tương đối hoặc có `..`, env bị cấm (`PATH`, `HOME`, `PORT`, `HOST`, `NODE_OPTIONS`, `LD_*`, `BFLOW_*`),
selector không ổn định (`:nth-child`, `:nth-of-type`, `:first-child`, `:last-child`, XPath), API không có
assertion hành vi ngoài status, và ngân sách timeout không đủ đều bị từ chối.

**Chọn check.** Chỉ check được ánh xạ bởi tiêu chí chấp nhận đang hoạt động, có `verificationMethod: e2e_test`
và mọi `testNames` là định danh app của cùng suite, mới chạy. Check cấu hình nhưng không được ánh xạ không
chạy và không xuất hiện trong evidence. Ingress (`splitAppCriteria`) từ chối với `unsupported_verification`
khi mapping trộn định danh app với test khác, suite/check không tồn tại hoặc tiêu chí trộn nhiều suite;
`unknown_test_command` khi thiếu `app:<suite>` trong `targetCommands`; `unsupported_method` khi method khác
`e2e_test`; và khi TDD ở chế độ `required` mà mọi tiêu chí tự động đều là app (đó là bằng chứng xác minh,
không phải bằng chứng Red). Tiêu chí app không kích hoạt lỗi "No owner-configured behavioral runner" cho các
tiêu chí khác. Trong `verificationPlan`, bộ lọc một dòng đảm bảo runner tự động không bao giờ nhận định danh app.

**Thực thi.** Ứng dụng chạy từ bytes đã commit của revision (checkout tạm), không chạy từ worktree của
developer, trong Bubblewrap (namespace trống, `--unshare-all`). Argv do owner cấu hình được chạy với
`HOST=127.0.0.1` và `PORT`; sẵn sàng được xác định theo điều kiện (`readyPath` trả 2xx trong
`startTimeoutMs`). UI check chạy Chrome headless qua CDP pipe trong sandbox. Một check chỉ pass khi không có
finding: lỗi trang, `console.error`, HTTP ≥ 400 (kể cả tài nguyên phụ), request lỗi, selector phải có mặt
**và hiển thị** (HTML tĩnh hoặc `<template>` không đủ), text phải có trong body đã render, không tràn
ngang khi `noHorizontalOverflow`. API check so sánh status, header, JSON pointer (RFC 6901), `bodyContains`;
nếu cấu hình `contract` OpenAPI thì route phải được khai báo. Screenshot chỉ là bằng chứng bổ sung, không
ảnh hưởng pass/fail.

**Lease trình duyệt.** Chrome là tài nguyên độc quyền host-local, lưu trong `app-checks/app-check-leases.json`
của thư mục state host (cùng UID). Lease có fencing token tăng đơn điệu, được gia hạn định kỳ; lease bị giành
hoặc hết hạn khi chạy khiến kết quả bị loại (`app_check_browser_lease_lost` / `app_check_browser_lease_expired`).
Lease không phân tán, không dùng trên NFS hay nhiều host.

**Evidence.** Gate lưu một artifact `test-result` JSON và ràng buộc: `candidate.sourceRevision`,
`candidate.checkoutTree`, `app.instanceId`, `app.origin`, `app.command`, `app.envKeys` và `envDigest` (không
bao giờ lưu giá trị env), định danh và tiêu chí được chọn, `browser.lease.fencingToken`, và `driver.sha256`
(băm file driver). Mỗi screenshot là artifact `report` riêng, được tham chiếu bằng `screenshotArtifactId`.
Trước khi lưu, toàn bộ nội dung tự do đi qua `sanitizeAppEvidence`: che `Bearer`/`Basic`, `token|secret|
password|api_key=...` và `sk-...` thành `[REDACTED]`; che giá trị env đã cấu hình (từ 4 ký tự); bỏ ký tự điều
khiển trừ tab và newline; giới hạn tail 8 KiB, message 2 KiB, body 4 KiB.

**Pha Tester (P16).** Validator TDD đòi evidence phủ mọi tiêu chí bắt buộc và mọi `targetCommands`, nên
`behavioralEvidence` cũng chạy các suite app được tiêu chí của task chọn ở mỗi pha (cùng revision, cùng đường
đo với gate) và ghi observation `e2e_test` với command `app:<suite>`. Suite bị `blocked` làm pha đó lỗi điều kiện
tiên quyết và không ghi evidence. Red vẫn cần một assertion failure của runner hành vi; check app fail (có thể chỉ
vì app không khởi động) không đủ để Red hợp lệ. Assessment phải liệt kê `{method: "e2e_test", command:
"app:<suite>"}` trong `infrastructure.commands` để `app:<suite>` có trong `targetCommands`.

**Trạng thái gate.** `passed`: app sẵn sàng và mọi check được chọn không có finding. `failed`: ứng viên lỗi,
mỗi finding trỏ tới artifact evidence (`location: app:<suite>:<check>`). `blocked`: thiếu điều kiện tiên quyết
hoặc tài nguyên, không có kết quả nào được tạo: `app_check_platform_unsupported`, `app_check_sandbox_unavailable`,
`app_check_app_missing`, `app_check_dependency_missing`, `app_check_browser_missing`,
`app_check_source_not_pinned`, `app_check_driver_failed`, `app_check_browser_busy` (có thể thử lại),
`app_check_browser_lease_lost`, `app_check_browser_lease_expired`, `app_check_timeout`. `blocked` không bao giờ
là pass: Core chỉ coi gate bắt buộc là đạt khi trạng thái đúng là `passed` (`requiredGatesSatisfied`).

**Giới hạn (phải đọc):**
- Chỉ Linux với Bubblewrap và Chrome headless qua CDP pipe. Không có macOS, không có Seatbelt cho app check.
- Ứng dụng được chạy theo argv Node-style do owner cấu hình; ứng dụng nhận `PORT`/`HOST`.
- Chưa có thao tác tương tác (click, nhập liệu, điều hướng nhiều bước) trong phiên bản này.
- `viewport.mobile: true` giả lập trình duyệt di động thật: trang thiếu `<meta name="viewport">` có layout 980px,
  nên bị `ui_viewport_mismatch`/`ui_horizontal_overflow` ở 375px. Đây là lỗi responsive thật, không phải lỗi gate.
- Contract chỉ hỗ trợ OpenAPI, và chỉ kiểm tra route cùng method có được khai báo.
- Lease là host-local và cùng UID; không phải khóa phân tán.
- `dependencyRoots` được mount chỉ đọc ở đúng đường dẫn tuyệt đối trên host; owner phải trỏ `app.env` (ví dụ
  `NODE_PATH`) tới đó.
- Sanitizer là lọc theo mẫu và theo giá trị đã cấu hình; không phải kiểm tra bảo mật toàn diện cho output tùy ý
  của ứng dụng.
- App của candidate chạy cùng sandbox và cùng UID với driver, nên code thù địch trong candidate về lý thuyết
  có thể can thiệp driver; mô hình này chống "pass giả" do agent, không chống code độc trong sandbox. Lease không
  bảo vệ trước tiến trình cùng UID cố ý sửa file lease.
- Đây là bằng chứng mức source và test cục bộ. Không phải bằng chứng acceptance provider, Herdr hoặc SDLC đầy đủ.

## Role prompt và policy không hướng tới người dùng trong host mặc định

`runAgenticHost` dựng system prompt launch của mỗi role từ `agents/<role>/system-prompt.md` gốc đã cài đặt qua `readBuiltinRolePrompt` từ `@bflow/pane-manager` đã build (`packages/pane-manager/dist/index.js`, được nạp khi host khởi động, nên build pane-manager trước). Thiếu prompt Conversation hoặc Coordinator sẽ hủy việc khởi động host. Với mọi role trừ Conversation, host đảm bảo policy không hướng tới người dùng nguyên văn (`NON_USER_FACING_AUTONOMOUS_POLICY`, export từ `src/agentic/host.ts`) cộng với `NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT` (các trường `status`, `summary`, `evidence`, `artifacts`, `blockers`, `requested_action`, `next_role`, `assumptions` tùy chọn): nó được nối thêm khi prompt đã nạp thiếu nó, hoặc khi không có builtin prompt. Một chỉ dẫn kết thúc cũng cấm hỏi người dùng trong pane và yêu cầu escalate lên Coordinator qua Herdr `RoleMessage`. Coordinator không còn đọc file prompt của nó riêng nữa; loader dùng chung cung cấp nó, tiếp theo là các chỉ dẫn tích hợp host. Văn bản prompt chỉ là chỉ dẫn và không chứng minh provider tuân theo.

Trong lúc khởi động, một SessionStart receipt cục bộ theo launch hoặc native-session receipt bị thiếu được báo cáo là `[bflow:native-startup-pending]`, mà `host-controller` biểu hiện thành `conflict` có thể retry (`details.stage: "native_startup"`) thay vì lỗi transport; hãy retry sau khi các native hook công bố receipt của chúng.

`ProjectContextService` nay ánh xạ role `reviewer` tới `agents/reviewer` (trước đây là `agents/verifier`) và chỉ lùi về chỉ dẫn verifier/QA khi chỉ dẫn reviewer hoặc security vắng mặt. Behavior test: `pnpm exec vitest run packages/runtime/test/agentic/agent-behavior-policies.test.ts`.

## P30 platform readiness

Claude được launch với `DISABLE_AUTOUPDATER=1`, áp dụng cả permanent role và Developer
động. Đây là policy môi trường riêng cho phiên để updater nền không đổi binary giữa
preflight và activation; các kiểm tra executable/config digest và attestation vẫn bắt buộc.

`DefaultPlatformReadinessService` (export từ `src/platform/index.ts`) ghép các thành phần
platform đã triển khai cho một session generation: role environment, skill session record, Gateway
registration, provider preflight/launch intent, và activation với launch attestation do host ký.
`createPlatformReadinessService` nối các thành phần thật từ một state directory, một `SkillManager`,
một Gateway control port tùy chọn và một attestation signer. Các class provider adapter cụ thể không được
export.

Các đảm bảo được triển khai ở đây, với package-local test trong `test/platform/service.test.ts`:

- `prepareSession` là all-or-nothing. Bất kỳ role bắt buộc nào chưa sẵn sàng (hoặc launch intent của nó
  không thể journal) tạo ra `ready: false` và không có launch material; các Gateway registration thực hiện trong lần gọi đó bị
  thu hồi theo từng role. Các role tùy chọn thất bại được báo cáo là `blocked` và bị bỏ qua.
- Với grant tường minh, registration Gateway dùng đúng session scope của role để tạo hoặc xác minh partition
  tương ứng, rồi Runtime kiểm tra readiness và operation discovery trong cùng scope trước khi tiếp tục.
  Health của partition setup khác không chứng minh role partition đã sẵn sàng; registration không đạt hậu kiểm
  bị thu hồi theo intent cụ thể, còn cleanup chưa xác nhận thì chặn launch và giữ reconciliation fail-closed.
- Một role cần Gateway service mà không có Gateway control port được cấu hình là `blocked`.
- Launch material (bearer token `launch.env`) chỉ được giữ trong bộ nhớ. Report, status snapshot và lỗi
  không bao giờ chứa giá trị token. Các launch đã nhả hoặc shut down bỏ material của chúng.
- `verifyActivated` yêu cầu một launch mà instance này đã chuẩn bị; `assertFresh` ủy quyền cho preflight đã cache.
- Persistent host kiểm tra activated health cho tối đa ba permanent role bắt buộc cùng lúc,
  bao gồm các quan sát pane của chúng. Mỗi role giữ launch đã chuẩn bị, quan sát native-session
  và attestation đã ký riêng của nó; khởi động chờ tất cả các check bắt buộc pass. Tham chiếu pane
  hoặc launch bị thiếu bị từ chối trước khi các probe bắt đầu. Một check thất bại dừng các check đang xếp hàng
  và drain các check đang chạy trước khi trả về lỗi đầu tiên theo thứ tự role đã cấu hình.
  Việc lên lịch này được bao phủ bởi các test cục bộ; mức giảm thời gian khởi động live chưa được đo.
- CLI có thể nộp một private preparatory role check sau khi native binding của role đó được
  công bố bền vững, chồng lấp tối đa ba check với các lần launch pane sau. Mỗi check xác thực
  các receipt startup/native/tool chính xác và thực hiện role health. Kích hoạt cuối cùng vẫn lặp lại
  toàn bộ cổng role bắt buộc với health mới và một attestation đã ký mới được xác minh cho mỗi role;
  kết quả chuẩn bị không bao giờ thay thế nó hay khởi động workspace/scheduler.
- Host provider factory tắt execution probe cho mọi provider trong preflight và activation:
  readiness dùng native auth, binary/config/permission, MCP, skill và attestation mới, không gọi model.
  Codex bootstrap được UserPromptSubmit ghi nhận native session rồi chặn bằng exit 2 trước inference;
  hook lỗi cũng chặn prompt. CLI vẫn chờ đầy đủ startup/tool/native receipts và activated health.
  Quota và khả năng chạy model chỉ được xác minh khi làm việc thật hoặc chủ động chạy
  `bflow doctor --deep`; readiness này không phải bằng chứng inference thành công.
- Các preparatory check dừng công việc đang xếp hàng khi thất bại và drain công việc đã bắt đầu. Một
  control acknowledgement riêng tư tách biệt drain công việc daemon và các journal native-session/startup
  tuần tự hóa sau khi client ngắt kết nối, trước CLI quiesce/shutdown/cleanup. Prepare drain generation trước
  trước khi thay thế các launch, và kích hoạt cuối cùng drain công việc chuẩn bị trước cổng mới của nó.
- Codex setup review, preflight probe và các lần launch role permanent/dynamic dùng chung HOME/PATH đã chọn
  và các bộ chọn Orca pane/root/endpoint/port bên ngoài được để rỗng tường minh trong môi trường con. Cài đặt cha
  và các hook Herdr/Runtime bắt buộc của Bflow được bảo tồn; một hook snapshot không được hỗ trợ vẫn chặn launch.
- Các đường dẫn hook runner ngắn ràng buộc toàn bộ thư mục host repository/session và vẫn ổn định qua
  host recovery. Các repository riêng biệt không thể ghi đè hay xóa runner của nhau. Một thư mục tạm
  không an toàn hoặc là symlink có sẵn không bao giờ bị chmod hay tiếp nhận.
- Hook ingress xác thực event/session và các trường prompt/tool bắt buộc. Input bọc banner
  phải chứa đúng một hook object khớp; input mơ hồ bị từ chối. `PreToolUse` input không hợp lệ
  phát ra một quyết định deny tường minh. Chỉ lượt khởi động Codex ràng buộc environment được dành riêng mới bị bỏ qua.
- Nguồn native session phải nhận diện provider đã cấu hình (ví dụ `codex` hoặc `herdr:codex`).
  Herdr như một transport không làm cho các nguồn `herdr`/`herdr:herdr` chung chung trở thành bằng chứng provider hợp lệ.

- Claude roles dùng isolator profile nhận `CLAUDE_CONFIG_DIR=<selected-profile-HOME>/.claude` trong cả preflight probe lẫn final launch. Điều này ghim việc native auth/config lookup vào profile đã chọn và ngăn `CLAUDE_CONFIG_DIR` được kế thừa từ bên ngoài chọn account khác. Sau đó Claude giữ `.claude.json` native tại `CLAUDE_CONFIG_DIR/.claude.json`; Runtime không copy, migrate hay symlink file `HOME/.claude.json` độc lập. Profile MCP synchronization quản lý riêng các managed MCP entry ở cả hai native location, còn account state vẫn thuộc profile. Hành vi này được kiểm tra bằng local synthetic-state tests, không phải xác minh provider hoặc model live.

Giới hạn: đây là composition source chỉ với bằng chứng fake-runner và fake-Gateway cục bộ. Các provider
probe live, Gateway daemon live và wiring Pane Manager/Conversation không được xác minh ở đây. Service
tạo thư mục state riêng tư `gen-<n>/roles/<role>` của mỗi role trước preflight.

### Khả năng tiếp cận MCP tool trong process, cổng Developer và mất Gateway (P30 hardening)

`src/agentic/tool-reachability.ts` chứng minh khả năng tiếp cận Gateway tool từ bên trong process provider đã launch,
không chỉ từ config digest. Với mỗi launch có Gateway registration (permanent role tại `prepare`, Developer
động tại lúc cấp phát) host ghi một plan riêng tư, không chứa token `gateway-probes/<launchId>.json` (dir 0700,
file 0600, nguyên tử): launch id, Gateway endpoint, registration id, tên biến `BFLOW_MCP_TOKEN_*`
được suy ra và các tool được phép. Launch material mang `BFLOW_LAUNCH_ID` không bí mật, nên hook
`SessionStart` gốc của provider tìm thấy plan của chính nó ngay cả khi nhiều Developer chạy đồng thời
(`<role>.gateway.json` legacy chỉ được đọc như fallback và bị xóa tại `prepare`). Hook thăm dò từng registration bằng bearer token từ
environment của chính nó (`initialize`, rồi `tools/list` với session id, 5 s mỗi request, `redirect: "error"`) và
chỉ báo cáo registration id, tên biến env, `ok`, các tool đã phát hiện và một code (`token_env_missing`,
`unauthorized`, `http_error`, `timeout`, `unreachable`, `protocol_error`, `missing_tools`). Các record được lưu theo
từng launch và pane.

- `activate` yêu cầu, với mỗi permanent role bắt buộc có registration, một record `ok` cho đúng launch
  đã chuẩn bị; record bị thiếu là `[bflow:native-startup-pending]`, record thất bại ném một lỗi có tên.
- Việc cấp phát của một Developer động trả về `conflict` có thể retry (`details.stage: "developer_startup"`) cho đến khi record của nó
  là `ok`; proof thất bại hoặc không có proof trong 30 s sẽ nhả launch và pane của nó (`validation` không thể retry).
- Mỗi 30 s host reconcile Gateway registration với Gateway control. Một registration bị thiếu sau khi
  Gateway daemon restart (hoặc hết hạn/thay đổi) đánh dấu launch của nó là `degraded`; các role degraded báo cáo `readyForPrompt:
  false`, nên outbox giữ thông điệp của chúng trong hàng đợi cho đến khi `bflow up` launch lại chúng (provider đang chạy giữ một
  token đã bị thu hồi; không thể hot-swap). Các check không chắc chắn không thay đổi gì.
- Một host daemon được restart sẽ cho nghỉ hưu các launch của daemon trước: nó thu hồi các registration của session, journal
  `released` cho các intent đang mở và xóa các plan/record của chúng; kích hoạt khi đó cần một `bflow up` mới.
- `platform_status` báo cáo khả năng tiếp cận theo từng launch, lần Gateway check cuối và mọi restart recovery, không có token.

### Tool actions, usage ledger và RTK

`assignment_context` trả về `toolActions` riêng cho role đang được xác thực. Mỗi mục nêu tool ID,
operation, trigger, mức bắt buộc, scope memory nếu có, và tình trạng `available`, `degraded` hoặc
`blocked`. Đây là mô tả quyền đã được host resolve; nó không chứa Gateway token, bearer header hay
identity đường dẫn executable. Role chỉ gọi `invoke_tool_action` khi trigger phù hợp với việc đang làm;
tool tùy chọn không cần được gọi chỉ để tạo bằng chứng.

Runtime ghi disposition `skipped` cho tool có grant nhưng không được dùng khi role kết thúc turn/task
được giao, và `degraded`/`blocked` cho grant tùy chọn/bắt buộc không khả dụng. Các entry liên kết với
run, task và role; `read_tool_usage` giữ lại entry từ generation trước để unknown delivery còn nhìn thấy
sau restart. Việc reconcile dùng invocation ID ổn định và giữ generation gốc trong ledger. `completed`
chỉ nói Gateway trả kết quả; khi provider transport không xác nhận đã nhận/kết hợp kết quả, consumption
được ghi là `not_used` với lý do `provider_delivery_unconfirmed`, không được suy diễn thành consumed.
Role có thể gọi `acknowledge_tool_action` trong đúng assignment hiện tại với invocation ID và nguyên
`ArtifactReference` trả về để xác nhận Runtime đã giao đúng result evidence vào task context. Runtime
xác thực lại pane/role, assignment, grant, invocation và checksum đã lưu; thao tác không gọi upstream,
không chấp nhận invocation unknown, và ACK lặp lại là idempotent. ACK chỉ chứng minh delivery vào
context, không chứng minh agent đã hiểu hoặc dùng nội dung, không thay thế accepted artifact/verified
action evidence và không chứng minh task thành công. Các entry này là chẩn đoán hoạt động, không chứng
minh task thành công.

Kiểm tra provenance của memory nhận cả MCP result envelope đầy đủ và content array mà Gateway stdio
driver trả về. Vẫn yêu cầu đúng một text block có giới hạn chứa kết quả parse được, wing được cấp và
trường nguồn/thời gian gốc (hoặc provenance tường minh tương đương); memory sai dạng, ngoài scope
hoặc không quy nguồn được giữ lại và không đưa vào context.

RTK là CLI-only và chỉ chạy qua host runner trên output đã capture. Lệnh gốc chạy một lần; Node TAP,
Vitest và kiểm tra RGR tiếp tục đọc status/output thô. RTK `auto` có thể giữ nguyên bytes, và Runtime
không tuyên bố giảm token nếu output không thay đổi. Probe identity/filter diễn ra trước lệnh; RTK tùy
chọn lỗi được ghi `degraded`, còn RTK bắt buộc lỗi trước lệnh chặn runner. Nếu format RTK bắt buộc lỗi
sau lệnh, Runtime lưu status/output thô và trả blocker, không chạy lại lệnh.
Host cấu hình cũ không có `toolPolicy` tiếp tục chạy runner gốc mà không tự yêu cầu RTK hoặc platform
generation. Một lần `check_work` mới sau invocation RTK đã kết thúc có invocation ID riêng; invocation
đang `started`/`unknown` vẫn chặn lần chạy tiếp theo cho tới khi được đối soát.

Browser MCP dùng resource lease của Gateway theo từng assignment attempt đã xác thực. CLI chuyển
resource key từ service definition đã duyệt; role không được chọn lease/fence hay resource key.
Runtime acquire trước thao tác đầu, giữ và renew qua các call cùng assignment, release sau kết quả
terminal hoặc khi revoke registration/shutdown. Transaction tối đa năm phút; hết hạn không tự lấy
lại browser state đã có thể đổi chủ. Role khác nhận lỗi busy có giới hạn thay vì đan xen thao tác.
GitNexus tiếp tục dùng lease theo từng call.

Ledger riêng `gen-N/browser-resource-transactions.json` ghi request gốc (có thể chứa URL/input browser, file private 0600), digest và
đúng lease gốc trước dispatch. Kết quả unknown, timeout, lỗi transport hoặc phản hồi không hợp lệ
chặn call mới và giữ trạng thái để reconcile; manager khởi tạo lại đọc cùng intent và không resend.
Reconcile dùng lease của call gốc kể cả khi transaction đã renew. Host daemon restart đối soát pending call một lần trước khi thu hồi
launch/registration cũ; còn unknown thì giữ registration và chặn lifecycle để tránh mất thẩm quyền
recovery. Ledger không phục hồi provider token hay tự resume assignment. Gateway quarantine vẫn là hàng rào cho mutation chưa rõ kết quả sau lease expiry/revoke.
Release lỗi không mở lại transaction và không biến receipt giao thông điệp đã ACK thành timeout.

Các test local bao phủ Runtime session, manager, control endpoint thật và stdio worker fixture,
tranh chấp tester/QA, custom resource key, timeout và manager restart. Chưa có live Chrome/provider/
Herdr acceptance hoặc bằng chứng full SDLC cho browser. Tool MCP và RTK local ở trên chưa chứng minh
live provider delivery hoặc full SDLC acceptance. Muốn dùng mã mới, host cần được build và nạp lại qua
lifecycle hiện có.

Giới hạn: kế thừa environment của hook, mở rộng header `${VAR}` của Claude và `bearer_token_env_var` của Codex
chỉ được xác minh bằng các hook spawn cục bộ và config đã render, không phải provider hay Herdr live.

Legacy JS and owner commands also have a deny-default macOS Seatbelt backend (see the runner architecture document).
Real macOS measurements, adversarial sandbox checks and local Runtime tests are recorded in
[the macOS report](../../docs/acceptance/2026-10-24-macos-portability.md). Native polyglot adapter
mounts/reports and automatic dependency warming remain Linux-only; install Node dependencies
in the disposable repository before starting verification on macOS.

The polyglot measurement fixtures require both an installed toolchain and the pinned
fixture dependencies in its selected offline cache. Tests inventory Maven/Gradle/NuGet
prerequisites before measurement and explicitly skip unavailable environments; once a
measurement starts, missing transitive dependencies and all infrastructure errors fail.
Installed SDKs alone do not prove measurement readiness. Linux test dependencies are
staged without pnpm workspace links; production dependency escape checks remain enabled.
PHPUnit uses an ini-free PHP invocation with explicit public extensions, and Rust pins
its canonical C linker without importing host alternatives configuration. Dependency
warming avoids devpts so its network namespace stays owned by the user namespace entered
by slirp; the helper must return exactly its documented readiness byte before npm starts.

### Custom skill authority và đối soát session

`createHostSkillManager(platform, sessionId)` là authority skill của host (dùng trong
`createHostPlatformSession`): builtin theo digest phân phối tin cậy; skill operator/repository chỉ
khi receipt máy khớp chính xác digest, version, dependency, role, provider, repository, session và
còn hạn, đọc lại ở mỗi lần resolve/verify/recover. `reconcileSkillSessionRecords({stateDirectory,
verify, authorize})` chỉ đọc các record `gen-*/skills/*.json`, báo manifest không còn verify hoặc skill
mất approval (`reconciliationRequired`) và từ chối thư mục symlink; nó không sửa record hay process.
Provider đang chạy vẫn giữ instruction đã nạp: phải relaunch role. `SkillSessionStore.load` (restart)
gọi `recover(exactDigest)` và từ chối manifest đã bị revoke, không bao giờ lấy version mới nhất.
Bằng chứng: test local (`test/platform/skills-session.test.ts`, `apps/cli/test/custom-skill-import.test.ts`).

## Workflow liveness và capability recovery

Host cung cấp `repository_read` cho Coordinator và các role điều tra/verification, cùng
`read_pinned_instructions` để đọc nội dung skill đã pin. Reader chỉ đọc file text có giới hạn (một lệnh không có `skillId` trả policy và danh sách skill; mỗi trang skill theo UTF-8 byte và trả `nextOffset` khi `truncated`; Agy giữ mỗi phản hồi trong `AGY_INLINE_REPLY_BYTES`),
listing có cursor và các thao tác Git cố định; không nhận shell hoặc argv tùy ý. Git status/diff
fail closed khi repository cấu hình filter có thể chạy chương trình. Dispatch kiểm tra role,
pane/native session, launch, Bflow tools/list, repository/Git và manifest trước lease/transport.
Quyền ghi của Developer, Conditional TDD, verification và human gates vẫn theo các đường hiện có.

Quyền truy cập provider tới workspace được xác minh riêng trong `bflow up`. Khi chạy Git, Runtime
không đọc global/system configuration để quyết định ownership: mỗi subprocess canonicalize đúng
repository root (hoặc checkout verification mới tạo), reset các giá trị `safe.directory` kế thừa,
rồi chỉ tin đường dẫn đó trong process hiện tại. Điều này cho phép đọc repo do UID khác sở hữu mà
không thêm trust vào user-global Git config; nested repo/đường dẫn khác không được trust theo root
này. Runtime runner xác minh detached worktree bằng trust riêng cho checkout đó.

Coordinator gửi blocker tới Conversation phải được Runtime ghi nhận trước khi giao nguyên
RoleMessage đã xác thực. Run có thể chuyển sang `escalated` kèm `pendingAction`, owner,
nguyên nhân và phase để tiếp tục. `resume_run` chỉ tiếp tục action khớp, kiểm tra lại capability,
không vượt approval/cancellation hoặc delivery chưa rõ; intent chưa gửi được dùng lại id cũ.
Một lượt Coordinator chỉ báo progress rồi dừng không được tính là có next action.

Recovery đọc inbox/receipts bền vững, phục hồi wake thiếu theo đúng result/assignment/correlation,
và tiếp tục verification bị gián đoạn bằng plan đã đóng băng. Nó không tạo binding proof hoặc
resend delivery chưa rõ. Watchdog xét obligation của đúng run/pane; `unknown_delivery` là chờ
reconciliation có hành động xử lý, không phải task thành công hoặc bằng chứng treo.

Diagnostic specialist không đưa workflow đã tạo Core trở lại phase lập kế hoạch. Khi mở journal
cũ có phase bị ghi lùi, Runtime khôi phục phase thực thi hoặc chờ phê duyệt task/delivery còn
hiệu lực, giữ nguyên request và quyết định đã ghi; một action tạm dừng vẫn cần được xử lý riêng.
Người dùng có thể explicit resume action đó về `awaiting_approval`, rồi trả lời approval;
automatic resume vẫn bị chặn và việc resume không thay thế quyết định phê duyệt.

Conversation nhận notice qua inbox; receipt chưa đồng nghĩa model đã thấy hoặc người dùng đã
đọc. Host nhận diện layout idle đã quan sát của Claude/Codex, giữ draft không bị ghi đè và giới
hạn automatic wake ở ba lần mỗi notice qua restart. Notice và lỗi delivery vẫn được giữ khi
cạn budget; người dùng có thể mở Conversation và hỏi trạng thái rồi resume/cancel cùng run.
`host_status` trả các lỗi delivery gần nhất để chẩn đoán. Layout khác fail closed.

Xem `WORKFLOW-LIVENESS-AUDIT.md` cho nguồn gốc sự cố và
ranh giới nghiệm thu. Có local regression tests; live provider/full SDLC acceptance không được
suy ra từ fake transport, receipt, hoặc test Herdr native actor.

`conversation_decide` và `resume_run` của Conversation không bắt model chép `messageId`: host gắn quyết định vào lượt
người dùng mới nhất đã xác thực của đúng pane (nếu model truyền `messageId` thì vẫn phải khớp). Một lượt người dùng
kết thúc mà chưa có quyết định sẽ bị hook Stop từ chối, tối đa hai lần mỗi lượt, cho cả Claude và Codex. Codex ghi nhận
notice đã hiển thị qua `last_assistant_message` của Stop. Khi khởi động, host không chấm lại các lần dừng của Coordinator
thuộc session trước.

Để yêu cầu tiếp tục run bị chặn trong Conversation, dùng `tiếp tục` hoặc `resume <run-id>`.
Host kiểm tra input người dùng thật và session trước khi chuyển yêu cầu tới Runtime; thao tác
này không thay thế một approval đang chờ và không tạo workflow mới.
Khi một review read-only đã được giao chắc chắn nhưng chưa trả kết quả, explicit resume
có provenance từ Conversation cho phép Runtime gửi một diagnostic riêng cho đúng native
session cũ khi gate đang đợi. Request/handle gốc không đổi; diagnostic có lease riêng,
giữ capability gốc, không cấp verdict và không được resend nếu delivery chưa rõ. Native
session khác, gate đang chờ duyệt hoặc request chưa rõ delivery đều chặn continuation.
Mỗi lượt người dùng giữ wake bất biến riêng; replay cùng lượt không tiêu thêm budget.
Thông tin vận hành `task.status` đã xác thực từ Conversation được chuyển tới Coordinator
ngay cả khi run đang escalated hoặc chờ duyệt; nội dung được giữ lồng trong wake của
Runtime, không có quyền resume/approve. Replay receipt `received`, lỗi capability và Stop
của lượt thông tin đều giữ nguyên blocker, bằng chứng và các cổng phê duyệt hiện có.

Runtime lưu intake đã được Conversation xác thực cùng outbox intent trước dispatch đầu tiên;
`delegation.accepted` và ingress Herdr vẫn là các bước riêng. Vì vậy capability denial trước khi
Coordinator nhận yêu cầu cũng giữ được cùng run và action để xử lý, thay vì chỉ có terminal lỗi.

Conversation display recovery distinguishes notices surfaced to the model from
notices displayed to the user. Substantive progress with a run and a complete
headline remains eligible for display acknowledgement after restart. Claude and
Codex Stop hooks (Codex requires its final assistant message) can issue at most two
reminders per missed notice. Generic/truncated updates have no progress display
acknowledgement; display receipts never authorize a workflow or approval. These
guarantees are covered by local subprocess/host tests, not live-provider acceptance.

A numbered choice followed by prose is not committed as human governance at intake.
The original authenticated turn stays undecided for `conversation_decide`, allowing
Chat to revise the same workflow while an older approval is pending. The revision
uses normal Runtime admission/supersession; it does not fabricate an approval or
invoke operational resume. Exact numeric/option replies still use the trusted human
hook. Restart/replay coverage retains the same revision envelope and user-turn identity.

## Session cancellation controls

Một lượt người dùng được xác thực chỉ có một `conversation_decide`. Protocol Chat/host
riêng nhận `cancellationInput.runId`, `runIds` hoặc `scope: "session_existing"`;
Conversation đóng băng tập run trong session trước khi gửi từng cancellation có key riêng.
`CancellationRequest` và `DelegationRequest` công khai không đổi. Retry vẫn gắn với
message/provenance gốc và không mở workflow mới.

Runtime lưu cancellation control vào outbox trước khi áp dụng, độc lập với việc Coordinator
đang rảnh hoặc scheduler đang chờ verification. Tick/flush khôi phục control còn queued
sau restart; binding pane cũ không thay đổi quyền hủy của cùng session. Trạng thái `delivered`
của control này nghĩa là Runtime đã áp dụng cục bộ, không phải signed Herdr receipt hay
Coordinator đã bắt đầu lượt model. Cancellation đang `sending`/`unknown_delivery` giữ
quy trình reconciliation và không được gửi lại tự động.

Run đã hủy không dispatch công việc còn queued và không nhận approval để tiếp tục.
Conversation đối soát projection/pending approval với Runtime; entry chỉ có trong snapshot
được báo riêng, không được dùng làm bằng chứng còn chạy hay đã dừng. `cancelled` nghĩa là
ý định hủy có thẩm quyền đã được áp dụng; chỉ thông báo reconciliation cuối mới cho biết
`fully stopped` hoặc blocker cần xử lý. Native delivery chưa rõ được giữ nguyên và báo blocker,
không bị bỏ qua để tuyên bố đã dừng. Worktree vẫn được giữ để kiểm tra.

Regression cục bộ: build rồi chạy `pnpm exec vitest run
packages/runtime/test/agentic/cancel-reconcile.test.ts
packages/runtime/test/agentic/conversation-intake.test.ts packages/conversation/test`.
Các test dùng transport giả và storage/policy thật; không chứng minh các run trong session
production đã được dừng hoặc provider/Herdr live đã chấp nhận bản sửa.

Nếu `complete_review` nhận sai observation ID, host vẫn từ chối verdict. Thông báo lỗi
chỉ gợi ý tối đa ba ID đã quan sát trong cùng native pane, cùng request và context được
giao; request bị thay thế không nhận gợi ý. Agent phải tự chọn ID đúng và nộp nhận định
độc lập. Gợi ý không tạo receipt hay tự thay tham số của agent.

Core giữ cache phục hồi chỉ trong một instance Runtime: aggregate đã xác thực hoặc đã ghi
thành công được tái dùng khi chính engine/RunStore, definition và toàn bộ snapshot trong
bộ nhớ/lưu trữ vẫn khớp. Cache không tạo aggregate từ projection và không lưu qua restart.
Phiên bản thay đổi, engine đổi, bộ nhớ lệch hoặc cache mới đều phải qua checkpoint/event
recovery; không cho phép ghi đè aggregate trong bộ nhớ mới hơn bằng lịch sử cũ.

Blocker chẩn đoán của specialist đến trong khoảng resume đã xếp hàng nhưng verifier chưa
bắt đầu cũng không thay pending action hay số lượt đã dùng. Thông điệp xác thực vẫn được
lưu trong inbox và chuyển tới Coordinator; chỉ kết quả kiểm chứng hoặc đường quyết định
được cấp quyền mới có thể tiếp tục thay đổi trạng thái công việc.

Run có pending action chờ đối soát delivery, kể cả journal cũ chưa có nativeDeliveries,
không tự advance Core hay ghi checkpoint mới trong scheduler. Đường đối soát và cancellation
vẫn hoạt động riêng; không có kết luận delivered/not-delivered, retry hay kết quả công việc
nào được suy ra từ việc giữ yên run đó.

Journal tái dùng snapshot đã kiểm tra chỉ khi nội dung file đọc dưới flock khớp chính xác
bytes đã xác thực trong instance đó. Callback nhận bản sao độc lập; file đổi, hỏng hoặc
khác version vẫn phải qua parser và không fallback về cache. Save không đổi state kiểm
tra lại bytes còn tồn tại rồi giữ nguyên commit; mọi thay đổi vẫn qua schema và
fsync/rename/fsync thư mục trước khi cập nhật cache. Cache không tạo receipt hay đổi
quy tắc giao nhận, phê duyệt, fencing hoặc giới hạn retry.

Khi diagnostic legacy làm mất bộ đếm resume thủ công đang cache, Runtime lấy cận dưới từ
các intent `resume_run` khác nhau do Runtime đã phát cho đúng run/action và giữ giá trị
lớn hơn giữa cận dưới đó với bộ đếm hiện có. Không suy diễn việc giao intent hay provider
đã dừng; không sửa intent cũ, không tạo receipt và không cấp lại các lượt đã dùng.

Native timeout reporting rechecks the owned immutable intent and signed ACK before and
again after recording uncertainty. An ACK that races a stale watchdog snapshot clears
only its exact pending delivery; a missing ACK still blocks dispatch. This never resends
the envelope, synthesizes an ACK, or substitutes transport evidence for a gate verdict.

While an independent Herdr gate awaits its reply, a non-overlapping dispatch pass keeps
its original queued request live if pane readiness or a delivery hold recovers. It uses
the existing Outbox checks and backoff within the original gate deadline; it does not
create a new invocation, retry an unknown delivery, or extend verification budgets.


Thông báo Coordinator bị chặn vì cần sửa yêu cầu nêu ngay nguyên nhân, chi tiết xung đột,
các bước xử lý và nội dung trả lời cho đúng run. Xung đột `lightweight`/`full SDD` có câu
trả lời mẫu để giữ phạm vi khi chính sách đã yêu cầu `full`; không hướng người dùng vào
vòng lặp “tiếp tục” hoặc gọi nhầm là lỗi capability. Blocker yêu cầu revision chờ xử lý thủ
công qua Conversation, kể cả sau restart; thông báo và câu trả lời mẫu không tự sửa yêu
cầu, cấp approval hay chứng minh workflow đã tiếp tục. Notice cũ còn đủ nội dung xung đột
cũng nhận hướng dẫn khi được render lại. Receipt mới lưu thêm trường blocked tùy chọn có
giới hạn, độc lập với summary để phần hành động không mất khi diagnostic bị cắt; receipt
cũ vẫn đọc được và không có migration hay thay đổi public contract. Đây là hành vi source/local-test; host/provider
đang chạy cần nạp lại mã/prompt qua lifecycle hiện có để sử dụng bản sửa.

Review bổ sung: chỉ gợi ý full SDD khi thông tin báo chặn khẳng định cần full; phủ định,
yêu cầu lightweight hoặc xung đột đã giải quyết không tạo gợi ý/gate mới. Hint full đã
xác định được lưu có kiểu và giới hạn trong notice/receipt để không mất khi reason bị cắt.
Notification giữ chỗ cho câu trả lời cần dùng trước phần lý do dài. Xác nhận hiển thị của
notice sửa yêu cầu phải có nội dung hành động; chỉ nhắc mã notice hoặc headline không đủ.
Các kiểm tra này không tạo quyền phê duyệt, thay đổi yêu cầu hay bằng chứng thành công.

## Context khảo sát có dẫn chứng

Host `assignment_context` cung cấp khảo sát có giới hạn cho assignment phân tích hiện hành
của Coordinator/specifier/architect/planner. Runtime tái sử dụng `ProjectContextService`
để chọn source, dependency tĩnh lân cận, test và tài liệu liên quan; context ghi worktree,
HEAD, fingerprint, dòng nguồn, mức `observed`/`inferred`/`unknown` và phần bị cắt.
Đây là dữ liệu chẩn đoán, không phải yêu cầu nghiệp vụ đã được duyệt hoặc bằng chứng task
thành công. Thiếu bằng chứng về business intent phải giữ `unknown`.

GitNexus chỉ bổ sung khảo sát qua tool action đã cấp quyền khi role xác minh được repository
và revision index phù hợp, rồi đối chiếu source. Index thiếu/stale/unverified cho phép fallback
đọc source trong phạm vi được cấp; dependency động và phần chưa đọc vẫn chưa được chứng minh.
Drift được báo khi context trước thay đổi; không tự sửa spec, replan, chuyển task status,
hoặc thay approval/lease. Kiểm thử cục bộ không chứng minh live-provider acceptance hay mức
giảm token/lỗi.

## Fast-path cho thay đổi trivial (`fastPath.mode`)

Khi `fastPathMode: "auto"` (truyền từ `environment.fastPath.mode` của CLI; `host.json` cũ thiếu trường này được `effectiveFastPathMode` xử lý là `"off"`), `evaluateFastPath` trong `packages/runtime/src/agentic/fast-path.ts` đánh giá thuần điều kiện fast-path tại `assess` (preview hướng dẫn cho Coordinator) và đóng băng `RunRecord.fastPath` tại `proposeWorkflow` ([ADR 0004](../../docs/adr/0004-fast-path-review-waiver.md)). Mọi cờ `fastPath` do agent gửi trong `metadata` đều bị bỏ qua. Run chỉ đạt `active` khi P15 phân loại `trivial`, không có `unresolvedQuestions`, SDD `lightweight`, đúng 1 Developer task không dependency và không `requiresApproval`, tối đa 5 đường dẫn literal trong `affectedPaths`, `tddDecision.mode !== "required"` và chưa gọi `request_specialist` (do đó `bugfix`/`feature` và TDD `required` không đủ điều kiện).

Khi `run.fastPath.status === "active"`, Runtime tự duyệt thiết kế (`designNeedsHuman` bỏ qua `projectApprovalRequired` nhưng vẫn giữ `classification.humanApprovalRequired` và luôn giữ phê duyệt `delivery` của người dùng). Trong `verificationPlan`, Runtime chỉ gửi waiver `deterministic_coverage` ở mức task khi mọi tiêu chí bắt buộc đều tự động hóa (`verificationMethod !== "manual_review"`) và có `targetCommands`; thay đổi chỉ gồm tài liệu (`manual_review`) vẫn chạy Reviewer/QA ở mức task. Ở mức workflow, nếu cây Git sau tích hợp (`policies.git.treeOf`) trùng khớp với cây của task duy nhất đã `passed`, Runtime gửi waiver `identical_integrated_tree` để bỏ Reviewer/QA lặp lại trong khi vẫn chạy `host-git-integrity` và regression gate. Nếu P17 từ chối waiver hoặc tree hash không khớp (`tree_mismatch`), Runtime hạ cấp một chiều (`status: "downgraded"`) về plan đầy đủ và phát notice tiếng Việt. Lưu ý: vì bộ cổng mặc định của host bao gồm `host-test-integrity` (xem mục TI-01 ngay bên dưới) đòi hỏi Reviewer độc lập thẩm định các ứng viên làm yếu test/config, `fastPath` sẽ bị hạ cấp bảo thủ (`test_integrity_requires_independent_review`) khi cổng `host-test-integrity` có mặt; review waiver chỉ còn hiệu lực khi cấu hình host tùy chỉnh không bật cổng này. Hiện trạng bằng chứng ở mức source + local/fake-runner tests, chưa có live Herdr/provider acceptance.

### Gate toàn vẹn test theo revision (TI-01)

Host đăng ký `host-test-integrity` như một check bắt buộc ở cả task và workflow,
độc lập với việc chọn behavioral/regression runner. Check dùng Git blob ở đúng
`baseRevision` và `sourceRevision`, nhận diện rename/move và giữ multiplicity của
các test trùng nhau; không quét từ khóa trên toàn working tree. Task rework giữ base
ban đầu của task, workflow giữ run base, để attempt bị từ chối không biến thành
oracle đáng tin của attempt sau. `baseRevision` trong report là base được bảo vệ này. TypeScript 5.9.3
là parser thuộc host, không load config/plugin từ candidate. Report được ghi qua
ArtifactStore, có rule/finding ID, vị trí và phía revision, hai SHA, before/after
và lý do. File test dạng symlink, revision/working tree không còn khớp, parse/input
không đo được hoặc vượt giới hạn không được coi là bằng chứng sạch.

Các form JS/JSX/TS/TSX được test gồm Vitest/Jest `test`/`it`/`describe` và `expect`
(global hoặc ESM alias), ESM Node `test`/`assert`, cùng Playwright test modifiers
và các action trên `page`/locator dẫn xuất. So sánh tìm test bị xóa, assertion bị
xóa/đổi oracle/nới numeric bound, skip/fixme/todo/expected-failure mới, test focus,
parameterized inputs, discovery/script thay đổi, coverage threshold giảm và
`force: true` mới trên browser action nhận diện được. Fixture dữ liệu nhị phân
bị xóa không bị hiểu là test bị xóa. Truthy assertion hữu ích, guard mới, comment,
chuỗi ký tự, test đổi tên/di chuyển và primitive equality tương đương không bị
cấm theo từ khóa hay tổng số test.

Chỉ literal tautology hẹp là `proven_violation` và tự làm gate thất bại nếu chưa
có ngoại lệ owner hợp lệ. Các delta khác là `review_required` hoặc `coverage_gap`:
check deterministic không tự kết luận chúng là lỗi. `inspect_review` cung cấp
`testIntegrityObservation`; Reviewer phải trả lời **đủ và đúng từng ID** trong
`complete_review.testIntegrityVerdicts`, gồm `verdict` (`equivalent` hoặc
`confirmed_violation`), `reason` và `evidence: [{ revision, path, line, excerpt }]`.
Evidence phải chỉ vào base/candidate, file Git thường có thật và đúng nguyên dòng
đã trim; host kiểm tra trước khi lưu receipt bất biến. `equivalent` giải thích
false positive/oracle được giữ nguyên, không miễn một vi phạm đã xác định.
QA và Developer không thể thay Reviewer cung cấp verdict này. Phiên bản đầu
conservatively downgrade fast-path khi gate hiện diện, kể cả candidate sạch,
để giữ đường Reviewer độc lập.

Reviewer có thể gọi `request_test_integrity_exception` với `reviewId`, `findingId`
và `reason`; host lấy report/evidence đã lưu và Runtime chuyển yêu cầu qua
Conversation. Reviewer kết thúc lượt khi chờ owner. Approval dùng chính authority
người dùng đã xác thực của Runtime, phải có lý do, và được ghim vào run/task/attempt,
base/candidate, spec fingerprint, scope, finding và report evidence. Quyết định gốc
được lưu và xác thực lại sau restart. Comment/ticket, Developer metadata, generic
user-decision hay chuỗi `approvedBy` không cấp ngoại lệ. Không chuyển ngoại lệ từ
task sang workflow hoặc sang candidate/attempt khác. Chờ quyết định giữ semantics
human-wait/timeout có sẵn: timeout không chứng minh agent đã dừng và không cấp phép
bỏ qua approval; có thể cần đối soát/retry luồng review hiện có. Không gửi verdict
cuối cùng trước khi có quyết định nếu đang xin ngoại lệ.

Giới hạn: đây không phải chứng minh semantic equivalence tổng quát. CommonJS
`require` aliases, custom assertions/helpers, generated tests và computed config
chưa có phân tích đầy đủ; ngôn ngữ khác chưa có assertion parser mặc dù behavioral
runner có hỗ trợ. Các form opaque/config hoặc ngôn ngữ test không phân tích được có coverage gap;
không có parser đầy đủ cho mọi runner config polyglot.
Repeated config keys ở nhiều scope có thể ghép heuristic sai; sửa thân test đã skip
có thể báo lại skip; marker multiset không chứng minh marker giữ nguyên testcase.
Import helper semantics và di chuyển test kèm sửa lớn cần Reviewer kiểm tra.
Discovery thay đổi không tự chứng minh discovery bị thu hẹp. Browser syntax
analysis không phải live browser evidence. Input host giới hạn 256 changed files,
1 MiB/blob và 8 MiB tổng; vượt giới hạn phải chia candidate/đối soát thay vì PASS.
Report giới hạn 2.000 findings / 2 MB, excerpt 256 ký tự và lý do 512 ký tự;
vượt giới hạn chặn thay vì cắt mất finding rồi PASS. Source anchor chỉ tới blob đầy đủ.
Agy nhận finding pages qua `integrityOffset`/`nextFindingOffset`, excerpt được giới
hạn ở response; report đầy đủ giữ trong ArtifactStore.

Kiểm chứng local (build trước các ca dùng `dist/`):

```sh
pnpm build
pnpm exec vitest run packages/runtime/test/agentic/test-integrity.test.ts packages/runtime/test/agentic/host-test-integrity.test.ts packages/runtime/test/agentic/test-integrity-authority.test.ts packages/runtime/test/agentic/host-verification.test.ts
```

Các ca này dùng Git thật và filesystem ArtifactStore ở boundary host; chúng không
chứng nhận live Herdr/provider hoặc full SDLC acceptance.

Plan được lưu trước nâng cấp mà thiếu integrity check/Reviewer hoặc còn review waiver
bị fence và cần owner đối soát; host không nâng evidence cũ thành receipt integrity.

### Task handover nội bộ

Developer của Core task có `read_task_handover` và `propose_task_handover`.
`assignment_context` và `workspace_status` trả `resumeContext`: handover được host
chọn cùng yêu cầu, specification, strategy, approval/decision, blocker và rework
context hiện hành. Các view compact/active_only giữ phần này; compact task dossier
cũng giữ specification và acceptance criteria khi không còn assignment đang chạy.
Pane đã nghỉ chỉ được đọc authority của assignment của mình, không ghi handover.
Conflict resolver và specialist ngoài Core task không dùng cơ chế này.

Schema riêng của Runtime (`src/agentic/task-handover.ts`, không export qua public
package contracts) là `{schemaVersion:1,binding,content}`:

- `binding`: `runId`, `taskId`, `assignmentId`, `attempt`, `attemptId`, `generation`, `reworkGeneration`,
  `worktreePath`, `revision` (Git HEAD), `specId`, `specVersion` (`null` nếu bản gốc
  không khai version), `specFingerprint`, `requirementFingerprint`. Host suy ra
  binding; proposal phải khớp chính xác binding từ lần đọc hiện tại.
- `content`: `nextAction`, `decisions`, `disprovedHypotheses`, `untestedAngles`,
  `references`. Mỗi chuỗi nội dung tối đa 768 ký tự; mỗi danh sách nội dung tối đa
  8 mục; references tối đa 16 source locations hoặc evidence artifact IDs.
  Evidence IDs chỉ là gợi ý tra cứu, không phải trusted ArtifactReference/proof.
- Toàn bộ envelope tối đa 16 KiB UTF-8; schema strict từ chối trường lạ. Không
  trích xuất log hoặc tự suy diễn lịch sử từ transcript.

Agent đề xuất trước khi nhường lượt hoặc rút gọn context, và cập nhật sau commit.
Host kiểm tra assignment hiện hành và gia hạn lease/fence, validate proposal, rồi
lưu một bản mới nhất cho mỗi run/task tại
`<journalDirectory>/task-handover/<hash(runId,taskId)>.json`, ngoài task worktree.
Khóa journal hiện có tuần tự hóa ghi/đọc với retry; ghi file tạm độc quyền,
fsync/rename và fsync thư mục theo nền tảng local POSIX hiện được kiểm chứng.
Đọc giới hạn byte, không theo symlink, không đọc special file/hardlink.

Sau retry/restart/context compaction, host đọc lại và kiểm tra provenance với
assignment đã lưu. Chỉ nhận attempt hiện hành hoặc attempt trước **cùng Core
generation và rework generation**, cùng HEAD/specification/requirement fingerprint. Worktree path của
attempt trước phải khớp assignment cũ; host không đổi nhãn attempt nguồn. Generation
mới, revision/specification/yêu cầu thay đổi hoặc binding không khớp sẽ bị giữ lại
với diagnostic `handover_*`; không tự chuyển handover sang generation mới.
Revision ở đây là HEAD, không chứng nhận nội dung chưa commit hay tình trạng source
reference hiện tại. Mọi reference cần được kiểm tra lại trước khi dùng làm evidence.

Handover luôn là JSON context chưa đáng tin kèm cảnh báo; chuỗi yêu cầu đổi policy,
approval, specification hoặc khai thành công không có authority. Nội dung không
được đưa vào system prompt hay acceptance proof. Trạng thái authority và các gate
hiện có vẫn quyết định có được tiếp tục hay không.

Không đổi checkpoint codec, journal version, public contract hoặc memory Gateway.
Checkpoint và dossier rework giữ vai trò hiện có; memory có provenance vẫn đi qua
Gateway, không được coi là nguồn handover chuẩn. State cũ không có file handover
trả `handover_absent`; assignment cũ không có marker provenance tiếp tục recovery
nhưng không được bịa generation để nhận proposal (`handover_unknown_assignment`).
File hỏng/quá cỡ hoặc revision không đọc được trả diagnostic và bỏ context tùy
chọn; không làm hỏng Core recovery. Nếu agent chưa đề xuất trước khi process chết,
host không thể khôi phục handover chưa từng được lưu. Đây là source/local tests,
chưa phải live-provider/Herdr/full-workflow acceptance.

Kiểm chứng sau build:

```sh
pnpm build
pnpm exec vitest run packages/runtime/test/agentic/task-handover.test.ts packages/runtime/test/agentic/task-handover-view.test.ts packages/runtime/test/agentic/rework-causality.test.ts packages/runtime/test/agentic/core-checkpoint-restore.test.ts packages/runtime/test/agentic/conversation-context-budget.test.ts packages/runtime/test/agentic/mcp-output-trim.test.ts packages/runtime/test/agentic/tool-action-policy.test.ts
```

Với Agy, context tự động trả chỉ dẫn `handover_context_deferred` tới
`read_task_handover`. Reader tự chia reply lớn thành `handover_context_paged`
(`page`, `cursor`, `offset`, `nextOffset`, `totalBytes`); ghép các chuỗi page rồi
parse JSON đầy đủ trước khi tiếp việc. Có thể yêu cầu `{view:"page"}` trên provider
khác. Trang tiếp dùng cùng `cursor` và `offset:nextOffset`; thay đổi requirement,
approval, revision hoặc nội dung sẽ làm cursor cũ bị từ chối với
`handover_cursor_stale`, phải đọc lại từ offset 0. Mỗi trang giữ UTF-8 nguyên vẹn
và nằm dưới ngân sách reply Agy 8.500 byte, không cắt âm thầm authority hoặc nội
dung đã lưu. Proposal acknowledgement không echo lại toàn bộ context. Đây là
phân trang presentation riêng, không thay đổi schema hay lifecycle checkpoint.


## Telemetry hiệu quả workflow

`bflow status <run-id> --telemetry [--json]` đọc report qua host agentic **đang tồn tại**.
Không khởi động host, chạy scheduler, phục hồi Core hay tạo receipt để đo. Projection
không tham gia acceptance/task success. Lỗi nguồn trả coverage không đầy đủ cùng mã lý do;
không ghi exception/prompt/command/output vào report.

Định nghĩa, mẫu số và Conditional TDD nằm trong [Specification](TELEMETRY-SPEC.md).
Các số đo Core gồm khoảng thời gian trạng thái task, rework theo generation, retry riêng,
first-pass trong nhóm task Core `succeeded` có lịch sử đầy đủ, approval wait và gate
turnaround (proxy timestamp event, không phải gate execution/persistence latency). Report luôn kèm cohort
failed/cancelled/incomplete; first-pass không phải tỷ lệ thành công toàn workflow.

Core ghi gate event bằng `evaluatedAt`; một số evaluator lấy mốc này trước khi chạy
xong. Vì vậy gate turnaround luôn `partial`, không chứng minh thời gian chạy lệnh thuần
hay latency ghi receipt.

Với run agentic, mỗi native Reviewer/QA gate được host đo start/end: từ lúc enqueue
verification request đến lúc settle (verdict, validation rejection, timeout hoặc abort), lưu
trong journal `reviewTimings` (tối đa 200 entry/run). `gateExecution` chỉ tính interval đã
đóng (`host_review_gate_timings`, `partial`); wait còn mở được đếm trong `open`. Khi wait đã
dùng 80% `executionTimeoutMs`, Conversation nhận đúng một progress note. Đây là wall time gồm
delivery Herdr và reply ingest, không phải thời gian thuần của Reviewer. Legacy report giữ
`unavailable`.

Host receipts bổ sung thời gian operation verification theo phase/role và regression
widening theo evaluation ID. Chúng mang nhãn `partial`: inventory receipt không có mốc
publication bất biến, không chứng minh toàn bộ operation lỗi/gián đoạn đều được ghi.
Tổng thời gian các operation có thể chồng nhau. Chỉ nhận timestamp phase do host measurement
path sinh cùng binding role, không dùng timestamp agent tự khai. Reason widening được
chuẩn hóa thành mã; không xuất file path. Artifact delivery ACK không chứng minh evidence
reuse. Thiếu proof reuse, cặp clarification, per-gate start/end hoặc provider usage thì
metric tương ứng là `null/unavailable`. Chưa ước tính chi phí hay có bảng giá.

Projection loại duplicate theo run/eventId và run/sequence, dùng validator batch hiện có,
chặn xung đột identity và báo coverage khi mất event/time. RunStore reader chốt high-water
mark rồi đọc tối đa 200 trang × 500 events. Nó không bám đuôi run đang tiếp tục ghi.
Superseded approval thiếu timestamp không được đóng duration; pending approval có deadline
đã qua được đếm riêng (không coi là quyết định human); cancellation/terminal không sinh
approval duration giả. Run chỉ có journal vẫn giữ business outcome cùng provenance.

Legacy standalone trả `legacy_readonly_source_unavailable`: factory Persistence hiện tại
không có read-only open, còn Runtime composition có thể seed registry. Không mở composition
đó chỉ để xem telemetry, không đọc SQLite bằng SQL riêng. Hỗ trợ legacy cần owner Persistence
cung cấp đường mở chỉ đọc; không có migration/public event mới trong thay đổi này.

Kiểm tra tập trung sau build:

```bash
pnpm build
pnpm exec vitest run packages/runtime/test/telemetry apps/cli/test/telemetry.test.ts
```

Đây là bằng chứng source/local fixtures, không phải live Herdr/provider hay full SDLC acceptance.

### Explicit cancellation reconciliation

`bflow cancel <run-id> --reconcile --json` connects to the already-running agentic
host as an operator. It observes an already-cancelled run once even after the five
automatic observations have been exhausted. It does not reset that budget, send
another interrupt/assignment, approve work, resume a run, or start a host. The
report contains `fullyStopped`, outstanding `blockers`, and `retainedWorktrees`;
an unresolved report has a nonzero CLI exit status. An older daemon that lacks
the operation fails explicitly; there is no legacy-runtime fallback.

A correlated observation must parse as `AgentTransportObservation`, match the
entire original handle, and have an observation timestamp between acceptance
and the current host time. Stop evidence is persisted before allocation/lease
cleanup. Cancelled allocations use P13's retained-pane/worktree release, with
idempotent launch revocation; dirty worktrees or a replaced binding stay blocked.
An expired Registry grant is reported separately from a successful release
receipt. Core cancellation is confirmed only after the remaining blockers clear.

**Current live limitation:** the Herdr adapter returns `correlationVerified:false`
for lifecycle observations. Idle/done, an interrupt acknowledgement, lease expiry,
a diagnostic note, or a cancellation-time `/proc`/shell snapshot cannot be
promoted to authenticated process-exit evidence. This command therefore cannot
clear a legacy Herdr writer solely because an operator has exited its CLI. It
retains the blocker until a supported stop-evidence source exists. Tests of the
positive recovery path use correlated fake-transport evidence, not live Herdr
process-containment acceptance. A launch-bound process-supervision/stop-proof
integration requires a separate architecture/contract decision; this change does
not introduce one or claim the current live session is recovered.

**Developer process supervision availability:** on a Linux host whose Bubblewrap
user namespaces (including AppArmor `apparmor_restrict_unprivileged_userns`) and
Python pidfd support pass the readiness probe, new Developer launches run inside a
launch-bound PID-namespace scope. A host without that backend, and every pane
launched before it, keeps the previous unsupervised behavior: launches are not
refused, dispatch is not gated on a scope, and cancellation uses the transport
interrupt path. `platform_status` reports `developerProcessSupervisionUnavailable`
with the probe failure. Only a binding that carries a `processScopeId` is held to
scope proof. An undispatched allocation without a scope (or whose sealed scope
never admitted its provider) is not a stop blocker; its worktree is reported as
retained. Uncertain deliveries retain only the Developer allocation they could
wake, not every Developer of the run. The connect-only reconcile call waits up to
10 minutes; a client timeout does not mean the host stopped applying it.

Private journal compatibility: v1–v5 are still read without manufacturing stop
proofs. The first real correlated cancellation proof writes **v6**. V6 pins each
proof to its exact cancelled execution and records lease disposition. Older
binaries reject v6; do not downgrade an affected session. No public contract,
Core event/checkpoint schema, or legacy run-store migration is changed.

### Execution preview and drift boundary

The additive preview contracts separate stable plan decisions from readiness observations. New
agentic runs bind their accepted specification/DAG and current resolution when design is accepted,
even if the caller supplied no preview expectation. Runtime revalidates before new worktree,
capacity, provider preparation and dispatch effects, and after awaited preparation boundaries.
A drift diagnostic includes a sourced `PlanDiff`; it creates no approval. Existing specification
and revision approval rules remain authoritative. Cancellation, receipt draining, lease renewal
for an already dispatched execution and Conversation reporting remain available during drift.

The CLI supplies declarative input file watches. JSON watches normalize key ordering/formatting;
other files conservatively invalidate on byte changes and require read-only re-resolution. Private
watch digests persist across host/run restart and are excluded from public fingerprints/inspect
output. Optional missing inputs are watched for later creation. Only bounded regular files with
no symlinked ancestors are read. Preview does not launch, install, reserve capacity, acquire a
lease, create an approval or invoke a model. A preview is neither readiness nor success evidence.

Historical accepted runs without a resolution binding explicitly report
`legacy_resolution_baseline_unavailable`; Runtime does not invent their historical configuration.
Legacy host composition without input declarations retains existing prerequisite checks but cannot
claim profile/config drift coverage. Read-only accepted-plan access reads the validated private
journal without opening mutable RunStore/Registry/Skill stores or creating locks/directories.

Repository/operator skills require machine-owned pre-approved receipts. The strict
`SkillApprovalStoreSchema` store is private (0700 parent, 0600 file, current owner), with exact
skill/version/digest/dependency pins, repository/session and role/provider scope; expired or
unavailable receipts deny authorization. The machine path is composed by the trusted host rather
than repository configuration. Preview reads these receipts and never creates them. Same-UID hostile
mutation and full live-provider/full-SDLC acceptance are outside local test evidence.

The host can declare `executionResolution.repositoryRoot` to bind read-only live Git observations.
The shared `readExecutionRepositorySnapshot` used by CLI and Runtime includes HEAD, semantic
index entries and bounded dirty/untracked noncredential file contents and executable modes.
Before an effect and after restart, changed observations require re-resolution; `.bflow` managed
metadata uses its separate explicit input watches. Legacy callers omitting `repositoryRoot` retain
file-watch compatibility without claiming Git drift coverage. Git optional writes, fsmonitor,
external diff and textconv are disabled; unsafe/oversized relevant files fail closed.

Custom skill dependency receipts can be passed separately as `dependencySkillApprovals` in role
platform options (`dependencyApprovals` on the SkillManager request). These exact pins and receipt
IDs authorize only dependencies reached by the shared resolver. They never select an additional
skill, and every reached dependency still passes the current machine approval's role/provider,
repository/session, content/dependency pin and expiration checks.

### Prototype review tùy chọn trước thiết kế chi tiết

Nhánh này chỉ chạy khi Coordinator gọi `propose_prototype`; run không dùng prototype giữ nguyên
đường `propose_workflow` → design approval → implementation → delivery. Không có workflow engine
thứ hai: state nằm trong `RunRecord.prototype` (journal private, schema version 1 trong
`src/agentic/prototype-review.ts`), quyết định đi qua `approval.decision` của Conversation hiện có.

- **Scope nhẹ được chấp nhận**: mục đích, luồng cần chứng minh, `allowedPaths` dưới vùng logic
  `prototype/`, artifact dự kiến, tiêu chí riêng của prototype, `disposition` (`throwaway` |
  `evolvable`), `environment: "mock"`, `dataPolicy` (`synthetic` | `anonymized_fixture`),
  `maxRevisions`. Schema strict: trường lạ (ví dụ deploy) bị từ chối. Tiêu chí prototype không được
  trùng ID tiêu chí nghiệm thu của sản phẩm.
- **Artifact**: `submit_prototype` chỉ lưu file vào ArtifactStore (`taskId: "prototype"`) kèm manifest
  canonical; không ghi repository, không deploy. Từ chối file ngoài vùng, luồng không khai báo/không
  được chứng minh, nội dung giống credential và URL tới host thật (chỉ cho loopback, `0.0.0.0`,
  `.test`/`.example`/`.invalid`/`.localhost`). Định danh `xmlns` và DOCTYPE public (không có internal
  subset) không bị coi là endpoint. Bộ quét credential riêng cho prototype (không dùng bộ che giấu log):
  từ chối dạng secret đã biết (khóa provider, JWT, PEM, `user:pass@` trong URL) ở mọi vị trí và mọi
  giá trị của key nhạy cảm (`password`, `token`, `api_key`, `Authorization`…, kể cả trong query của
  thuộc tính HTML) trừ mặt nạ/ô template (`****`, `<token>`, `{{token}}`, `${token}`) hoặc chữ thường
  không có chữ số (`Pending`, `Đang chờ`). Sau `Bearer`/`Basic` chỉ chấp nhận mặt nạ/ô template.
  Tối đa 20 phiên bản scope và 50 phiên bản artifact.
- **Approval riêng**: ID `prototype-…`, target `task/prototype`, `revision` = phiên bản artifact,
  `generation` = phiên bản scope; metadata ghi digest manifest, luồng cần xem/luồng giữ duyệt cũ,
  `approves: "prototype_only"`, `provesAcceptanceCriteria: false`. Chỉ người được `authorizeHuman`
  duyệt; trước khi duyệt Runtime kiểm lại checksum mọi artifact. Card Conversation tách rõ
  "đồng ý", "cần sửa <góp ý>" (`changes_requested`), "đổi yêu cầu <nội dung>" (`changes_requested`
  kèm `metadata.feedbackKind: "specification_revision"`, chỉ khi trả lời có nêu mã approval prototype),
  "từ chối vì <lý do>" (`rejected`) và "hủy việc".
- **Quyết định**: `approved` ghi `acceptance` (approvalId, version, manifestDigest, scope, người duyệt,
  thời điểm, luồng); run sang `planning`, không tạo design approval hay Core aggregate. `changes_requested`
  ghi feedback `prototype_revision` (hoặc `specification_revision_proposal` khi decision metadata có
  `feedbackKind: "specification_revision"`), không sửa yêu cầu đã chấp nhận. Với đề xuất sửa
  specification, Runtime đánh thức Coordinator (`prototype_specification_revision_proposed`) và báo
  người dùng rằng yêu cầu chưa đổi; thay đổi chỉ có hiệu lực khi Conversation gửi requirement revision
  (supersede prototype hiện tại). Vượt `maxRevisions` thì
  `escalated`. `rejected` kết thúc run `failed`. Hủy run đóng approval đang chờ.
- **Approval cũ**: artifact mới supersede approval đang chờ; sau khi đã duyệt, chỉ luồng có digest
  nội dung không đổi giữ duyệt cũ, luồng thay đổi phải duyệt lại và `acceptance` bị thu hồi. Sửa scope
  hoặc revision yêu cầu supersede toàn bộ (revision yêu cầu đưa ID vào `supersededApprovals`).
  Prototype bị supersede bởi revision yêu cầu không chặn và không làm đầu vào cho thiết kế của
  revision mới; Coordinator có thể mở prototype mới cho revision đó.
  Quyết định trễ cho approval không còn pending bị từ chối ở cả `queueHerdr` và `receiveHerdr`.
- **Thiết kế chính thức**: `propose_workflow` bị từ chối khi prototype chưa `accepted` hoặc
  `acceptance` không khớp artifact/scope hiện tại. Design approval là approval riêng, chỉ mang
  `metadata.prototype` (`inputOnly: true`) và manifest làm evidence. Task có
  `metadata.retainsPrototype: true` chỉ hợp lệ với prototype `evolvable` đã duyệt; fast-path bị tắt
  để code giữ lại qua verification đầy đủ. Sau khi design được đề xuất, prototype đóng băng.
- **Retry/restart**: gửi lại đúng nội dung (kể cả sau restart) không tạo version hay `approval.request`
  mới; gửi lại nội dung đã bị yêu cầu sửa bị từ chối. Approval đang chờ được trả lại qua
  `pendingApprovals` để Conversation reconcile.

Giới hạn: prototype do Coordinator nộp trực tiếp (nội dung từ specialist hoặc tự soạn), không có
Developer worktree riêng cho prototype; kiểm tra "dữ liệu thật" là heuristic (credential, host ngoài)
chứ không chứng minh nguồn dữ liệu: cụm chữ không có chữ số (ví dụ passphrase) hoặc secret không gắn
nhãn vẫn có thể lọt. Watchdog chưa resurface riêng approval prototype; Conversation
lấy lại qua `reconcileApprovals`. Bằng chứng: source và test cục bộ
(`test/agentic/prototype-review.test.ts`), chưa có live Herdr/provider acceptance.

### Gói bàn giao offline (HX-01)

`exportHandoverPackage`, `inspectHandoverRun`, `verifyHandoverPackage` và `openRepositoryHandoverSources`
(`src/handover/**`) dựng gói bàn giao từ đúng một lần đọc journal của run (kiểm tra owner/mode,
`parseAgenticJournalState`, không flock, không kết nối host) và đọc ArtifactStore có kiểm tra integrity
(chỉ mở store đã có catalog). Snapshot identity là digest canonical của run record công khai;
revision yêu cầu phải bằng `workflowChange.headCommitHash`. Ma trận criterion → task → integrated
revision → check/verdict → evidence chỉ coi `passed` khi check workflow-scope gắn với integrated revision
và evidence đã xác minh; evidence thiếu/hỏng hoặc lệch revision thành `inconclusive`. Delivery approval
chỉ hợp lệ khi gắn với kết quả workflow verification cuối (approvalId/idempotency key/evidence).
Hướng dẫn chạy chỉ lấy từ `targetCommands` và command đã ghi nhận; rollback chỉ từ
`specification.rollbackPlan`, thiếu thì ghi thiếu. Journal được đọc qua descriptor mở bằng
`O_NOFOLLOW` và owner/mode được kiểm trên chính descriptor đó; ArtifactStore mà user khác ghi được
(root hoặc catalog group/other-writable) bị coi là `unavailable`. Manifest ghi thêm sha256 của đúng
bytes journal đã đọc. `includeEvidence` chép evidence văn bản đã xác minh (`test-result`, `report`,
`patch`, `document`; 1 MiB/file, 16 MiB tổng) sau redact vào `evidence/<sha256>.txt`; log và
agent output không bao giờ được chép. Publish giữ flock trên `.<tên>.handover.lock` cạnh thư mục
đích, dọn staging sót lại, kiểm inode thư mục sau rename và từ chối thư mục cha mà user khác ghi được
(trừ khi có sticky bit); `replace` chỉ thay gói của cùng run. Content digest gồm exporter version.
Schema gói (`HandoverDocumentSchema`, `HandoverManifestSchema`, version 1, exporter version 1) do
Runtime sở hữu, chưa nằm trong `@bflow/contracts` (quyết định hoãn trong tài liệu thiết kế).
Thiết kế và giới hạn: [handover-export-design.md](handover-export-design.md). Bằng chứng: source và
test cục bộ (`test/handover/handover-export.test.ts`, `apps/cli/test/handover-binary.test.ts`), chưa
có live Herdr/provider hay full SDLC acceptance.

## Data contract drift and dbt snapshot checks (DC-01)

The opt-in `DataVerificationHost` library entry point separates directional structural drift
from actual dbt/DuckDB snapshot data-quality execution and ingests host-measured evidence
through ArtifactStore. Contract/specification revision/digest and current approval are pinned;
stale/superseded authority blocks acceptance. Linux Bubblewrap is required; missing tools and
unsupported checks are prerequisite gaps. This does not add daemon/CLI configuration wiring,
execute arbitrary candidate SQL or establish warehouse/live acceptance. See
[adapter inputs, evidence, reproduction and limits](DATA-VERIFICATION.md).

A Coordinator progress report containing questions preserves an existing pending
design approval. Initialization also restores pre-Core design approvals hidden in
preparation phases by older progress reports; it keeps the exact pending request,
evidence and decision authority and never approves or replays transport messages.
Settled/nonpending approvals, terminal runs and cancelled runs are not restored.

Persisted lifecycle reopening may connect to an authenticated live host for
quiesce/checkpoint even when execution inputs changed. Explicit new startup
still validates current sources; it refreshes the inactive host's source snapshot
only after no live owner is detected. Existing accepted run plans stay pinned and
retain their own drift checks. This does not grant execution from a stale plan.

Supervised Linux Developer launches use private zsh startup files to keep their
process-scope wrapper first on PATH. Account `.zshrc` cannot prepend an ordinary
provider binary around the witness bootstrap. Provider HOME/auth and the original
PATH inside the supervised provider remain unchanged; account shell files are not
modified. Missing/invalid supervision witnesses still block dispatch.

### Policy-required manual review in behavioral phases

High-risk policy may require `manual_review` in addition to automated criterion methods.
The host declares this capability through its required native QA review check; it does
not assign a command runner to a judgment. Automated method/command/test mappings still
have to pass proposal ingress validation. Human design approval remains required where
SDD policy requires it and does not constitute implementation or delivery acceptance.

For a successful policy phase (`green`, `refactor`, or recommended-mode `verification`),
Runtime's assigned QA first calls `inspect_alternative_verification` with `runId`, `taskId`
and `phase`. It then submits explicit judgments for every active criterion in
`record_behavioral_verification.review = { observationId, criteria }`. Test execution and
stored evidence remain host-owned. Red requires its actual failing behavioral evidence
and does not manufacture a successful manual judgment.

Inspection binds the current request, implementation attempt, native independent executor
and lineage, lease/fencing token, Spec fingerprint, source revision and phase. Changes to
those bindings require a fresh inspection. Each successful phase stores a new artifact;
Green's review cannot satisfy refactor. Immutable retries retain the same judgment and
verifier identity. Missing/rejected/stale review does not count as accepted evidence.
After submission, failed automatic policy verification escalates to Coordinator through
Conversation instead of sending repair notices to a terminal Developer execution.

This uses existing private observation/receipt storage and adds no public contract or
database migration. Coverage is source plus local Runtime tests; it does not establish live
provider/Herdr reviewer judgment quality, dbt results, or warehouse acceptance.

## Automatic TypeScript verification

With automatic runner detection, an installed repository-local TypeScript compiler
and regular `tsconfig.json` projects provide the `auto:typecheck` planning label.
The host runs a fixed compiler build over the discovered projects in a temporary,
revision-pinned checkout using the existing verification sandbox and read-only
dependency mounts. It does not run a package script supplied by an agent. Compiler
diagnostics fail the check; timeout, truncated output and launcher failures remain
infrastructure errors. Compiler checks supplement mapped behavioral acceptance and
never establish the failing behavioral assertion required for TDD Red.

`auto:static` also parses changed TypeScript files through that compiler, including
test files outside project includes, without executing emitted code. Missing compiler
support and other unsupported source types fail closed. Original execution-definition
pins remain enforced. Successful measurements bind the accepted criterion, revision
and command and receive the same authenticated host receipts as existing checks.
Compiler execution is bounded to five minutes and shares the independent phase's
nine-minute budget with behavioral commands. The planning view reports the compiler
version and project scope. Owner-only behavioral runner configuration retains its
existing behavior; this is not general lint or polyglot typechecker support.

Evidence includes local tests with a real compiler, syntax errors outside project
includes, original-config drift and gate receipt binding. A sandboxed measurement of
this repository also passed; this does not establish full SDLC live acceptance.

Policy-phase inspection keeps the complete committed diff and all unique accepted
requirements inline while removing duplicated strategy fields and prior raw measurement
logs. Prior evidence is referenced by immutable receipt/artifact identity and is still
authenticated in full before accepting a later phase. Large source diffs can still
exceed a provider's output budget; this compaction is not arbitrary diff truncation.

An owner may explicitly resume a released, current conditional-evidence request that
has no measurement or recorded outcome, even when its QA blocker left the run in an
implementing Coordinator continuation. The web action binds the exact pending action
version and follows the existing capability preflight, lease/fence, human-gate and
bounded retry checks. It never reuses an old review verdict or automatically resumes
an active measurement. Ordinary Coordinator continuations remain unchanged.

Owner startup can settle an interrupted web cancellation as failed when its validated host receipt has a dispatch intent but the complete retained Runtime journal proves the cancellation was never enqueued. This runs after receipt replay and before intake, never replays the cancellation, and leaves accepted-only intents, queued/uncertain deliveries, pending Core writes and unverifiable snapshots unresolved. A failed cancellation is not proof that a process stopped; a new owner cancellation still uses normal stop/lease reconciliation.

Ingress refusals of an exactly admitted, superseded Conversation requirement remain diagnostic-only. They cannot pause a newer requirement revision; current and unrecognized envelopes retain the normal bounded failure/escalation path.

Oversized policy-phase QA inspections are served as lossless UTF-8 JSON pages by `inspect_alternative_verification` (`cursor`, `offset`, optional `view: page`). Follow every `nextOffset` with the same run/task/phase and cursor, concatenate pages and parse JSON; the final page supplies `observationId`. Each continuation rechecks the assigned native verifier, active lease/request, phase and clean pinned source. Cursor state is bounded and ephemeral; a stale cursor requires a fresh inspection. The immutable captured observation and verdict/evidence validators are unchanged, and no protected provider directory is exposed.
