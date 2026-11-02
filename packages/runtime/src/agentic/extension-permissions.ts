import { z } from "zod";
import { AgentExecutionHandleSchema, AgentRequestSchema, PaneBindingSchema, RoleMessageSchema, type PaneBinding } from "@bflow/contracts";
import { NativeExtensionIntentSchema } from "./extension-delivery.js";
import { RepositoryReadInputSchema, repositoryRead } from "./repository-read.js";
import { digest, record, type Outbound } from "./journal.js";

export interface NativeExtensionScope {
  state: "active" | "settled" | "uncertain";
  family: "analysis" | "qa";
  runId: string; taskId: string; attemptId: string; messageId: string; readPaths: string[];
  outbound: Outbound;
}

/** A settled extension never restores old pane defaults. A new accepted ordinary assignment must supply new authority. */
export function selectNativeExtensionScope(native: readonly Outbound[], ordinaryInput: unknown, bindingInput: PaneBinding): NativeExtensionScope | undefined {
  const binding = PaneBindingSchema.parse(bindingInput);
  const ordinary = z.array(z.object({ status: z.string().min(1), message: RoleMessageSchema,
    handle: AgentExecutionHandleSchema.optional() }).passthrough()).parse(ordinaryInput);
  const candidates = native.filter(out => out.request && ["sending", "unknown_delivery", "accepted", "released"].includes(out.status) &&
    out.request.target.paneId === binding.paneId && out.request.target.agentId === binding.agentId);
  const uncertain = candidates.filter(out => out.status === "sending" || out.status === "unknown_delivery" ||
    out.status === "accepted" && (digest(out.request!.target.session) !== digest(binding.session) || out.request!.role !== binding.role)).at(-1);
  const active = candidates.filter(out => out.status === "accepted").at(-1);
  const settled = candidates.filter(out => out.status === "released" && digest(out.request!.target.session) === digest(binding.session)).at(-1);
  const out = uncertain ?? active ?? settled;
  if (!out?.request) return undefined;
  const request = AgentRequestSchema.parse(out.request), message = RoleMessageSchema.parse(out.message);
  const intent = NativeExtensionIntentSchema.parse(record(message.payload).intent);
  if (record(message.payload).kind !== "extension.assignment" || intent.runId !== request.runId || intent.taskId !== request.taskId ||
      intent.attemptId !== request.attemptId || intent.message.recipient.role !== request.role)
    throw new Error("Native permission scope lost its exact assignment owner");
  if (out.handle) {
    const handle = AgentExecutionHandleSchema.parse(out.handle);
    if (handle.requestId !== request.requestId || handle.runId !== request.runId || handle.taskId !== request.taskId ||
        handle.attemptId !== request.attemptId || digest(handle.target) !== digest(request.target))
      throw new Error("Native permission scope handle changed");
  }
  if (out.status === "released") {
    const acceptedAt = out.handle?.acceptedAt ?? request.createdAt;
    const next = ordinary.some(item => {
      if (item.status !== "accepted" || !item.handle || !["delegation.request", "task.assignment", "verification.requested"].includes(item.message.type)) return false;
      const handle = AgentExecutionHandleSchema.parse(item.handle);
      return handle.target.paneId === binding.paneId && handle.target.agentId === binding.agentId &&
        digest(handle.target.session) === digest(binding.session) && Date.parse(handle.acceptedAt) > Date.parse(acceptedAt);
    });
    if (next) return undefined;
  }
  return { state: uncertain ? "uncertain" : out.status === "released" ? "settled" : "active", family: intent.family,
    runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, messageId: message.message_id,
    readPaths: [...intent.allowedReadPaths], outbound: out };
}

/** Additional narrowing only. The ordinary host checks still authenticate the pane, current fence, skill pins and data. */
export function guardExtensionTool(scope: NativeExtensionScope, tool: string, input: unknown): { permitted: boolean; reason?: string } {
  const denied = () => ({ permitted: false, reason: "This extension assignment permits only scoped Bflow reads and its structured output; native tools, commands, writes and network operations are disabled." });
  if (tool === "mcp__bflow__host_status" || tool === "mcp__bflow__read_pinned_instructions") return { permitted: true };
  if (scope.state === "uncertain") return denied();
  const args = record(input);
  if (tool === "mcp__bflow__submit_extension_output") return args.messageId === scope.messageId ? { permitted: true } : denied();
  if (scope.state !== "active") return denied();
  if (tool === "mcp__bflow__assignment_context") return { permitted: true };
  if (tool === "mcp__bflow__read_task_log")
    return args.runId === scope.runId && args.taskId === scope.taskId ? { permitted: true } : denied();
  if (tool === "mcp__bflow__repository_read" || tool === "mcp__bflow__read_project_policy") {
    const parsed = RepositoryReadInputSchema.safeParse(tool === "mcp__bflow__repository_read" ? input : { op: "read", path: args.filePath });
    if (!parsed.success || parsed.data.op === "git") return denied();
    const path = parsed.data.path;
    if (scope.readPaths.some(root => path === root || path.startsWith(`${root}/`))) return { permitted: true };
  }
  return denied();
}

/** Always read this run's repository. A historical verification worktree is never an extension source root. */
export async function readNativeExtensionRepository(scope: NativeExtensionScope, repositoryRoot: string, input: unknown, authorize: () => Promise<void>) {
  const decision = guardExtensionTool(scope, "mcp__bflow__repository_read", input);
  if (!decision.permitted) throw new Error(decision.reason);
  const query = RepositoryReadInputSchema.parse(input);
  await authorize();
  return repositoryRead(repositoryRoot, query);
}
