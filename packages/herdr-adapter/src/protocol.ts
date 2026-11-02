import type { CommandOutcome } from "./runner.js";

export interface HerdrAgentInfo {
  readonly agent: string | null;
  readonly name: string | null;
  readonly agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly revision: number;
  readonly cwd?: string;
  readonly foregroundCwd?: string;
  readonly stateChangeSequence?: number;
  readonly session?: { readonly source: string; readonly kind: "id" | "path" | "opaque"; readonly value: string };
}

export class HerdrProtocolError extends Error {
  constructor(message: string, readonly kind: "malformed" | "remote", readonly code?: string) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HerdrProtocolError("Malformed Herdr JSON object", "malformed");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HerdrProtocolError(`Missing Herdr ${field}`, "malformed");
  return value;
}

function tryParseJsonEnvelope(source: string): Record<string, unknown> | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed);
    if (direct !== null && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // Fall through to single-envelope line extraction when CLI diagnostics surround JSON
  }
  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= 1) return null;
  const candidates: Record<string, unknown>[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          ("result" in parsed || "error" in parsed)
        ) {
          candidates.push(parsed as Record<string, unknown>);
          continue;
        }
      } catch {
        return null;
      }
      return null;
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function summarizePlainCliDiagnostic(stderr: string, stdout: string): string | null {
  for (const raw of [stderr, stdout]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const firstLine = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) {
      return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
    }
  }
  return null;
}

function classifyPlainTextCliError(stderr: string, stdout: string): HerdrProtocolError | null {
  const summary = summarizePlainCliDiagnostic(stderr, stdout);
  if (!summary) return null;
  const combined = `${stderr}\n${stdout}`;
  if (
    /\b(?:agent\s+target|target|pane|agent|session|workspace|tab|terminal)\b[^\r\n]*?\b(?:not\s+found|does\s+not\s+exist|no\s+longer\s+exists)\b/i.test(combined) ||
    /\b(?:unknown|invalid|no\s+such)\s+(?:agent\s+target|target|pane|agent|session|workspace|tab|terminal)\b/i.test(combined) ||
    /\bagent\b[^\r\n]*?\bnot\s+running\b/i.test(combined)
  ) {
    return new HerdrProtocolError(summary, "remote", "target_not_found");
  }
  if (/\bagent\b[^\r\n]*?\b(?:is\s+blocked|not\s+ready)\b/i.test(combined)) {
    return new HerdrProtocolError(summary, "remote", "agent_not_ready");
  }
  if (/\b(?:timed?\s+out|deadline\s+exceeded)\b/i.test(combined)) {
    return new HerdrProtocolError(summary, "remote", "timeout");
  }
  if (
    /\b(?:ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|EACCES|daemon|socket|server\s+unavailable|connection\s+(?:refused|failed|closed|reset)|failed\s+to\s+connect)\b/i.test(
      combined
    )
  ) {
    return new HerdrProtocolError(summary, "remote", "server_unavailable");
  }
  return null;
}

export function parseHerdrResponse(outcome: CommandOutcome): Record<string, unknown> {
  if (outcome.exitCode === 0) {
    const envelope = tryParseJsonEnvelope(outcome.stdout);
    if (!envelope) {
      throw new HerdrProtocolError("Herdr returned malformed JSON", "malformed");
    }
    return record(envelope.result);
  }
  let envelope: Record<string, unknown> | null = null;
  for (const source of [outcome.stderr, outcome.stdout]) {
    if (!source || !source.trim()) continue;
    envelope = tryParseJsonEnvelope(source);
    if (envelope) break;
  }
  if (!envelope) {
    const plainError = classifyPlainTextCliError(outcome.stderr, outcome.stdout);
    if (plainError) throw plainError;
    throw new HerdrProtocolError("Herdr returned malformed JSON", "malformed");
  }
  const error = record(envelope.error);
  throw new HerdrProtocolError(string(error.message, "error.message"), "remote", string(error.code, "error.code"));
}

export function parseAgentInfo(value: unknown): HerdrAgentInfo {
  const info = record(value);
  const status = string(info.agent_status, "agent_status");
  if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) {
    throw new HerdrProtocolError("Unsupported Herdr agent status", "malformed");
  }
  const revision = info.revision;
  if (!Number.isInteger(revision) || (revision as number) < 0) throw new HerdrProtocolError("Invalid Herdr revision", "malformed");
  const seq = info.state_change_seq;
  if (seq !== undefined && (!Number.isInteger(seq) || (seq as number) < 0)) throw new HerdrProtocolError("Invalid Herdr state sequence", "malformed");
  let session: HerdrAgentInfo["session"];
  if (info.agent_session !== undefined && info.agent_session !== null) {
    const raw = record(info.agent_session);
    const kind = string(raw.kind, "agent_session.kind");
    if (kind !== "id" && kind !== "path") throw new HerdrProtocolError("Invalid Herdr session kind", "malformed");
    if (raw.agent !== undefined && typeof info.agent === "string" && string(raw.agent, "agent_session.agent") !== info.agent) {
      throw new HerdrProtocolError("Herdr session agent does not match the pane agent", "malformed");
    }
    session = { source: string(raw.source, "agent_session.source"), kind, value: string(raw.value, "agent_session.value") };
  }
  return {
    agent: info.agent === null || info.agent === undefined ? null : string(info.agent, "agent"),
    name: info.name === null || info.name === undefined ? null : string(info.name, "name"),
    agentStatus: status as HerdrAgentInfo["agentStatus"],
    workspaceId: string(info.workspace_id, "workspace_id"),
    tabId: string(info.tab_id, "tab_id"),
    paneId: string(info.pane_id, "pane_id"),
    terminalId: string(info.terminal_id, "terminal_id"),
    revision: revision as number,
    ...(typeof info.cwd === "string" && { cwd: info.cwd }),
    ...(typeof info.foreground_cwd === "string" && { foregroundCwd: info.foreground_cwd }),
    ...(seq !== undefined && { stateChangeSequence: seq as number }),
    ...(session && { session })
  };
}

export function parseAgentResult(outcome: CommandOutcome, expectedType?: "agent_info" | "agent_started" | "agent_prompted"): HerdrAgentInfo {
  const result = parseHerdrResponse(outcome);
  if (expectedType !== undefined && result.type !== expectedType) throw new HerdrProtocolError(`Unexpected Herdr response type: expected ${expectedType}`, "malformed");
  return parseAgentInfo(result.agent);
}

export function parseCliError(outcome: CommandOutcome): HerdrProtocolError | null {
  if (outcome.exitCode === 0 || outcome.failure) return null;
  try { parseHerdrResponse(outcome); } catch (error) { if (error instanceof HerdrProtocolError) return error; }
  return new HerdrProtocolError("Unknown Herdr CLI error", "malformed");
}
