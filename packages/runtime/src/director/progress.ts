import { DirectorProgressSnapshotSchema, type DirectorProgressSnapshot } from "@bflow/contracts";

export interface ProgressRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly now: Date;
}

interface Line {
  readonly text: string;
  readonly priority: 0 | 1 | 2 | 3;
}

const PRESENCE_LABEL: Record<string, string> = {
  active: "đang hoạt động",
  waiting: "đang chờ sự kiện",
  absent: "vắng mặt — mở CLI và chạy /bflow-start"
};

const SDLC_LABEL: Record<string, string> = {
  intake: "tiếp nhận",
  clarifying: "làm rõ",
  specifying: "đặc tả",
  planning: "lập kế hoạch",
  tdd_deciding: "chọn TDD",
  implementing: "thực hiện",
  verifying: "kiểm chứng",
  reviewing: "review",
  awaiting_approval: "chờ duyệt",
  completed: "hoàn tất",
  escalated: "cần người",
  failed: "thất bại",
  cancelled: "đã hủy",
  completed_with_parked: "Xong một phần — còn mục treo"
};

const ACTIVE_TASK_LABEL: Record<string, string> = {
  running: "đang chạy",
  retrying: "thử lại",
  waiting: "chờ"
};

function bar(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.min(10, Math.floor((done * 10) / total));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function elapsed(startedAt: string, now: Date): string {
  const ms = now.getTime() - new Date(startedAt).getTime();
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1 phút";
  if (minutes < 60) return `${minutes} phút`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}p`;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function sanitize(text: string): string {
  const indent = /^ */.exec(text)![0];
  return indent + text.slice(indent.length).replace(/\s+/g, " ").replace(CONTROL_CHARS, "");
}

function truncate(text: string, width: number): string {
  const points = Array.from(text);
  return points.length > width ? `${points.slice(0, width - 1).join("")}…` : text;
}

export function renderDirectorProgress(snapshot: DirectorProgressSnapshot, options: ProgressRenderOptions): string[] {
  const parsed = DirectorProgressSnapshotSchema.parse(snapshot);
  const width = Math.max(20, options.width);
  const height = Math.max(3, options.height);

  const pendingIssues = parsed.issues
    .filter(issue => issue.status === "open" || issue.status === "retrying")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const openCount = parsed.issues.filter(issue => issue.status === "open").length;

  const lines: Line[] = [];
  lines.push({ text: `BFLOW · Director ${PRESENCE_LABEL[parsed.director.presence] ?? parsed.director.presence}`, priority: 0 });
  lines.push({
    text: parsed.pendingApprovals === 0 && parsed.pendingQuestions === 0 && openCount === 0
      ? "CẦN BẠN: không có — máy đang làm"
      : `CẦN BẠN: ${parsed.pendingApprovals} phê duyệt · ${parsed.pendingQuestions} câu hỏi · ${openCount} lỗi chờ xử lý`,
    priority: 0
  });

  for (const run of parsed.runs) {
    const done = run.tasks.filter(task => task.status === "succeeded").length;
    const statusLabel = run.sdlcStatus === "completed_with_parked"
      ? `Xong một phần — còn ${run.tasks.filter(task => task.status === "parked").length} mục treo`
      : SDLC_LABEL[run.sdlcStatus] ?? run.sdlcStatus;
    lines.push({
      text: `▸ ${run.title} [${bar(done, run.tasks.length)}] ${done}/${run.tasks.length} · ${statusLabel}`,
      priority: 1
    });
    for (const task of run.tasks) {
      const label = ACTIVE_TASK_LABEL[task.status];
      if (label !== undefined) {
        const time = task.startedAt === undefined ? "" : ` ${elapsed(task.startedAt, options.now)}`;
        lines.push({ text: `  · ${task.role ?? "—"} ${task.title} · ${label}${time}`, priority: 2 });
      } else if (task.status === "blocked" || task.status === "failed") {
        lines.push({ text: `  ! ${task.title} · ${task.status === "blocked" ? "bị chặn" : "thất bại"}`, priority: 2 });
      }
    }
  }

  const parkedTasks = parsed.runs.flatMap(run => run.tasks.filter(task => task.status === "parked")
    .filter(task => !pendingIssues.some(issue => issue.runId === run.runId && issue.taskKey === task.taskKey)));
  if (pendingIssues.length > 0 || parkedTasks.length > 0) {
    lines.push({ text: `HÀNG ĐỢI LỖI (${pendingIssues.length + parkedTasks.length})`, priority: 1 });
    for (const issue of pendingIssues) {
      lines.push({ text: `  #${issue.issueId.slice(0, 8)} ${issue.summary}`, priority: 3 });
    }
    for (const task of parkedTasks) lines.push({ text: `  · ${task.title} · đang treo`, priority: 3 });
  }

  let kept = lines;
  let dropped = 0;
  for (const priority of [3, 2, 1] as const) {
    while (kept.length > height) {
      let index = -1;
      for (let i = kept.length - 1; i >= 0; i -= 1) {
        if (kept[i]!.priority === priority) { index = i; break; }
      }
      if (index < 0) break;
      kept = [...kept.slice(0, index), ...kept.slice(index + 1)];
      dropped += 1;
    }
  }
  if (dropped > 0) {
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (kept[i]!.priority !== 0) {
        kept = kept.map((line, j) => (j === i ? { text: `… còn ${dropped + 1} dòng`, priority: line.priority } : line));
        break;
      }
    }
  }
  return kept.map(line => truncate(sanitize(line.text), width));
}
