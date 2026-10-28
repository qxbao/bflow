import { parseAllDocuments, stringify } from "yaml";

const MAX_CONFIG_ALIASES = 32;

/** Parses the YAML 1.2 configuration subset used by Bflow, rejecting ambiguous documents. */
export function parseConfigYaml(content: string): unknown {
  const documents = parseAllDocuments(content, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    strict: true
  });
  if (documents.length !== 1) throw new Error("Configuration must contain exactly one YAML document.");
  const document = documents[0]!;
  if (document.errors.length) throw new Error(`Invalid YAML configuration: ${document.errors[0]!.message}`);
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if ("tag" in node && (node as { tag?: unknown }).tag !== undefined)
      throw new Error("Explicit YAML tags are not supported in configuration.");
    if ("items" in node && Array.isArray((node as { items?: unknown }).items)) {
      for (const item of (node as { items: unknown[] }).items) {
        if (item && typeof item === "object" && "key" in item && "value" in item) {
          const keyNode = (item as { key: unknown }).key;
          if (!keyNode || typeof keyNode !== "object" || !("value" in keyNode) || typeof (keyNode as { value: unknown }).value !== "string")
            throw new Error("Configuration mapping keys must be strings.");
          if ((keyNode as { value: string }).value === "<<") throw new Error("YAML merge keys are not supported in configuration.");
          visit(keyNode);
          visit((item as { value: unknown }).value);
        } else visit(item);
      }
    }
    if ("value" in node) visit((node as { value: unknown }).value);
  };
  visit(document.contents);
  try {
    const value = document.toJS({ maxAliasCount: MAX_CONFIG_ALIASES });
    const assertAcyclic = (current: unknown, stack: Set<object>): void => {
      if (current === null || typeof current !== "object") return;
      if (stack.has(current)) throw new Error("Cyclic YAML aliases are not supported in configuration.");
      stack.add(current);
      for (const child of Array.isArray(current) ? current : Object.values(current)) assertAcyclic(child, stack);
      stack.delete(current);
    };
    assertAcyclic(value, new Set());
    return value;
  } catch (error) {
    throw new Error(`Invalid YAML configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Renders a human-editable YAML config with frequently changed role choices first. */
export function stringifyConfigYaml(value: unknown): string {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Configuration must be an object.");
  const root = data as Record<string, unknown>;
  const env = root["environment"] && typeof root["environment"] === "object" && !Array.isArray(root["environment"])
    ? root["environment"] as Record<string, unknown>
    : undefined;
  const ordered: Record<string, unknown> = {};
  if (env) {
    const envOrdered: Record<string, unknown> = {};
    if (Array.isArray(env["roles"])) envOrdered["roles"] = env["roles"];
    const envOrder = [
      "defaults",
      "specialistProfiles",
      "sdd",
      "tdd",
      "verification",
      "fastPath",
      "concurrency",
      "startupTimeoutMs",
      "shutdownTimeoutMs",
      "allowProviderFallback",
      "permissions",
      "tools",
      "requiredMcpServices",
      "requiredTools",
      "toolPolicy",
      "context7",
      "skills",
      "repositoryId",
      "workspaceRoot",
      "sessionName",
      "herdrBinary"
    ];
    for (const key of envOrder) if (key in env) envOrdered[key] = env[key];
    for (const [key, item] of Object.entries(env)) if (!(key in envOrdered) && key !== "roles") envOrdered[key] = item;
    ordered["environment"] = envOrdered;
  }
  for (const [key, item] of Object.entries(root)) if (key !== "environment") ordered[key] = item;
  return stringify(ordered, { lineWidth: 100, aliasDuplicateObjects: false, sortMapEntries: false });
}

export function renderEnvironmentConfigYaml(value: unknown): string {
  const rolesBanner = [
    "environment:",
    "  # ============================================================================",
    "  # 1. CẤU HÌNH VAI TRÒ AGENT (ROLES) & PROVIDER PROFILES",
    "  # ============================================================================",
    "  # Danh sách các vai trò (role) trong quy trình Bflow Agentic SDLC.",
    "  # Các giá trị enum hợp lệ cho trường `role`:",
    "  #   - conversation : Cổng giao tiếp duy nhất với người dùng (`bflow attach`), làm rõ yêu cầu & nhận phê duyệt.",
    "  #   - coordinator  : Điều phối viên kỹ thuật, phân rã DAG tác vụ, quyết định SDD/TDD và giao việc qua Runtime.",
    "  #   - planner      : Lập kế hoạch triển khai chi tiết và thứ tự phụ thuộc tác vụ.",
    "  #   - architect    : Thiết kế kiến trúc, ranh giới module và đánh giá rủi ro kỹ thuật.",
    "  #   - specifier    : Phân tích yêu cầu và viết đặc tả kỹ thuật (`Specification` & `AcceptanceCriteria`).",
    "  #   - developer    : Template cho Developer agent được spawn động theo từng task/worktree (`required: false`).",
    "  #   - tester       : (Tuỳ chọn) Chuyên trách kiểm thử tự động / tái hiện lỗi độc lập.",
    "  #   - reviewer     : Kiểm tra chất lượng code (Code Review) đối chiếu với đặc tả và tiêu chuẩn.",
    "  #   - security     : (Tuỳ chọn) Kiểm tra bảo mật, quyền hạn và lỗ hổng.",
    "  #   - qa           : Kiểm định chất lượng cuối cùng (Quality Assurance) trước khi hoàn tất.",
    "  #",
    "  # Các trường cấu hình cho mỗi phần tử trong `roles`:",
    "  #   - cli            : (Bắt buộc, enum: `codex` | `claude` | `agy`)",
    "  #                      Provider CLI thực thi role (`codex`: OpenAI Codex, `claude`: Claude Code, `agy`: Antigravity).",
    "  #   - required       : (Tuỳ chọn, boolean: `true` | `false`, mặc định: `true` trừ `developer` là `false`)",
    "  #                      `true` = khởi tạo pane cố định khi `bflow up` (bắt buộc với `conversation` và `coordinator`).",
    "  #                      `false` = chỉ làm template cấu hình khi Runtime spawn động theo task.",
    "  #   - model          : (Tuỳ chọn, string) Tên model cụ thể. Nếu bỏ trống sẽ dùng model mặc định của CLI.",
    "  #                      + Gợi ý cho `claude`: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`",
    "  #                      + Gợi ý cho `codex` : `gpt-5.4`, `gpt-5.4-mini`, `o3`",
    "  #                      + `agy`: dùng đúng id do `agy models` liệt kê (catalog thay đổi theo tài khoản/phiên bản);",
    "  #                        preflight chặn id không có trong catalog vì Agy tự chạy model mặc định thay vì báo lỗi.",
    "  #   - effort         : (Tuỳ chọn, enum: `minimal` | `low` | `medium` | `high` | `xhigh` | `max`)",
    "  #                      Mức độ suy luận (reasoning effort). KHÔNG khai báo `effort` khi `cli: agy`.",
    "  #   - profile-name   : (Tuỳ chọn, string `[A-Za-z0-9._-]+`) Tên profile `ai-isolator` riêng cho role này.",
    "  #   - permissionMode : (Tuỳ chọn, enum: `restricted` | `workspace_auto` | `unattended_isolated`)",
    "  #                      Ghi đè chế độ quyền hạn cho riêng role này.",
    "  #   - fallbackCli    : (Tuỳ chọn, enum: `claude` | `codex` | `agy`) Provider dự phòng khi `allowProviderFallback: true`.",
    "  #   - requiredEnv    : (Tuỳ chọn, string[]) Danh sách biến môi trường bắt buộc phải tồn tại khi khởi chạy.",
    "  #   - skills         : (Tuỳ chọn, string[]) Danh sách skill ID bổ sung gắn riêng cho role.",
    "  #",
    "  # Optional existing ai-isolator profiles: set defaults.<codex|claude|agy>.profile-name here.",
    "  # Example provider defaults:",
    "  # defaults:",
    "  #   codex:",
    "  #     profile-name: work",
    "  #   claude:",
    "  #     profile-name: personal",
    "  #   agy:",
    "  #     profile-name: work",
    "  # A role's profile-name overrides its provider default; add it to the existing role entry.",
    "  # Example role override:",
    "  # - role: coordinator",
    "  #   cli: codex",
    "  #   profile-name: lead",
    "  # Missing profiles block startup; bflow up does not create one or fall back to the account HOME.",
    "  # Pick a CLI and optional model per role. Omit model to use the provider default.",
    "  # Example model override:",
    "  # - role: developer",
    "  #   cli: codex",
    "  #   model: <provider-specific-model>",
    "  #   effort: high",
    "  roles:"
  ].join("\n");

  const defaultsBanner = [
    "  # Cấu hình profile `ai-isolator` mặc định cho từng Provider CLI (`codex`, `claude`, `agy`).",
    "  # Có thể thêm `profile-name: <tên-profile>` bên dưới từng provider nếu muốn dùng chung cho mọi role.",
    "  defaults:"
  ].join("\n");

  const sddBanner = [
    "  # ============================================================================",
    "  # 2. CHÍNH SÁCH QUY TRÌNH SDLC, TDD, KIỂM CHỨNG & ĐỒNG THỜI",
    "  # ============================================================================",
    "  # SDLC policy and runtime limits are usually left at their defaults.",
    "  # Chính sách Spec-Driven Development (SDD):",
    "  #   - minimumLevel     : (enum: `lightweight` | `full`, mặc định: `lightweight`)",
    "  #                        + `lightweight` : Đặc tả gọn nhẹ cho thay đổi nhỏ/tiêu chuẩn, vẫn bắt buộc có Acceptance Criteria.",
    "  #                        + `full`        : Đặc tả đầy đủ (kiến trúc, rủi ro, kế hoạch kiểm thử chi tiết) cho mọi yêu cầu.",
    "  #   - approvalRequired : (boolean: `true` | `false`, mặc định: `true`)",
    "  #                        + `true`  : Bắt buộc người dùng phê duyệt bản đặc tả/thiết kế trước khi lập kế hoạch & code.",
    "  #                        + `false` : Tự động chuyển tiếp sau khi đặc tả hợp lệ.",
    "  sdd:"
  ].join("\n");

  const tddBanner = [
    "  # Chính sách Test-Driven Development (TDD):",
    "  #   - policy : (enum: `conditional`, mặc định: `conditional`)",
    "  #              Coordinator/TestStrategyResolver tự động phân loại từng task thành:",
    "  #              + `required`       : Bắt buộc tuân thủ chu trình Red -> Green -> Refactor có bằng chứng.",
    "  #              + `recommended`    : Khuyến nghị viết test trước khi triển khai.",
    "  #              + `not_applicable` : Không áp dụng TDD trực tiếp, bắt buộc có bằng chứng kiểm chứng thay thế.",
    "  tdd:"
  ].join("\n");

  const verificationBanner = [
    "  # Chính sách Vòng lặp Kiểm chứng (Verification Loop):",
    "  #   - maxIterations : (integer: `1..100`, mặc định: `3`) Số vòng lặp kiểm chứng & sửa lỗi (rework) tối đa cho mỗi task.",
    "  #   - onExhausted   : (enum: `require_human`, mặc định: `require_human`)",
    "  #                     Khi vượt quá `maxIterations` mà chưa đạt tiêu chuẩn, leo thang để xin quyết định từ người dùng.",
    "  #   - regressionScope: affected | full | mapped_only (mặc định: `affected`)",
    "  #                      + `affected`    : Chạy kiểm thử liên quan đến các file thay đổi trong phạm vi task/run.",
    "  #                      + `full`        : Chạy toàn bộ bộ kiểm thử (full regression suite) của repository.",
    "  #                      + `mapped_only` : Chỉ chạy các lệnh kiểm thử được ánh xạ trực tiếp tới tiêu chí nghiệm thu.",
    "  #   - reviewTimeoutMs : (integer ms: `60000..3600000`, mặc định: `900000`) Thời gian tối đa chờ một phiên Reviewer/QA độc lập trả kết quả.",
    "  #                      Không ghi khóa này nếu dùng mặc định; tăng giá trị khi review trên repository lớn bị hết giờ.",
    "  verification:"
  ].join("\n");

  const fastPathBanner = [
    "  # Fast-path: thay đổi nhỏ (trivial) chạy ít bước hơn và tự duyệt design; bạn vẫn duyệt bàn giao. mode: auto | off (mặc định: auto).",
    "  fastPath:"
  ].join("\n");

  const concurrencyBanner = [
    "  # Giới hạn thực thi đồng thời & Thời gian chờ (Timeouts):",
    "  #   - concurrency.maxConcurrency : (integer: `1..64`, mặc định: `2`) Số lượng Developer task chạy song song tối đa.",
    "  #   - startupTimeoutMs           : (integer: `1..600000`, mặc định: `300000`) Timeout (ms) khi `bflow up` khởi động.",
    "  #   - shutdownTimeoutMs          : (integer: `1..600000`, mặc định: `30000`) Timeout (ms) khi `bflow down` dừng.",
    "  #   - allowProviderFallback      : (boolean: `true` | `false`, mặc định: `false`) Cho phép chuyển sang `fallbackCli`.",
    "  concurrency:"
  ].join("\n");

  const permissionsBanner = [
    "  # ============================================================================",
    "  # 3. CHÍNH SÁCH QUYỀN HẠN & CÔ LẬP (PERMISSIONS & ISOLATION)",
    "  # ============================================================================",
    "  #   - mode             : (enum: `restricted` | `workspace_auto` | `unattended_isolated`, mặc định: `workspace_auto`)",
    "  #                        + `restricted`          : Chế độ hạn chế, chỉ cho phép các thao tác an toàn tối thiểu.",
    "  #                        + `workspace_auto`      : Tự động cho phép đọc/ghi và chạy lệnh trong phạm vi workspace/worktree.",
    "  #                        + `unattended_isolated` : Tự động hoàn toàn trong môi trường cô lập (đòi hỏi `os_sandbox` hoặc `container`).",
    "  #   - isolation        : (enum: `provider_policy` | `os_sandbox` | `container`, mặc định: `provider_policy`)",
    "  #                        + `provider_policy` : Kiểm soát quyền bằng cơ chế gốc của CLI provider kết hợp Git worktree.",
    "  #                        + `os_sandbox`      : Cô lập bằng sandbox cấp hệ điều hành.",
    "  #                        + `container`       : Cô lập trong container độc lập.",
    "  #   - trustedWorkspace : (boolean: `true` | `false`, mặc định: `true`) Đánh dấu tin cậy thư mục dự án hiện tại.",
    "  permissions:"
  ].join("\n");

  const toolsBanner = [
    "  # ============================================================================",
    "  # 4. CẤU HÌNH CÔNG CỤ TÍCH HỢP (INTEGRATED TOOLS, CONTEXT7 & SKILLS)",
    "  # ============================================================================",
    "  # Nguyên tắc mặc định: TẤT CẢ các công cụ tích hợp đều ĐƯỢC PHÉP sử dụng (`enabled: true`, `required: false`)",
    "  # ngay cả khi không khai báo trong file config. Chỉ khi khai báo rõ `enabled: false` thì công cụ mới bị tắt.",
    "  #   - rtk                 : Rust Token Killer (CLI-only) - lọc/tối ưu đầu ra lệnh test & build cho `developer`, `reviewer`, `tester`, `qa`.",
    "  #                           Tuỳ chọn thêm `cliCommandProfiles: [\"unit-test\", ...]` nếu muốn giới hạn profile lệnh.",
    "  #   - gitnexus            : Đồ thị mã nguồn & phân tích tác động phụ thuộc qua MCP cho `architect`, `developer`, `reviewer`, `security`.",
    "  #   - mempalace           : Bộ nhớ ngữ cảnh lịch sử chỉ-đọc qua MCP cho `developer`, `qa`, `security`.",
    "  #                           Tuỳ chọn thêm `wing: <tên-wing>` (mặc định: `repositoryId`) và `serviceId: <id>`.",
    "  #   - chrome-devtools-mcp : Kiểm tra giao diện & trình duyệt qua Chrome DevTools MCP cho `tester`, `qa`.",
    "  # Trong mỗi công cụ:",
    "  #   - enabled  : (boolean: `true` | `false`, mặc định: `true`) Bật/tắt quyền sử dụng công cụ trong dự án.",
    "  #   - required : (boolean: `true` | `false`, mặc định: `false`)",
    "  #                `false` = `optional` (nếu máy chưa cài đặt thì ghi nhận degraded và vẫn tiếp tục chạy).",
    "  #                `true`  = `required` (bắt buộc công cụ phải sẵn sàng, nếu thiếu sẽ chặn `bflow up` / task).",
    "  tools:"
  ].join("\n");

  const context7Banner = [
    "  # Dịch vụ tra cứu tài liệu thư viện bên ngoài Context7 (qua Shared MCP Gateway):",
    "  #   - enabled                  : (boolean: `true` | `false`, mặc định: `true`) Cho phép tra cứu tài liệu qua Context7.",
    "  #   - required                 : (boolean: `true` | `false`, mặc định: `false`) Bắt buộc Context7 sẵn sàng khi `bflow up`.",
    "  #   - cache.enabled            : (boolean: `true` | `false`, mặc định: `false`) Bật bộ nhớ đệm tài liệu cục bộ trên đĩa.",
    "  #   - cache.ttlSeconds         : (integer: `60..604800`, mặc định: `3600`) Thời gian sống của cache (giây).",
    "  #   - cache.allowAuthenticated : (boolean: `true` | `false`, mặc định: `false`) Cho phép lưu cache kết quả dùng API key riêng.",
    "  context7:"
  ].join("\n");

  const skillsBanner = [
    "  # Cấu hình danh mục Kỹ năng (Role Skills):",
    "  #   - required       : (boolean: `true` | `false`, mặc định: `false`) Bắt buộc đồng bộ đầy đủ skill trước khi `bflow up`.",
    "  #   - requiredSkills : (string[], mặc định: `[]`) Danh sách skill ID bắt buộc phải có.",
    "  #   - catalogDir     : (Tuỳ chọn, string) Đường dẫn thư mục catalog skill tuỳ chỉnh.",
    "  #   - bindingsPath   : (Tuỳ chọn, string) Đường dẫn file `bindings.json` tuỳ chỉnh.",
    "  skills:"
  ].join("\n");

  const identityBanner = [
    "  # ============================================================================",
    "  # 5. ĐỊNH DANH MÔI TRƯỜNG REPOSITORY (TỰ ĐỘNG QUẢN LÝ)",
    "  # ============================================================================",
    "  # Các trường `repositoryId`, `workspaceRoot`, `sessionName` gắn kết file config với đúng Git repository này.",
    "  # Chạy `bflow init --update` nếu cần đồng bộ lại định danh hoặc cập nhật cấu trúc config mới.",
    "  repositoryId:"
  ].join("\n");

  const projectBanner = [
    "# ============================================================================",
    "# 6. THÔNG TIN DỰ ÁN, LƯU TRỮ CỤC BỘ (STORAGE) & WORKFLOW MẶC ĐỊNH",
    "# ============================================================================",
    "# Storage paths and repository identity live below the frequently edited agent choices.",
    "# Trong `defaultWorkflow.tasks`, các trường enum hỗ trợ gồm:",
    "#   - role                 : (enum: `conversation` | `coordinator` | `planner` | `architect` | `specifier` | `developer` | `tester` | `reviewer` | `security` | `qa`)",
    "#   - qualityGates[].gate  : (enum: `spec_completeness` | `test_pass` | `code_review` | `human_approval`)",
    "#   - retryPolicy.backoff  : (enum: `fixed` | `exponential`)",
    "#   - timeoutPolicy.action : (enum: `fail` | `escalate`)",
    "projectName:"
  ].join("\n");

  const serialized = stringifyConfigYaml(value)
    .replace(/^environment:\n  roles:\n/m, `${rolesBanner}\n`)
    .replace(/^  defaults:\n/m, `${defaultsBanner}\n`)
    .replace(/^  sdd:\n/m, `${sddBanner}\n`)
    .replace(/^  tdd:\n/m, `${tddBanner}\n`)
    .replace(/^  verification:\n/m, `${verificationBanner}\n`)
    .replace(/^  fastPath:\n/m, `${fastPathBanner}\n`)
    .replace(/^  concurrency:\n/m, `${concurrencyBanner}\n`)
    .replace(/^  permissions:\n/m, `${permissionsBanner}\n`)
    .replace(/^  tools:\n/m, `${toolsBanner}\n`)
    .replace(/^  context7:\n/m, `${context7Banner}\n`)
    .replace(/^  skills:\n/m, `${skillsBanner}\n`)
    .replace(/^  repositoryId:/m, identityBanner)
    .replace(/^projectName:/m, projectBanner);
  return [
    "# ============================================================================",
    "# BFLOW REPOSITORY CONFIGURATION (.bflow/config.yml)",
    "# ============================================================================",
    "# Bflow repository configuration. Change agent choices first; the provider default model is used when omitted.",
    "# Developer is a dynamic task/worktree template; it does not create a permanent startup pane.",
    "# A dynamically spawned Developer role without an explicit entry inherits the Coordinator's provider/model/effort/profile.",
    "# effort is optional (minimal, low, medium, high, xhigh, max); valid values depend on the provider.",
    "# Agy encodes effort in the model name, so do not set effort for an agy role.",
    "# Mẹo: Chạy `bflow init --update` để làm mới toàn bộ comment và bổ sung các trường mặc định mới",
    "#      mà vẫn giữ nguyên các giá trị bạn đã tuỳ chỉnh trong file này.",
    "",
    serialized
  ].join("\n");
}
