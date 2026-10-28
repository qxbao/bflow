import type { HandoverDocument, HandoverEvidence, HandoverFormat, HandoverStatus } from "./schema.js";

/** Report renderers. Inputs are already redacted; rendering only escapes. No scripts or remote resources; links stay in the package. */
const BANNER: Record<HandoverStatus, string> = {
  eligible: "ĐỦ ĐIỀU KIỆN BÀN GIAO",
  partial: "CHƯA ĐỦ ĐIỀU KIỆN BÀN GIAO — GÓI MỘT PHẦN",
  draft: "BẢN NHÁP — KHÔNG ĐỦ ĐIỀU KIỆN BÀN GIAO"
};
const NOT_PACKAGED = "không đóng gói";
const NOT_PACKAGED_REASON: Record<string, string> = {
  not_requested: "không yêu cầu đóng gói", kind_not_allowed: "loại artifact không được đóng gói", not_verified: "chưa xác minh toàn vẹn",
  too_large: "vượt giới hạn kích thước", not_text: "không phải văn bản", total_limit: "vượt tổng dung lượng đóng gói"
};

const packagingLabel = (item: HandoverEvidence) => item.packaging.status === "packaged"
  ? `đóng gói tại ${item.packaging.path}${item.packaging.redacted ? " (đã redact)" : ""}`
  : `${NOT_PACKAGED}: ${NOT_PACKAGED_REASON[item.packaging.reason]}`;
const evidenceLabel = (item: HandoverEvidence) => `${item.uri} [${item.integrity}; ${item.checksum.algorithm}:${item.checksum.value.slice(0, 16)}…; ${packagingLabel(item)}]`;

/** A cell is plain text or a link to a file inside the package; every link target is a manifest-listed path. */
type Cell = string | { text: string; href: string };
interface Section { id: string; title: string; paragraphs?: string[]; table?: { head: string[]; rows: Cell[][] } }

function sections(document: HandoverDocument): Section[] {
  const spec = document.specification;
  const list = <T>(items: readonly T[], empty: string, row: (item: T) => Cell[]) => items.length ? items.map(row) : [[empty]];
  return [
    { id: "identity", title: "Danh tính snapshot", table: { head: ["Trường", "Giá trị"], rows: [
      ["Run", document.snapshot.runId], ["Snapshot", document.snapshot.snapshotId], ["Journal version", String(document.snapshot.journalVersion)],
      ["Run status", document.run.status], ["Tiêu đề", document.run.title], ["Base revision", document.run.baseRevision ?? "không có"],
      ["Integrated revision", document.run.integratedRevision ?? "không có"], ["Cancelled", String(document.run.cancelled)],
      ["Superseded by", document.run.supersededBy ?? "không"], ["Lỗi", document.run.error ?? "không"]] } },
    { id: "eligibility", title: "Điều kiện bàn giao", paragraphs: [`Trạng thái: ${document.eligibility.status}`],
      table: { head: ["Mã", "Lý do"], rows: list(document.eligibility.reasons, "Không còn điều kiện nào chưa đạt", item => [item.code, item.message]) } },
    { id: "specification", title: "Specification", table: { head: ["Trường", "Giá trị"], rows: spec ? [
      ["Spec", `${spec.specId} v${spec.version} (${spec.level})`], ["Status", spec.status], ["Approval", spec.approval],
      ["Tiêu đề", spec.title], ["Tóm tắt", spec.summary], ["Artifact", spec.artifact ? evidenceLabel(spec.artifact) : "không có"],
      ["Binding", spec.binding]] : [["Specification", "Chưa có specification được chấp nhận"]] } },
    { id: "criteria", title: "Acceptance criteria", table: { head: ["Criterion", "Mô tả", "Loại", "Phương pháp", "Bắt buộc", "Waiver"],
      rows: list(document.criteria, "Không có criterion", item => [item.id, item.description, item.category, item.verificationMethod, String(item.required), item.waiver ?? "không"]) } },
    { id: "matrix", title: "Ma trận criterion → task → integrated revision → check/verdict → evidence", table: {
      head: ["Criterion", "Tasks", "Integrated revision", "Check", "Verdict", "Evidence"],
      rows: list(document.matrix, "Không có criterion", row => [
        `${row.criterionId}${row.required ? "" : " (không bắt buộc)"}`, row.taskIds.join(", ") || "không có task",
        row.integratedRevision ?? "không có",
        row.checks.map(check => `${check.scope}/${check.taskId} ${check.verificationId} #${check.cycleNumber}: ${check.passed ? "pass" : "fail"} (${check.resultStatus}); revision ${check.revision ?? "không có"} ${check.revisionBinding}${check.command ? `; ${check.command}${check.exitCode !== undefined ? ` → ${check.exitCode}` : ""}` : ""}`).join(" ‖ ") || "không có check",
        `${row.verdict}${row.reasons.length ? ` — ${row.reasons.join("; ")}` : ""}`,
        row.checks.map(check => evidenceLabel(check.evidence)).join(" ‖ ") || "không có evidence"]) } },
    { id: "tasks", title: "Task outcomes", table: { head: ["Task", "Tiêu đề", "Criteria", "Outcome", "Cycle", "Iterations", "Revision", "Integration"],
      rows: list(document.tasks, "Chưa có task được chấp nhận", task => [task.taskId, task.title, task.criteria.join(", "), task.outcome,
        task.cycleStatus ?? "không có", String(task.iterations), task.revision ?? "không có", task.integration]) } },
    { id: "findings", title: "Findings", table: { head: ["Scope", "Task", "Verification", "Code", "Severity", "Message", "Còn mở"],
      rows: list(document.findings, "Không có finding trong kết quả hiện hành", item => [item.scope, item.taskId, item.verificationId, item.code, item.severity, item.message, item.open ? "có" : "không"]) } },
    { id: "exceptions", title: "Exception / waiver", table: { head: ["Loại", "Đối tượng", "Lý do", "Hợp lệ"],
      rows: list(document.exceptions, "Không có exception hoặc waiver", item => [item.kind, item.subject, item.reason, item.valid ? "có" : "không"]) } },
    { id: "approvals", title: "Approvals", table: { head: ["Approval", "Loại", "Target", "Requested", "Decision", "Bởi", "Lúc", "Hiệu lực", "Ghi chú"],
      rows: list(document.approvals, "Không có approval", item => [item.approvalId, item.kind, item.target, item.requestedAt, item.decision,
        item.decidedBy ?? "", item.decidedAt ?? "", item.validity, item.reasons.join("; ")]) } },
    { id: "run-instructions", title: "Hướng dẫn chạy / kiểm chứng", paragraphs: document.instructions.run.status === "missing"
      ? [`THIẾU: không có nguồn đã xác định (${document.instructions.run.expectedSource}).`] : [`Nguồn: ${document.instructions.run.expectedSource}`],
      ...(document.instructions.run.commands.length ? { table: { head: ["Lệnh", "Nguồn"], rows: document.instructions.run.commands.map(item => [item.command, item.source]) } } : {}) },
    { id: "rollback", title: "Rollback", paragraphs: document.instructions.rollback.status === "missing"
      ? [`THIẾU: specification được chấp nhận không có ${document.instructions.rollback.expectedSource}.`]
      : [`Nguồn: ${document.instructions.rollback.expectedSource}`, document.instructions.rollback.text ?? ""] },
    { id: "unverified", title: "Phần chưa được kiểm chứng", table: { head: ["Đối tượng", "Lý do"],
      rows: list(document.unverified, "Không có", item => [item.subject, item.reason]) } },
    { id: "evidence", title: "Evidence (ArtifactReference)", paragraphs: [
      "Checksum là của artifact gốc trong ArtifactStore. Bản đóng gói chỉ gồm loại test-result, report, patch, document dạng văn bản đã xác minh; " +
      "nội dung đã qua redact nên hash của file đóng gói nằm trong manifest và có thể khác checksum gốc."],
      table: { head: ["Artifact", "Kind", "Task", "Media type", "Checksum", "Integrity", "Đóng gói"],
      rows: list(document.evidence, "Không có evidence", (item): Cell[] => [item.uri, item.kind, item.taskId ?? "", item.mediaType,
        `${item.checksum.algorithm}:${item.checksum.value}`, item.integrity,
        item.packaging.status === "packaged" ? { text: packagingLabel(item), href: item.packaging.path } : packagingLabel(item)]) } }
  ];
}

const html = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const markdown = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/([\\`*_{}[\]()#+!|~])/g, "\\$1").replace(/\r?\n/g, " ");

export function renderHtml(document: HandoverDocument, formats: readonly HandoverFormat[]): string {
  const links = [...(formats.includes("md") ? ["handover.md"] : []), "handover.json", "manifest.json"];
  const parts = sections(document).map(section => [
    `<section id="${section.id}"><h2>${html(section.title)}</h2>`,
    ...(section.paragraphs ?? []).map(text => `<p>${html(text)}</p>`),
    ...(section.table ? [`<table><thead><tr>${section.table.head.map(cell => `<th>${html(cell)}</th>`).join("")}</tr></thead><tbody>`,
      ...section.table.rows.map(row => `<tr>${row.map(cell => `<td>${typeof cell === "string" ? html(cell) : `<a href="${html(cell.href)}">${html(cell.text)}</a>`}</td>`).join("")}</tr>`), "</tbody></table>"] : []),
    "</section>"].join("\n"));
  return [
    "<!doctype html>", '<html lang="vi">', "<head>", '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="referrer" content="no-referrer">',
    `<title>${html(`Gói bàn giao ${document.snapshot.runId}`)}</title>`,
    "<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px;color:#1b1b1b;background:#fff}table{border-collapse:collapse;width:100%;margin:8px 0}" +
    "th,td{border:1px solid #c8c8c8;padding:4px 6px;vertical-align:top;text-align:left;overflow-wrap:anywhere}th{background:#f1f1f1}" +
    ".banner{padding:10px;font-weight:700;border:2px solid}.eligible{border-color:#1a7f37;color:#1a7f37}.partial{border-color:#9a6700;color:#9a6700}.draft{border-color:#cf222e;color:#cf222e}</style>",
    "</head>", "<body>",
    `<p class="banner ${document.eligibility.status}">${html(BANNER[document.eligibility.status])}</p>`,
    `<h1>${html(`Gói bàn giao — ${document.run.title}`)}</h1>`,
    `<nav>${[...links.map(link => `<a href="${link}">${html(link)}</a>`), ...sections(document).map(section => `<a href="#${section.id}">${html(section.title)}</a>`)].join(" · ")}</nav>`,
    ...parts, "</body>", "</html>", ""].join("\n");
}

export function renderMarkdown(document: HandoverDocument, formats: readonly HandoverFormat[]): string {
  const links = [...(formats.includes("html") ? ["index.html"] : []), "handover.json", "manifest.json"];
  const lines = [`> **${markdown(BANNER[document.eligibility.status])}**`, "", `# ${markdown(`Gói bàn giao — ${document.run.title}`)}`, "",
    links.map(link => `[${markdown(link)}](${link})`).join(" · "), ""];
  for (const section of sections(document)) {
    lines.push(`## ${markdown(section.title)}`, "");
    for (const text of section.paragraphs ?? []) lines.push(markdown(text), "");
    if (section.table) {
      lines.push(`| ${section.table.head.map(markdown).join(" | ")} |`, `|${section.table.head.map(() => " --- ").join("|")}|`);
      for (const row of section.table.rows) lines.push(`| ${section.table.head.map((_, index) => {
        const cell = row[index] ?? "";
        return typeof cell === "string" ? markdown(cell) : `[${markdown(cell.text)}](${cell.href})`;
      }).join(" | ")} |`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
