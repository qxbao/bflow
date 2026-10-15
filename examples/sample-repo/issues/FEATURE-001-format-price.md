# FEATURE-001 — Định dạng giá tiền để hiển thị

## Mô tả

Thêm hàm `formatPriceCents(cents: number): string` trong `src/money.ts` và export từ `src/index.ts`.

## Tiêu chí chấp nhận

- `formatPriceCents(123456)` trả về `"$1,234.56"`.
- `formatPriceCents(5)` trả về `"$0.05"`.
- `formatPriceCents(0)` trả về `"$0.00"`.
- Số âm hoặc không phải số nguyên ném `RangeError`.
- Có unit test trong `test/money.test.ts`; `pnpm test` pass.
