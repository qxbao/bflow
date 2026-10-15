# Sample repository: `ai-flow-sample-shop`

Repository TypeScript rất nhỏ dùng để thử workflow **feature** và **bugfix** của AI Flow SDLC. Repository này không thuộc pnpm workspace và không có dependency: test chạy bằng `node:test` với type stripping của Node (`--experimental-strip-types`, Node >= 22.13).

| Đường dẫn | Nội dung |
| --- | --- |
| `src/cart.ts` | `subtotalCents`, `cartTotalCents` — chứa lỗi BUG-001 |
| `test/cart.test.ts` | Test hiện có (đều pass) |
| `repro/bug-001.test.ts` | Test tái hiện BUG-001 (fail cho đến khi sửa lỗi; không nằm trong `pnpm test`) |
| `issues/BUG-001-discount.md` | Mô tả lỗi giảm giá |
| `issues/FEATURE-001-format-price.md` | Mô tả tính năng `formatPriceCents` |

## Lệnh

Từ thư mục này:

```bash
pnpm test        # 4 test, pass
pnpm repro:bug   # 1 test, FAIL: expected 3600, actual 3990
```

Kiểm tra kiểu từ thư mục gốc của monorepo (dùng TypeScript của workspace):

```bash
pnpm exec tsc -p examples/sample-repo/tsconfig.json
```

Repository này cố tình chứa một lỗi. Không sửa `src/cart.ts` trực tiếp trong bản commit; demo Runtime làm việc trên một bản sao tạm — xem [`../runtime-demo`](../runtime-demo/README.md).
