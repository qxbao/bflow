# Regression Scope (affected tests via GitNexus) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use bflow-superpowers:subagent-driven-development (recommended) or bflow-superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm `verification.regressionScope` (`affected` mặc định | `full` | `mapped_only`). Với `affected`, host tự chạy các test file hiện có bị ảnh hưởng bởi diff của task/workflow, chọn theo GitNexus import graph, và tự mở rộng phạm vi khi không chứng minh được.

**Architecture:** Có một gate host-owned mới là `host-regression-<profileId>` cho mỗi profile JS được detect. Gate này tính diff `base..head`, phân loại file (none/graph/package/full), tra ngược closure `IMPORTS` qua GitNexus CLI (chỉ khi index được chứng minh fresh tại `base`), rồi chạy nguyên các test file đã chọn trong measurement sandbox hiện có. Gate so failure với `base` để không đổ lỗi cho failure có sẵn. Không đổi contracts, TDD phases hay các gate hiện có.

**Tech Stack:** Node >=22.13, pnpm (pin trong root `package.json`), TypeScript, Zod, Vitest. GitNexus 1.6.12 CLI (`status --json`, `cypher`).

**Spec:** `docs/superpowers/specs/2026-10-25-regression-scope-design.md` (D1–D7; mục 3 là kết quả khảo sát thật). Đọc spec trước khi làm.

## Global Constraints

- Không sửa `packages/contracts/**`, root config, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`, `docs/**` (ngoài 2 file spec/plan này).
- Selection, lệnh và revision **chỉ** do host tính. Không đọc từ RoleMessage, tool input hay `strategy.metadata` (D1).
- Host không bao giờ gọi `gitnexus analyze`, không ghi vào `GITNEXUS_HOME`, không tạo file lock storage của GitNexus.
- Env khi gọi GitNexus phải đúng là `{ GITNEXUS_HOME: <home>, GITNEXUS_SHARED_STORE: "off" }`, cwd = canonical repository root, timeout 30_000 ms cho mỗi lệnh.
- Tầng chỉ được mở rộng (graph → package → full), không bao giờ thu hẹp để "bỏ qua" (D2/D3).
- Deadline của regression gate: `min(540_000, profile.timeoutMs * 3)` ms.
- Giới hạn bằng chứng: `changedFiles` tối đa 200 phần tử, kèm `truncated: boolean`.
- Mã reason/finding cố định: `regression_failure`, `pre_existing_failure`, `regression_budget_exceeded`, `regression_infrastructure`, `unsupported_runner`, `docs_only`, `index_unavailable:<code>` với `<code>` ∈ `not_configured | status_failed | repository_mismatch | not_up_to_date | content_drift | commit_mismatch | incomplete | storage_locked | query_failed | changed_during_query`.
- Build trước khi chạy test subprocess/worker (`pnpm run build`), vì các test đó import `dist/`.
- Chạy test theo từng package khi làm task. Full suite (`pnpm check`) chỉ chạy một lần ở Task 8 (xem memory về tải song song).

## Review Focus

1. **Test chỉ dùng hằng số, type hoặc re-export** (`export const LIMIT`, `export type`, barrel `index.ts`): người dùng kỳ vọng các test đó vẫn được chọn. `impact` của GitNexus bỏ sót trường hợp này, nên selection phải dựa trên closure `IMPORTS` → test ở Task 3 (`selects tests that only import a constant`) và Task 8.
2. **Index lệch revision hoặc tree bẩn** (user sửa file trong main checkout, hoặc main HEAD đã tiến lên sau khi integrate task khác): kỳ vọng phạm vi tự mở rộng sang package và **không** dùng graph cũ → test ở Task 3 (mỗi mã `index_unavailable:*`).
3. **Test đã fail sẵn ở base**: kỳ vọng task không bị đẩy vào rework vì lỗi không phải của mình → test ở Task 6 (`classifies failures present at base as pre_existing`).
4. **Thay đổi chỉ là fixture/JSON/snapshot hoặc config root**: kỳ vọng các test đọc file đó vẫn chạy, dù không có cạnh import → test ở Task 2 (fixture → package, `vitest.config.ts` → full).
5. **Diff rất lớn hoặc suite chậm vượt deadline**: kỳ vọng gate `blocked` với hướng dẫn rõ ràng, không treo và không `failed` giả → test ở Task 6 (`blocks with regression_budget_exceeded on timeout`).

---

## File Structure

| File | Trách nhiệm |
| --- | --- |
| `packages/runtime/src/agentic/regression-changes.ts` (mới) | Pure: phân loại file thay đổi → tầng scope + lý do (D2) |
| `packages/runtime/src/agentic/impact-index.ts` (mới) | Port `ImpactIndex` + adapter GitNexus CLI (probe freshness D3, closure `IMPORTS`) |
| `packages/runtime/src/agentic/regression-selection.ts` (mới) | Ghép diff Git + phân loại + index + liệt kê test file → `RegressionSelection` |
| `packages/runtime/src/agentic/regression-results.ts` (mới) | Parser regression cho `vitest_json` và `node_tap` (D4) |
| `packages/runtime/src/agentic/behavioral-runner.ts` | Tách `runMeasurementCommand` khỏi `measureBehavior`; thêm `bindRegressionProfile`, `measureRegression` |
| `packages/runtime/src/agentic/host-verification.ts` | Định nghĩa và evaluator cho regression gate, so sánh với base, evidence (D5/D6) |
| `packages/runtime/src/agentic/host-controller.ts`, `host.ts` | Option host `regressionScope`, `impactIndex`; validate host.json đã persist |
| `packages/tool-installer/src/integrations.ts` | Export `gitNexusStorageLockPath` (dùng chung tên file lock) |
| `apps/cli/src/environment-config.ts`, `config-format.ts`, `agentic-host.ts` | Option config, mặc định, truyền vào host |

---

### Task 1: Option cấu hình `regressionScope` (CLI → host)

**Files:**
- Modify: `apps/cli/src/environment-config.ts:95-99` (schema `verification`), `:196` (default), `:281` (merge), `:350-353` (validate)
- Modify: `apps/cli/src/config-format.ts:189-196` (banner `verification`)
- Modify: `apps/cli/src/agentic-host.ts:~80` (`policy.verification`)
- Modify: `packages/runtime/src/agentic/host-controller.ts:24-25` (type), `:55-59` (validate host.json)
- Test: `apps/cli/test/environment.test.ts`, `apps/cli/test/config-format.test.ts`, `packages/runtime/test/agentic/host-recovery.test.ts`

**Interfaces:**
- Produces: `export type RegressionScope = "affected" | "full" | "mapped_only"` export từ `packages/runtime/src/agentic/regression-changes.ts` (tạo file này với type đó ở task này). `AgenticHostOptions.policy.verification.regressionScope?: RegressionScope`. Helper `export function effectiveRegressionScope(policy: AgenticHostOptions["policy"] | undefined, persisted: boolean): RegressionScope`: trả về `policy.verification.regressionScope` nếu có; nếu thiếu thì `persisted ? "mapped_only" : "affected"`; nếu không có policy thì `"mapped_only"`.

- [ ] **Step 1: Viết test fail.**
  - `environment.test.ts`: `it("defaults verification.regressionScope to affected")`: config mới từ init có `environment.verification.regressionScope === "affected"`. `it("reads legacy config without regressionScope as affected")`. `it("rejects unknown regressionScope")`: `"some"` → throw.
  - `config-format.test.ts`: banner `verification` có dòng giải thích 3 giá trị (string chứa `regressionScope: affected | full | mapped_only`).
  - `host-recovery.test.ts`: `it("treats persisted host policy without regressionScope as mapped_only")` dùng `effectiveRegressionScope(policy, true)`. Host.json có `regressionScope: "bogus"` → `Invalid persisted host policy`.
- [ ] **Step 2: Chạy** `pnpm --filter @bflow/cli run build && pnpm vitest run apps/cli/test/environment.test.ts apps/cli/test/config-format.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Zod: `regressionScope: z.enum(["affected","full","mapped_only"]).default("affected")`. Validate thủ công ở `:353` phải chấp nhận field (thiếu hoặc một trong ba giá trị). Host-controller chấp nhận field optional, giá trị khác → throw như hiện có.
- [ ] **Step 4: Chạy lại các test ở Step 2 và** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/host-recovery.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(cli,runtime): add verification.regressionScope option`.

---

### Task 2: Phân loại file thay đổi (pure)

**Files:**
- Modify: `packages/runtime/src/agentic/regression-changes.ts`
- Test: `packages/runtime/test/agentic/regression-changes.test.ts` (mới)

**Interfaces:**
- Consumes: `testFilePattern` từ `behavioral-runner.ts`.
- Produces:
  ```ts
  export interface ChangedFile { path: string; status: "A" | "M" | "D" | "R" | "C" | "T"; previousPath?: string }
  export type ScopeTier = "none" | "graph" | "package" | "full";
  export interface Widening { path: string; tier: "package" | "full"; reason: string; packageRoot?: string }
  export interface ChangeClassification {
    tier: ScopeTier;                 // tầng cao nhất cần dùng
    graphFiles: string[];            // file code cần tra closure (đường dẫn ở base; với R dùng previousPath)
    packageRoots: string[];          // thư mục package cần chạy toàn bộ test
    changedTests: string[];          // test file A/M/R trong diff (path ở head)
    widening: Widening[];
  }
  export function classifyChanges(changes: readonly ChangedFile[], packageRootOf: (path: string) => string | undefined): ChangeClassification
  export function parseNameStatus(output: string): ChangedFile[]   // cho `git diff --name-status -M -z`
  ```
  `packageRootOf` trả về thư mục tổ tiên gần nhất có `package.json` và khác root (`undefined` nếu chỉ có root). Task 4 cung cấp hàm này.

- [ ] **Step 1: Viết test fail** (mỗi case một `it`, assert `tier`, `graphFiles`, `packageRoots`, `widening[].reason`):
  - `docs only → none` với `[M README.md, M docs/a.md]` → `{ tier: "none", graphFiles: [] }`, widening rỗng.
  - `source file → graph`: `M packages/x/src/a.ts` → `graphFiles: ["packages/x/src/a.ts"]`.
  - `deleted source uses base path`: `D packages/x/src/old.ts` → `graphFiles` chứa nó.
  - `rename uses previous path for graph and new path for changedTests`: `R packages/x/test/a.test.ts ← packages/x/test/b.test.ts` → `changedTests: ["packages/x/test/a.test.ts"]`.
  - `fixture → package`: `M packages/x/test/fixtures/data.json` → `packageRoots: ["packages/x"]`, reason `non_code_change`.
  - `package manifest → package`: `M packages/x/package.json` → reason `package_manifest`.
  - `root config → full`: lần lượt `vitest.config.ts`, `pnpm-lock.yaml`, `tsconfig.base.json`, `package.json`, `eslint.config.mjs` → `tier: "full"`, reason `root_config:<path>`.
  - `non-code file without sub-package → full`: `packageRootOf` trả `undefined` → `tier: "full"`.
  - `parseNameStatus` parse đúng output `-z` gồm `M\0a.ts\0R100\0old.ts\0new.ts\0`.
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/regression-changes.test.ts` → FAIL.
- [ ] **Step 3: Implement** theo đúng bảng `FULL_TRIGGERS` trong spec D2. Code = `/\.[cm]?[jt]sx?$/`. Docs = `/\.(md|txt|rst)$/i`. Test file được nhận diện bằng `testFilePattern` (vẫn đưa vào `graphFiles` nếu là code, vì test helper có thể được import).
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `feat(runtime): classify changed files for regression scope`.

---

### Task 3: Port `ImpactIndex` + adapter GitNexus CLI

**Files:**
- Create: `packages/runtime/src/agentic/impact-index.ts`
- Modify: `packages/tool-installer/src/integrations.ts:~315` (dùng helper mới thay chuỗi inline) và export
- Test: `packages/runtime/test/agentic/impact-index.test.ts` (mới), `packages/tool-installer/test/gitnexus-lock-diagnostics.test.ts` (thêm 1 case)

**Interfaces:**
- Produces:
  ```ts
  export type IndexUnavailableCode = "not_configured" | "status_failed" | "repository_mismatch" | "not_up_to_date" | "content_drift"
    | "commit_mismatch" | "incomplete" | "storage_locked" | "query_failed" | "changed_during_query";
  export type ImportersResult = { status: "ok"; indexCommit: string; files: string[] } | { status: "unavailable"; code: IndexUnavailableCode; detail: string };
  export interface ImpactIndex { importersOf(input: { repositoryRoot: string; base: string; files: readonly string[] }): Promise<ImportersResult> }
  export interface GitNexusImpactIndexOptions { executable: string; home: string; storageLockPath: string;
    run?: (executable: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string }> }
  export function createGitNexusImpactIndex(options: GitNexusImpactIndexOptions): ImpactIndex
  export const unconfiguredImpactIndex: ImpactIndex   // luôn trả unavailable/not_configured
  export function parseCypherFilePaths(stdout: string): string[]   // từ JSON {markdown,row_count}
  ```
  Tool-installer: `export function gitNexusStorageLockPath(stateRoot: string, canonicalRoot: string): string` trả về `join(stateRoot, \`gitnexus-storage-${sha256hex(canonicalRoot)}.lock\`)`.

- [ ] **Step 1: Viết test fail** với `run` giả (đọc fixture string), mỗi trường hợp một `it`:
  - `returns importers when index is fresh at base`: status `{repository: root, status:"up-to-date", contentDrift:{status:"current"}, index:{commit: BASE, incompleteReasons:[]}}` + cypher `{"markdown":"| t.filePath |\n| --- |\n| test/math.test.ts |\n| src/report.ts |","row_count":2}` → `{status:"ok", indexCommit: BASE, files:["test/math.test.ts","src/report.ts"]}`. Assert lệnh cypher có `-r <root>`, env đúng hai key và không có `analyze`.
  - Mỗi mã unavailable một test: exit≠0 → `status_failed`; repository khác → `repository_mismatch`; `stale` → `not_up_to_date`; `drifted` → `content_drift`; commit khác → `commit_mismatch`; `incompleteReasons:["x"]` → `incomplete`; file lock tồn tại → `storage_locked`; cypher exit≠0 hoặc `row_count` ≠ số dòng parse được → `query_failed`; status lần 2 khác commit → `changed_during_query`.
  - `rejects unsafe file paths before querying`: path chứa `'`, `\`, `\n` hoặc `..` → `query_failed` và **không** gọi cypher.
  - `parseCypherFilePaths` xử lý bảng rỗng (`row_count: 0`) → `[]`; banner text trước JSON được bỏ qua (cắt từ `{` đầu tiên của dòng cuối).
  - Test thật, skip nếu không có binary (`process.env.BFLOW_GITNEXUS_BIN` hoặc `~/.local/share/bflow/tools/gitnexus/node_modules/.bin/gitnexus`), timeout 120 s: tạo repo tạm giống spec mục 3 (`src/math.ts`, `src/report.ts`, `src/config.ts` có `export const LIMIT`, `src/other.ts` và test tương ứng), dùng `GITNEXUS_HOME` tạm, chạy `analyze --index-only --skip-skills` **trong fixture của test** (không phải trong adapter), commit thay đổi `add`. `importersOf({files:["src/math.ts"]})` chứa `test/math.test.ts`, `test/report.test.ts`, không chứa `test/other.test.ts`. Test `selects tests that only import a constant`: `importersOf({files:["src/config.ts"]})` chứa `test/config.test.ts`.
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/impact-index.test.ts` → FAIL.
- [ ] **Step 3: Implement** `importersOf`: (a) nếu `existsSync(storageLockPath)` → `storage_locked`; (b) probe `status --json` (parse dòng JSON cuối bằng Zod schema private), kiểm tra theo D3; (c) query:
  ```
  MATCH (t:File)-[:CodeRelation* 1..10 (r, n | WHERE r.type = 'IMPORTS')]->(f:File) WHERE f.filePath IN [<'p1','p2'>] RETURN DISTINCT t.filePath
  ```
  với args `["cypher", "-r", repositoryRoot, "-l", "5000", query]`; (d) probe lại, `index.commit` và `status` phải giống lần đầu. Nếu `row_count >= 5000` → `query_failed` (không tin được kết quả đã bị cắt). Chạy query theo lô 100 file. `run` mặc định dùng `execFile` với `env` đúng như trên (không kế thừa `process.env` ngoài `PATH`).
- [ ] **Step 4: Chạy lại** → PASS; `pnpm --filter @bflow/tool-installer test` → PASS.
- [ ] **Step 5: Commit** `feat(runtime): GitNexus import-closure impact index with freshness proof`.

---

### Task 4: Selection (`RegressionSelection`)

**Files:**
- Create: `packages/runtime/src/agentic/regression-selection.ts`
- Test: `packages/runtime/test/agentic/regression-selection.test.ts` (mới)

**Interfaces:**
- Consumes: `classifyChanges`, `parseNameStatus`, `ChangedFile` (Task 2); `ImpactIndex` (Task 3); `verificationGit(cwd, args)` từ `behavioral-runner.ts`; `testFilePattern`; `RunnerProfile`.
- Produces:
  ```ts
  export interface RegressionSelection {
    scope: ScopeTier; base: string; head: string; testPaths: string[];
    changedFiles: string[]; changedFilesTruncated: boolean; widening: Widening[];
    index: { commit: string } | { unavailable: IndexUnavailableCode; detail: string } | { notQueried: true };
  }
  export async function selectRegressionTests(input: {
    worktreePath: string; repositoryRoot: string; base: string; head: string;
    profile: RunnerProfile; scope: Exclude<RegressionScope, "mapped_only">; index: ImpactIndex;
    git?: (cwd: string, args: string[]) => Promise<string>;
  }): Promise<RegressionSelection>
  ```
  Ghi chú: `base`/`head` phải là SHA 40 ký tự. Test file ứng viên = `git ls-tree -r --name-only -z <head>` lọc bằng `testFilePattern` và extension JS (`/\.[cm]?[jt]sx?$/`). `packageRootOf` dựa trên `git ls-tree` tại head (thư mục có `package.json`).

- [ ] **Step 1: Viết test fail** (repo Git tạm thật, `index` giả):
  - `scope full selects every runner test file` (khi `scope: "full"`, không gọi index).
  - `graph selects importer tests and changed tests`: index trả `["test/math.test.ts","src/report.ts","test/report.test.ts"]` → `testPaths` chỉ gồm 2 test file (đã sort), cộng với test file mới thêm trong diff.
  - `index unavailable widens code files to their package`: index trả `commit_mismatch` → `scope: "package"`, `testPaths` = mọi test trong `packages/x`, `widening[0].reason === "index_unavailable:commit_mismatch"`, `index.unavailable === "commit_mismatch"`.
  - `package without sub-package widens to full`.
  - `docs only selects nothing`: `scope: "none"`, `testPaths: []`, `index: { notQueried: true }`.
  - `drops importer paths that no longer exist at head` (test file bị xóa trong diff).
  - `caps changedFiles at 200` → `changedFilesTruncated: true`.
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/regression-selection.test.ts` → FAIL.
- [ ] **Step 3: Implement** `selectRegressionTests`: diff `["diff","--name-status","-M","-z",base,head,"--"]` trong `worktreePath`; phân loại; nếu `tier === "full"` hoặc `scope === "full"` → mọi ứng viên; nếu không thì union của (test trong `packageRoots`) ∪ (test trong closure index của `graphFiles`) ∪ `changedTests`. Khi index unavailable, mọi `graphFiles` chuyển thành package root (hoặc full). Chỉ giữ path có trong tập ứng viên ở head.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `feat(runtime): select affected regression tests`.

---

### Task 5: Chạy và parse regression

**Files:**
- Modify: `packages/runtime/src/agentic/behavioral-runner.ts:92-121` (bind), `:281-…` (`measureBehavior`)
- Create: `packages/runtime/src/agentic/regression-results.ts`
- Test: `packages/runtime/test/agentic/regression-results.test.ts` (mới), `packages/runtime/test/agentic/runner-profile-measure.test.ts` (thêm case; dùng làm mẫu cho sandbox/pin)

**Interfaces:**
- Produces:
  ```ts
  // behavioral-runner.ts
  export type RegressionCommand = Omit<BoundBehavioralCommand, "testNames"> & { testNames: []; selection: "regression" };
  export function bindRegressionProfile(profile: RunnerProfile, testPaths: string[], timeoutMs: number): RegressionCommand  // throw nếu profile.adapter hoặc testPaths rỗng
  export async function measureRegression(command: RegressionCommand, cwd: string, revision: string): Promise<RegressionMeasurement>
  export interface RegressionMeasurement { sourceRevision: string; commandId: string; testBlobs: Record<string, string>;
    observation: RegressionObservation; outcome: QualityCommandOutcome }
  // regression-results.ts
  export interface RegressionFailure { testPath: string; testName: string }
  export interface RegressionObservation { tests: number; passed: number; failed: number; skipped: number; failures: RegressionFailure[] }
  export class RegressionInfrastructureFailure extends Error {}
  export function parseRegressionResult(outcome: QualityCommandOutcome, reporter: "vitest_json" | "node_tap", checkout: string): RegressionObservation
  ```
  `measureBehavior` giữ nguyên chữ ký và hành vi. Tách phần checkout/sandbox/prepare/run thành hàm private `runMeasurementCommand(command, cwd, revision, options) → { outcome, testBlobs, checkout, rtk? }`, dùng chung cho cả hai.

- [ ] **Step 1: Viết test fail** cho parser (fixture string):
  - node_tap: dùng output đúng như spec mục 3 (`ok a`, `bad a` TypeError có `location`, `skip a # SKIP`, `ok b`) → `{tests:4, passed:2, failed:1, skipped:1, failures:[{testPath:"test/a.test.mjs", testName:"bad a"}]}` (testPath tương đối so với checkout).
  - node_tap: test con lồng nhau → `testName` là các tên subtest nối bằng ` > `; fail mức file (lỗi import) → `testName: "<file>"`.
  - vitest_json: failure là `TypeError` vẫn được tính (khác `parseVitestJson`); `numPendingTests`/`numTodoTests` > 0 được chấp nhận; stderr `BFLOW_VITEST_RUNTIME_ERRORS=2` → thêm failure `{testPath:"<runtime>", testName:"<vitest-runtime-errors>"}`.
  - infrastructure: `timedOut`, `signal`, `outputTruncated`, `spawnError`, JSON hỏng, `tests === 0` với `exitCode !== 0` → `RegressionInfrastructureFailure`. Riêng `timedOut` có `message` bắt đầu bằng `regression_budget_exceeded`.
  - `runner-profile-measure.test.ts`: `it("measureRegression runs whole files without a name filter")`: repo node tạm có 2 test trong 1 file, một test fail → `observation.failed === 1`, args **không** chứa `--test-name-pattern`. `it("bindRegressionProfile rejects adapter profiles")`. Toàn bộ test `measureBehavior` cũ vẫn pass.
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/regression-results.test.ts packages/runtime/test/agentic/runner-profile-measure.test.ts packages/runtime/test/agentic/behavioral-runner.test.ts` → FAIL ở case mới.
- [ ] **Step 3: Implement.** `bindRegressionProfile` dùng lại các kiểm tra an toàn path của `bindRunnerProfile` (`assertTestIdentities([], testPaths)`, `testFilePattern`), args = `[...profile.args, ...testPaths]`, `timeoutMs` = tham số. Vitest vẫn dùng reporter companion như hiện tại.
- [ ] **Step 4: Chạy lại** → PASS (kể cả `behavioral-runner.test.ts` cũ).
- [ ] **Step 5: Commit** `feat(runtime): measure regression test files with tolerant parser`.

---

### Task 6: Regression gate trong `HostVerification`

**Files:**
- Modify: `packages/runtime/src/agentic/host-verification.ts:79-89` (constructor options), `:204-217` (`behavioralChecks`), `:385-391` (`behavioralGates`)
- Modify: `packages/runtime/src/agentic/task-commands.ts` (thêm `regressionChecks`)
- Test: `packages/runtime/test/agentic/host-verification.test.ts`, `packages/runtime/test/agentic/regression-gate.test.ts` (mới)

**Interfaces:**
- Consumes: `selectRegressionTests` (Task 4), `bindRegressionProfile`/`measureRegression`/`RegressionInfrastructureFailure` (Task 5), `RegressionScope` (Task 1), `ImpactIndex` (Task 3).
- Produces:
  ```ts
  // task-commands.ts
  export function regressionChecks(profiles: readonly RunnerProfile[]): QualityGateDefinition[]
  // id `host-regression-${profile.id}`, evaluator "host-regression-command", required: true,
  // timeout.executionTimeoutMs = min(540_000, profile.timeoutMs*3) + 60_000, onTimeout "block",
  // metadata: {} (KHÔNG có bindAcceptedCriteria), configuration: { kind:"deterministic", method: profile.method, command: profile.command,
  //   criterionIds: [], testNames: [], role:"quality_gate", levels:["regression"], selection:"regression" }
  // HostVerification constructor: thêm tham số cuối `regression: { scope: RegressionScope; index: ImpactIndex } = { scope: "mapped_only", index: unconfiguredImpactIndex }`
  ```
  `behavioralChecks()` nối thêm `regressionChecks(profiles không có adapter)` khi `this.runners.automatic && regression.scope !== "mapped_only"`. Trường hợp owner-configured (`.bflow/verification.json`) giữ nguyên, không có regression. `behavioralGates()` nối thêm evaluator tương ứng.

- [ ] **Step 1: Viết test fail** trong `regression-gate.test.ts`. Repo Git tạm + node `--test`, profile detected thật như `runner-profile-measure.test.ts`, `ImpactIndex` giả. Gọi `gate.evaluate(context)` với `input.sourceWorktreePath/sourceRevision`:
  - `passes when selected regression tests pass`: `status:"passed"`, `metadata.regression.scope === "graph"`, `selectedTestPaths` đúng, `testsRun > 0`.
  - `fails with regression_failure when a selected test newly fails`: `status:"failed"`, finding `{code:"regression_failure", severity:"error", location:"test/math.test.ts"}`, `details.testName`.
  - `classifies failures present at base as pre_existing`: test đã fail ở base, vẫn fail ở head → `status:"passed"`, finding `pre_existing_failure` `warning`.
  - `test file added in the change is never pre_existing` (không tồn tại ở base → `regression_failure`).
  - `blocks with regression_budget_exceeded on timeout` (profile `timeoutMs` rất nhỏ, test `await new Promise(r=>setTimeout(r,5000))`) → `status:"blocked"`, finding code `regression_budget_exceeded`, message có chữ `mapped_only`.
  - `blocks with regression_infrastructure on runner crash`.
  - `docs-only change passes with docs_only and runs nothing` (`testsRun: 0`, info finding `docs_only`).
  - `workflow-level gate uses run.baseRevision as base` (taskId `workflow-verification`).
  - `host-verification.test.ts`: `behavioralChecks()` có `host-regression-*` khi scope là `affected`; không có khi `mapped_only`, khi owner-configured, hoặc với profile có `adapter`.
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run packages/runtime/test/agentic/regression-gate.test.ts packages/runtime/test/agentic/host-verification.test.ts` → FAIL.
- [ ] **Step 3: Implement evaluator** `regressionGate(profile)`: parse context như `gate()` (`:393`); kiểm tra `definition.id`/`configuration` khớp; `dossierFor` → `base = originalRevision`, `head = input.sourceRevision`; `selectRegressionTests`; `scope:"none"` → passed. Ngược lại `measureRegression` tại head. Với file có failure tồn tại ở base (`git cat-file -e base:path`) thì `measureRegression` tại base trên cùng worktree. Phân loại theo D5. `RegressionInfrastructureFailure` → `blocked`. Dựng `QualityGateResultSchema.parse(...)` với `metadata.regression` đúng D6 cộng `metadata.verification` cùng shape như `gate()` (`method`, `command`, `sourceRevision`, `independentExecution: true`, `isolated: true`, `executorId: "bflow-host-regression-check"`, `testNames: []`, `criteria: []`). Sau đó gọi `trustGate`.
  Kiểm tra `createVerificationPlan` (verification package) có chấp nhận check `criterionIds: []` không. Nếu không, **dừng lại và báo integrator** kèm fixture fail; không sửa `packages/verification/**`.
- [ ] **Step 4: Chạy lại** → PASS; chạy thêm `packages/runtime/test/agentic/stuck-states.test.ts`, `workflow-liveness-regressions.test.ts` → PASS (gate mới không làm treo run).
- [ ] **Step 5: Commit** `feat(runtime): host regression gate with base comparison`.

---

### Task 7: Wiring host + CLI

**Files:**
- Modify: `packages/runtime/src/agentic/host-controller.ts:21-25` (`impactIndex?: { executable: string; home: string; storageLockPath: string }` trong `AgenticHostOptions`; validate khi đọc host.json: cả ba là absolute path không chứa `\0`)
- Modify: `packages/runtime/src/agentic/host.ts:479` (tạo `createGitNexusImpactIndex(configuration.impactIndex)` hoặc `unconfiguredImpactIndex`; truyền `{ scope: effectiveRegressionScope(configuration.policy, persisted), index }` vào `HostVerification`)
- Modify: `apps/cli/src/agentic-host.ts:66-90` (`ensureAgenticHost({... impactIndex })`), dùng `resolveApprovedGitNexusBinary(platform)`, home `join(platform.paths.state, "gitnexus", "gitnexus-home")` (realpath) và `gitNexusStorageLockPath(join(platform.paths.state, "gitnexus"), canonicalRoot)`. Bỏ qua (không truyền) khi binary/home không tồn tại.
- Modify: `packages/runtime/README.md`, `apps/cli/README.md`, `apps/cli/src/command-reference.ts` (mục verification: 3 giá trị, tầng mở rộng, giới hạn: chỉ runner JS, không làm mới index)
- Test: `apps/cli/test/host-recovery.test.ts` hoặc test gần nhất đang kiểm `ensureAgenticHost` options, `packages/runtime/test/agentic/host-recovery.test.ts`

**Interfaces:**
- Consumes: mọi thứ ở Task 1–6.

- [ ] **Step 1: Viết test fail:** CLI truyền `impactIndex` đúng 3 path khi có binary giả và home; không truyền khi thiếu. Host persist rồi đọc lại `impactIndex`; `impactIndex.home` tương đối → `Invalid persisted host` (throw).
- [ ] **Step 2: Chạy** `pnpm run build && pnpm vitest run apps/cli/test packages/runtime/test/agentic/host-recovery.test.ts` → FAIL.
- [ ] **Step 3: Implement** wiring như trên. Thông điệp `doctor`/`status` không đổi trong task này.
- [ ] **Step 4: Chạy lại** → PASS.
- [ ] **Step 5: Commit** `feat(cli,runtime): wire GitNexus impact index and regression scope into host`.

---

### Task 8: Kiểm chứng tích hợp + full validation

**Files:**
- Test: `packages/runtime/test/agentic/regression-scope.integration.test.ts` (mới)

- [ ] **Step 1: Viết test** dùng GitNexus thật, skip nếu không có binary (như Task 3) hoặc sandbox (`probeBehavioralSandbox`). Repo tạm theo spec mục 3; index tại base bằng `analyze --index-only --skip-skills` trong fixture; `HostVerification` với `scope:"affected"` và `createGitNexusImpactIndex`:
  - đổi `add` → `metadata.regression.testPaths` = `["test/math.test.ts","test/report.test.ts"]`;
  - đổi `LIMIT` → `["test/config.test.ts"]`;
  - đổi `vitest.config.ts` hoặc root `package.json` → `scope:"full"`;
  - sửa file chưa commit trong main checkout (`content_drift`) → `scope:"package"` hoặc `"full"`, `widening[].reason` bắt đầu bằng `index_unavailable:`.
- [ ] **Step 2: Chạy** test này → PASS (hoặc SKIP có lý do được in ra).
- [ ] **Step 3: Full validation từ root** (chạy một lần):
  ```bash
  pnpm check:deps && pnpm typecheck && pnpm test
  git diff --check
  git status --short
  ```
  Expected: exit 0. Ghi lại số pass/fail/skip, HEAD đã test, danh sách file theo ownership.
- [ ] **Step 4: Commit** `test(runtime): GitNexus-backed regression scope integration`.
- [ ] **Step 5: Handoff:** báo cáo theo mục "Required validation before handoff" trong AGENTS.md. Ghi rõ: đây là source + local test, không phải live SDLC acceptance; đề xuất cập nhật `docs/verification-runners.md` và `docs/implementation-status.md` cho integrator, không tự sửa.

---

## Self-review (đã chạy)

- Spec coverage: D1→Task 6 (host tự tính); D2→Task 2/4; D3→Task 3; D4→Task 5/6; D5/D6→Task 6; D7→Task 1/7; mục 5 (ngoài phạm vi) được thể hiện qua `unsupported_runner` và việc không gọi `analyze`.
- Type consistency: `RegressionScope` (T1), `ChangedFile/ScopeTier/Widening` (T2), `ImpactIndex/IndexUnavailableCode` (T3), `RegressionSelection` (T4), `RegressionCommand/RegressionObservation` (T5) được dùng đúng tên ở T6–T8.
- Điểm có thể phải dừng để hỏi integrator: `createVerificationPlan` có thể không chấp nhận check không có criterion (Task 6, Step 3).
