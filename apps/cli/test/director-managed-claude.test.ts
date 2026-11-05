import { describe, expect, it, vi } from "vitest";
import { createClaudeDirectorSupervisorOptions } from "../src/director-managed-claude.js";

describe("managed Claude Director options", () => {
  it("binds Claude streaming protocol to the requested executable and repository", () => {
    const transcript = vi.fn();
    const status = vi.fn();
    const env = { PATH: "/usr/bin", BFLOW_DIRECTOR_TOKEN: "secret-value" };
    const options = createClaudeDirectorSupervisorOptions({
      executable: "/opt/claude", cwd: "/repo", env, stateRoot: "/repo",
      sessionName: "bf-project", initialPrompt: "/bflow-start", onTranscript: transcript, onStatus: status
    });
    expect(options).toMatchObject({
      provider: "claude", executable: "/opt/claude", cwd: "/repo", env,
      stateRoot: "/repo", sessionName: "bf-project", initialPrompt: "/bflow-start",
      onTranscript: transcript, onStatus: status
    });
    expect(options.args).toContain("stream-json");
    expect(options.args.join(" ")).not.toContain("secret-value");
    expect(JSON.parse(options.protocol.encodePrompt("wake"))).toMatchObject({ type: "user", message: { content: "wake" } });
    expect(options.protocol.classifyEvent({ type: "result", subtype: "success", is_error: false,
      session_id: "123e4567-e89b-42d3-a456-426614174000" })).toMatchObject({ kind: "turn_complete", success: true });
  });
});
