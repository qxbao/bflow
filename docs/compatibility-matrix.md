# Ma trận tương thích hiện tại

Đối chiếu source và các hồ sơ trong repo ngày 2026-10-25. **Source/local test, probe binary thật và full SDLC acceptance là các mức khác nhau**; xem [implementation status](implementation-status.md). Các phiên bản binary trong [provider report](provider-compatibility.md) và [E2E report](e2e-report.md) là quan sát lịch sử, không phải release allowlist hoặc kết quả thử lại ở HEAD.

## Hệ điều hành và filesystem

| Nền tảng | Setup/service | Workspace và verification | Bằng chứng, giới hạn |
| --- | --- | --- | --- |
| Linux, filesystem POSIX cục bộ | `systemd --user`, managed PATH, private XDG state | Descriptor-relative workspace tools; Bubblewrap sandbox | Có source/local tests và các hồ sơ daemon/binary thật trước đây; full live SDLC/active fault campaign còn mở |
| macOS arm64/APFS | `launchd`, managed PATH | Apple Command Line Tools cho helper; Seatbelt `deny default` cho JS/TS/owner commands | [Portability report](acceptance/2026-10-24-macos-portability.md) có phép đo thật và [follow-up tests](acceptance/2026-10-24-macos-portability-review.md); chưa full SDLC acceptance |
| macOS x86_64 | Cùng adapter Darwin | Source backend có sẵn | Không suy bằng chứng arm64 thành chứng nhận x86_64 |
| Checkout không giữ được private mode | Machine state vẫn cần POSIX filesystem | Runtime có private-state fallback ngoài repo, locator pin authority | Không làm NFS/NTFS trở thành nền tảng được chứng nhận; workspace/sandbox còn điều kiện riêng |
| Windows native | `designed_unverified`; machine mutation blocked | Không có verification sandbox được chứng nhận | Git Bash/WSL không phải bằng chứng Windows native |

Node.js **≥22.13**, pnpm **12.5.1**; [package.json](../package.json) pin pnpm. Linux cần `flock` util-linux; macOS cần bản `flock` hỗ trợ inherited fd. Python ≥3.11 cần cho profile sync. Network filesystem, multi-host, hostile same-UID và power-loss durability vẫn ngoài cam kết.

## Provider và role

| Khía cạnh | Claude Code | Codex CLI | Agy |
| --- | --- | --- | --- |
| Adapter | `ClaudeProviderAdapter` | `CodexProviderAdapter` | `AgyProviderAdapter` |
| Version floor ở adapter | ≥2.0.0, cùng các capability/flag bắt buộc | ≥0.150.0, cùng các capability/flag bắt buộc | ≥1.0.0, cùng các capability/flag bắt buộc |
| Conversation | Có đường trusted user-input hook | Có đường trusted user-input hook | **Unsupported**: thiếu trusted `UserPromptSubmit` |
| Specialist | Launch/readiness/native binding đã triển khai | Launch/readiness/native binding đã triển khai | Native hooks/config/shim và signed binding có source/local tests; không tuyên bố Developer/full SDLC acceptance |
| MCP | Scoped host stdio, Gateway HTTP | Scoped host stdio, Gateway HTTP/token env var | Native config trong HOME riêng; Gateway HTTP qua stdio shim |
| `restricted` / `workspace_auto` | Role policy, scoped MCP, host tool guard | Read-only/workspace-write sandbox, approval policy riêng | Plan/accept-edits; native file/shell bị deny, thao tác qua Bflow tools |
| `unattended_isolated` | Chỉ khi đầy đủ provider OS sandbox/container được xác minh | Cùng yêu cầu isolation | **Unsupported** (`agy_unattended_unsupported`) |
| Global config | Scoped launch settings/strict MCP; CLI có thể ghi per-project trust vào config người dùng khi `trustedWorkspace: true` | Global MCP bị thu hẹp; hooks cần quyết định operator riêng | HOME/XDG launch riêng; auth/onboarding phải đạt |
| Model/effort/profile | Theo role/provider defaults và capability | Theo role/provider defaults và capability | Effort nằm trong tên model; không khai field `effort` |

Không dùng global bypass cho bất kỳ permission mode nào. Sandbox của **test runner** không chứng minh isolation của **toàn bộ provider process**. Adapter permission compile không tự cung cấp deployment/container an toàn. [Provider contract](provider-contracts.md) và [permission compiler](../packages/agent-providers/src/permissions.ts) là nguồn tham chiếu.

Standalone `agent check` dùng adapter environment riêng, không đọc role/profile/model từ config và có thể chạy model probe. `mcp status` đọc inventory nhưng binary chưa nối live health port mặc định; dùng `doctor`/service status và `docs status` (Context7) để chẩn đoán.

`bflow up` và `doctor` mặc định dùng native auth/catalog, không model ping. `doctor --deep` là opt-in có thể tiêu hao usage. Readiness vẫn yêu cầu đúng launch/generation/native session, Ed25519 attestation, skills, permissions và MCP reachability. Agy auth/onboarding trong HOME launch cũng được kiểm tra; receipt copy hoặc Herdr `idle` không đủ.

## Herdr, tools và Gateway

| Thành phần | Đường tích hợp hiện tại | Mức hỗ trợ và giới hạn |
| --- | --- | --- |
| Herdr | Protocol 22/schema 1, CLI + Unix socket, env truyền khi tạo pane | Phải kiểm tra phản hồi/hành vi thực tế; không khóa release label |
| Shared Gateway | Loopback Streamable HTTP, stdio bridge, role/service/operation grants | Ledger/pinned schemas, structured output, unknown/quarantine; không làm kênh inter-role |
| RTK | CLI-only, formatter `pipe` trên raw output đã capture | Command gốc chạy một lần; parser/gate dùng raw status/output. Passthrough không được gọi là token saving |
| GitNexus | Stdio MCP, query/context/impact theo policy | Fresh repo index, workspace phù hợp, Runtime resource lease/fence theo registration; không tự rebuild trong task |
| MemPalace | Managed Python venv, MCP search qua Gateway | Read-only wing được resolve (mặc định repo ID), provenance/trusted artifact bắt buộc; memory không thay current spec/test |
| Context7 | Hosted MCP qua Gateway, anonymous/API key | Dùng chung giữa worktrees; optional cache, không OAuth; version/quota/network failure phải hiển thị |
| Chrome DevTools | Dedicated profile/resource APIs ở Gateway/services | Runtime browser tool actions có Gateway lease theo assignment transaction (source + test local, chưa live Chrome/provider/Herdr acceptance); gate `appChecks` dùng Chrome riêng trong sandbox; không dùng profile cá nhân |
| Canonical skills | Exact bundle pins, role bindings, manifests, `read_pinned_instructions` | Nội dung được load không chứng minh tuân thủ; không cấp capability/tool permission |

Phiên bản installer thực tế nằm trong [catalog đã review](../packages/tool-installer/README.md); đừng suy machine receipt đúng chỉ từ binary cùng tên trên PATH. [D-TOOLS-01](tools-sdlc-integration.md) quy định trigger, grant, usage và consumption.

## Verification runners

Runtime tự phát hiện các adapter hỗ trợ JS/TS (Vitest, Jest, Mocha, Node TAP), Python, Go, Rust, JVM, .NET, Ruby, PHP và CTest theo định dạng được mô tả trong [runner matrix](verification-runners.md). Source/parser coverage không phải real sandbox measurement cho mọi ecosystem.

| Đường thực thi | Linux | macOS |
| --- | --- | --- |
| JS/TS, owner Node TAP/Vitest | Bubblewrap, dependency mounts được kiểm tra | Seatbelt deny-default; cài dependency trước |
| Native polyglot mounts/reports | Có source và fixture tests theo adapter | Chưa hỗ trợ |
| Dependency warming | Linux-only, network sandbox/owned cache | Chưa hỗ trợ |
| Arbitrary command từ agent | Không cấp quyền | Không cấp quyền |

Mỗi criterion cần mapping/test identity đúng, status nhất quán và evidence độc lập; exit 0 không đủ. `.bflow/verification.json` là owner override tùy chọn, không phải điều kiện bắt buộc cho mọi repo.
