# Conditional TDD policy engine (P16)

`@bflow/test-strategy` phân giải TDD policy dựa trên rủi ro mà không thực thi test,
không sửa source, không quản lý workflow và không chấp nhận task. Workspace dependency
duy nhất của nó là `@bflow/contracts`.

```ts
import {
  TestStrategyResolver, recordEvidence,
  assertReadyToImplement, assertEvidenceComplete
} from "@bflow/test-strategy";

const resolver = new TestStrategyResolver();
let strategy = resolver.resolve(specification);
resolver.validateAgainstSpecification(strategy, specification);
// For required TDD: obtain an independent Red VerificationResult first.
strategy = recordEvidence(strategy, redResult);
assertReadyToImplement(strategy);
// Runtime allows implementation; independent verification supplies later phases.
strategy = recordEvidence(strategy, greenResult);
strategy = recordEvidence(strategy, refactorResult);
assertEvidenceComplete(strategy);
// Persist the returned TestStrategy using existing Runtime persistence ports.
```

Với `recommended`/`not_applicable`, ghi một `VerificationResult` aggregate thành công
với phase `verification`, rồi assert hoàn tất. Recommended TDD có thể được thực hành
tự nguyện; một alternative verification receipt vẫn là nội dung nộp bắt buộc của nó.
Các phase API xác thực một policy dossier, không phải việc chấp nhận task.

## Ranh giới contract và input

`resolve(unknown)` parse `SpecificationSchema`, yêu cầu `runId` và ít nhất một
acceptance criterion bắt buộc, rồi parse `metadata.conditionalTdd` bằng
`AssessmentSchema` được export. Metadata khác, kể cả `metadata.sdd` của P15, có thể
cùng tồn tại. Xem [ví dụ input đầy đủ](examples/domain-logic.spec.json).

Payload metadata riêng tư, có phiên bản cung cấp cả bảy input của assessment:

| Input | Nguồn |
| --- | --- |
| Task type | `taskType`, `taskId` |
| Acceptance criteria | Contract `Specification.acceptanceCriteria` |
| Change impact | `changeImpact.surfaces`, các cờ behavior/determinism/regression, security/data impact và scope; `Specification.affectedPaths` |
| Existing infrastructure | `infrastructure.readiness` và các cặp method/command thực tế |
| Testability | `testability.level` và rationale cụ thể (tối thiểu 10 ký tự) |
| Risk | Giá trị lớn nhất của assessment/spec risk đã khai báo và các tín hiệu security/migration |
| Project conventions | `conventions.tdd`, các method bắt buộc và test level đề xuất |

Task/impact surface bao gồm domain logic, bug, contract, validation, transformation,
state machine, integration, refactoring, layout, infrastructure, configuration,
documentation, formatting và exploration. Nhiều impact surface được ưu tiên hơn một
task label vô hại. Behavioral criterion và các đường dẫn không phải tài liệu cũng
mâu thuẫn với khẳng định chỉ-tài-liệu. Đây là assessment có cấu trúc, không phải
semantic diff classifier: P19/P17 phải so sánh assessment với các thay đổi thực tế.

Policy có thể được phân giải trước khi phê duyệt specification. Runtime phải tách biệt
thực thi các specification và approval đã chấp nhận trước khi implementation. Một
full SDD specification đã cần strategy/decision theo yêu cầu contract; hãy phân giải
một lightweight planning specification trước, rồi soạn tài liệu full qua P15. Package
này không làm yếu các invariant full-SDD của contract.

## Policy và output

Giá trị trả về là `TestStrategy` contract hiện có, nhúng một `TddDecision` contract.
Không thêm shared schema, port, migration hay public wire shape mới.

| Mode | Assessment điển hình | Verification bắt buộc |
| --- | --- | --- |
| `required` | Logic lặp lại được, regression, hành vi API/validation/transformation/workflow; hành vi rủi ro cao khả thi hoặc project convention bắt buộc | Red dẫn xuất từ spec, test không đổi Green, chạy lại thành công sau refactor, mọi method đã chọn |
| `recommended` | Integration/refactoring/exploration; hành vi có infrastructure/testability chưa đầy đủ | Alternative check độc lập thành công; nghĩa vụ provisioning tường minh cho các command còn thiếu |
| `not_applicable` | Thuần documentation, formatting, layout, wiring hoặc configuration đơn giản không có behavioral target | Evidence phù hợp dạng manual, visual, lint, schema, smoke hoặc integration |

Đây là các mặc định theo ngữ cảnh. Hành vi hỗn hợp có thể yêu cầu TDD bất kể label.
Infrastructure chưa đầy đủ ngăn việc giả vờ rằng có phase Red chạy được. Mỗi behavioral
method được chọn phải có command đã cấu hình trước khi TDD có thể được yêu cầu. Các
regression check hiện có cho thay đổi formatting/documentation không có hành vi vẫn
bắt buộc mà không tạo ra target failing-test-first. Công việc characterization chỉ
thay đổi các đường dẫn thuộc tệp test (`*.test.*`, `*.spec.*`, `test/`, `tests/`,
`__tests__/`, `__fixtures__/`), không có logic, bug fix hay regression surface, được
phân giải thành `not_applicable` và cần ghi nhận thành công rằng các test chạy qua trên
code hiện tại. Characterization của domain logic (vẫn chỉ thay đổi tệp test, không có
regression) được phân giải thành `recommended` với cùng loại evidence, để phase Red bất
khả thi không chặn công việc. Tái hiện regression vẫn giữ mode `required`; nếu có bất kỳ
đường dẫn production nào thì áp dụng policy thông thường. Domain logic và bug fix không
bao giờ được phân giải thành `not_applicable` (contract cũng từ chối mode này nếu không
có `humanOverrideApproved`); resolver không tự tạo ra hoặc chấp nhận một cờ human override
chưa được xác minh. Rủi ro cao bổ sung static analysis và review, cùng integration check
cho công việc có hành vi. Command còn thiếu được nêu thành điều kiện provisioning, không
bị bịa ra hay âm thầm miễn trừ.

Đọc `mode`/`rationale` từ `tddDecision`; đọc các method bắt buộc, test level đề xuất
và evidence requirement từ `metadata.conditionalTdd`. `requiredTestLevels` của contract
biểu diễn các level của method đã chọn; các đề xuất project bổ sung và đề xuất
regression/property nằm trong `suggestedTestLevels`. Các acceptance method bắt buộc
và project check được giữ nguyên. Mọi criterion nhận tên ổn định dẫn xuất từ spec;
criterion được waive không âm thầm loại bỏ nghĩa vụ verification.

`validate` đánh giá lại policy dựa trên assessment đã lưu, từ chối việc hạ cấp mode,
rationale, method, command và mapping. `validateAgainstSpecification` còn ràng buộc
nó với một specification có thẩm quyền. Dùng cái sau tại ingress tích hợp: tự nhất
quán đơn thuần không thể xác thực một assessment.
`validateAgainstSpecification(strategy, specification, decision?)` cũng nhận một
`TddDecision` tùy chọn và từ chối nếu `decisionId` hoặc `mode` của nó khác của strategy.
Các verification method theo enum `verificationMethod` của contract `AcceptanceCriterion`
(`smoke_test`, `visual_review`, `snapshot_test` và `schema_validation` không còn là
các method riêng; thay đổi configuration và infrastructure dùng
`typecheck`/`static_analysis`/`integration_test`, và UI layout dùng `manual_review`).
Các ánh xạ tên test theo criterion hợp lệ sẵn có trên một specification được giữ nguyên;
nếu không, ánh xạ được dẫn xuất từ criterion ID. Resolver từ chối criterion ID trùng
lặp, và các specification mức full hoặc đã phê duyệt thiếu section bắt buộc hay
metadata phê duyệt. Decision ID là hash xác định của specification và assessment liên quan.

## Evidence và persistence

`recordEvidence(unknown, unknown)` parse `TestStrategySchema` và
`VerificationResultSchema`, xác thực mọi receipt trước đó, và trả về `TestStrategy`
mới với các receipt bất biến theo quy ước trong `metadata.tddEvidence`. Nó không bao
giờ thay đổi input. Retry receipt giống hệt là idempotent; receipt ID xung đột thì
thất bại. Caller lưu giá trị contract này qua các port hiện có. Không dùng thư mục
polling, adapter persistence in-memory hay artifact bịa đặt nào.

Mỗi result phải cung cấp `metadata.conditionalTdd` khớp `EvidenceDetailsSchema`:

```json
{
  "phase": "red",
  "decisionId": "tdd-<resolver digest>",
  "specId": "price-rounding",
  "sourceRevision": "<pre-implementation commit or content hash>",
  "testRevision": "<immutable test content hash>",
  "testNames": ["round-1: A total of 10.125 becomes 10.13"],
  "failureKind": "target_behavior",
  "observations": [{
    "method": "unit_test",
    "criterionId": "round-1",
    "evidenceArtifactId": "<ArtifactStore result id>",
    "summary": "Expected 10.13 but received 10.125",
    "command": "pnpm test:pricing",
    "exitCode": 1
  }]
}
```

Các phase Green/refactor bỏ `failureKind`, dùng exit code bằng 0 và giữ test
revision/name/command của Red trên một implementation revision. Refactor có thể giữ
source revision của Green khi không cần dọn dẹp. Timestamp phải đi sau decision và
phase trước đó; attempt và artifact đã lưu phải khác nhau. Mỗi behavioral criterion
bắt buộc phải có evidence Red. Các phase thành công phải bao phủ mọi criterion bắt
buộc bằng method đã khai báo của nó, mọi method bắt buộc trên toàn cục, và mọi target
command đã cấu hình, kể cả nhiều suite ở cùng test level.

Observation tham chiếu artifact đã lưu của criterion được đánh giá. Khi nhiều check
dùng chung một criterion, việc đánh giá của nó có thể bỏ `command` và `exitCode`
aggregate; mỗi automated observation vẫn cần command và exit code riêng. Red phải bao
gồm một behavioral observation thất bại và exit code đánh giá khác 0 của nó. Các
behavioral criterion hiện có và check khác có thể đã pass trong Red suite; ép các
check đó thất bại không phải TDD. Các phase receipt phải nằm trong cùng verification
cycle. Observation thủ công/trực quan cần tóm tắt cụ thể và artifact đã lưu. Lỗi
infrastructure hoặc không liên quan không thể xác lập Red. Mọi artifact được tham
chiếu phải khớp run/task và được ingest sau khi observation bắt đầu.

Chỉ ArtifactStore mới có thể phát sinh trusted reference. Package này xác thực hình
dạng receipt, ràng buộc, trình tự và outcome đã khai báo; nó không đọc byte artifact,
không xác thực caller, không thực thi command và không kiểm tra Git revision. P17
phải xác minh độc lập log và revision, còn P19 phải dùng spec có thẩm quyền, lưu
receipt và thực thi các kiểm tra này qua Runtime. `assertEvidenceComplete` không phải
acceptance gate cũng không thay thế Verification Loop có giới hạn.

## Prompt và xác thực

Các prompt template tích hợp nằm ở [prompts/](prompts/): assessment, required TDD
và alternative verification. Chúng là asset cho tích hợp P19 và không được cài vào
quyền sở hữu prompt của role khác ở đây.

```bash
pnpm --filter @bflow/test-strategy typecheck
pnpm --filter @bflow/test-strategy test
pnpm check:deps
pnpm typecheck
TMPDIR=/tmp pnpm test
git diff --check
git status --short
```

Build đi trước các package test. Package được đăng ký trong TypeScript reference gốc
và workspace lockfile, nên các lệnh build/typecheck gốc bao gồm P16. Xem
[REVIEW.md](REVIEW.md) cho các bản sửa review và evidence tích hợp.
