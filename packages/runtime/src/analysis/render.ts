import type { AnalysisDocument } from "./model.js";
import type { AnalysisVerification } from "./verify.js";

const PROVENANCE_LABEL = { user: "Người dùng", source: "Quan sát source", inference: "Suy luận", open_decision: "Quyết định còn thiếu" } as const;

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function origin(item: { provenance: { kind: keyof typeof PROVENANCE_LABEL; refs: readonly string[] } }): string {
  return `${PROVENANCE_LABEL[item.provenance.kind]}: ${item.provenance.refs.map(ref => `\`${cell(ref)}\``).join(", ")}`;
}

/** Human-readable analysis document; every statement keeps its provenance label and references. */
export function renderAnalysisDocument(document: AnalysisDocument, meta: { version: number; digest: string }): string {
  const lines = [`# ${document.title}`, "", `Phiên bản tài liệu ${meta.version} · sha256 \`${meta.digest}\``, "",
    "Mỗi phát biểu ghi nguồn: người dùng, quan sát source, suy luận hoặc quyết định còn thiếu.", ""];
  const table = (title: string, header: string[], rows: string[][]) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, "", `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`,
      ...rows.map(row => `| ${row.map(cell).join(" | ")} |`), "");
  };
  table("Phạm vi", ["ID", "Trong/ngoài", "Nội dung", "Nguồn"], [
    ...document.scope.inScope.map(item => [item.id, "Trong phạm vi", item.text, origin(item)]),
    ...document.scope.outOfScope.map(item => [item.id, "Ngoài phạm vi", item.text, origin(item)])]);
  table("Yêu cầu chức năng (FR)", ["ID", "Yêu cầu", "Nguồn"], document.functionalRequirements.map(item => [item.id, item.text, origin(item)]));
  table("Tiêu chí chấp nhận (AC)", ["ID", "FR", "Given", "When", "Then", "Oracle", "Nguồn"], document.acceptanceCriteria.map(item =>
    [item.id, item.requirementIds.join(", "), item.given, item.when, item.then, item.oracle, origin(item)]));
  table("Yêu cầu phi chức năng (NFR)", ["ID", "Nhóm", "Phát biểu", "Trạng thái", "Metric", "Oracle", "Workload", "Ngưỡng", "Nguồn"],
    document.nfrs.map(item => [item.id, item.category, item.text, item.status === "accepted" ? "Đã chấp nhận" : `Chưa quyết định (${item.decisionId ?? "?"})`,
      item.metric ?? "—", item.oracle ?? "—", item.workload ?? "—", item.threshold ?? "—", origin(item)]));
  if (document.businessFlows.length) {
    lines.push("## Luồng nghiệp vụ", "");
    for (const flow of document.businessFlows) {
      lines.push(`### ${flow.id}: ${flow.text}`, "", `FR: ${flow.requirementIds.join(", ") || "—"} · ${origin(flow)}`, "");
      flow.steps.forEach((step, index) => lines.push(`${index + 1}. **${step.actor}**: ${step.action}`));
      lines.push("");
    }
  }
  table("Thuật ngữ", ["ID", "Thuật ngữ", "Định nghĩa", "Nguồn"], document.glossary.map(item => [item.id, item.term, item.text, origin(item)]));
  table("Ghi chú context/data/API", ["ID", "Loại", "Nội dung", "Nguồn"], document.notes.map(item => [item.id, item.kind, item.text, origin(item)]));
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderVerificationSummary(verification: AnalysisVerification): string[] {
  return verification.checks.map(item => `- \`${item.check}\`: ${item.evaluated - item.failed}/${item.evaluated} đạt`);
}
