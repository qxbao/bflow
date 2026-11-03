import { z } from "zod";
import { AgentProviderIdSchema, DIRECTOR_LIMITS, JsonValueSchema, ParkedIssueStatusSchema } from "@bflow/contracts";
import { COORDINATOR_TOOLS } from "../agentic/tools.js";
import { DirectorEndpoint } from "./endpoint.js";

/** The only host method a Director credential may call. */
export const DirectorCallInputSchema = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(JsonValueSchema).optional()
}).strict();

const IssueId = z.string().min(1).max(200);
/** Strict input schemas of the owner-token Director host methods. */
export const DIRECTOR_OWNER_METHODS = {
  director_register: z.object({ provider: AgentProviderIdSchema }).strict(),
  director_revoke: z.object({}).strict(),
  director_progress: z.object({}).strict(),
  director_hook_note: z.object({
    provider: AgentProviderIdSchema,
    prompt: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= DIRECTOR_LIMITS.messageBytes,
      `must be at most ${DIRECTOR_LIMITS.messageBytes} UTF-8 bytes`)
  }).strict(),
  director_issues: z.object({ status: z.array(ParkedIssueStatusSchema).max(10).optional() }).strict(),
  director_issue: z.object({ issueId: IssueId }).strict(),
  director_issue_status: z.object({ issueId: IssueId, status: z.enum(["retrying", "resolved", "dismissed"]) }).strict()
} as const;

/** Coordinator orchestration tools the Director may use: everything but report_progress (which targets Conversation). */
export function isDirectorCoordinatorTool(name: string): boolean {
  return name !== "report_progress" && COORDINATOR_TOOLS.some(tool => tool.name === name);
}

/** R-B1-1: a non-owner token that has the Director `<id>.<secret>` shape is routed to the Director branch. */
export function isDirectorCredential(token: string, ownerToken: string): boolean {
  return token !== ownerToken && DirectorEndpoint.isDirectorToken(token);
}

/** Director credentials may only call director_call; the error never contains the token. */
export function parseDirectorCredentialCall(method: string, params: unknown): z.infer<typeof DirectorCallInputSchema> {
  if (method !== "director_call") throw new Error("Director credentials can only call director tools");
  return DirectorCallInputSchema.parse(params);
}
