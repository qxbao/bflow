/**
 * Herdr-specific behavior is intentionally not implemented until its CLI and
 * Socket API have been verified. Implementations in this package must satisfy
 * this transport boundary without leaking Herdr details into core.
 */
export type {
  AgentExecutionHandle,
  AgentMessage,
  AgentReadOptions,
  AgentRequest,
  AgentResult,
  AgentTransport,
  AgentTransportCapabilities,
  AgentTransportInitialization,
  CancellationRequest,
  CancellationResult,
  OperationOptions
} from "@ai-flow/contracts";
