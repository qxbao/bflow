import { z } from "zod";

export const ConversationSessionStatusSchema = z.enum([
  "active",
  "awaiting_user_clarification",
  "delegated_to_coordinator",
  "reporting_progress",
  "awaiting_user_approval",
  "completed",
  "paused",
  "closed",
  "archived"
]);
export type ConversationSessionStatus = z.infer<typeof ConversationSessionStatusSchema>;
