import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  IdentifierSchema,
  WebProjectSessionResultSchema,
  WebRunPageResultSchema,
  WebRunViewResultSchema,
  WebDecisionPageResultSchema,
  type UserInteractionClient,
  type OperationResult,
} from "@bflow/contracts";
import { queryAgenticHostInteraction } from "../agentic/host-controller.js";
import { InteractionQuerySchema } from "./schemas.js";
/** Registry adapters must use the canonical repository path, never browser-supplied project IDs. */
export function interactionProjectId(canonicalRepositoryPath: string): string {
  return (
    "project-" +
    createHash("sha256")
      .update(canonicalRepositoryPath)
      .digest("hex")
      .slice(0, 32)
  );
}
const unavailable = <T>(): OperationResult<T> => ({
  ok: false,
  error: {
    code: "transport_unavailable",
    retryable: true,
    message: "Agentic host is unavailable; start the session explicitly.",
  },
});
const refused = <T>(): OperationResult<T> => ({
  ok: false,
  error: {
    code: "validation",
    retryable: false,
    message: "Interaction method or scope is not supported.",
  },
});
/** Read-only connection. It deliberately never calls ensureAgenticHost/openPersistedAgenticHost. */
export async function openUserInteractionClient(options: {
  repositoryPath: string;
  sessionId: string;
}): Promise<UserInteractionClient> {
  const repositoryPath = await realpath(options.repositoryPath),
    sessionId = IdentifierSchema.parse(options.sessionId);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes(".."))
    throw new Error("Unsafe host session ID");
  const projectId = interactionProjectId(repositoryPath);
  const query = async <T>(
    input: unknown,
    parse: (v: unknown) => OperationResult<T>,
  ): Promise<OperationResult<T>> => {
    let request;
    try {
      request = InteractionQuerySchema.parse(input);
    } catch {
      return refused();
    }
    if (request.projectId !== projectId) return refused();
    try {
      return parse(
        await queryAgenticHostInteraction(
          { repositoryPath, sessionId },
          request,
        ),
      );
    } catch {
      return unavailable();
    }
  };
  return {
    async readProjectSession(id) {
      const result = await query({ kind: "session", projectId: id }, (v) =>
        WebProjectSessionResultSchema.parse(v),
      );
      if (!result.ok && result.error.code === "transport_unavailable")
        return WebProjectSessionResultSchema.parse({
          ok: true,
          value: {
            apiVersion: 1,
            projectId: id,
            sessionId,
            state: "unavailable",
            pendingIntakes: [],
            blockers: [
              {
                code: "host_unavailable",
                message: "Start the session explicitly to connect.",
              },
            ],
            updatedAt: new Date().toISOString(),
          },
        });
      return result;
    },
    listRuns: (id, input) =>
      query({ kind: "runs", projectId: id, query: input }, (v) => {
        const result = WebRunPageResultSchema.parse(v);
        return result.ok
          ? {
              ok: true,
              value: {
                apiVersion: 1,
                items: result.value.items,
                ...(result.value.nextCursor
                  ? { nextCursor: result.value.nextCursor }
                  : {}),
              },
            }
          : result;
      }),
    readRun: (id, runId) =>
      query({ kind: "run", projectId: id, runId }, (v) =>
        WebRunViewResultSchema.parse(v),
      ),
    listDecisions: (id) =>
      query({ kind: "decisions", projectId: id }, (v) => {
        const result = WebDecisionPageResultSchema.parse(v);
        return result.ok
          ? {
              ok: true,
              value: {
                apiVersion: 1,
                items: result.value.items,
                ...(result.value.nextCursor
                  ? { nextCursor: result.value.nextCursor }
                  : {}),
              },
            }
          : result;
      }),
    async execute() {
      return refused();
    },
    async readOperation() {
      return refused();
    },
    async *events() {
      throw new Error("Interaction events are not implemented (W05).");
    },
    async acknowledgeNotice() {
      return refused();
    },
    async listMessages() {
      return refused();
    },
    async sendMessage() {
      return refused();
    },
    async readArtifact() {
      return refused();
    },
  };
}
