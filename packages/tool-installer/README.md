# Tool installer và kiểm kê capability

`@bflow/tool-installer` là bản triển khai leaf P26 của `ToolInstaller`. Package chỉ phụ thuộc vào `@bflow/contracts`. Nó không thay đổi ProviderAdapter, MCP Gateway, provider home hay cấu hình build gốc của repo. CLI setup đã ghép nó qua MachineSetup; Runtime đọc inventory/receipt mà không cài tool khi `up`. Xem [trạng thái hiện tại](../../docs/implementation-status.md). P27 sở hữu việc thương lượng MCP và các lease.

## Thiết lập

1. Chọn đúng các bản phát hành upstream cụ thể và rà soát giấy phép của chúng. Ghi lại URL HTTPS của release artifact cùng SHA-256 vào một machine catalog đáng tin cậy. Không bao giờ dùng `latest`, branch archive, hoặc giá trị lấy từ văn bản trong repository làm pin đã được duyệt. GitNexus yêu cầu rà soát việc sử dụng phi thương mại cho bản phát hành được chọn.
2. Khởi tạo `ManagedToolInstaller({ managedRoot, pins })` với một thư mục dữ liệu XDG tuyệt đối, riêng tư (`$XDG_DATA_HOME/bflow/tools`, hoặc tương đương theo nền tảng). Giữ catalog và receipt trong trạng thái do operator sở hữu; không đặt các bản cài executable bên trong task worktree.
3. Gọi `plan(ToolInstallRequest)`, hiển thị `SetupStep` kết quả cùng machine approval cần thiết, rồi chỉ gọi `apply(SetupApplyRequest)` sau khi MachineSetup đã xác minh approval receipt. `reconcile` quan sát bản cài hiện tại mà không cài lại. Một pin chính xác mới cùng `apply` sẽ cập nhật; nếu cập nhật binary theo kiểu staged thất bại thì thư mục owned trước đó được giữ lại. Các thay đổi provider gốc (native) có thể được áp dụng một phần khi installer thất bại, nên receipt của chúng là `unknown` và rollback là thủ công. Đích không thuộc sở hữu và config hiện có bị chặn.
4. Thực hiện bước xác minh riêng cho từng tool ở bên dưới. Chỉ đăng ký `ToolCapability` sau khi đã xác minh. `FileToolCapabilityRegistry` lưu trữ inventory theo scope; hãy xóa các đăng ký lỗi thời khi một tool, worker, index, profile hoặc Gateway service mất trạng thái sẵn sàng.
5. Chuyển các yêu cầu launch/cấu hình được sinh ra cho P27/P30. Tool chỉ có CLI không bao giờ được đăng ký như một MCP server. Không đường dẫn `up` nào nên gọi installer này; setup plan/apply là tường minh.

`ManagedToolInstaller.inspectExecutable(ToolInstallRequest)` là quan sát chỉ đọc cho grant của host. Nó
chỉ trả đường dẫn executable canonical và SHA-256 hiện tại khi ownership marker, artifact pin, version
và probe chức năng vẫn khớp; `missing`, `unknown`, drift và provider plugin không trả ra identity
executable. Một PATH probe hoặc version khớp riêng lẻ không được dùng để tạo `cliIdentity`.
`projectVerifiedServiceCapability({service, observation})` chỉ trả capability khi observation Gateway
còn mới, cùng service ID/revision/ownership và đã thương lượng đủ chính xác các operations được cấu hình.
Helper alias duy nhất là `browser` → `chrome-devtools-mcp`; alias không cấp quyền.

Recipe npm tích hợp sẵn tải một tarball chính xác và xác minh SHA-256 của nó trước khi cài vào thư mục staging, sau đó kiểm tra danh tính và phiên bản package. `allowBuildScripts` là tường minh vì các native dependency của GitNexus có thể cần lifecycle script. Bản thân việc phân giải dependency của npm không phải là một lock transitive được pin đầy đủ; một catalog production nên giữ lại cây dependency đã được audit hoặc một offline bundle đã được xác minh. Recipe RTK chỉ giải nén member archive có tên `rtk` và xác minh `rtk --version` cùng `rtk gain`. `rtk proxy <command>` là lối thoát để lấy toàn bộ output; caller phải giữ nguyên exit code của lệnh được proxy. Installer không dùng shell interpolation.

Config được sinh ra có thể được ghi bằng `writeOwnedToolConfig`, hàm này từ chối các file không thuộc sở hữu, trả về bản sao rollback cho một lần cập nhật file owned, và tuần tự hóa các writer. Nó dành cho các file sinh ra do Bflow sở hữu, không dành cho việc sửa tùy ý `~/.claude`, `~/.codex` hay `~/.gemini`.

Với các pin `provider_plugin`, truyền `OfficialProviderPluginAdapter` làm `providerPlugin` cho `ManagedToolInstaller`. Callback `discoverSkills` của nó phải kiểm tra inventory skill *đang hoạt động (active)* của provider. `verifyProvenance` phải gắn một snapshot marketplace Superpowers đang active với pin đã được rà soát; chỉ riêng phiên bản là không đủ. Installer tải xuống và xác minh artifact đã được duyệt trước khi gọi một route native, sau đó kiểm tra phiên bản đã cài chính xác và mức sẵn sàng về chức năng. Superpowers dùng plugin CLI của từng provider. Mỗi provider có instance installer và đích riêng. Machine setup approval phải bao phủ các thay đổi provider-home được liệt kê bởi lệnh upstream. Các route native này có thể chạm vào trạng thái provider dùng chung, nên Bflow không tuyên bố sở hữu các file đó trong `ownedPaths` và không tự động xóa chúng khi rollback.

## Vận hành theo từng tool

| Tool | Cài đặt và cập nhật | Xác minh và capability | Cấu hình / rollback |
| --- | --- | --- | --- |
| RTK | Pin archive binary release `rtk-ai/rtk`; recipe `rtk_archive`. | `rtk --version`, `rtk gain`; `cli_only`. | `rtkProviderIntegration` cung cấp các route init chính thức cho Claude/Codex/Antigravity; host phải kiểm tra `rtk init --help`, các hook hiện có và bản phát hành provider trước khi áp dụng một route. `rtk proxy` giữ toàn bộ output. Chỉ xóa binary/config do Bflow sở hữu, hoặc khôi phục phiên bản được giữ lại. |
| MemPalace | Được cài bởi `bflow setup --apply` từ PyPI wheel đã rà soát (recipe `python_wheel`): xác minh SHA-256, cài vào một virtualenv do Bflow sở hữu với các wrapper `bin/mempalace` và `bin/mempalace-mcp` có thể di dời, kiểm tra danh tính/phiên bản/giấy phép trước khi publish. Cần `uv` hoặc `python3` >= 3.9 trên PATH. | Capability cho Gateway giới hạn ở `mempalace_search`; grant read-only còn phải mang memory scope đã duyệt và input phải chỉ rõ đúng `wing` được cấp theo schema thực đã thương lượng. Gateway không tự thêm `repositoryId` vào input upstream. Digest của wheel được pin; output phiên bản không phải bằng chứng của việc task thành công. | Palace nằm ngoài repository (`~/.mempalace`); Bflow không mine, sửa chữa hay ghi lại nó. |
| GitNexus | Pin tarball npm `gitnexus` chính thức; rà soát giấy phép của package được chọn. | `gitnexus --version`; `ensureGitNexusIndex` trước hết quan sát `status --json` có phiên bản, cho phép một index hiện hành đi qua trong khi Gateway giữ reader lock của nó. Một index cũ (stale) yêu cầu các writer lock của storage và machine, lần quan sát status thứ hai, `analyze <repo> --index-only` nếu vẫn stale, và status sau khi index đã được xác minh. Nó từ chối status sai định dạng/không được hỗ trợ thay vì suy ra độ mới từ exit code hay Git porcelain. MCP `initialize`/`tools/list` phải vượt qua `verifyMcpStartup`. | `--index-only` tránh việc GitNexus ghi AGENTS.md hay skill vào repository. Gateway nên launch `gitnexus mcp` đã pin với `GITNEXUS_MCP_ALLOWED_REPOS` và, khi phù hợp, `GITNEXUS_MCP_READ_ONLY=1`. Phân vùng theo repo/storage; không để các writer đồng thời dùng chung một LadybugDB store. Bản cài trước đó được giữ lại chính là rollback. |
| Chrome DevTools MCP | Pin tarball npm `chrome-devtools-mcp` chính thức. | Kiểm tra phiên bản server và phiên bản executable Chrome, sau đó kiểm tra khởi động MCP/tool discovery qua Gateway. `planChromeSession` từ chối Chrome `SingletonLock`. | Dùng `--userDataDir` dưới managed root của Bflow và `--executablePath` cho trình duyệt đã xác minh. Một profile cho mỗi repository/task, với exclusive resource lease của Gateway cho mỗi lần gọi page. Server khởi chạy Chrome ở lần dùng browser-tool đầu tiên. Không bao giờ kết nối với profile Chrome cá nhân. |
| Superpowers | Cài độc lập qua `claude plugin install`, `codex plugin add` và `agy plugin install`. `superpowersInstallRoute` ghi lại từng route. | Yêu cầu đúng phiên bản plugin đã bật, provenance marketplace đã xác minh, và `using-superpowers` trong active skill discovery. | Đặt namespace cho skill bên ngoài tách biệt với skill của Bflow. `TddDecision` của Bflow điều khiển TDD; mặc định của skill bên ngoài không được mở rộng chính sách hay bỏ qua gate. Việc cài từ provider marketplace có thể không tái tạo archive đã tải xuống từng byte một. Rollback native vẫn là thủ công. |

## Ma trận tương thích và nghiệm thu

| Kịch bản | Kết quả của package | Tích hợp hoặc bằng chứng live cần có |
| --- | --- | --- |
| Cài lần đầu / cài lần hai | Cài đặt staged với kiểm tra tính toàn vẹn và probe chức năng / `already_satisfied`. | Pin chính xác đã được duyệt, approval đáng tin cậy và lưu receipt qua MachineSetup. |
| Config hiện có / cập nhật thất bại | Config không thuộc sở hữu bị chặn; config owned có bản sao rollback. Executable hiện có được giữ lại khi bản cài staged mới thất bại. | Operator rà soát rollback trước khi xóa phiên bản trước đó. |
| Plugin không khả dụng hoặc probe thất bại | Planning yêu cầu một native adapter đã cấu hình; kích hoạt mà không có xác minh chức năng độc lập trả về `unknown`. | Cài đặt chính thức theo từng provider, kiểm thử hook/skill theo phiên bản cụ thể và kiểm tra provenance marketplace. |
| Khởi động MCP thất bại | `verifyMcpStartup` trả về blocked và không có capability. | P27 Gateway thực hiện thương lượng giao thức thật, ủy quyền, tool discovery và giới hạn restart. |
| Reader/writer GitNexus chặn việc rebuild | Trả về `busy` kèm rebuild cần thiết, đường dẫn lock được giữ lại và PID chủ sở hữu đã ghi, hoặc `owner unknown` cho các bản ghi legacy/không đọc được. Chẩn đoán hướng dẫn giải phóng reader/writer trước khi chạy lại setup đã được duyệt; nó giữ nguyên lock và không suy ra một tiến trình đang hoạt động từ sự tồn tại của lock. | Topology storage dùng chung và locking giữa nhiều host không được hỗ trợ. |
| Khóa profile trình duyệt | `profile_locked`; profile/resource key riêng cho task. | Gateway thực thi lease/fencing và định tuyến page; việc khởi chạy Chrome thật và cô lập theo từng page phải được kiểm thử. |

Các test của package này dùng fake command runner và HTTP probe. Chúng không chứng minh Herdr live, provider hook, tương thích MCP wire, việc khởi chạy Chrome hay mức đủ điều kiện giấy phép thương mại của GitNexus. `FileToolCapabilityRegistry` chỉ dành cho local filesystem; một crash có thể để lại lock file mà operator phải kiểm tra trước khi xóa.

Các test cấu hình RTK dùng một provider home dùng một lần và tiến trình tool giả, nên không đọc cấu hình hook của operator. Chúng vẫn thực thi các kiểm tra production từ chối global hook là symlink và các đăng ký RTK global/repository trùng lặp trước khi gọi tool. Việc cô lập test này không thay đổi chính sách đường dẫn production.

## Lệnh

Từ thư mục gốc repository: `pnpm exec tsc -b packages/tool-installer --pretty false` và `pnpm exec vitest run packages/tool-installer/test`. Các project reference TypeScript gốc và lockfile là file dùng chung do integrator sở hữu; integrator phải nối package này trong một thay đổi riêng đã được review.

## Tham chiếu chính thức

- [RTK installation and agent support](https://github.com/rtk-ai/rtk)
- [MemPalace on PyPI](https://pypi.org/project/mempalace/)
- [GitNexus CLI, MCP and repository policy](https://github.com/abhigyanpatwari/GitNexus) và [license](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)
- [Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- [Superpowers provider installation](https://github.com/obra/superpowers)

## Catalog setup mặc định đã rà soát

`defaultToolCatalog(os, arch)` chọn các artifact upstream cố định mà không cần truy cập mạng.
`createDefaultSetupConfiguration` của CLI đăng ký các pin đó và giữ nguyên các descriptor tường minh
của operator. Linux x64 gồm RTK, Herdr, Agy, Claude Code, Codex, GitNexus và
Chrome DevTools MCP; Linux ARM64 và macOS x64/ARM64 gồm tất cả trừ Agy. Các nền tảng khác
trả về các yêu cầu thủ công. Việc cài đặt nằm dưới thư mục machine `data/tools/<toolId>`
đã được duyệt; xác thực provider vẫn mang tính tương tác.

Catalog ghi các giá trị SHA-256 thực tế được tính từ artifact đã tải xuống và đối chiếu
với checksum GitHub/Herdr upstream, npm SHA-512 SRI, hoặc SHA-512 trong manifest của Agy. Các
dependency transitive của npm không phải là offline bundle được pin đầy đủ. GitNexus yêu cầu Node
`^22.18.0 || >=24.11.0` và rà soát giấy phép phi thương mại; các build script của native dependency
là tường minh. Npm installer upstream của Claude cũng yêu cầu postinstall script của nó.
Bản phát hành RTK được chọn bao gồm giấy phép engine BUSL-1.1 song song với giấy phép MIT của CLI.

Agy dùng native archive được liên kết từ [official installer](https://antigravity.google/docs/cli/install/).
Herdr dùng binary release thô từ [official release manifest](https://herdr.dev/latest.json).
Installer không thêm shell initialization, quyền provider, hook hay credential.
Superpowers dùng `NativeProvidersToolInstaller`, ghép một bản cài đặt theo từng provider
đã được duyệt cho mọi provider được chọn. Native runtime hiện có xác minh provenance của active-cache
và các policy overlay của Bflow. Metadata native của bundle đã duyệt được lưu trước khi
provider bị thay đổi, để một lệnh bị timeout có thể được đối chiếu với inventory đã bật của provider
và active cache chính xác. Chỉ riêng metadata không bao giờ xác lập việc đã cài đặt. Reconciliation
cũng kiểm tra bản cài được giữ lại khi một thư mục staging bị gián đoạn cũ thiếu metadata;
nó chỉ chấp nhận một pin mong muốn đã được xác minh độc lập và không bao giờ tạo receipt còn thiếu. Các
quan sát này để nguyên pending intent và các file staged. Một bản cài đầu tiên legacy có
plugin đã đăng ký và không có native receipt ở cả hai vị trí vẫn là `unknown` và cần operator
rà soát. Việc giao native không rõ kết quả được giữ lại
và không bao giờ tự động phát lại, với một ngoại lệ: khi inventory plugin của chính provider
đọc được và chứng minh không có phần nào của plugin được đăng ký, lần apply kế tiếp lưu trữ intent bị gián đoạn
(`<destination>.native-pending.json.reviewed-<id>`), bỏ thư mục staging của nó và cài
lại. Inventory không đọc được hoặc plugin đã đăng ký giữ step ở `unknown`. Việc validate plugin Agy
chạy không có `--strict` vì Superpowers upstream phát hành kèm các warning mà strict mode từ chối; các lỗi
manifest thật vẫn thất bại. Các thay đổi config provider native cần machine
setup approval. Isolated setup truyền `NativeRuntimeOptions.isolation` (HOME cùng
`CLAUDE_CONFIG_DIR` cho Claude và `CODEX_HOME` cho Codex) cho mọi tiến trình con của provider, và
chỉ đọc config provider từ các thư mục đó. Agy không có biến cô lập được ghi tài liệu,
nên isolated setup trì hoãn việc kích hoạt native của nó và báo step là `blocked` (fail closed).
Real setup không truyền isolation và giữ nguyên môi trường của caller. `additionalToolObservations` cung cấp mức sẵn sàng native về chức năng cho
machine setup doctor mà không giả vờ rằng file plugin là executable độc lập. Các yêu cầu launch MCP được trả về riêng cho scope Runtime/Gateway,
cô lập profile Chrome và thiết lập index đã xác minh; việc cài một server không đăng ký
hay khởi động nó. Kiểm tra phiên bản binary không xác lập mức sẵn sàng SDLC live.
