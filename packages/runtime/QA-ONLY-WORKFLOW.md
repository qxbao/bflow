# Workflow chỉ kiểm thử (QA-only)

Module `packages/runtime/src/qa/**` chạy một workflow kiểm thử hệ thống có sẵn **mà không sửa sản phẩm đích**. Đây là
**extension của Runtime**, không phải engine thực thi riêng. Nó tái sử dụng:

- Core `DeterministicWorkflowEngine`: DAG, chuyển trạng thái hợp lệ, gate, retry có giới hạn và approval.
- `RunStore` (SQLite): event có thẩm quyền, khôi phục bằng replay.
- `ArtifactStore`: thiết kế test, kết quả kiểm tra, evidence từng case, phân xử và báo cáo, tất cả có checksum.
- `@bflow/test-strategy`: quyết định Conditional TDD.
- `AppCheckBrowserLeases`: lease host-local, có fencing token đơn điệu.
- Contract `ResolvedToolGrant`: kiểm tra grant theo phiên.

Không thay đổi `@bflow/contracts`, cấu hình root hay lockfile. Giống BA-only, `AgenticWorkflowRuntime` bắt buộc có Developer
task và Git integration, nên QA-only là luồng tương thích riêng; nó không tạo patch giả hay task implementation giả.

## Intake

`QaIntakeSchema` khai báo:

| Trường | Ý nghĩa |
| --- | --- |
| `target.environmentId`, `target.kind` | `fixture` (môi trường cô lập), `non_production` hoặc `production` |
| `target.origins` | Origin chính xác được duyệt (`scheme://host[:port]`); origin đầu tiên là origin chính |
| `target.readinessPath`, `target.buildIdentity` | Kiểm tra readiness và nguồn build identity (endpoint + JSON pointer, hoặc header) |
| `criteria` | Tiêu chí nghiệm thu của sản phẩm cần kiểm thử |
| `allowedActions` | `http_read`, `http_mutate`, `browser_navigate`, `browser_interact` |
| `accountPolicy.accounts` | Tài khoản `isolated_fixture` hoặc `shared_readonly` |
| `dataPolicy` | `fixturePrefix` đánh dấu dữ liệu do test tạo ra; key/header cần che |
| `cleanup.required` | Case có side effect bắt buộc phải có cleanup |
| `workspace.assetRoot` | Nơi duy nhất được ghi test asset và báo cáo |
| `protectedPaths` | Source/deploy/config của sản phẩm; không bao giờ được ghi, digest được kiểm trước/sau |

Intake bị từ chối khi:

- target `production` cho phép hành động mutating;
- workspace chồng lên path được bảo vệ;
- origin có path;
- ID trùng.

Target không phải `fixture` cần quyền truy cập do **người được xác thực** cấp (`start({ access: { decidedBy } })`). Thiếu
quyền thì không có gì được lập kế hoạch hay truy cập.

## DAG

`planQaWorkflow` lập DAG mặc định. Nếu Coordinator tự đề xuất DAG, `assertQaOnlyWorkflow` kiểm tra lại:

| Task | Role | Gate / điểm người duyệt |
| --- | --- | --- |
| `design` | tester/qa | `qa-design-verification` (retry có giới hạn, trả findings cho designer) |
| `design-review` | reviewer/qa | `qa-independent-review` + **người duyệt đúng digest thiết kế** trước mọi side effect |
| `execution` | coordinator (Runtime thực thi) | `qa-execution-integrity` |
| `adjudication` | qa/reviewer | `qa-adjudication` (retry có giới hạn) |
| `report` | coordinator (Runtime thực thi) | `qa-report-integrity` |

DAG đề xuất bị từ chối khi có:

- role/kind khác bảng trên, chẳng hạn developer, fix, deploy hay install;
- metadata `ownedPaths`/`commands`/`worktree`/`patch`;
- gate do agent tự định nghĩa;
- thiếu stage hoặc sai thứ tự.

Gate, retry bound và approval luôn do Runtime đặt lại.

## Kiểm tra thiết kế test (`verifyQaDesign`)

- **Coverage**: mọi criterion bắt buộc có case; bảng coverage khớp với `criterionIds` của case.
- **Scope**: mọi bước (kể cả cleanup và probe đối soát) dùng hành động được phép và origin được duyệt. Placeholder
  `${var}` không được chọn origin.
- **Side effect**:
  - authority suy ra từ HTTP method, không từ khai báo;
  - case mutating phải khai báo `sideEffect: mutating`;
  - dùng tài khoản `isolated_fixture` (trừ khi cả target là `fixture`);
  - dữ liệu tạo ra mang `${fixturePrefix}`;
  - có cleanup khi intake yêu cầu.
- **Recovery**: probe `reconcile` phải chỉ đọc; mọi biến được dùng đều đã được capture.
- **Credential**: step không được nhúng header credential (`authorization`, `cookie`, `x-api-key`, …), vì test asset
  được ghi vào repository. Credential chỉ đến từ `QaAccountPort` lúc thực thi (`credential_in_design`).

Review độc lập yêu cầu reviewer khác danh tính với tác giả, verdict ghim đúng digest hiện tại, `approved`, không có
finding blocking, và thiết kế vẫn qua kiểm tra. Sai thì run chuyển `needs_revision`.

## Thực thi (Runtime)

Thứ tự trong một transaction:

1. Ghi test asset: thiết kế đã duyệt, ghim digest và approval. File là `<assetRoot>/<requestId>/r<rev>/tests/cases.json`,
   ghi trước mọi truy cập target. Path symlink, ngoài repository hoặc trong path được bảo vệ bị từ chối. File có sẵn
   không bị ghi đè, trừ khi nội dung y hệt.
2. Lấy digest các path được bảo vệ.
3. Chuyển mutation còn ở `intent` (do crash) thành `uncertain`; không gửi lại.
4. Lấy lease `qa-target-<environmentId>` cho holder `qa:<runId>`.
   - Lease **bận**: run chuyển `blocked` (`lease_busy:<key>:<holder>:<expiresAt>`), chưa có side effect nào. `drive` lại
     sau khi lease được trả.
   - Sau restart: dùng lại lease đã journal nếu vẫn còn hiệu lực.
5. Kiểm tra readiness và build identity. Nếu chính probe readiness không chạy được (tool HTTP chưa wiring hoặc thiếu grant
   `http_read`), các case là `blocked` với mã prerequisite gap, không phải `environment_failure`. Build không quan sát được thì ghi `status: unknown` kèm giới hạn
   "results are not attributed to any source revision". **Không bao giờ dùng Git HEAD của repository thay cho build.**
6. Chạy từng case, theo các quy tắc sau:
   - **Prerequisite gap**: tool chưa wiring (`tool_not_wired:<tool>`), thiếu grant cho role `qa`/tool/operation trong
     đúng phiên và workspace (`grant_unavailable:<tool>:<action>`), hành động không được phép, hoặc thiếu port tài khoản.
     Case bị `blocked`, không bypass.
   - **Fence**: `assertCurrent(lease)` ngay trước mọi request. Lease hết hạn hoặc mất giữa transaction thì không lấy lại
     ngầm. Các hành động sau đó và các case còn lại bị `blocked` (`lease_expired`/`lease_lost`); cleanup không chạy được
     sẽ thành dữ liệu còn sót.
   - **Mutation**: HTTP mutating method và tương tác browser (`click`/`fill`) đều ghi intent (request digest, leaseId,
     fencing token) vào journal **trước** khi thực hiện. Kết quả là `applied`/`rejected`/`not_delivered`, hoặc `uncertain`
     khi timeout hay mất kết nối. Placeholder `${var}` được thay ở URL, body, header, selector, text và value.
   - **Uncertain**: không bao giờ replay. Runtime chạy probe `reconcile` chỉ đọc để xác định `applied`/`not_applied`/`unknown`;
     probe có thể capture ID để cleanup. Case thành `inconclusive` (`mutation_uncertain`).
   - **Redirect**: chỉ theo redirect cùng origin được duyệt, tối đa 3 lần, và chỉ với request đọc. Redirect sang origin
     khác bị chặn (`origin_redirect_denied`) và ghi denial.
   - **Cleanup**: chạy dưới cùng lease với cùng fencing. Thất bại thì ghi `residualData`. Cleanup không xoá bản ghi của
     mutation không chắc chắn.
   - **Sau restart giữa một case**: nếu case chưa có mutation, case chạy lại (đọc lại là an toàn). Nếu đã có mutation,
     case không chạy lại: Runtime chỉ đối soát và cleanup.
7. Trả lease, lấy lại digest các path được bảo vệ (`productUnchanged`), lưu evidence thực thi kèm digest.

Gate `qa-execution-integrity` thất bại khi:

- case thiếu outcome;
- còn mutation ở trạng thái `intent`;
- test asset bị đổi;
- **path sản phẩm bị thay đổi** (`product_changed`). Khi đó không có báo cáo nào được publish.

## Phân loại và phân xử

Runtime quan sát `passed`, `assertion_failed`, `environment_failure` (app unavailable/không ready), `blocked` và
`inconclusive`. Role phân xử (độc lập với tác giả test, ghim digest thực thi):

- chỉ được chọn `product_failure` hoặc `test_defect` cho `assertion_failed`, kèm lý do;
- không được đổi các kết quả Runtime đã quan sát (`classification_override`, retry có giới hạn).

Kết luận run:

- `product_failures_found`;
- `passed`;
- `environment_failure`;
- `blocked`;
- `test_defects_found`;
- `inconclusive`.

## Báo cáo

Runtime ghi `<assetRoot>/<requestId>/r<rev>/report.md`. Nội dung xác định (deterministic), nên publish lại sau restart
cho ra cùng bytes. Báo cáo gồm:

- phạm vi: origin, hành động, path được bảo vệ, quyền truy cập, lease/fencing;
- môi trường và build identity, hoặc giới hạn khi không xác định được build;
- tác giả/reviewer/người duyệt thiết kế và người phân xử;
- bảng phân loại theo case;
- mỗi bug: criterion, expected/actual, các bước tái hiện, môi trường/build, artifact evidence đã làm sạch,
  `fixAuthority: none`;
- danh sách `test_defect`, mutation không chắc chắn, dữ liệu còn sót và giới hạn.

Evidence được làm sạch:

- header credential (authorization, cookie, set-cookie, …) và key nhạy cảm (`token`, `password`, … cùng
  `dataPolicy.redactKeys`) bị che;
- mọi giá trị bí mật đã thấy (credential tài khoản, field bị che) bị xoá khỏi text;
- biến capture chỉ nằm trong journal private, không có trong status hay evidence.

**Phát hiện bug không cấp quyền sửa.** Workflow không bao giờ đòi product patch để hoàn thành. Muốn sửa bug thì cần
intake/specification riêng.

## Conditional TDD

Workflow chỉ ghi test asset (`tests/cases.json`). Sản phẩm đã deploy là đối tượng kiểm thử, nên không có pha Red có
nghĩa: `TestStrategyResolver` trả về `not_applicable`. Alternative verification bắt buộc là `manual_review`: review thiết
kế độc lập cộng phân xử kết quả độc lập. Evidence được ghi lúc publish báo cáo. `sourceRevision` ghi
`build:<identity>` hoặc `build:unknown`, không bao giờ là một Git revision.

## Recovery

- Core event được append vào RunStore sau mỗi mutation; restart dựng lại aggregate bằng replay.
- Execution của role đã bind nhưng chưa có kết quả thì không gửi lại. Runtime gọi `roles.reconcile`; nếu `unknown` thì run
  `blocked` với `unknown_delivery:<executionId>`.
- Task Runtime (`execution`, `report`) tiếp tục idempotent từ journal: bỏ qua case đã xong, intent thành uncertain,
  artifact được định danh theo nội dung.

## Cách dùng

```ts
import { QaWorkflowRuntime, createHttpQaTool } from "@bflow/runtime";
const runtime = await QaWorkflowRuntime.open({ engine, runStore, artifactStore, roles, repositoryRoot, journalPath,
  authorizeHuman, now: () => new Date().toISOString(), tools: { http: createHttpQaTool() }, grants, leases, accounts });
await runtime.start({ runId, intake });              // target không phải fixture: thêm access: { decidedBy: "user:<id>" }
await runtime.drive(runId);                          // dừng ở awaiting_design_approval
await runtime.decideDesign(runId, { decision: "approved", designDigest, decidedBy: "user:<id>" }); // thực thi → báo cáo
```

## Tích hợp còn lại (đề xuất, cần owner duyệt)

1. Host MCP tool cho Coordinator: `propose_qa_workflow` gọi `start`. `QaRolePort` giao việc qua Runtime → Herdr
   `RoleMessage`; `reconcile` dùng execution binding/receipt hiện có.
2. Conversation route `decideDesign` và quyền truy cập target qua `request_user_decision`; `authorizeHuman` dùng cơ chế
   xác thực human decision của host.
3. `grants` lấy từ `platform.toolGrants` (D-TOOLS-01) với requirement `qa-http`/`qa-browser` cho role `qa`.
   `QaBrowserTool` cần bind vào Gateway browser MCP (`chrome-devtools-mcp`) trong `BrowserResourceTransactions`. Hiện
   chưa có adapter thật, nên mọi case browser là prerequisite gap.
4. `QaAccountPort` lấy credential tài khoản fixture từ secret store của host. Lease directory và journal nằm trong private
   runtime state.
5. Lệnh CLI/`bflow up` không yêu cầu Developer/Git integration cho workflow này. Đây là thay đổi P29/P30, không phải
   contract.

## Giới hạn

- Mức bằng chứng: source cộng test local (`test/qa/qa-workflow.test.ts`) với Core/RunStore/ArtifactStore thật, một app
  fixture HTTP thật chạy ở process riêng (`test/fixtures/qa-app/server.mjs`, có bug cố ý), tool HTTP thật (Node fetch) và
  role giả lập xác định. Chưa nối host/Herdr/Conversation/CLI, chưa có live provider acceptance, chưa có browser adapter
  thật.
- Lease là host-local same-UID (file lock), không phải lock phân tán. Lease chỉ được gia hạn giữa các case, nên một case
  dài hơn TTL sẽ bị fence chặn giữa chừng (an toàn nhưng có thể cần TTL lớn hơn).
- Readiness và build identity chỉ được probe một lần mỗi run. Thay đổi deploy giữa run không bị phát hiện.
- Phân loại `product_failure`/`test_defect` là phán đoán của role. Gate chỉ kiểm tra tính nhất quán và độc lập, không
  chứng minh phán đoán đúng.
- Làm sạch evidence dựa trên tên key/header và giá trị bí mật đã biết. PII trong text tự do không có key nhạy cảm vẫn
  có thể lọt qua.
- Chưa có `revise`: thiết kế bị yêu cầu sửa (`needs_revision`) cần một run mới.
- Journal là file JSON ghi nguyên tử, một writer, chưa có lock giữa nhiều process.
