import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export interface AgyPendingNativeTool {
  readonly stepIndex: number;
  readonly toolCall: { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
}

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AgyNativeAnchor {
  readonly transcriptPath: string;
  readonly device: string;
  readonly inode: string;
  readonly stepIndex: number;
  readonly rowDigest: string;
  readonly prefixDigest: string;
}

interface NativeTranscriptRow {
  readonly step_index: number;
  readonly source: string;
  readonly type: string;
  readonly status: string;
  readonly content?: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractRequest(content: string): string {
  const opening = "<USER_REQUEST>\n";
  const separator = "\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n";
  if (!content.startsWith(opening)) throw new Error("Agy explicit input has an unexpected USER_REQUEST wrapper");
  const end = content.indexOf(separator, opening.length);
  if (end < opening.length || !content.includes("\n</ADDITIONAL_METADATA>", end + separator.length))
    throw new Error("Agy explicit input has a malformed USER_REQUEST metadata wrapper");
  return content.slice(opening.length, end);
}

async function assertProtectedPath(home: string, expectedPath: string): Promise<void> {
  const root = resolve(home);
  let ancestor = parse(root).root;
  for (const component of root.slice(ancestor.length).split(sep).filter(Boolean)) {
    ancestor = join(ancestor, component);
    const info = await lstat(ancestor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Agy private HOME has an unsafe symlink or non-directory ancestor");
  }
  const relativePath = expectedPath.slice(root.length + 1);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new Error("Agy transcript path is outside the private HOME");
  const components = relativePath.split(sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const info = await lstat(current);
    const isFile = index === components.length - 1;
    if (info.isSymbolicLink()) throw new Error("Agy transcript path contains a symlink");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Agy transcript path has a foreign owner");
    if (isFile) {
      if (!info.isFile()) throw new Error("Agy transcript is not a regular file");
      if ((info.mode & 0o022) !== 0) throw new Error("Agy transcript permissions are writable by another user");
      if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error("Agy transcript exceeds the 16 MiB limit");
    } else {
      if (!info.isDirectory()) throw new Error("Agy transcript ancestor is not a directory");
      if ((info.mode & 0o022) !== 0) throw new Error("Agy transcript ancestor is writable by another user");
    }
  }
  const homeInfo = await lstat(root);
  if (homeInfo.isSymbolicLink() || !homeInfo.isDirectory() || (typeof process.getuid === "function" && homeInfo.uid !== process.getuid()) || (homeInfo.mode & 0o077) !== 0)
    throw new Error("Agy private HOME is unsafe");
}

export async function readAgyNativeTurn(input: {
  readonly home: string;
  readonly nativeSessionId: string;
  readonly transcriptPath: string;
  readonly priorAnchor?: AgyNativeAnchor;
  readonly pendingTool?: AgyPendingNativeTool;
  readonly expectedMcpTool?: { readonly name: string; readonly arguments: Record<string, unknown> };
}): Promise<{ readonly anchor: AgyNativeAnchor; readonly prompt: string; readonly pendingTool?: AgyPendingNativeTool }> {
  if (!UUID.test(input.nativeSessionId)) throw new Error("Agy native session id must be a UUID");
  const home = resolve(input.home);
  const expectedPath = join(home, ".gemini", "antigravity-cli", "brain", input.nativeSessionId, ".system_generated", "logs", "transcript_full.jsonl");
  if (resolve(input.transcriptPath) !== expectedPath) throw new Error("Agy transcript path does not match the canonical native session path");
  await assertProtectedPath(home, expectedPath);

  const handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_TRANSCRIPT_BYTES || (before.mode & 0o022) !== 0 || (typeof process.getuid === "function" && before.uid !== process.getuid()))
      throw new Error("Agy transcript file failed protected-file validation");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new Error("Agy transcript exceeds the 16 MiB limit");
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Agy transcript identity changed while reading");
    if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) throw new Error("Agy transcript has a partial final row");

    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Agy transcript is not valid UTF-8"); }
    const rows = text.slice(0, -1).split("\n");
    let previousIndex = -1;
    let offset = 0;
    let selected: { row: NativeTranscriptRow; raw: string; prefixLength: number } | undefined;
    let prior: { row: NativeTranscriptRow; raw: string; prefixLength: number } | undefined;
    let planner: { stepIndex: number; toolCalls: unknown; completedOperations: number; validResults: boolean } | undefined;
    for (const raw of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error("Agy transcript contains a malformed JSONL row"); }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Agy transcript row is not an object");
      const row = parsed as Partial<NativeTranscriptRow>;
      if (!Number.isSafeInteger(row.step_index) || (row.step_index as number) <= previousIndex) throw new Error("Agy transcript step_index values must be strictly increasing");
      previousIndex = row.step_index as number;
      if (row.source === "USER_EXPLICIT" && row.type === "USER_INPUT" && row.status === "DONE") {
        const inputRow = { row: row as NativeTranscriptRow, raw, prefixLength: offset + Buffer.byteLength(raw, "utf8") + 1 };
        selected = inputRow;
        planner = undefined;
        if (input.priorAnchor?.stepIndex === row.step_index) prior = inputRow;
      }
      if (row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && row.status === "DONE") {
        planner = { stepIndex: row.step_index as number, toolCalls: (parsed as Record<string, unknown>).tool_calls,
          completedOperations: 0, validResults: true };
      } else if (planner) {
        // Observed Agy batches append one MODEL/GENERIC result per operation,
        // in tool_calls order. DONE and ERROR both consume a native slot;
        // neither proves business success. Other rows cannot certify a slot.
        if (row.source !== "MODEL" || row.type !== "GENERIC" || !["DONE", "ERROR"].includes(String(row.status)) ||
            row.step_index !== planner.stepIndex + planner.completedOperations + 1) planner.validResults = false;
        planner.completedOperations++;
      }
      offset += Buffer.byteLength(raw, "utf8") + 1;
    }
    if (!selected || typeof selected.row.content !== "string") throw new Error("Agy transcript has no completed explicit user input");
    let pendingTool = input.pendingTool;
    if (input.expectedMcpTool) {
      const captured: AgyPendingNativeTool = { stepIndex: previousIndex + 1,
        toolCall: { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: input.expectedMcpTool.name, Arguments: input.expectedMcpTool.arguments } } };
      if (pendingTool && !isDeepStrictEqual(pendingTool, captured))
        throw new Error("Agy native tool differs from the expected MCP tool and pending transcript step");
      pendingTool = captured;
    }
    if (pendingTool) {
      const tool = pendingTool;
      // Native PreToolUse reports the prospective operation-result index. At
      // that boundary the completed planner row, not a result row, pins args.
      if (!Number.isSafeInteger(tool.stepIndex) || tool.stepIndex <= selected.row.step_index || tool.stepIndex !== previousIndex + 1 ||
          !planner || !planner.validResults || planner.stepIndex <= selected.row.step_index || !Array.isArray(planner.toolCalls) ||
          !isDeepStrictEqual(planner.toolCalls[planner.completedOperations], tool.toolCall))
        throw new Error("Agy native tool does not match the current planner call and pending transcript step");
    }
    if (input.priorAnchor) {
      const previous = input.priorAnchor;
      if (previous.transcriptPath !== expectedPath || previous.device !== String(before.dev) || previous.inode !== String(before.ino))
        throw new Error("Agy transcript identity changed since the prior native anchor");
      if (!prior || previous.stepIndex > selected.row.step_index || sha256(bytes.subarray(0, prior.prefixLength)) !== previous.prefixDigest || sha256(prior.raw) !== previous.rowDigest)
        throw new Error("Agy transcript prefix changed since the prior native anchor");
    }
    const prompt = extractRequest(selected.row.content);
    return {
      anchor: {
        transcriptPath: expectedPath,
        device: String(before.dev),
        inode: String(before.ino),
        stepIndex: selected.row.step_index,
        rowDigest: sha256(selected.raw),
        prefixDigest: sha256(bytes.subarray(0, selected.prefixLength))
      },
      prompt,
      ...(pendingTool ? { pendingTool } : {})
    };
  } finally {
    await handle.close();
  }
}
