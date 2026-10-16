import { z } from "zod";

export const PullRequestRequestSchema = z.object({
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  baseBranch: z.string().min(1),
  title: z.string().trim().min(1),
  body: z.string()
}).strict();
export type PullRequestRequest = z.infer<typeof PullRequestRequestSchema>;
export interface ProviderRequest extends PullRequestRequest {
  remoteUrl: string;
  headBranch: string;
  headCommitHash: string;
  idempotencyKey: string;
}
/** Provider must implement durable idempotency for create; find must reconcile ambiguous delivery. */
export interface GitProvider {
  checkAccess(request: ProviderRequest): Promise<boolean>;
  find(request: ProviderRequest): Promise<{ url: string } | null>;
  create(request: ProviderRequest): Promise<{ url: string }>;
}
export const PullRequestSchema = z.object({ url: z.string().url() }).strict();
