import { describe, expect, it } from "vitest";
import type { DirectorProgressSnapshot, ParkedIssue } from "@bflow/contracts";
import { renderDirectorProgress } from "../../src/director/index.js";

const now = new Date("2026-11-03T10:00:00.000Z");
const ago = (seconds: number): string => new Date(now.getTime() - seconds * 1000).toISOString();

function snap(overrides: Partial<DirectorProgressSnapshot> = {}): DirectorProgressSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    director: { presence: "absent" },
    runs: [],
    pendingApprovals: 0,
    pendingQuestions: 0,
    issues: [],
    ...overrides
  } as DirectorProgressSnapshot;
}

function issue(n: number, status: ParkedIssue["status"]): ParkedIssue {
  return {
    schemaVersion: 1,
    issueId: `issue${n}-abcdefgh`,
    runId: "run-1",
    kind: "other",
    status,
    summary: `Lỗi số ${n}`,
    attempts: 1,
    evidence: [],
    createdAt: ago(1000 - n),
    updatedAt: ago(1000 - n)
  } as ParkedIssue;
}

const run = (tasks: unknown[], sdlcStatus = "implementing") =>
  ({ runId: "run-1", title: "Chạy một", sdlcStatus, tasks }) as DirectorProgressSnapshot["runs"][number];
const task = (key: string, status: string, extra: object = {}) => ({ taskKey: key, title: `Task ${key}`, status, ...extra });

describe("renderDirectorProgress", () => {
  it("renders only two lines for an absent Director with no runs", () => {
    const out = renderDirectorProgress(snap(), { width: 80, height: 20, now });
    expect(out).toEqual(["BFLOW · Director vắng mặt — mở CLI và chạy /bflow-start", "CẦN BẠN: không có — máy đang làm"]);
  });

  it("renders the progress bar and sdlc label", () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task(`t${i}`, i < 3 ? "succeeded" : "pending"));
    const out = renderDirectorProgress(snap({ runs: [run(tasks)] }), { width: 80, height: 20, now });
    expect(out[2]).toContain("███░░░░░░░");
    expect(out[2]).toContain("3/9");
    expect(out[2]).toContain("thực hiện");
  });

  it("labels a run that completed with parked tasks (R-B2-15)", () => {
    const out = renderDirectorProgress(snap({ runs: [run([task("a", "succeeded"), task("b", "parked")], "completed_with_parked")] }),
      { width: 120, height: 20, now });
    expect(out[2]).toContain("Xong một phần — còn 1 mục treo");
  });

  it("formats elapsed time", () => {
    const out = renderDirectorProgress(
      snap({
        runs: [run([
          task("a", "running", { role: "developer", startedAt: ago(65 * 60) }),
          task("b", "running", { startedAt: ago(30) }),
          task("c", "waiting", { startedAt: ago(5 * 60) })
        ])]
      }),
      { width: 120, height: 20, now }
    );
    expect(out[3]).toBe("  · developer Task a · đang chạy 1h 05p");
    expect(out[4]).toContain("— Task b · đang chạy <1 phút");
    expect(out[5]).toContain("chờ 5 phút");
  });

  it("lists only open and retrying issues", () => {
    const out = renderDirectorProgress(
      snap({ issues: [issue(1, "open"), issue(2, "open"), issue(3, "resolved")] }),
      { width: 80, height: 20, now }
    );
    expect(out).toContain("HÀNG ĐỢI LỖI (2)");
    expect(out.filter(line => line.trimStart().startsWith("#"))).toHaveLength(2);
    expect(out[1]).toContain("2 lỗi chờ xử lý");
  });

  it("drops low-priority lines to fit the height", () => {
    const out = renderDirectorProgress(
      snap({
        runs: [run([task("a", "running"), task("b", "blocked")])],
        issues: [issue(1, "open"), issue(2, "open"), issue(3, "open")]
      }),
      { width: 80, height: 4, now }
    );
    expect(out).toHaveLength(4);
    expect(out[0]).toContain("BFLOW");
    expect(out[1]).toContain("CẦN BẠN");
    expect(out[2]).toContain("▸");
    expect(out[3]).toMatch(/^… còn /);
    expect(out.join("\n")).not.toContain("#issue");
  });

  it("truncates lines to the width", () => {
    const out = renderDirectorProgress(snap(), { width: 20, height: 20, now });
    for (const line of out) expect(Array.from(line).length).toBeLessThanOrEqual(20);
    expect(out[0]!.endsWith("…")).toBe(true);
  });

  it("sanitises titles: whitespace runs collapse and control characters are removed", () => {
    const bad = { runId: "run-1", title: "a\nb\x1b[31mc", sdlcStatus: "implementing", tasks: [] } as DirectorProgressSnapshot["runs"][number];
    const out = renderDirectorProgress(snap({ runs: [bad] }), { width: 80, height: 20, now });
    expect(out).toHaveLength(3);
    expect(out[2]).toContain("▸ a b[31mc");
    expect(out.join("")).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });

  it("throws on an invalid snapshot", () => {
    expect(() => renderDirectorProgress({ ...snap(), pendingApprovals: -1 }, { width: 80, height: 10, now })).toThrow();
  });
});
