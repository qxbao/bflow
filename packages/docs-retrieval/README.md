# @bflow/docs-retrieval

Tra cứu tài liệu thư viện hiện hành, theo đúng phiên bản qua Context7 (hoặc bất kỳ caller nào cung cấp cùng hai MCP
tool đó), và báo cáo chính xác những gì nhận về. Là một leaf package: không có workspace dependency, không có code mạng riêng. Caller
(`DocsToolCaller`) được inject; CLI cung cấp một caller đi qua MCP Gateway dùng chung với registration riêng của agent.

## Chức năng

- `detectInstalledVersion(root, library)` đọc phiên bản mà dự án thực sự dùng: lockfile trước (`package-lock.json`,
  `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `go.mod`, `Cargo.lock`), sau đó
  manifest (`package.json`, `requirements*.txt`, `pyproject.toml`). Nó cho biết phiên bản có chính xác (exact) hay không. Các biến thể tên
  (`next.js` -> `next`) được thử. Việc tìm kiếm bắt đầu ở `options.from` và đi lên tới root, nên một workspace package được tìm thấy
  từ thư mục của chính nó và lockfile đặt ở workspace root được sử dụng. Lockfile có nhiều bản sao không thể gắn với range đã khai báo thì
  không bị đoán: phiên bản thấp nhất của manifest được trả về dưới dạng inexact. Các parser lockfile nhỏ và khoan dung về định dạng, không đầy đủ.
- `parseResolveResult` / `selectLibrary` / `selectVersion` parse văn bản `resolve-library-id` của Context7 và chọn một library và một
  phiên bản. Một tên không xác định khiến Context7 trả về các library gần nhất nhưng không liên quan, nên một ứng viên chỉ đủ điều kiện nếu title hoặc id
  của nó chứa tên được yêu cầu. Library cung cấp phiên bản của dự án được xếp trên library không có. Phiên bản được chọn là
  phiên bản chính xác, nếu không thì phiên bản gần nhất bằng hoặc thấp hơn trong cùng minor, rồi cùng major. Nó không bao giờ chuyển sang bản phát hành mới hơn; khi
  không có gì khớp nó nói rõ và liệt kê những gì được cung cấp.
- `DocsClient` chạy resolve -> choose -> query, ghi lại phiên bản được yêu cầu và phiên bản được dùng, và trả về các lỗi có kiểu.
  `probe()` thực hành việc khám phá và cả hai tool với các query công khai.
- `classifyToolError` / `classifyGatewayError` phân tách `network`, `timeout`, `auth_missing`, `auth_invalid`, `rate_limited`,
  `library_not_found`, `version_not_found`, `no_documentation`, `invalid_arguments`, `permission_denied`, `unavailable`,
  `upstream_error` và `protocol`. Hosted server báo cáo một số trong đó bằng HTTP 200 và `isError`, nên văn bản được parse.
  Cách diễn đạt rate-limit và quota **chưa được quan sát** (không thể kích hoạt) và được khớp một cách lỏng.
- Cache tùy chọn (`MemoryDocsCache`, `FileDocsCache`): key = library id + version + query + language, đã hash; query không bao giờ
  được lưu; thư mục `0700`, file `0600`; TTL, giới hạn kích thước, vô hiệu hóa theo library hoặc toàn bộ, bộ đếm hit/miss/eviction. Lỗi
  không bao giờ được cache. Với API key, câu trả lời có thể đến từ các library riêng tư, nên chúng không được cache trừ khi có `allowAuthenticated`.

## Evidence

Unit test parse các phản hồi được thu từ dịch vụ hosted vào 2026-10-19 (`test/fixtures`, xem README của nó). Các test dịch vụ thật
nằm ở `apps/cli/test/context7-live.test.ts` và chỉ chạy với `BFLOW_TEST_LIVE_CONTEXT7=1`.

## Không bao phủ

Việc cache tài liệu vượt quá những gì điều khoản của chính Context7 cho phép là trách nhiệm của operator. Hỗ trợ lockfile chỉ bao phủ các
định dạng nêu trên. OAuth, kiểm tra quota và Windows chưa được triển khai.
