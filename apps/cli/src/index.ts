/**
 * The executable command surface will be added with the runtime implementation.
 * Keeping this module type-only prevents the bootstrap from pretending a runtime
 * is available while fixing the CLI's dependency boundary now.
 */
export type {
  ApprovalDecision,
  CancellationRequest,
  ResumeRunInput,
  RuntimeService,
  StartRunInput,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";

export type { RuntimeService as RuntimeServicePort } from "@ai-flow/runtime";
