# Evidence xác thực P17

Bản triển khai được kiểm thử: `691a845911ff8e4e17ef520d7314a6a95bab1b5c`.
Baseline: `d8c6d18120c7a01a4bf8aad13f14660d20e0cdf6`.
Nhánh: `agent/verification/p17-loop-engine`.
Worktree: `/tmp/bflow-p17-verification`.
Nền tảng: Linux, Node `v24.16.0`, pnpm `12.5.1`.
Ngày: 2026-10-16.

| Command | Exit | Kết quả |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Đồ thị dependency không có chu trình; 14 workspace package, 20 cạnh |
| `pnpm typecheck` | 0 | Các project reference gốc hiện có |
| `pnpm --filter @bflow/verification typecheck` | 0 | Source P17 và tham chiếu contracts |
| `pnpm --filter @bflow/verification test` | 0 | 3 file, 49 passed, 0 failed, 0 skipped |
| `pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck packages/verification/test/*.ts` | 0 | Typecheck nghiêm ngặt cho test helper, case và fixture |
| `TMPDIR=/tmp pnpm test` | 0 | 45 file, 1003 passed, 0 failed, 0 skipped |
| `git diff --check` | 0 | Không có lỗi whitespace |
| `git diff --cached --check` | 0 | Không có lỗi whitespace ở staged trước implementation commit |
| `git status --short` | 0 | Worktree cuối cùng sạch sau evidence commit này |

Lần chạy `pnpm test` đầu tiên không có điều kiện trả về exit 1: 977 passed và 1 failed
(trong tổng 978 test ở revision trung gian đó). Fixture hiện có của ArtifactStore
`A02: Unix socket is rejected before any open/connection` không thể tạo socket dưới
TMPDIR của profile dài (`listen EINVAL`). Đường dẫn POSIX cục bộ ngắn `TMPDIR=/tmp` đã
giải quyết lỗi môi trường này. Phần xác thực cuối cùng ở trên bao gồm mọi test P17 sau đó.
Build được thực hiện trước các test của package và test đầy đủ.

Việc cài đặt workspace dependency dùng đúng các phiên bản lockfile đã pin của baseline.
Bước chuẩn bị task tự động của pnpm đã tạm thời thêm importer lockfile của package mới ở
máy cục bộ; importer được sinh ra đó đã bị xóa sau khi kiểm tra. Nó không được commit.
Các project reference TypeScript gốc không thay đổi; do đó các lệnh typecheck/build P17
tường minh là evidence cần thiết ngoài typecheck gốc. Không có thay đổi lockfile gốc, cấu hình
hay shared contract nào. Integration owner phải áp dụng phần wiring mô tả trong
[INTEGRATION.md](INTEGRATION.md) trước khi một lần cài đặt clean với frozen lockfile có thể
phát hiện importer của package mới.

Diff thuộc sở hữu chỉ chứa `packages/verification/**` và `agents/verifier/prompt.md`.
Không có migration, nâng cấp dependency, build output được commit, database, thư mục coverage
hay agent log. Các ví dụ JSON là source fixture được yêu cầu, thu bằng fake ArtifactStore lưu
byte và fake tool runner; schema test xác thực cả sáu ví dụ.

Phạm vi bao phủ gồm tám kịch bản được yêu cầu, ưu tiên của exit khác 0 thực tế so với
gate/review đang pass, từ chối attempt/revision và executor lỗi thời, scope và specification
drift, evidence sai định dạng/thiếu/hỏng, ingestion proposal, thực thi ngưỡng coverage, timeout
có giới hạn, giả mạo receipt/history, giới hạn loop đã cấu hình, tái sử dụng check đã đổi so
với không bị ảnh hưởng (kể cả đổi tên), và workflow verification sau tích hợp. Review đã phát
hiện và đóng lỗ hổng bỏ qua coverage trong đó manual-review/static-check giả dạng integration.

Đây là evidence triển khai source và test cục bộ. Nó không phải tích hợp Runtime P19, xác minh
Herdr thật, tích hợp Git thật hay đóng remote. Trusted host phải cung cấp các check cô lập thực
tế, command capability đã phê duyệt, danh tính executor và trạng thái Git. Runtime phải thực
thi optimistic version của cycle mới nhất, giới hạn rework của Core, lease, cancellation/recovery
và việc gửi thông điệp. Engine tự nó không thể xác thực tiến trình hay phân biệt replay một
snapshot cycle xác thực cũ hơn với cycle mới nhất. Không yêu cầu sửa đổi contract. P02-RA01 và
P03-RA01 nằm ngoài quyền sở hữu của package này và không thay đổi.

## Đóng tích hợp đã được review

Integration commit được kiểm thử: `8e7778a4b134d9b85edf5a5989d1da33b36a54cf`.
Các bản sửa source đã review: `46a6eac` và `26b1950`.
Đăng ký build/lockfile/tài liệu dùng chung: `13e9013`.
Integration worktree: `/tmp/bflow-p17-integration` trên `integration/p17-closure`.
Tiền nhiệm main cục bộ: `d8c6d18120c7a01a4bf8aad13f14660d20e0cdf6`.
Ủy quyền: yêu cầu tường minh của người dùng để review, fix và merge main.

| Command | Exit | Kết quả |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts --offline` | 0 | Cài đặt sạch trong integration worktree; giữ nguyên phiên bản dependency đã pin |
| `pnpm check:deps` | 0 | 14 workspace package, 20 cạnh; không có chu trình |
| `pnpm typecheck` | 0 | Các reference gốc nay bao gồm P17 |
| `pnpm --filter @bflow/verification test` | 0 | 4 file, 66 passed, 0 failed, 0 skipped |
| `pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck packages/verification/test/*.ts` | 0 | Typecheck nghiêm ngặt cho test/helper |
| `pnpm lint` | 0 | Kiểm tra dependency, typecheck gốc và tương thích kiểu của bộ E2E |
| `TMPDIR=/tmp pnpm test` | 0 | 46 file, 1020 passed, 0 failed, 0 skipped |
| `git diff --check` | 0 | Sạch |
| `git status --short` | 0 | Cây tích hợp đã kiểm thử sạch |

Review trước tiên tái hiện tám lỗi đối kháng, sau đó đóng chúng bằng regression test. Một test
tương thích thất bại khác đã tái hiện việc từ chối metadata receipt TDD được append của P16.
Các test cuối cũng bao phủ tính duy nhất toàn cục của submission identity, thiếu check
criterion bổ sung, độ mới của timestamp, tái sử dụng review/coverage thất bại, khai báo đường
dẫn literal, provenance tích hợp task-complete, định tuyến repair theo từng check và các tiền
tố receipt TDD đã phê duyệt bất biến. Xem [REVIEW.md](REVIEW.md) cho các finding và khắc phục.

Diff tích hợp chỉ thêm package P17/Verifier prompt cùng các thay đổi được ủy quyền ở `README.md`
gốc, `tsconfig.json` và importer workspace mới trong `pnpm-lock.yaml`. Không có phiên bản
dependency hiện có, public contract, migration, triển khai Runtime/Core hay build output sinh ra
nào thay đổi. Bản triển khai source gốc và các bản sửa sau đó vẫn nằm trong lịch sử merge. Hạn
chế lockfile/build độc lập nêu trên đã được giải quyết bởi tích hợp này.

Mọi finding review được xác định trong lượt này đều đã sửa. Điều này đóng tích hợp source/build
cục bộ của P17; nó không triển khai P19 hay xác minh thực thi Herdr/Git thật. Việc Runtime thực
thi latest-cycle/version/lease/recovery và các trusted host capability vẫn là ranh giới tích hợp
tường minh. Không có push, remote merge hay PR trong lần đóng này. Evidence commit chỉ thay đổi
tài liệu sau integration commit đã kiểm thử.
