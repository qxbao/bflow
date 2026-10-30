# @bflow/docs-retrieval

Đọc tài liệu của một repository GitHub **công khai** qua DeepWiki (hoặc bất kỳ caller nào cung cấp cùng ba MCP tool `ask_wiki_question`,
`read_wiki_contents`, `read_wiki_structure`), và báo cáo chính xác những gì nhận về. Package này replaced the legacy Context7 client
(`resolve-library-id` / `query-docs`); API công khai thay đổi theo đó (migration: `DocsClient.lookup`/`search` được thay bằng
`ask`/`structure`/`contents`). Là một leaf package: không có workspace dependency, không có code mạng riêng. Caller
(`DocsToolCaller`) được inject; CLI cung cấp một caller đi qua MCP Gateway dùng chung với registration riêng của agent. DeepWiki không cần API key.

## Chức năng

- `DocsClient.ask({ repoName, visibility, question })` gọi `ask_wiki_question` với đúng `{ repoName, question }`; `structure` và `contents` gọi
  `read_wiki_structure` / `read_wiki_contents` với đúng `{ repoName }`. Khai báo `visibility` chỉ được kiểm tra cục bộ và không bao giờ được gửi đi.
- Chỉ repository được chỉ định rõ mới được hỏi: `repoName` phải là `owner/repo` (không phải URL, Git remote hay đường dẫn) và
  `visibility` phải đúng bằng `"public"`. Việc công khai không bao giờ được suy ra từ Git remote hay hình dạng của `owner/repo`.
  Ngoại lệ duy nhất là `library` khớp chính xác (không phân biệt hoa thường) một mục của bảng ánh xạ rõ ràng (`resolveRepository`, ví dụ `react` ->
  `facebook/react`); tên gần giống hoặc không biết trả `library_not_found` và không gọi gì.
- `checkQuestion` chặn câu hỏi rỗng hoặc dài quá 2000 ký tự, câu hỏi chứa credential (token GitHub, AWS, PEM, Bearer, khóa cũ...), khối mã hoặc
  nhiều dòng nhìn như mã nguồn. Văn bản khớp không bao giờ được lặp lại trong thông báo lỗi. Không có mã nguồn, repository riêng tư hay secret nào rời máy.
- `probe()` khám phá tool rồi gọi `read_wiki_structure` cho một repository công khai nổi tiếng; dùng bởi `docs status`, `doctor` và `docs probe`.
- `detectInstalledVersion(root, library)` đọc phiên bản mà dự án thực sự dùng: lockfile trước (`package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `go.mod`, `Cargo.lock`), sau đó
  manifest (`package.json`, `requirements*.txt`, `pyproject.toml`). Nó cho biết phiên bản có chính xác (exact) hay không. DeepWiki mô tả nhánh
  mặc định nên phiên bản này chỉ để người dùng đối chiếu, không được gửi đi.
- `classifyToolError` / `classifyGatewayError` phân tách `network`, `timeout`, `rate_limited`, `library_not_found`, `no_documentation`,
  `invalid_arguments`, `permission_denied`, `unavailable`, `upstream_error` và `protocol`. Hosted server báo cáo một số trong đó bằng HTTP 200 và
  `isError`, nên văn bản được parse. Cách diễn đạt của DeepWiki cho repository chưa index, rate-limit và quota được khớp một cách lỏng.
- Cache tùy chọn (`MemoryDocsCache`, `FileDocsCache`): key = repository + câu hỏi, đã hash; câu hỏi không bao giờ
  được lưu; thư mục `0700`, file `0600`; TTL, giới hạn kích thước, vô hiệu hóa theo repository hoặc toàn bộ, bộ đếm hit/miss/eviction. Lỗi
  không bao giờ được cache.

## Evidence

Unit test dùng nội dung inline (không đọc file fixture) ghi lại hình dạng phản hồi của DeepWiki. Test dịch vụ thật
nằm ở `apps/cli/test/context7-live.test.ts` (legacy file name kept from the Context7 era) và chỉ chạy với `BFLOW_TEST_LIVE_DEEPWIKI=1`. Bằng chứng live thật do owner chạy bằng
`bflow docs probe --live`; kết quả ghi `mode=live|fixture|skipped` cùng timestamp và revision, và chỉ `live` mới là bằng chứng live. Các file trong `test/fixtures` là
tư liệu legacy từ thời Context7, không được dùng nữa.

## Không bao phủ

DeepWiki không có API key, OAuth hay phiên bản theo từng release. Hỗ trợ lockfile chỉ bao phủ các định dạng nêu trên. Kiểm tra quota và Windows chưa được triển khai.
