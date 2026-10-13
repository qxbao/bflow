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

export function parseHerdrResponse(outcome: CommandOutcome): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(outcome.exitCode === 0 ? outcome.stdout : outcome.stderr);
  } catch {
    throw new HerdrProtocolError("Herdr returned malformed JSON", "malformed");
  }
  const envelope = record(value);
  if (outcome.exitCode !== 0) {
    const error = record(envelope.error);
    throw new HerdrProtocolError(string(error.message, "error.message"), "remote", string(error.code, "error.code"));
  }
  return record(envelope.result);
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
    if (kind !== "id" && kind !== "path" && kind !== "opaque") throw new HerdrProtocolError("Invalid Herdr session kind", "malformed");
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
