import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  IdentifierSchema,
  WebProjectSessionResultSchema,
  WebRunPageResultSchema,
  WebRunViewResultSchema,
  WebDecisionPageResultSchema,
  WebCommandSchema, WebOperationResponseSchema, type WebCommand,
  type UserInteractionClient,
  type OperationResult,
} from "@bflow/contracts";
import { queryAgenticHostInteraction, callUserInteractionHost } from "../agentic/host-controller.js";
import { WebPrincipalSchema } from "@bflow/contracts/web-host";
import { InteractionQuerySchema, InteractionOperationSchema } from "./schemas.js";
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
/** Existing-host connection. Mutations require a separately owner-registered
 * user-interaction credential and signer. Never starts/prepares a host. */
export async function openUserInteractionClient(options: {
  repositoryPath: string;
  sessionId: string;
  /** Supplied only by owner-registered Local Server composition, never browser input. */
  interaction?: { credential: string; sign(command: WebCommand): unknown | Promise<unknown> };
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
    async execute(input) {
      if (!options.interaction) return refused();
      let command;
      try { command = WebCommandSchema.parse(input); if (command.projectId !== projectId) return refused(); }
      catch { return refused(); }
      try {
        const principal = WebPrincipalSchema.parse(await options.interaction.sign(command));
        return WebOperationResponseSchema.parse(await callUserInteractionHost({ repositoryPath, sessionId },
          options.interaction.credential, "interaction_execute", { command, principal }));
      } catch {
        return { ok: false, error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true,
          message: "Interaction acknowledgement unavailable; observe the same operation before retrying.",
          details: { operationId: command.commandId, reason: "reconciliation_required" } } };
      }
    },
    async readOperation(id, operationId) {
      if (!options.interaction || id !== projectId) return refused();
      try {
        const input = InteractionOperationSchema.parse({ projectId: id, operationId });
        return WebOperationResponseSchema.parse(await callUserInteractionHost({ repositoryPath, sessionId },
          options.interaction.credential, "interaction_operation", input));
      } catch { return unavailable(); }
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
