# @bflow/skills — framework instruction tái sử dụng P28

Triển khai `SkillManager.list`, `validate`, `install`/`installBundle`, `sync`, `link`,
`verify`, `update` và `recover` theo generation chính xác. Thư viện canonical trong `skills/`
chứa cả 20 shared skill được yêu cầu cùng 12 role skill và các ví dụ thực hành.
Analyst ánh xạ tới `specifier`; Verifier ánh xạ tới `qa`/`tester`. Không thay đổi contract.

## Ranh giới và tích hợp

Leaf này chỉ phụ thuộc vào `@bflow/contracts` và Zod. Các definition, pin, role binding
và manifest được parse bằng các schema đã xuất của P24. Việc parse metadata/tham chiếu,
setup request và repository desired config dùng các schema nghiêm ngặt cục bộ của package.

- **P26 machine setup:** tiêm `SkillsSetupSynchronizer` vào port `SkillsSynchronizer`
  cấu trúc của nó. Desired/check/dry-run không tạo trạng thái catalog.
  Apply cài các pin chính xác đã rà soát và đọc lại trạng thái thực tế. P26 sở hữu
  approval của operator cho setup, locking, plan receipt và việc báo cáo các lần áp dụng một phần bị gián đoạn.
- **P29 repository init:** dùng `repositoryConfig(previousSkillsConfig, rolePins)` để
  dựng dữ liệu `.bflow/skills.json` do init sở hữu. Merge cây con skills được trả về qua
  config writer hiện có; giữ nguyên các thiết lập repository/provider không liên quan. Helper
  giữ userSettings và các role pin không được chỉ định, và không ghi filesystem.
- **P30 Runtime:** phân giải dựa trên inventory capability/tool thực tế và callback
  approval đã xác thực, lưu digest manifest được trả về cùng generation của session,
  cung cấp `rendered.instructionText` cùng với **role prompt gốc đầy đủ** cho P25.
  Restart gọi `recover(exactDigest)`; không bao giờ phân giải một phiên bản di động cho live session.
- **P25 launch:** cả ba provider nhận cùng một biểu diễn metadata/tham chiếu.
  Bề mặt launch đã cài của chúng phải được xác minh riêng. Việc native slash/skill
  discovery của Claude vẫn bị tắt trừ khi được duyệt riêng; package này không thay đổi provider
  home, hook, thiết lập toàn cục hay đường dẫn native discovery.

Các tham chiếu build gốc và workspace lockfile bao gồm package này sau khi tích hợp P28.
CLI parser và Runtime wiring vẫn do P29/P30 sở hữu. `bflow setup`,
`bflow skills ...` và việc kích hoạt skill tự động của `bflow init` **không phải là tuyên bố có thể chạy được**
trên baseline này. API của package và các điểm tích hợp đã sẵn sàng; việc nối lệnh cuối cùng
và kích hoạt provider live vẫn là công việc tích hợp. Ở đây không có scheduler hay gate mới.

## Định dạng và xác minh

Mỗi bundle chứa `SKILL.md` với YAML frontmatter `name`/`description` một dòng chuẩn,
`skill.json`, và các resource cục bộ được tham chiếu. JSON cung cấp `version`,
`allowedRoles`, `supportedProviders`, `requiredCapabilityIds`, `requiredToolIds`, và
`dependencies` chính xác. Mọi section được yêu cầu phải có mặt và không rỗng. Các
frontmatter field khác bị từ chối, kể cả các điều khiển hook/model/permission. Chỉ chấp nhận
tập con chuẩn nhỏ: đặt trong dấu nháy các giá trị scalar chứa dấu câu YAML;
YAML block/folded, nội suy thực thi được và YAML tùy ý đặc thù provider đều
không được hỗ trợ. Không có thực thi install/postinstall.

`validateSkill` kiểm kê mọi file UTF8 trong bundle, kiểm tra các tham chiếu resource inline/có tên/ngoặc nhọn,
từ chối các liên kết từ xa chưa được fetch/thẻ resource HTML, và đối chiếu các lệnh Bflow
literal với một inventory do host cung cấp. Cú pháp lệnh option-first/động bị từ chối; validator
cố ý không phải là một shell interpreter. Việc một lệnh khả dụng không cấp quyền thực thi.
Chỉ cập nhật inventory khi host thực sự triển khai lệnh. Các lệnh baseline hiện có được xuất dưới dạng `BASELINE_COMMANDS`.

Digest bundle SHA-256 bao phủ một inventory đã sắp xếp gồm đường dẫn/hash nội dung, kể cả metadata,
ví dụ và resource đi kèm không dùng đến. File cục bộ bị giới hạn ở 128 file, 256KiB mỗi
file, 2MiB mỗi bundle/tài liệu, 32 cấp thư mục và tổng 512 entry. Resource nhị phân,
symlink (kể cả thư mục cha), file đặc biệt và path traversal không được hỗ trợ/bị từ chối.
Không đặt byte bí mật trong skill. Các tham chiếu resource bí mật/từ xa không bao giờ được fetch.

Việc phân giải từ chối các lựa chọn/tên trùng lặp, pin cùng ID xung đột, chu trình,
dependency bị thiếu, role/provider không khớp và capability/tool bắt buộc không khả dụng.
Dependency đứng trước consumer với tie-breaking ổn định theo ID. Các cây tùy chọn không khả dụng
bị lược bỏ nguyên tử kèm chẩn đoán; pin xung đột vẫn thất bại. Mỗi repository skill được chọn
cần một approval ID **và** một callback của host xác thực
chính xác source/digest/dependency, role/provider, scope và thời hạn. Riêng một chuỗi ID
không chứng minh gì. Builtin yêu cầu allowlist digest phân phối đáng tin cậy; nội dung của operator
cũng yêu cầu callback approval của host. Chỉ đổi `source` bên trong nội dung không cấp được sự tin cậy nào.

`verify`/`recover`/`link` kiểm tra lại danh tính/digest manifest, provenance catalog đã lưu,
mọi byte của bundle, các ràng buộc role/provider và approval hiện tại. Chúng xác minh nội dung
và thẩm quyền, **không phải mức sẵn sàng hiện tại của tool/provider**. Khả năng sẵn có của capability/tool
được kiểm tra trong lúc phân giải và phải được P25/P30 thăm dò lại trước khi launch/dispatch và khi có
drift. Một skill được render thành công không phải bằng chứng rằng agent đã tuân theo nó.

Skill giữ nguyên chính sách host/project, role prompt, Conditional TDD, specification đã chấp nhận,
lease/fencing, verification có giới hạn, Reviewer/QA độc lập và approval chính xác của con người.
Mọi specialist định tuyến quyết định Runtime → Herdr → Conversation. Không skill nào bật
câu hỏi trực tiếp native, bỏ qua quyền hay cài đặt tool. Các instruction đã duyệt
vẫn phụ thuộc vào host; văn xuôi ngữ nghĩa không phải là một security sandbox.

## Lưu trữ và cập nhật

`new SkillFileStore(absoluteRoot)` yêu cầu một thư mục cha đã tồn tại và một root POSIX
riêng tư do chủ sở hữu (tạo với mode 0700 khi apply); các file được lưu dùng 0600. Dùng dữ liệu do máy
quản lý trên filesystem POSIX cục bộ, nằm ngoài các write root của repository/role. Việc cài đặt lấy một
`catalog.lock` độc quyền và publish nội dung/provenance bất biến. Các writer đồng thời thất bại với busy;
reconcile và thử lại một cách tường minh. Một crash có thể để lại lock hoặc bundle mồ côi; operator
phải xác lập rằng writer đã dừng trước khi xóa lock do nó sở hữu. Không bao giờ tự xóa
một lock không chắc chắn, ghi đè dữ liệu hỏng hay suy ra việc hoàn tất từ một file còn sót lại.

`update` nối thêm một phiên bản chính xác đã rà soát. Nó để nguyên các manifest hiện có và thiết lập người dùng.
Cùng name/version nhưng byte thay đổi bị từ chối. JSON manifest/render bất biến được đánh địa chỉ bằng
digest manifest; các generation cũ vẫn có thể phục hồi. Không có dọn dẹp/garbage collection
ngầm. Các thư mục staging tạm và bundle không dùng có thể còn lại sau khi tiến trình chết; chúng không phải là
entry skill đã publish. Publish nguyên tử không phải là transaction nhiều file hay chịu được mất điện,
và đây không phải cô lập chống same-UID thù địch, network-filesystem hay đa host. Full provider sandboxing vẫn là công việc của P25/P30.

Bundle canonical `use-mempalace` có phiên bản `1.0.1`: cách diễn đạt về điều kiện tiên quyết do setup sở hữu
đã thay đổi sau khi `1.0.0` được publish. Setup nối thêm pin chính xác mới bên cạnh các byte
`1.0.0` đã cài, bảo toàn các session manifest hiện có. Không xóa catalog cũ
hay ghi đè phiên bản cũ để hòa giải một bundle phân phối đã thay đổi.

## Ví dụ: từ machine catalog đến manifest Developer có scope

```ts
import {
  BASELINE_COMMANDS, SkillFileStore, SkillManager, loadSkillCatalog,
  RoleSkillBindingsSchema, bindRoleSkills, SkillsSetupSynchronizer, readBundle
} from '@bflow/skills';

const catalogRoot = '/opt/bflow/skills'; // Explicit reviewed distribution, never provider-home discovery.
const catalog = await loadSkillCatalog(catalogRoot, {
  source: 'builtin', supportedCommands: BASELINE_COMMANDS
});
// supplied by trusted operator/distribution config; do NOT approve arbitrary repo bytes here
const approvedDigests: string[] = trustedDistribution.skillDigests;
const store = new SkillFileStore('/var/lib/bflow/owned-skills'); // parent already provisioned
const manager = new SkillManager({
  store, supportedCommands: BASELINE_COMMANDS, approvedBuiltinDigests: approvedDigests,
  authorize: check => authenticatedApprovals.verify(check)
});
const setup = new SkillsSetupSynchronizer(manager, store, catalog.map(s => ({
  root: s.directory, source: 'builtin', expectedDigest: s.definition.digest
})));
const preview = await setup.desired({mode: 'dry_run'});
// P26 authenticates approval of the exact setup plan before invoking apply:
await setup.sync({mode: 'apply'});
const recipe = RoleSkillBindingsSchema.parse(JSON.parse(
  (await readBundle(catalogRoot))['roles/bindings.json']!
));
const result = await manager.sync({
  manifestId: 'developer-generation-1', environmentId: 'developer-env-1',
  scope: {kind: 'session', machineId: 'machine-1', repositoryId: 'repo-1',
    workspaceRoot: '/work/project', sessionId: 'session-1'},
  role: 'developer', provider: 'codex',
  selections: bindRoleSkills(recipe.bindings, 'developer', catalog.map(s => s.definition)),
  capabilityIds: [], toolIds: ['gitnexus', 'rtk'] // actual approved and probed host inventory
});
// P30 persists result.manifest.digest, and composes through P25's contract port:
const renderedSkillsContent = result.rendered.instructionText;
// Later, restart verifies this same generation:
await manager.recover(result.manifest.digest);
```

Ví dụ để lại cấu hình đáng tin cậy, approval đã xác thực và facade wiring cho
các owner của chúng; nó không bao giờ tự tạo ra chúng. `packages/skills/test/catalog.test.ts` thực thi
chuỗi catalog/install/binding/render cho mọi role và cả ba provider bằng
storage tạm cô lập. Mỗi skill cũng có một ví dụ thực hành riêng cho task.

Tham chiếu định dạng native: [Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://developers.openai.com/codex/skills),
[Agy](https://www.agy.dev/docs/skills/). Chúng xác lập các bề mặt định dạng, không phải việc kích hoạt Bflow
live hay thực thi quyền.

## Xác thực và đề xuất tích hợp

Từ thư mục gốc repository (Node >=22.13 và pnpm đã pin):

```sh
pnpm --filter @bflow/skills typecheck
pnpm --filter @bflow/skills test
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Workspace importer và TypeScript reference gốc đã được tích hợp, nên build và
typecheck gốc bao gồm package này. Các integration owner vẫn cần ghép các port setup/init/
Runtime ở trên; các kiểm tra cục bộ của package vẫn dùng được để xác thực tập trung. Các test
bao phủ mọi trường hợp tiêu cực được yêu cầu, tương đương lựa chọn giữa các provider, approval lỗi thời, content drift, concurrency, lập kế hoạch chỉ đọc,
cấu hình được bảo toàn và ngữ nghĩa restart/update bất biến. Chúng là các test source
và rendering cục bộ; không tuyên bố có live model session, nghiệm thu native skill-discovery hay thành công SDLC
đầy đủ.
