# @bflow/git-orchestrator (P18)

Cơ chế tích hợp Git cục bộ cho các task Developer chạy song song. Chỉ phụ thuộc vào
`@bflow/contracts` và Zod; không tự động gọi Workflow scheduler, Herdr, Registry,
quality gate hay provider được host.

## API

```ts
import { GitIntegrationEngine } from "@bflow/git-orchestrator";

const git = await GitIntegrationEngine.open({
  repositoryPath: "/projects/app", // any directory inside a non-bare repository
  artifactStore,                   // contracts ArtifactStore, required
  // provider: configuredGitProvider
});
const repository = await git.inspect(); // root, commonDir, branch|null, head, dirty, status
const task = await git.prepareTask({
  runId: "run-42", taskId: "implement-api", attemptId: "attempt-1",
  developerId: "developer-1", baseRevision: repository.head,
  ownedPaths: ["packages/api"], forbiddenPaths: ["packages/api/secrets"]
});
// Runtime assigns this worktree to that Developer. Developer commits using Git.
// Caller must release the Developer's write access before collect/integrate/cleanup.
const changeSet = await git.collectTask(task.key);
const integration = await git.beginIntegration({
  runId: "run-42", integrationId: "integration-1", baseRevision: repository.head,
  tasks: [{ taskKey: task.key, dependsOn: [] }]
});
// integration.status === "awaiting_verification" does not mean task/workflow success.
// Runtime consumes integration.requests and executes independent workflow verification.
```

Mọi method đều trả về Promise; các mutation bị từ chối vẫn bảo toàn thay đổi và cung cấp một error.
`GitOrchestrationError.code` mô tả các lỗi chính sách; lỗi Git subprocess và lỗi validation của Zod
giữ nguyên thông tin chẩn đoán. Không có method nào của engine commit thay đổi của Developer,
reset checkout, auto-stash, giải quyết conflict, xóa branch, force-push hay merge vào
branch được bảo vệ/main. Việc tích hợp branch dùng một branch `integration/bflow/...` riêng,
kể cả khi `baseRevision` trỏ tới `main`.

| Method | Behavior |
| --- | --- |
| `open({repositoryPath, artifactStore, provider?})` | Tìm repository/thư mục Git chung ở dạng chuẩn tắc; validate/load journal. Yêu cầu có commit SHA-1 ban đầu. |
| `inspect()` | Quan sát root, branch hiện tại (null khi detached), HEAD và porcelain status phân tách bằng NUL mà không thay đổi checkout. |
| `prepareTask(request)` | Lưu intent tạo, tạo/khóa một task worktree duy nhất và branch xác định `agent/bflow/<run>/<task>/<attempt>`; retry các request giống hệt một cách idempotent. Từ chối source bị dirty, va chạm hoặc input bị thay đổi. |
| `taskBranchName(request)` | Trả về cùng tên branch an toàn trước khi tạo; ID rút gọn dễ đọc cộng hậu tố hash giữ nguyên danh tính. |
| `getTask(key)`, `getIntegration(key)` | Đọc một bản sao tách rời của bản ghi đã lưu. |
| `collectTask(taskKey)` | Yêu cầu worktree sạch, các commit tuyến tính mới kế thừa từ base đã ghi nhận, thay đổi ròng và tuân thủ ownership trong **mọi commit**, kể cả các thay đổi sau đó bị revert. Lưu patch thực tế hỗ trợ binary qua ArtifactStore; trả về `GitChangeSet` đã parse, các commit và summary trong metadata. |
| `beginIntegration(request)` | Validate dependency DAG và mọi submission/artifact trước khi tạo integration worktree. Pin các commit của task, rồi merge theo thứ tự topo. Lưu intent và receipt quanh mỗi lần merge. Dùng lại một plan ID với input khác sẽ thất bại. |
| `resumeIntegration(key)` | Đối chiếu các thao tác Git đang chờ với các commit đã pin và merge parent kỳ vọng chính xác. Không có merge/verification request trùng lặp khi restart. Một conflict đã ghi nhận sẽ chờ xác nhận giải quyết tường minh. Trạng thái dirty, bất ngờ hoặc không nhất quán sẽ fail-closed. |
| `acceptConflictResolution(key, {taskKey, resolutionCommitHash})` | Chỉ chấp nhận một merge đã được giải quyết bên ngoài và đã commit khi sạch, khớp task/HEAD đang chờ, có merge parent chính xác và thay đổi nằm trong phạm vi của task đó. Tiếp tục các merge còn lại, rồi yêu cầu verification. |
| `recordVerification(key, result)` | Parse `VerificationResultSchema` được export. Yêu cầu phạm vi workflow, run khớp và `metadata.integrationCommitHash` bằng đúng HEAD của integration. Đọc/checksum toàn bộ evidence và task patch artifact. Kết quả `passed` đánh dấu Git integration là `verified`; các kết quả khác giữ `awaiting_verification`. |
| `cancelTask(key)` | Đánh dấu cancelled, bảo toàn mọi công việc đã commit/chưa commit. Từ chối khi đang bị pin bởi một integration còn sống. |
| `cancelIntegration(key)` | Đánh dấu cancelled; giữ lại mọi merge đang chờ, conflict marker và chỉnh sửa. Việc cancel không bao giờ abort Git. |
| `cleanupTask(key)` | Chỉ xóa task worktree sạch và đã được release sau khi cancel hoặc integration đã verified; từ chối khi có integration đang chờ, file untracked/ignored và thao tác Git đang dở. Giữ lại branch và journal của nó. |
| `cleanupIntegration(key)` | Chỉ xóa integration worktree sạch đã verified/cancelled. Giữ lại branch và receipt của nó. Lặp lại cleanup, kể cả sau khi process chết, là an toàn. |
| `requestPullRequest(key, {remote, baseBranch, title, body})` | Yêu cầu publish tường minh. Yêu cầu provider đã cấu hình, remote/base tồn tại, provider cho phép, workflow verification đạt và evidence đọc được. Push **SHA đã verify và pin** lên branch integration riêng bằng push thường không force, tắt việc tự động publish tag và submodule, rồi tạo/đối chiếu PR. Không bao giờ merge PR. |

`ownedPaths`/`forbiddenPaths` là các file hoặc tiền tố thư mục tương đối theo repo ở dạng literal,
không có cú pháp glob, dấu gạch chéo cuối, `.` hay `..`. Việc so khớp tiền tố tôn trọng ranh giới
thư mục. Rename được biểu diễn bằng xóa cộng thêm để cả hai đường dẫn đều được
kiểm tra (tính năng phát hiện rename của Git bị tắt cho diff; copy được báo cáo là thêm mới). Message yêu cầu workflow verification mang theo `integratedTaskIds` cùng với integration commit. Các đường dẫn tracked được sinh ra/nhạy cảm (`node_modules`, `dist`, `coverage`,
`.git`, `.bflow`, `.env*`, private key, database và build metadata) bị từ chối.
Số dòng của file binary bằng không; phần byte của chúng vẫn nằm trong Git binary patch đã lưu.
Tên file không được hỗ trợ/không phải UTF-8 sẽ thất bại thay vì làm thay đổi ý nghĩa ownership của chúng.
Một task no-op chưa commit không thể tạo ra contract `GitChangeSet` đã đóng băng, vì contract này
yêu cầu ít nhất một changed file và một patch đã lưu.

## Runtime handoff and conflict ownership

`IntegrationRecord.requests` là một outbox bền vững gồm các bản ghi `RoleMessage` được export:

- `task.status` với `reason: "merge_conflict"`, task/commit đến, Developer ID,
  integration worktree, tip trước merge và các đường dẫn conflict; người nhận là Coordinator.
- `verification.requested` với `verificationScope: "workflow"`, integration
  commit chính xác, branch/worktree và các patch reference nguồn; người nhận là Coordinator.

Runtime phải chuyển các message qua Herdr với message/idempotency ID ổn định,
đối chiếu việc chuyển phát của transport, và tạo assignment có lease phù hợp cho
Developer ban đầu hoặc một resolver khác đã được phê duyệt. Engine không bao giờ dispatch một
agent, coi Herdr `done` là thành công hay dùng file artifact để giao tiếp.
Resolver commit merge đang chờ trong **integration** worktree, giữ nguyên
hai parent đã ghi nhận, và Runtime xác nhận commit đó bằng
`acceptConflictResolution`. Không cấp phát worktree đó cho writer khác khi
một resolver đang giữ nó. Các conflict phức tạp hoặc ngoài phạm vi vẫn thuộc về Coordinator
và quyết định của con người; không có fallback ours/theirs hay rebase tự động.

Engine kiểm tra verification receipt được cung cấp và evidence đã lưu của nó.
Việc chấp nhận specification, thực thi độc lập, lease/fencing, trạng thái SDLC/task,
giới hạn số vòng verification và các quyết định hoàn thành task vẫn là trách nhiệm của Runtime/P17.
Trạng thái Git integration là một miền trạng thái cục bộ riêng biệt.

## Persistence, recovery and cleanup

Thư mục Git chung chứa `bflow-git/state.json`, một journal cục bộ có phiên bản,
lock và các worktree được quản lý. Atomic rename, file sync và directory sync bảo toàn
các intent tạo/merge, submission đã pin, receipt, conflict/verification request
và các lần thử PR qua restart process. State hỏng/không được hỗ trợ sẽ bị từ chối.
Không có journal upcaster tự động và không thay đổi contract RunStore dùng chung.

Các thao tác giữa các engine instance dùng `flock` của Linux; một thao tác còn sống trả về
`busy` thay vì xen kẽ một mutation khác. File descriptor của lock file được mọi Git child kế thừa: một Git process mồ côi
tiếp tục loại trừ các mutation mới của engine sau khi process cha chết. Kernel chỉ nhả
lock khi mọi holder đã thoát. Việc tạo branch/worktree đang chờ được đối chiếu với base và
binding đã ghi nhận. Việc khôi phục merge đang chờ kiểm tra `MERGE_HEAD`, trạng thái worktree và merge parent
chính xác; nó nhận ra một merge đã commit trước khi tiến các receipt.
Một tip sạch không đổi cho phép retry cùng merge đã pin. Các merge chưa giải quyết hoặc
chưa commit sẽ yêu cầu đối chiếu tường minh. Các Git lock file còn sót lại
không bao giờ bị xóa tự động. Các thao tác ghi Git/filesystem/ArtifactStore/provider không phải
một transaction nguyên tử duy nhất.

Cleanup kiểm tra Git status, file ignored, binding branch/repository và các thao tác
đang chờ, rồi unlock/xóa worktree mà không dùng `--force`. Cleanup bị gián đoạn
có thể được lặp lại. Các index flag `assume-unchanged` và `skip-worktree` có thể che
các chỉnh sửa cục bộ của file tracked khỏi Git status và việc xóa Git worktree. Các thao tác yêu cầu
cây sạch sẽ từ chối các flag này với `unsupported_index_flags`; hãy kiểm tra các file
và xóa flag một cách tường minh trước khi thử lại. Sparse checkout dùng
`skip-worktree` hiện chưa được hỗ trợ. Engine không bao giờ tự động xóa các flag này
hay loại bỏ các chỉnh sửa bị ẩn. Việc xóa branch là quyết định riêng của owner và cố ý
không có trong API này. Cancel không đồng nghĩa đủ điều kiện cleanup khi vẫn còn dữ liệu
hoặc một thao tác Git đang chờ.

## Provider adapter

Triển khai interface `GitProvider` được export và inject nó tại `open`:

```ts
interface GitProvider {
  checkAccess(request: ProviderRequest): Promise<boolean>;
  find(request: ProviderRequest): Promise<{ url: string } | null>;
  create(request: ProviderRequest): Promise<{ url: string }>;
}
```

`ProviderRequest` gồm remote URL, head branch, SHA đã verify chính xác, base branch,
title/body và `idempotencyKey` ổn định. Adapter phải verify danh tính repository,
quyền truy cập remote và head SHA; `create` phải idempotent bền vững. `find`
đối chiếu một response bị mất sau khi server đã tạo. Không trả về `null` khi
việc kiểm tra quyền truy cập hoặc tra cứu chưa kết luận được. Việc chuyển phát mơ hồ giữ `pending` trong
journal và có thể được tiếp tục với đúng request y hệt. Việc thay đổi target hoặc nội dung của
PR đang pending/đã tạo sẽ bị từ chối. Cần đúng một push URL cho remote được chọn.
Không đi kèm credential của hosted provider nào. Test dùng một bare remote cục bộ và provider được inject;
truy cập GitHub/GitLab thật **chưa được verify**.

## Validation and integration notes

Yêu cầu Linux, filesystem cục bộ, `git`, `flock`, Node >=22.13 và pnpm đã pin.
Các override repository/index `GIT_*` được kế thừa sẽ bị loại bỏ; Git chạy với
argument literal, không shell, không có prompt credential tương tác, hook, signing, rerere,
autostash, external diff hay textconv. Các lệnh có giới hạn output 60 giây/64 MiB.
Timeout/lỗi để lại intent bền vững để đối chiếu. Engine không tuyên bố đảm bảo
network-filesystem, multi-host, hostile same-user hay power-loss.

Từ thư mục gốc repository:

```sh
pnpm --filter @bflow/git-orchestrator build
pnpm --filter @bflow/artifact-store exec tsc -b
pnpm --filter @bflow/git-orchestrator test
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
```

Test dùng repository tạm thật và ArtifactStore filesystem thật,
bao gồm task độc lập, merge thành công/conflict, trạng thái dirty, thiếu
commit/artifact, branch trùng, kiểm tra ownership/history, cancel,
cleanup, publish/đối chiếu provider, và SIGKILL trước/trong/sau một merge, kể cả Git process mồ côi giữ lock.
Test crash subprocess import `dist`; hãy build cả hai package trước và sau mỗi lần chỉnh sửa.

Các contract dùng chung đã đóng băng không có port cho Git orchestration. Package này export
các API cấu hình/journal cục bộ đã validate, trong khi mọi evidence SDLC được trao đổi,
thao tác artifact, kết quả verification và role message đều dùng contract.
Integration owner phải review mọi Git port dùng chung trong tương lai cùng với kế hoạch tương thích của nó;
triển khai này không sửa contract hay API scheduler. Root
TypeScript reference và lockfile importer có bao gồm package này, nên các lệnh
build và test ở root cũng bao phủ P18. Việc compose Runtime vẫn là công việc của P19.
