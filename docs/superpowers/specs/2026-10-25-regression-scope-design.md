# Regression scope theo vùng ảnh hưởng (GitNexus) — Design

> Trạng thái: **đề xuất, chờ project owner duyệt**. Tài liệu này là spec cho
> `docs/superpowers/plans/2026-10-25-regression-scope.md`. Không phải bằng chứng implementation/acceptance.

## 1. Vấn đề

Hiện tại Runtime chỉ chạy các test identity được map từ acceptance criterion
(`resolveTaskCommands`, `packages/runtime/src/agentic/task-commands.ts:91`): test file phải nằm trong
`specification.affectedPaths` và bị lọc bằng `--testNamePattern` / `--test-name-pattern` theo
`criterionMappings[].testNames`. Không có bước nào chạy **test hiện có** mà thay đổi có thể làm hỏng.
Chạy toàn bộ suite thì quá chậm với monorepo và vượt deadline 540 s của host check.

## 2. Mục tiêu

Thêm option `verification.regressionScope` cho repository:

| Giá trị | Ý nghĩa |
| --- | --- |
| `affected` (**mặc định, khuyến nghị**) | Host tự chọn test file hiện có bị ảnh hưởng bởi diff, dựa trên GitNexus import graph; tự mở rộng phạm vi khi không chứng minh được |
| `full` | Chạy mọi test file mà runner được detect nhận diện |
| `mapped_only` | Hành vi hiện tại: không có regression gate |

Không đổi: Red/Green/Refactor, criterion mapping, TddDecision, các gate hiện có, contracts.

## 3. Khảo sát GitNexus 1.6.12 (đã chạy thật, 2026-10-25)

Binary được quản lý: `~/.local/share/bflow/tools/gitnexus/node_modules/gitnexus` (1.6.12). Bflow chạy với
`GITNEXUS_HOME=<platform state>/gitnexus/gitnexus-home`, `GITNEXUS_SHARED_STORE=off`
(`apps/cli/src/gateway-repositories.ts:459`, `packages/tool-installer/src/integrations.ts:297`).
Thí nghiệm trên repo scratch (TS, `src/` + `test/`), index riêng `GITNEXUS_HOME`:

1. `gitnexus status --json` (cwd = repo) in một dòng JSON sau banner. Trường dùng được:
   `repository`, `status` (`up-to-date` | `stale` | …), `index.commit`, `current.commit`,
   `index.incompleteReasons[]`, `contentDrift.status` (`current` | `drifted` | `unmeasurable` | `not-checked`).
   - Index đúng HEAD, tree sạch → `up-to-date` + `contentDrift.status: "current"`.
   - Sửa file chưa commit → `stale` + `drifted` (liệt kê file).
   - HEAD tiến lên sau analyze → `stale`, `contentDrift: not-checked`.
2. `gitnexus impact <symbol> --include-tests` (JSON) tìm test qua CALLS, **nhưng bỏ sót test chỉ dùng
   hằng số export** (`export const LIMIT` → `[]`). Không đủ an toàn để chọn test.
3. `gitnexus cypher` trên quan hệ `IMPORTS` mức file cho đúng tập test kể cả trường hợp hằng số:
   ```
   MATCH (t:File)-[:CodeRelation* 1..10 (r, n | WHERE r.type = 'IMPORTS')]->(f:File)
   WHERE f.filePath IN ['src/math.ts'] RETURN DISTINCT t.filePath
   ```
   → `test/report.test.ts`, `src/report.ts`, `test/math.test.ts` (đúng; `test/other.test.ts` bị loại).
   Output CLI là JSON `{ "markdown": "| t.filePath |\n| --- |\n| … |", "row_count": N }`.
4. `cypher` **không** có trong `MCP_READ_ONLY_TOOLS` (`dist/mcp/read-only-policy.js`), nên Gateway
   (`GITNEXUS_MCP_READ_ONLY=1`) không gọi được. Host phải gọi CLI trực tiếp.
5. Đọc bằng CLI trong khi `gitnexus mcp` đang mở cùng index chạy được (không lỗi lock).
6. Trong home dùng chung nhiều repo, nếu thiếu `-r` thì CLI báo "Multiple repositories indexed". Repo phải đăng ký trong
   registry của home đó. Bflow dùng home riêng nên đã đăng ký qua `ensureGitNexusIndex`.
7. `detect-changes` trên CLI chỉ in text. Bản MCP trả JSON với `partial`/`truncated`. Thiết kế này không cần nó:
   host tự tính diff bằng Git.
8. `analyze` không có `--index-only` sẽ ghi vào AGENTS.md/CLAUDE.md và cài skill. Host **không bao giờ** gọi `analyze`.

Node TAP (`node --test`, Node 24): test fail có `location: '<abs path>:line:col'`, test pass thì không có.
Có `# SKIP` và `# todo`. Summary có `# tests/# pass/# fail/# skipped/# todo/# cancelled`.

## 4. Quyết định thiết kế

### D1. Host chọn, agent không chọn
Selection do `HostVerification` tính trong gate evaluator, từ revision đã pin. Không đọc danh sách test,
lệnh hay scope từ RoleMessage, tool input của agent hay `strategy.metadata`.

### D2. Ba tầng phạm vi, luôn đi về phía an toàn
Thứ tự ưu tiên khi phân loại các file thay đổi (`git diff --name-status -M <base> <head>`):

1. **full** nếu có bất kỳ file nào khớp `FULL_TRIGGERS`: `package.json` ở root, lockfile
   (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`), `tsconfig*.json`, `vitest.config.*`,
   `vitest.workspace.*`, `.node-version`, `.nvmrc`, `pnpm-workspace.yaml`, `turbo.json`, hoặc bất kỳ file
   cấu hình nào (`*.config.{js,cjs,mjs,ts,cts,mts,json}`) ở root.
2. **package** (cho package chứa file đó) nếu file là: `package.json` của package con, file không phải code và
   không phải tài liệu (fixture, snapshot, JSON/YAML data, `.sql`, …), hoặc file code mà graph không trả lời
   được (index không fresh hoặc query lỗi). "Package" là thư mục tổ tiên gần nhất có `package.json`
   (khác root). Nếu không có package con thì nâng thành **full**.
3. **graph**: các file code (`/\.[cm]?[jt]sx?$/`) còn lại được tra ngược closure `IMPORTS` (tối đa 10 hop) trên index
   tại `base`. Test file hiện có trong closure được chọn.

Luôn chọn thêm: test file nằm trong diff (thêm/sửa) mà runner nhận diện được.
Tài liệu (`.md`, `.txt`, `.rst`) không kéo theo test. Nếu diff chỉ có tài liệu thì scope là `none`
(gate pass với `testsRun: 0` và ghi lý do).

### D3. Bằng chứng index còn mới
Graph chỉ được dùng khi **cả bốn** điều kiện đúng, đo ngay trước và lặp lại ngay sau query (cùng kết quả):
- realpath của `status.repository` trùng realpath của repository root;
- `status.status === "up-to-date"` và `contentDrift.status === "current"`;
- `index.commit === base` (base = `baseCommitHash` của worktree task, hoặc `run.baseRevision` ở mức workflow);
- `index.incompleteReasons` rỗng, và file lock storage `gitnexus-storage-<sha256(root)>.lock` không tồn tại.

Sai bất kỳ điều kiện nào thì mọi file code chuyển sang tầng **package** với lý do `index_unavailable:<code>`.
Nếu không có cấu hình GitNexus thì cũng xử lý như vậy (`index_unavailable:not_configured`).

### D4. Chạy regression
- Một gate cho mỗi detected profile JS (`reporter` là `vitest_json` hoặc `node_tap`, không có `adapter`):
  `host-regression-<profile.id>`, `required: true`. Profile có `adapter` (polyglot) được ghi nhận là
  `unsupported_runner` và không tạo gate. Hành vi khi đó giống hôm nay, nhưng có ghi lý do.
- Chạy cả file, không lọc tên. Dùng cùng sandbox, checkout tách rời, dependency roots và prepare như
  `measureBehavior`.
- Parser regression: chấp nhận skipped/todo; **mọi** test fail (kể cả TypeError, lỗi import, runtime
  error của Vitest) đều là failure. Lỗi spawn, timeout, signal, output bị cắt hoặc JSON/TAP không hợp lệ được coi
  là **infrastructure** (gate `blocked`).
- Deadline: `min(540_000, profile.timeoutMs × 3)` ms cho mỗi gate. Hết hạn thì `blocked`, mã
  `regression_budget_exceeded`, kèm gợi ý đổi sang `mapped_only` hoặc chia task.

### D5. Không đổ lỗi cho failure có sẵn
Với mỗi test file có failure tại `head`: nếu file tồn tại ở `base` thì chạy lại file đó tại `base`.
Failure identity là `(testPath, testName)`. Identity cũng fail ở base được tính là `pre_existing`
(finding `warning`, không làm gate fail). Các failure còn lại là `regression_failure` (finding `error`, gate
`failed`, kích hoạt bounded rework như hiện nay). Nếu chạy ở base gặp lỗi infrastructure thì gate `blocked`.

### D6. Bằng chứng
`QualityGateResult.metadata.regression` gồm: `scope`, `selectedTestPaths`, `changedFiles` (tối đa 200, kèm
cờ `truncated`), `widening[] { path, scope, reason }`, `index { commit, probedAt } | { unavailable }`,
`base`, `head`, `failures[] { testPath, testName, classification }`, `testsRun/passed/failed/skipped`.
Reviewer đọc qua `inspect_review` như các gate khác.

### D7. Cấu hình và tương thích
- `.bflow` environment config: `verification.regressionScope`, mặc định `affected` khi `init` tạo config.
  Config cũ thiếu field thì đọc là `affected`, vì đó là mặc định của tính năng.
- `host.json` đã persist mà thiếu field thì coi là `mapped_only`, để recovery của host cũ không đổi hành vi giữa chừng.
- Plan verification đã lưu trên task (`task.verificationPlan`) không đổi. Run đã lập plan trước khi nâng cấp
  sẽ không có regression gate.
- Không đổi `@bflow/contracts`. Dữ liệu mới đi qua `metadata` (JsonValue) và cấu hình CLI/host.

## 5. Ngoài phạm vi
Runner polyglot (pytest/go/cargo/…), chạy lại test flaky, chia nhỏ suite để vượt deadline, coverage, gọi `analyze`
để làm mới index, dùng `impact`/`detect_changes` qua Gateway.

## 6. Ownership
`packages/runtime/**` và `apps/cli/**` (P29/P30), cộng một export nhỏ trong `packages/tool-installer/**` (P26:
tên file lock storage). Không đụng `packages/contracts/**`. Docs dùng chung (`docs/**`, README root) chỉ đề xuất cập nhật.
