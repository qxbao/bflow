# Examples

| Thư mục | Mục đích |
| --- | --- |
| [`portable-node`](portable-node/README.md) | Repository TypeScript độc lập với lockfile riêng, bốn bài tập feature/bugfix/refactor/docs và hướng dẫn init/config; xem [portable templates](../templates/node-typescript/README.md) |
| [`sample-repo`](sample-repo/README.md) | Repository TypeScript nhỏ có một tính năng cần làm (FEATURE-001) và một lỗi (BUG-001) |
| [`runtime-demo`](runtime-demo/README.md) | Script chạy workflow feature/bugfix trên bản sao của `sample-repo` bằng các package đã triển khai |

Các ví dụ không thuộc pnpm workspace, không chạy trong `pnpm test` và import trực tiếp `packages/*/dist`, vì vậy cần `pnpm build` trước. Hướng dẫn: [docs/guide](../docs/guide/README.md).
