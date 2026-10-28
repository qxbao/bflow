import type { QaClassification } from "./model.js";

type Build = { status: "identified"; value: string; source: string } | { status: "unknown"; limitation: string };

/** One product bug: criterion, expected/actual, reproduction, environment/build identity and sanitized evidence. */
export interface QaBug {
  readonly bugId: string;
  readonly caseId: string;
  readonly criterionId: string;
  readonly criterionIds: readonly string[];
  readonly title: string;
  readonly expected: string;
  readonly actual: string;
  readonly reproduction: readonly string[];
  readonly environment: { readonly environmentId: string; readonly origin: string; readonly build: Build };
  readonly evidenceArtifactIds: readonly string[];
  readonly rationale: string;
  /** A found bug grants no authority to change the product; a fix is a separate intake/specification. */
  readonly fixAuthority: "none";
}

export interface QaReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly title: string;
  readonly verdict: "passed" | "product_failures_found" | "test_defects_found" | "environment_failure" | "blocked" | "inconclusive";
  readonly scope: { environmentId: string; kind: string; origins: readonly string[]; allowedActions: readonly string[]; protectedPaths: readonly string[];
    assetRoot: string; access: { decidedBy: string; decidedAt: string } | null };
  readonly environment: QaBug["environment"];
  readonly readiness: { ready: boolean; status?: number; reason?: string };
  readonly productUnchanged: boolean;
  readonly design: { digest: string; approvalId: string; approvedBy: string; reviewer: string; author: string };
  readonly adjudication: { agentId: string; artifactId: string };
  readonly cases: readonly { caseId: string; title: string; criterionIds: readonly string[]; classification: QaClassification; code: string | null;
    cleanup: string; rationale: string }[];
  readonly bugs: readonly QaBug[];
  readonly testDefects: readonly { caseId: string; rationale: string }[];
  readonly residualData: readonly { caseId: string; detail: string; mutations: readonly string[] }[];
  readonly uncertainMutations: readonly { mutationId: string; caseId: string; request: string; reconciliation: string; recoveredAfterRestart: boolean }[];
  readonly leases: readonly { resourceKey: string; fencingToken: number; released: boolean }[];
  readonly limitations: readonly string[];
  readonly executionArtifactId: string;
  readonly tdd: { mode: string; alternativeVerification: readonly string[] };
  readonly productChange: "not_authorized";
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function buildLine(build: Build): string {
  return build.status === "identified"
    ? `Build \`${build.value}\` (nguồn: ${build.source})`
    : `**Không xác định được build identity**: ${build.limitation}`;
}

/** Deterministic Markdown rendering: the same report always produces the same bytes (idempotent republish after restart). */
export function renderQaReport(report: QaReport): string {
  const lines = [
    `# Báo cáo QA: ${report.title}`, "",
    `- Run \`${report.runId}\` · request \`${report.requestId}\` · revision ${report.revision}`,
    `- Kết luận: **${report.verdict}**`,
    `- Môi trường \`${report.environment.environmentId}\` · origin ${report.environment.origin}`,
    `- ${buildLine(report.environment.build)}`,
    `- Thiết kế test \`${report.design.digest}\` · tác giả ${report.design.author} · reviewer độc lập ${report.design.reviewer} · duyệt bởi ${report.design.approvedBy} (\`${report.design.approvalId}\`)`,
    `- Phân xử kết quả bởi ${report.adjudication.agentId} · evidence thực thi \`${report.executionArtifactId}\``,
    `- Sản phẩm không bị thay đổi: ${report.productUnchanged ? "có (digest các path được bảo vệ trước/sau trùng nhau)" : "**KHÔNG** — các path được bảo vệ đã thay đổi"}`,
    `- Conditional TDD: \`${report.tdd.mode}\`; alternative verification: ${report.tdd.alternativeVerification.join(", ")}`,
    "- **Phát hiện bug không cấp quyền sửa sản phẩm.** Việc sửa cần intake/specification riêng (`fixAuthority: none`).",
    "", "## Phạm vi", "",
    `- Loại môi trường: ${report.scope.kind}${report.scope.access ? ` · quyền truy cập do ${report.scope.access.decidedBy} cấp lúc ${report.scope.access.decidedAt}` : ""}`,
    `- Origin được duyệt: ${report.scope.origins.join(", ")} (redirect sang origin khác bị chặn)`,
    `- Hành động được phép: ${report.scope.allowedActions.join(", ")}`,
    `- Workspace test: \`${report.scope.assetRoot}\` · path sản phẩm được bảo vệ: ${report.scope.protectedPaths.length ? report.scope.protectedPaths.map(item => `\`${item}\``).join(", ") : "không khai báo"}`,
    `- Lease môi trường: ${report.leases.map(item => `${item.resourceKey} fencing ${item.fencingToken}${item.released ? " (đã trả)" : " (chưa trả)"}`).join("; ") || "không có"}`,
    `- Readiness: ${report.readiness.ready ? "sẵn sàng" : `không sẵn sàng (${report.readiness.reason ?? "unknown"})`}`,
    "", "## Kết quả theo test case", "",
    "| Case | Criteria | Phân loại | Mã | Cleanup | Lý do |", "| --- | --- | --- | --- | --- | --- |",
    ...report.cases.map(item => `| ${item.caseId} | ${item.criterionIds.join(", ")} | ${item.classification} | ${item.code ?? ""} | ${item.cleanup} | ${cell(item.rationale)} |`),
    "", "## Bug sản phẩm", ""
  ];
  if (!report.bugs.length) lines.push("- Không có", "");
  for (const bug of report.bugs) {
    lines.push(`### Bug ${bug.bugId}: ${bug.title}`, "",
      `- Criterion: ${bug.criterionIds.join(", ")} · test case ${bug.caseId}`,
      `- Expected: ${bug.expected}`,
      `- Actual: ${bug.actual}`,
      `- Môi trường: \`${bug.environment.environmentId}\` · ${bug.environment.origin} · ${buildLine(bug.environment.build)}`,
      `- Evidence (đã làm sạch): ${bug.evidenceArtifactIds.map(item => `\`${item}\``).join(", ")}`,
      `- Phân xử: ${bug.rationale}`,
      "- Quyền sửa: không (`fixAuthority: none`)", "",
      "Các bước tái hiện:", "", ...bug.reproduction.map((step, index) => `${index + 1}. \`${step}\``), "");
  }
  lines.push("## Lỗi của test (test_defect)", "",
    ...(report.testDefects.length ? report.testDefects.map(item => `- ${item.caseId}: ${item.rationale}`) : ["- Không có"]), "");
  if (report.uncertainMutations.length)
    lines.push("## Mutation không chắc chắn", "",
      "Các mutation dưới đây không có phản hồi xác định. Runtime không gửi lại; trạng thái được đối soát bằng probe chỉ đọc.", "",
      ...report.uncertainMutations.map(item => `- ${item.caseId} \`${item.request}\` · đối soát: ${item.reconciliation}${item.recoveredAfterRestart ? " · phát hiện sau khi khởi động lại" : ""}`), "");
  if (report.residualData.length)
    lines.push("## Dữ liệu còn sót", "", "Cleanup không hoàn tất; dữ liệu fixture sau đây có thể còn trên môi trường và cần xử lý thủ công:", "",
      ...report.residualData.map(item => `- ${item.caseId}: ${item.detail}${item.mutations.length ? ` (${item.mutations.map(request => `\`${request}\``).join(", ")})` : ""}`), "");
  lines.push("## Giới hạn", "", ...(report.limitations.length ? report.limitations.map(item => `- ${item}`) : ["- Không có"]), "");
  return lines.join("\n");
}
