# Portable Bflow Node.js/TypeScript example

Đây là repository calculator nhỏ để thử init/config ở ngoài monorepo. Baseline
export `sum(a, b)`, dùng TypeScript build và Node test runner; không có service,
API key, mock agent hoặc always-success gate. Bốn test kiểm tra cộng số nguyên,
số âm/zero và từ chối fractional/unsafe inputs.

`sum(2, 3)` trả `5`. Inputs phải là safe integers. Có một lỗi chủ ý cho bài tập
bugfix: tổng vượt giới hạn safe integer hiện chưa bị từ chối; baseline tests chưa
bắt lỗi này. Không dùng module này như thư viện tính tiền/production arithmetic.

Copy các file được track vào thư mục trống **ngoài workspace Bflow**, rồi:

```sh
git init
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
node --input-type=module -e 'import { sum } from "./dist/math.js"; console.log(sum(2, 3))'
git add .gitignore README.md package.json pnpm-lock.yaml tsconfig.json src test requests
git commit -m "chore: initialize calculator example"
```

Dùng Node >=22.13 và pnpm 12.5.1. Test chạy build trước rồi import `dist/math.js`;
không phụ thuộc Node experimental type stripping. Khi chạy ngay trong checkout
Bflow, dùng `pnpm install --ignore-workspace --frozen-lockfile` để cài dependency
example riêng. Nếu chỉ chạy `pnpm install` từ đây, pnpm sẽ chọn root workspace và
không cài example vì nó không nằm trong workspace packages.

Sau [setup một lần](../../docs/guide/installation.md), dùng lệnh tắt `bflow`. Đặt `BFLOW_SOURCE` trỏ tới source Bflow đã build để gọi template helper (không dùng `BFLOW_HOME`, vì biến đó chọn isolated state/provider environment):

```sh
bflow init --name calculator
node "$BFLOW_SOURCE/templates/node-typescript/apply.mjs" . bugfix
bflow status --json
bflow doctor --json
```

`.gitignore` của example chỉ ignore file legacy `.bflow/config.yaml`; canonical `.bflow/config.yml` vẫn có thể được track. Review rồi commit config và `.bflow/.gitignore` trong checkout thử nghiệm để working tree sạch; không copy identity đó sang clone/worktree khác. Template portable nằm ở checkout Bflow; helper giữ identity mới của repo này. State/log/DB/
artifact được nested ignore do init tạo bảo vệ khỏi commit nhầm. Không commit
`dist/`, `node_modules/`, `.bflow/state`, key hoặc secret.

Chọn một bài tập độc lập và reset bằng Git một cách có chủ ý giữa các bài tập nếu
cần; không trộn thay đổi khác scope:

| Request | Mục tiêu | Policy mẫu |
| --- | --- | --- |
| [feature](requests/feature.md) | Thêm multiply với criteria cho validation/overflow và giữ nguyên sum | full SDD / required TDD |
| [bugfix](requests/bugfix.md) | Bắt output overflow của sum bằng regression test trước | lightweight / required |
| [refactor](requests/refactor.md) | Tách input validation, giữ behavior | lightweight / recommended |
| [docs](requests/docs.md) | Giải thích giới hạn và kiểm tra ví dụ | lightweight / not_applicable + manual evidence |

Draft/workflow tương ứng ở [templates](../../templates/node-typescript/README.md)
trong source Bflow; khi đã copy repository riêng, mở hướng dẫn bằng
`$BFLOW_SOURCE/templates/node-typescript/README.md`. Các relative links sang Bflow
chỉ dùng trong source checkout; example tự build/test được mà không có Bflow.

`up`/`attach` cần Herdr + provider CLI đã đăng nhập và platform readiness. CLI đã nối persistent P19 host, provider tools và shutdown barrier. Chuẩn bị backend của repository bằng `bflow setup --dir .`; commit config/ignore file nếu cần để giữ working tree sạch trước khi cấp worktree Developer. Xem
[Getting Started](../../docs/guide/getting-started.md) và
[validation report](../../templates/node-typescript/VALIDATION.md) để biết phạm vi
đã kiểm chứng. Chưa tuyên bố đã có AI thực hiện bốn bài tập hay model review thật.
