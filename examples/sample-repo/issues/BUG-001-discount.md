# BUG-001 — Giảm giá phần trăm bị trừ như số cent cố định

## Mô tả

`cartTotalCents(items, discountPercent)` phải giảm `discountPercent` phần trăm trên subtotal. Hiện tại hàm trừ thẳng `discountPercent` cent.

## Tái hiện

Từ thư mục `examples/sample-repo`:

```bash
pnpm repro:bug
```

Kết quả hiện tại: test `BUG-001` thất bại với `expected: 3600`, `actual: 3990`.

## Tiêu chí chấp nhận

- 10% trên subtotal 4000 cent cho tổng 3600 cent.
- Kết quả được làm tròn tới cent gần nhất (`Math.round`).
- Có regression test trong `test/` (chạy bằng `pnpm test`).
- Các test hiện có vẫn pass; giới hạn 0–100 vẫn được kiểm tra.
