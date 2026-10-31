# Bổ sung tài liệu từ các commit mới trên main (8d86553..74f8d3f và nhánh ổn định Web)

Tiếp nối [đợt đối chiếu 2026-10-29 (`901caa6..8d86553`)](main-updates-2026-10-29.md) và [đợt 2026-10-25/27](main-updates-2026-10-25.md). Tài liệu này đối chiếu các thay đổi đã hợp nhất từ **`8d86553`** đến **`74f8d3f`** (bao gồm chuỗi gia cố toàn luồng Slice 1–8 trên `main`) cùng đợt ổn định UX/CLS và kiểm chứng SDLC thực tế trên Bflow Web (`fix/web/ux-stabilization`).

Mức bằng chứng của từng mục được ghi rõ theo 4 cấp độ của [trạng thái triển khai](implementation-status.md): **source**, **local tests**, **live probe có phạm vi**, và **full SDLC acceptance**.

---

## 1. Tài liệu thư viện, CLI chẩn đoán và Machine Setup (Slice 1–3)

| Commit | Hành vi/source đã cập nhật | Tài liệu liên quan |
| --- | --- | --- |
| `ebad431` · `de56f4c` | Thay thế hoàn toàn Context7 bằng **DeepWiki** (`use-deepwiki`, dịch vụ MCP từ xa không cần API key cho kho công khai, giải mã phong bì kết quả MCP lồng nhau) | [Skills catalog](../skills/README.md), [Known limitations](known-limitations-v3.md) |
| `cc28707` · `73558fb` | **Slice 1:** `bflow mcp status` tự động khám phá Gateway cấp máy qua `setup-gateway.json` + biên nhận `setup-gateway-ready.json` còn tươi (≤ 60 giây), kiểm tra PID sống và probe loopback `/health` (`withDefaultMcpGateway`); `bflow status` bổ sung quan sát độ lệch Runtime (`observeAuthoritativeRuntime`); `docs-gateway` hỗ trợ luồng SSE; làm sạch `PATH` và `fsync` cho `machine-setup` / `tool-installer` | [High-level CLI](../apps/cli/docs/command-reference.md), [Implementation status](implementation-status.md) |
| `e43d396` · `69f1e25` | **Slice 2:** chuẩn hóa `PATH` khi khởi chạy Developer, tuần tự hóa thu hồi pane trong `RolePaneManager`, củng cố ghi nhận workspace trust cho Codex, chịu lỗi `fsync` thư mục trên hệ tệp FUSE/NTFS (`EINVAL`/`ENOTSUP`/`EPERM`) | [Pane Manager](../packages/pane-manager/README.md), [Agent providers](../packages/agent-providers/README.md) |
| `ecea1fd` · `45bc207` | **Slice 3:** single-flight và ngân sách thời gian thao tác cho `herdr-adapter`; chuẩn hóa SSE/envelope và sổ cái bền vững của `mcp-gateway`; quản lý vòng đời tiến trình trình duyệt/dịch vụ OS trong `mcp-services`; gia cố bộ nhớ đệm `docs-retrieval` | [Shared MCP architecture](shared-mcp-architecture.md) |
| `e3ebae1` | Tắt cảnh báo thử nghiệm `node:sqlite` trên Node 22 ở CLI (`quiet-sqlite-warning.ts`); hiển thị rõ trạng thái `unknown_delivery` trong projection | [CLI README](../apps/cli/README.md) |

---

## 2. Runtime, SDD/TDD, Verification Sandbox và Khám phá lỗi trạng thái (Slice 5–8)

| Commit | Hành vi/source đã cập nhật | Tài liệu liên quan |
| --- | --- | --- |
| `1d29112` · `3c64964` · `8d20906` · `106502f` · `5503cba` · `0594f92` · `6676dcb` | Giảm thiểu lỗi `E2BIG` cho payload lớn: tham chiếu intent bền vững cho native delivery lớn, giới hạn kích thước prompt policy phase, phân trang kiểm tra policy của QA không lộ tệp bảo vệ, phục hồi prelaunch phase từ journal có khóa qua lần mở lại host | [E2BIG validation](reliability/e2big-mitigation-validation.md), [Real incident](reliability/real-incident-investigation.md) |
| `4b72d47` · `6d45e3a` · `b534e5e` · `d4ff767` · `0883c30` | Tự phục hồi có giới hạn khi lỗi cấp phát Developer tạm thời; cho phép rào chắn báo cáo `blocked` từ specialist pane đã nghỉ; hiển thị lease sửa chữa hết hạn để người vận hành chủ động `resume`; đối soát hủy từ Web bị ngắt trước khi xếp hàng | [Runtime README](../packages/runtime/README.md) |
| `5b76ccb` · `1b6959f` · `dfa8796` | **Slice 6:** bảo vệ vòng đời watchdog khi `workspace`/`manifest` chưa kích hoạt xong hoặc đang `quiescing`/`closing`; giữ lease cho thông báo điều khiển hoãn (`policy_phase_outcome`, `user_decision_answer`); khóa journal và đối soát ingress | [Live runtime validation](reliability/live-runtime-validation.md) |
| `53e78b6` · `89c709a` | **Slice 5:** gia cố phân loại/truy vết SDD, bộ giải quyết bằng chứng Conditional TDD, ngữ nghĩa hủy/chặn trên DAG của Core, SQLite `RunStore`, `ArtifactStore` và `AgentRegistry` | [SDLC policies](sdlc-policies.md) |
| `4fdc9e7` · `9ad460b` | **Slice 7:** chuẩn hóa `PATH`/`fsync` trong `developer-process-scope`, phân loại assertion và suite có lọc của Vitest JSON reporter, hỗ trợ Git worktree trên FUSE/NTFS và rút cạn đường ống (pipe drain) | [Verification runners](verification-runners.md) |
| `7206ee6` · `182cb86` · `74f8d3f` | **Slice 8:** gia cố máy trạng thái workflow agentic, đối soát hủy sau khi hết hạn lease, thông báo tác vụ và công cụ theo vai trò; kiểm thử đảm bảo prompt Coordinator điều hướng qua `task.status` | [Runtime README](../packages/runtime/README.md) |
| `936dac3` .. `71e8389` | Chiến dịch khám phá lỗi có trạng thái (stateful fault exploration) và bộ hồ sơ độ tin cậy dưới `docs/reliability/` | [Stateful exploration](reliability/stateful-exploration-results.md) |

---

## 3. Giao diện Bflow Web, Cẩm nang người dùng và Kiểm chứng SDLC thực tế (Slice 4 & UX Stabilization)

| Commit / Nhánh | Hành vi/source đã cập nhật | Tài liệu liên quan |
| --- | --- | --- |
| `8df798c` · `9ee620a` · `4d457b6` · `0892e66` · `c15aab2` · `d1091c8` | Làm rõ trạng thái lượt chạy/khôi phục cho người vận hành; cho phép chat Web của Claude sau khi xác minh readiness trước transcript đầu tiên; commit cấu hình Web đã duyệt kể cả khi `.bflow` nằm trong rule ignore mặc định | [Web README](../apps/web/README.md) |
| `2dc6441` · `5dcf71a` | **Slice 4:** định tuyến bí danh tiếng Việt và câu hỏi làm rõ trong Conversation; chống lặp chữ ký vòng làm mới 3 giây trên `Operations`; khử trùng lặp cursor SSE và tự nối lại khi trình duyệt phát sự kiện `online`; tự mở slot thao tác mới sau khi thao tác trước đã chốt (`applied`/`failed`); mở khóa `ChatComposer` khi lỗi từ chối dứt khoát trước tiếp nhận; tự động hỏi vòng 2,5 giây khi phiên ở trạng thái chuyển tiếp `starting`/`stopping` | [Web README](../apps/web/README.md), [Local Server README](../apps/local-server/README.md) |
| `559e089` · `4e86cb4` (`fix/web/ux-stabilization`) | **Ổn định UX/CLS & gỡ bỏ điểm nghẽn SDLC thực tế qua Web:**<br/>• Nâng hạn mức thời gian chờ HTTP socket và client cho các thao tác nhiều vai trò (`POST /session/inspect` 45s/55s, `GET /preview` 15s/25s, `POST /commands` & `GET /operations/:id` & chat 35s/40s; giữ `deliverLifecycle` 5s).<br/>• Ghi sẵn workspace trust của Claude Code 2.x trên cả `~/.claude/.claude.json` và `ORCA_CLAUDE_CONFIG_DIR`; đặt `MCP_TIMEOUT=120000` cho phiên Claude và trả chuẩn JSON-RPC `-32601` cho `server/discover` trong `runRoleMcp` để 7/7 vai trò kết nối MCP ổn định khi khởi động đồng thời.<br/>• Giữ lease `conditional_evidence` của QA trong giai đoạn trễ nhắc lệnh TUI trước lượt chạy (`outbox.ts`/`runtime.ts`).<br/>• Tái cấu trúc mật độ giao diện và loại bỏ hoàn toàn dịch chuyển bố cục khi làm mới ngầm (**`CLS = 0.00000`**, `maxAnchorShiftPx = 0px`; chiều cao trang `Cài đặt dự án` giảm **64,6%** từ `10.125px` xuống `3.587px`, `Chi tiết công việc` giảm **35,0%**, `Tổng quan` giảm **28,4%**; thanh chọn nhanh Provider/Model 1 cú nhấp cho mọi vai trò; thu gọn danh sách tài liệu kiểm chứng dài và chẩn đoán kỹ thuật; dịch tiêu đề phê duyệt Runtime sang tiếng Việt dễ hiểu).<br/>• Hoàn thành một lượt chạy **SDLC đầu-cuối thực tế điều khiển hoàn toàn qua Bflow Web** trên trình duyệt Chrome thật với Herdr `0.9.5` + Claude Code `v2.1.316` (`run-web-c72842ea-a325-4305-833e-760d560e095b`, `sdlcStatus: completed`, `coreStatus: succeeded`, duyệt cả đặc tả và gói bàn giao 14 bằng chứng trên trình duyệt).<br/>• Biên soạn [Cẩm nang sử dụng Bflow Web có ảnh chụp màn hình từng bước](guide/web-manual.md). | [Báo cáo ổn định Web UX & SDLC](reliability/web-ux-stabilization.md), [Cẩm nang người dùng Web](guide/web-manual.md) |

---

## 4. Ranh giới bằng chứng cần giữ đúng

- Lượt chạy SDLC thực tế qua Bflow Web (`run-web-c72842ea-a325-4305-833e-760d560e095b`) chứng minh đường **Chrome thật → Bflow Web → Local Server → Conversation/Runtime → Herdr `0.9.5` → Claude Code `v2.1.316` → Conditional TDD → Reviewer/QA độc lập → Git integration → duyệt bàn giao trên Web → `completed`/`succeeded`** trong môi trường cô lập một provider.
- Bằng chứng này **chưa đóng** nghiệm thu đa provider (`PV3-01` trên toàn bộ tổ hợp Claude/Codex/Agy), chiến dịch tiêm lỗi/SIGKILL giữa lượt provider đang sửa mã (`RR-02`/`RR-19`), hay nghiệm thu `appChecks` Chrome thật trong luồng nhiều dịch vụ.
- Các extension thư viện BA-only, QA-only và data verification vẫn chưa nối vào `bflow up`/CLI/Web.
