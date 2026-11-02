import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildUserDecisionRequest, parseUserDecisionToolInput, refuseDelegableCommand } from "../../src/agentic/decision-routing.js";
import { renderConversationNotice, userDecisionNoticeFields } from "../../src/agentic/conversation-notice-render.js";
import { reportsToUser } from "../../src/agentic/workflow-rejection.js";

const base = { runId: "run-1", taskId: "task-1", question: "Bạn muốn đăng bài thật lên Facebook không?", options: ["Có", "Không"] };
const userAction = {
  why: "Bflow cần quyền đăng bài lên Trang của bạn; chỉ chủ Trang mới cấp được.",
  steps: ["Mở developers.facebook.com và tạo ứng dụng", "Tạo Page Access Token", "Đặt token vào biến môi trường FACEBOOK_PAGE_TOKEN"],
  done: "Trả lời #n: 1 sau khi đặt xong token."
};
const build = (input: unknown) => buildUserDecisionRequest({ input: parseUserDecisionToolInput(input), role: "coordinator",
  sessionId: "session-1", revision: 1, generation: 0, now: "2026-11-02T00:00:00.000Z" });

describe("a decision that needs the user to act says how and why on the first card", () => {
  it("shows why, every step and how to report back, without asking the user to open details", () => {
    const request = build({ ...base, userAction });
    const fields = userDecisionNoticeFields(request);
    const { display } = renderConversationNotice({ messageId: "m", type: "approval.request", shortId: "#2", userDecision: fields });
    expect(display).toContain(`Để làm gì: ${userAction.why}`);
    for (const step of userAction.steps) expect(display).toContain(step);
    expect(display).toContain(`Làm xong: ${userAction.done}`);
  });
  it("reaches the Web card, which reads the request reason", () => {
    const request = build({ ...base, userAction });
    expect(request.reason).toContain(userAction.steps[1]);
    expect(request.reason).toContain(userAction.why);
  });
  it("keeps the approval id of a decision without an action", () => {
    expect(build(base).reason).toBe(base.question);
    expect(build(base).approvalId).not.toBe(build({ ...base, userAction }).approvalId);
  });
  it.each([
    ["no reason", { steps: ["x"], done: "y" }],
    ["no steps", { why: "x", steps: [], done: "y" }],
    ["no way to report back", { why: "x", steps: ["y"] }],
    ["unknown keys", { ...userAction, extra: 1 }]
  ])("refuses an action with %s", (_label, action) => {
    expect(() => parseUserDecisionToolInput({ ...base, userAction: action })).toThrow(/userAction/);
  });
  it("refuses an action that would be clipped on the card", () => {
    const long = { why: "x".repeat(500), steps: Array.from({ length: 10 }, () => "y".repeat(300)), done: "z" };
    expect(() => parseUserDecisionToolInput({ ...base, userAction: long })).toThrow(/userAction/);
  });
});

describe("Coordinator cannot hand the user a command it can run itself", () => {
  // Verbatim from the 2026-11-01/02 delebanana run.
  it.each([
    ["test runner", "Lệnh cần chạy tại /Users/x/delebanana:\nprintf 'node_modules/\\n' >> .gitignore\nnpm init -y\nnpm i -D vitest@2\ngit add .gitignore package.json package-lock.json\ngit commit -m \"chore: add vitest test runner\""],
    ["one-line retry", "Chạy lệnh sau trong terminal (có thể các lần trước lệnh đã chạy ở thư mục khác, nên lệnh này có cd sẵn):\ncd /Users/x/delebanana && printf 'node_modules/\\n' >> .gitignore && npm init -y && npm i -D vitest@2"],
    ["scaffold", "Lệnh cho lựa chọn 1, chạy tại /Users/x/delebanana:\nfor d in src/core test/core; do mkdir -p $d && touch $d/.gitkeep; done && git add src test && git commit -m \"chore: scaffold\""],
    ["progress", "Khi commit đã có, hãy nhắn trong chat. Lệnh: cd /Users/x/delebanana && npm init -y && npm i -D vitest@2"],
    ["cancellation", "Bạn chạy lệnh này trong terminal: bflow cancel run-1 --reconcile"]
  ])("refuses the %s text", (_label, text) => {
    expect(refuseDelegableCommand([text])).toMatch(/repository_setup/);
    expect(() => parseUserDecisionToolInput({ ...base, context: text })).toThrow(/repository_setup/);
  });
  it("refuses a covered command listed as a user step even with no wording around it", () => {
    expect(() => parseUserDecisionToolInput({ ...base, userAction: { ...userAction, steps: ["npm i -D vitest@2"] } })).toThrow(/repository_setup/);
  });
  it.each([
    "Dùng npm install hay pnpm install cho dự án này?",
    "Tôi đã chạy npm init và git commit xong qua Runtime.",
    "Tôi đã chạy lệnh npm i -D vitest qua repository_setup.",
    "Bạn chạy lệnh gh auth login để đăng nhập GitHub."
  ])("allows %s", text => {
    expect(refuseDelegableCommand([text])).toBeUndefined();
  });
});

describe("a repository with no test runner is Coordinator's job", () => {
  it("is not reported to the user as a blocker", () => {
    expect(reportsToUser({ code: "no_test_runner_detected", reason: "package.json is missing", options: [] })).toBe(false);
  });
});

describe("blocked card", () => {
  it("says what typing continue does, not 'after you have handled it'", () => {
    const { display } = renderConversationNotice({ messageId: "m", type: "conversation.progress", shortId: "#3", runLabel: "Việc #1: X",
      summary: JSON.stringify({ kind: "workflow_blocked", reason: "Developer không phản hồi", runId: "run-1" }) });
    expect(display).not.toContain("sau khi xử lý xong");
    expect(display).toContain('Gõ "tiếp tục việc #1" để Trưởng nhóm kỹ thuật kiểm tra và tự xử lý');
  });
});

describe("role prompts", () => {
  const prompt = (role: string) => readFile(fileURLToPath(new URL(`../../../../agents/${role}/system-prompt.md`, import.meta.url)), "utf8");
  it("sends Coordinator to repository_setup instead of a setup task, and to re-resolve on drift", async () => {
    const coordinator = await prompt("coordinator");
    expect(coordinator).not.toMatch(/add one setup task/);
    expect(coordinator).toMatch(/no_test_runner_detected[\s\S]{0,200}repository_setup/);
    expect(coordinator).not.toMatch(/execution plan drift blocks resume/);
  });
  it("makes Coordinator collect what only the user can do before proposing, with how and why", async () => {
    const coordinator = await prompt("coordinator");
    expect(coordinator).toMatch(/userAction/);
    expect(coordinator).toMatch(/before `propose_workflow`/);
  });
  it("forbids Conversation from relaying a command Coordinator can run, and requires how and why", async () => {
    const chat = await prompt("chat");
    expect(chat).toMatch(/Không bao giờ bảo người dùng tự chạy/);
    expect(chat).toMatch(/để làm gì/);
  });
});
