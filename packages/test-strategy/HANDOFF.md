# Bàn giao triển khai P16 — 2026-10-16

Bản bàn giao triển khai mang tính lịch sử. Các bản sửa review sau đó và việc đăng ký
package được ghi trong [REVIEW.md](REVIEW.md); các đề xuất tích hợp bên dưới mô tả
trạng thái gốc trước tích hợp.

Conditional TDD Policy Engine được triển khai cục bộ trên
`agent/test-strategy/p16-conditional-tdd`, tại `/tmp/bflow-p16-test-strategy`.
Commit triển khai được kiểm thử là
`02e6ca534ce9cadfbe241523bafc03e330758a7f`.
Báo cáo này là một commit chỉ-tài-liệu tiếp theo. Không khẳng định remote merge, push,
tích hợp P19 hay xác minh Herdr thật.

## Baseline và quyền sở hữu

- Base: `4e818b4a7c0c9b102bf1e85906a24d57fd6c192c`, `main` và
  `origin/main` sạch quan sát được, chứa P11 `106d69d` và các phần mở rộng được chấp nhận
  `8c27cbf` cùng các tiền nhiệm P13/P14/P15 đã tích hợp. Đã kiểm tra các ref cục bộ,
  worktree, ancestry, contract diff và patch equivalence (`git cherry -v origin/main main`, rỗng).
- Một branch/worktree riêng được tạo; các worktree khác và công việc chưa commit được
  giữ nguyên. `main` vẫn ở cùng baseline đã phê duyệt khi bàn giao.
- Toàn bộ diff đã commit nằm dưới `packages/test-strategy/**`: triển khai, cấu hình
  package, unit test, prompt, ví dụ và tài liệu package.
- Không có contract, Workflow Engine, Runtime, tài liệu dùng chung, cấu hình gốc,
  migration hay thay đổi lockfile nào được commit. `dist` sinh ra, link dependency và
  raw test log vẫn untracked/ignored hoặc nằm ngoài repository.

## Hành vi đã bàn giao

`TestStrategyResolver.resolve` parse một `Specification` contract, đánh giá bảy input
assessment và phát ra `TestStrategy`/`TddDecision` contract. Metadata riêng tư có phiên
bản dùng các Zod schema nghiêm ngặt. Các verification method bắt buộc, test level đề
xuất, ánh xạ spec-to-test, rationale và evidence requirement đều tường minh.

Logic xác định, regression tái hiện được, API, validation, transformation và state
machine thường yêu cầu TDD khi có một behavioral test chạy được khả thi.
Integration/refactoring/exploration thường chỉ khuyến nghị. Documentation thuần,
formatting, visual layout, wiring và configuration đơn giản có thể dùng phương án thay
thế. Các impact hành vi hỗn hợp, behavioral acceptance criterion, đường dẫn thực tế,
rủi ro và project convention ghi đè các task label bề ngoài. Infrastructure chưa đầy đủ
giữ lại nghĩa vụ verification và phơi bày việc thiếu provisioning command.

Rủi ro high/critical bổ sung review/static analysis và behavioral integration check.
Tín hiệu security/data migration nâng rủi ro hiệu lực. Domain logic/bug fix không thể
bị đánh dấu non-applicable bởi engine này; các boolean override chưa xác minh bị bỏ qua.
`validateAgainstSpecification` từ chối assessment bị thay đổi hoặc policy không khớp
so với input có thẩm quyền, vượt ra ngoài các kiểm tra tự nhất quán.

Evidence API parse các record `VerificationResult` của contract, thực thi thứ tự
Red/Green/refactor tương quan và danh tính test không đổi, từ chối các lỗi Red không
liên quan hoặc do infrastructure, và yêu cầu attempt/artifact đã lưu khác nhau. Các
alternative mode vẫn cần verification khách quan thành công bao phủ criterion và method
bắt buộc. Retry receipt là idempotent; ID xung đột thì thất bại. Caller lưu giá trị
contract được trả về, bao gồm phase evidence được giữ nguyên.

Ba prompt template bao phủ assessment, required TDD và alternative verification.
JSON input được tài liệu hóa được thực thi bởi một unit test; các export ESM đã build
cũng được kiểm tra với ví dụ đó.

## Evidence xác thực

Nền tảng: Linux/hệ thống file cục bộ, Node `v24.16.0`, pnpm `12.5.1` đã pin.
Mọi kiểm tra cuối cùng bên dưới chạy trên implementation HEAD `02e6ca5`.

| Command | Exit | Kết quả |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Không có chu trình: 13 package, 19 cạnh nội bộ |
| `pnpm typecheck` | 0 | Các project reference gốc hiện có pass |
| `pnpm --filter @bflow/test-strategy typecheck` | 0 | P16 được typecheck tường minh, gồm project reference của contract |
| `pnpm --filter @bflow/test-strategy test` | 0 | Build rồi 2 file, 74 passed / 0 failed / 0 skipped |
| `TMPDIR=/tmp pnpm test` | 0 | Build gốc rồi 42 file, 947 passed / 0 failed / 0 skipped |
| Kiểm tra import/ví dụ ESM đã build, lệnh bên dưới | 0 | Resolution và xác thực spec có thẩm quyền pass |
| `git diff --check` | 0 | Không có lỗi whitespace |
| `git status --short` sau khi khôi phục importer lockfile sinh ra | 0 | Sạch sau implementation commit; chỉ báo cáo này còn chờ trước commit của nó |

Lệnh smoke export đã build (từ thư mục gốc repository):

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { TestStrategyResolver } from "./packages/test-strategy/dist/index.js"; const spec = JSON.parse(readFileSync("packages/test-strategy/examples/domain-logic.spec.json", "utf8")); const resolver = new TestStrategyResolver(); const strategy = resolver.resolve(spec); resolver.validateAgainstSpecification(strategy, spec); if (strategy.tddDecision.mode !== "required") throw new Error("Unexpected policy"); console.log("Built ESM export and contract example: PASS");'
```

Lần chạy `pnpm test` đầu tiên chưa chỉnh sửa exit 1: 939 passed, 1 failed, 0 skipped
(940 test ở revision đó). Fixture Unix-socket của ArtifactStore không thể bind socket
vì TMPDIR của profile kế thừa tạo đường dẫn AF_UNIX quá dài (`listen EINVAL`). Chạy lại
với `TMPDIR=/tmp` pass mọi test, kể cả fixture đó. Không có source hay test ArtifactStore
nào bị thay đổi. Số lượng 947 test cuối cùng bao gồm các test P16 bổ sung thêm sau lần
chạy ban đầu.

Các test P16 bao phủ task class, né tránh bằng label hỗn hợp, mâu thuẫn criterion/đường
dẫn, thiếu rationale/context, criterion toàn tùy chọn, infrastructure một phần/vắng mặt,
rủi ro high/critical, tác động security/migration, project convention, hạ cấp policy,
ràng buộc assessment có thẩm quyền, thứ tự phase, bao phủ method/criterion, test bị đổi,
run/task/spec/decision sai, artifact cũ/không tin cậy, exit Red khác 0 và Green bằng 0,
xung đột receipt, xác thực lịch sử đã lưu, và evidence đa-method thành công cho
visual/schema/smoke/formatting và rủi ro cao.

### Dấu vết Red/Green/refactor của triển khai

Đây là các quan sát test trong phiên triển khai, không phải evidence task thật hay
khẳng định tin cậy ArtifactStore. Raw report nằm ngoài Git; log sinh ra không được commit.

| Giai đoạn | Command và kết quả |
| --- | --- |
| Red | `pnpm exec vitest run packages/test-strategy/test --reporter=json --outputFile=/tmp/bflow-p16-red.json` — exit 1, 47 failed / 4 passed / 0 skipped. Hành vi resolver/evidence cố ý vắng mặt; các lỗi báo `Policy resolution is not implemented`. Các kiểm tra invalid-ingress đã pass. |
| Green | `pnpm exec vitest run packages/test-strategy/test --reporter=json --outputFile=/tmp/bflow-p16-green.json` — exit 0, 51 passed / 0 failed / 0 skipped sau khi triển khai policy mục tiêu và hành vi evidence. |
| Refactor/hardening | Tách các level của method bắt buộc khỏi các đề xuất tùy chọn, bỏ phase state dư thừa, thêm ràng buộc spec có thẩm quyền và bao phủ evidence đối kháng. Chạy lại package cuối: 74 passed; chạy lại toàn monorepo: 947 passed. |

SHA-256 checksum của raw report khi bàn giao:

- Red: `bee5de2b8c870e33834d2b0d0d3d0cf6c741ccdf8f71dde8c81e084640ac352f`.
- Green: `33201aa28820f4d724d5c8ba0f95bccb7b94e55db58945f1ece170babb456ba4`.

## Đề xuất tích hợp và phạm vi còn lại

Integrator nên đăng ký package trong cấu hình build/install dùng chung:

1. Thêm `{ "path": "./packages/test-strategy" }` vào các reference của `tsconfig.json` gốc.
2. Sinh lại lockfile để gồm importer này, dùng các dependency đã resolve hiện có:

   ```yaml
   packages/test-strategy:
     dependencies:
       '@bflow/contracts':
         specifier: workspace:*
         version: link:../contracts
       zod:
         specifier: ^3.24.2
         version: 3.25.76
   ```

3. Cập nhật tài liệu trạng thái package dùng chung để mô tả P16 là đã triển khai sau
   tích hợp, với việc thực thi qua Runtime vẫn chờ P19.
4. P19 tiêu thụ metadata assessment, phân giải policy, xác thực nó với spec đã chấp nhận
   có thẩm quyền, lưu evidence và gọi các kiểm tra policy qua Runtime. P17 xác minh độc
   lập log thực tế, revision và việc chấp nhận.

pnpm 12 tự động sinh importer chín dòng trong các lần chạy lệnh cục bộ; nó đã được khôi
phục trước các commit. Do đó build/typecheck gốc chưa bao gồm P16 theo reference: các
lệnh build/typecheck package tường minh ở trên cung cấp độ bao phủ P16. Cài đặt clean với
frozen lockfile trên tích hợp cần đề xuất 2; riêng feature commit này không khẳng định
việc đăng ký dùng chung đã hoàn tất.

Không yêu cầu sửa đổi shared contract hay migration. Chi tiết assessment và evidence dùng
các điểm mở rộng metadata của contract hiện có. Input contract full-SDD đã yêu cầu strategy/decision
hợp lệ; policy ban đầu có thể được phân giải trên lightweight planning spec rồi soạn qua
P15 mà không làm yếu contract.

Engine xác thực cấu trúc evidence đã khai báo, ràng buộc và trình tự. Nó không thực thi
test, không đọc/xác minh byte artifact, không xác thực provenance của reference, không
kiểm tra lịch sử Git, không cấp human override và không thực hiện chấp nhận độc lập.
Các việc đó vẫn là trách nhiệm hiện có của ArtifactStore/P17/P19. Các fixture unit tổng
hợp không xác lập E2E Herdr thật hay đảm bảo về độ bền/bảo mật. P02-RA01 và P03-RA01 không
bị đụng tới và thuộc các chủ sở hữu gốc.
