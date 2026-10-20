# @bflow/verification

Verification độc lập, có giới hạn cho các contract Bflow v2 đã đóng băng. Package dựng một verification plan từ một `Specification` đã phê duyệt, một `TestStrategy` khớp và các quality check tường minh. Nó đánh giá evidence đối với mọi acceptance criterion và trả về các giá trị `VerificationResult` và `VerificationCycle` đã được contract xác thực. Việc Developer tự đánh giá hay tín hiệu `done` của Herdr không thể chứng minh thành công.

## API

```ts
import {
  createVerificationPlan,
  VerificationEngine,
} from "@bflow/verification";

const plan = createVerificationPlan({
  runId,
  taskId,
  scope: "task",
  specification,
  strategy,
  checks,
  implementerIds: [developerId],
  maxIterations: 3,
});

const engine = new VerificationEngine({
  artifactStore,
  gates,
  loadSpecification,
});
const cycle = engine.start(plan, cycleId);
const outcome = await engine.verify(plan, cycle, changeSet);
// outcome.result: VerificationResult; outcome.cycle: VerificationCycle
```

Outcome cũng chứa các giá trị `RoleMessage` đã xác thực cho `verification.result` và, khi cần, `verification.escalation`; Runtime chịu trách nhiệm gửi chúng.

Constructor nhận các contract port `artifactStore` và `gates`, một callback của host `loadSpecification`, và một callback `clock` tùy chọn. Host cung cấp các triển khai thực tế; package không phụ thuộc vào các package triển khai ngang hàng. Việc dựng plan từ chối specification chưa phê duyệt hoặc không nhất quán, strategy/TDD decision mâu thuẫn, đường dẫn không an toàn, ánh xạ criterion chưa đầy đủ, thiếu target command hoặc test level, và các plan không có check Reviewer hoặc QA độc lập. P16 có thể append các receipt `metadata.tddEvidence` hợp lệ theo contract mà không thay đổi approved strategy policy; mọi tiền tố receipt đã phê duyệt được giữ lại và receipt phải khớp run/task của strategy. Toàn bộ dossier được đóng băng vào plan, trong khi P19 vẫn chịu trách nhiệm xác thực trình tự P16. Số iteration tối đa cấu hình được từ 1 đến 10 và mặc định là 3.

`VerificationPlan`, `CheckConfigurationSchema` và `ObservationSchema` là các codec cục bộ của package. Chúng không sửa đổi shared contract hay đưa vào biến thể thông điệp Herdr mới.

## Check và evidence

Mỗi `QualityGateDefinition.configuration` bắt buộc phải parse được bằng `CheckConfigurationSchema`:

| Field | Ý nghĩa |
| --- | --- |
| `kind` | `deterministic` hoặc `review` |
| `method` | Phương pháp xác minh acceptance criterion |
| `command` | Bắt buộc với deterministic check; xác định command binding do host phê duyệt |
| `criterionIds` | Các criterion tường minh được check này đánh giá |
| `testNames` | Tên test tương ứng với ánh xạ criterion của strategy |
| `role` | `quality_gate`, `tester`, `reviewer` hoặc `qa`; review yêu cầu Reviewer hoặc QA |
| `levels` | Các test level được bao phủ từ test strategy |
| `measuresCoverage` | Phép đo aggregate coverage tùy chọn; bắt buộc trên deterministic check khi strategy có ngưỡng coverage |
| `dependsOnPaths` | Khai báo impact đầy đủ tùy chọn dùng các đường dẫn repository literal an toàn |

Engine gọi `QualityGate` port được cung cấp với các giá trị `QualityGateContext` đã xác thực. Một gate phải trả về `QualityGateResult` hợp lệ theo contract với `metadata.verification` khớp `ObservationSchema`. Observation gắn evidence với check, run, task, attempt, Git revision, specification fingerprint và verification scope. Nó khai báo việc thực thi độc lập, cô lập, xác định executor và role, đồng thời cung cấp kết quả theo criterion, tên test, tóm tắt, và command/exit status xác định khi áp dụng. Evidence gate mới phải có timestamp nằm trong cửa sổ thực thi check hiện tại theo đồng hồ của host. Executor phải khác với mọi implementer được liệt kê. Review pass không thể ghi đè một deterministic check thất bại. Một phép đo coverage đã cấu hình phải báo cáo `coveragePercent`; thiếu phép đo thì inconclusive và giá trị dưới ngưỡng strategy đã chấp nhận thì verification thất bại.

Output artifact của gate là proposal. Trusted reference chỉ xuất phát từ `ArtifactStore`; engine lưu các verification audit report của nó qua port đó và xác thực nội dung/checksum của artifact. Khi gate tạo proposal, host cung cấp `readProposal(proposal)` để mở byte đã materialize của chúng. Engine ingest chúng qua ArtifactStore, xác minh tính toàn vẹn và đưa các reference đã lưu vào kết quả. Proposal không có byte đã materialize sẽ ngăn việc chấp nhận. Mỗi criterion chỉ pass khi mọi check đã lập kế hoạch được ánh xạ tới nó có evidence pass hợp lệ. Outcome của nó trỏ tới một evidence artifact, kèm giải thích tường minh khi bất kỳ evidence check nào bị thiếu. Các check thất bại cũng phát ra chi tiết task, role, check, criterion và evidence ngay cả khi gate không cung cấp finding. Một report ghi nhận evidence không đủ chứng minh verification là inconclusive; nó không chứng minh requirement đã pass.

Criterion được waive sẽ pass kèm lý do waiver, và criterion tùy chọn (`required: false`) thất bại được báo cáo như cảnh báo thay vì lỗi chặn; thất bại của criterion bắt buộc vẫn là lỗi. Workflow audit report và result ghi lại `integrationCommitHash` và `integratedTaskIds` khi có cung cấp provenance tích hợp.

Specification được tải trước và sau verification. Specification thay đổi, xung đột requirement chưa giải quyết, dependency không khả dụng, observation không hợp lệ hoặc evidence không đủ sẽ ngăn kết quả pass. Verification không bao giờ sửa specification hay sửa source code.

## Outcome và rework

| Kết quả | Hành vi của cycle |
| --- | --- |
| `passed` | Hoàn tất cycle chỉ sau khi mọi check và criterion bắt buộc pass |
| `failed` | Yêu cầu rework có phạm vi khi còn iteration; escalate khi đạt giới hạn |
| `inconclusive` | Escalate ngay vì evidence không thể xác lập kết luận |
| `blocked` | Escalate ngay vì verification không thể tiếp tục |

Xung đột specification/scope trả về `escalated`, như contract v2 hiện có cho phép. Ngoài ra, escalation giữ nguyên trạng thái kết quả bên dưới và ghi nhận escalation trên cycle. Nó không biến thất bại thành thành công. Một cycle failed chỉ có thể được verify lại với một repair record xác định `taskId`, `role: "developer"` chịu trách nhiệm, `changeSetId` và `summary`, cùng một attempt, change-set ID và Git head chưa được dùng ở bất kỳ đâu trước đó trong cycle. Cung cấp repair record qua `verify(..., { repair })`. Mỗi lần verification hoàn tất sẽ append một result có cấu trúc vào lịch sử cycle được trả về. Finding giữ trách nhiệm task/role để Coordinator định tuyến; một bản sửa ngoài phạm vi đã chấp nhận cần một task được ủy quyền riêng.

Task check chỉ có thể tái sử dụng evidence check thành công trước đó khi host cung cấp khai báo `dependsOnPaths` đầy đủ, gate audit trước đó hợp lệ, và Git diff tuyến tính bắt đầu từ head đã xác minh trước đó và không ảnh hưởng đến đường dẫn nào trong số đó. Việc tái sử dụng ghi lại lý do. Review exit khác 0 và coverage dưới ngưỡng ngăn tái sử dụng ngay cả khi bản thân gate báo `passed`. Đường dẫn dependency (`dependsOnPaths`) là các tiền tố repository literal; biểu thức glob `*` và `?` bị từ chối ở đó, trong khi `affectedPaths` của specification dùng cho kiểm tra scope có thể là đường dẫn repository an toàn hoặc glob (`*`, `**`, `?`). Thiếu khai báo impact khiến các check chạy lại.

Workflow plan yêu cầu bao phủ integration, regression hoặc E2E. Sau Git integration, gọi verification với `scope: "workflow"` và `verify(..., { integration })`, cung cấp `{ headCommitHash, integratedTaskIds }` khớp head hiện tại. `GitChangeSet.taskId` của workflow xác định task verification của nó; danh sách task đã tích hợp là provenance riêng, phải chứa mọi task được liệt kê trong traceability của specification đã phê duyệt, và được chuyển tiếp tới runner độc lập. Workflow check chạy lại trên revision đã tích hợp; kết quả task không bao giờ thay thế verification này.

## Trách nhiệm của host và hạn chế

Gate runner được cung cấp phải ánh xạ các command đã cấu hình tới capability do host phê duyệt và việc thực thi check cô lập. Package này không cung cấp shell runner và không tự động thực thi chuỗi command tùy ý. Xác thực schema và executor ID khác nhau không thể xác thực một tiến trình OS hay chứng minh sự cô lập vật lý. Host phải thiết lập danh tính reviewer, việc thực thi độc lập, Git snapshot/diff thực tế và provenance của artifact.

Runtime vẫn chịu trách nhiệm về lease/fencing, capability an toàn, dispatch, trạng thái bền vững và khôi phục sau crash, cancellation và xử lý approval. Lưu cycle và evidence được trả về trước khi dispatch các bản sửa. Runtime phải cung cấp cycle có thẩm quyền mới nhất và thực thi optimistic version/quyền sở hữu single-writer: một engine không trạng thái không thể phân biệt snapshot xác thực cũ hơn với trạng thái mới nhất. So sánh receipt đã lưu từ chối các chỉnh sửa lên lịch sử được cung cấp; chúng không ngăn replay một snapshot xác thực cũ hơn. Một exception trong lúc lưu trữ để lại durable intent cho Runtime đối soát và không được kích hoạt redispatch tự động. Engine không dispatch agent Developer, Reviewer hay QA, không thay đổi Git, không merge branch và không gửi thông điệp escalation. Coordinator yêu cầu các hành động đó độc quyền qua Workflow Runtime bằng các biến thể `RoleMessage` hiện có đã xác thực.

Package không có xác minh E2E Herdr thật và không triển khai tích hợp Runtime P19. Unit test với fake runner xác minh policy của engine; chúng không thể xác lập việc thực thi command thật, các agent độc lập đã xác thực hay tính đúng đắn của hệ thống tích hợp. Package đã review được đăng ký trong TypeScript reference gốc và workspace lockfile. Build/typecheck gốc bao gồm P17; việc đăng ký này không kết hợp nó vào Runtime.

## Xác thực

Từ thư mục gốc repository, khi các workspace dependency đã sẵn sàng:

```sh
pnpm --filter @bflow/verification test
```

Lệnh này build package trước các unit test của nó. Bàn giao repository cũng yêu cầu `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, `git diff --check` và `git status --short`. Ghi lại kết quả thực tế và commit đã kiểm thử vào evidence bàn giao; không diễn giải một lần chạy test của package là tích hợp hay đóng remote.
