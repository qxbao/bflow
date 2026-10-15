/** CLI-backed Herdr transport; public workflow data stays on the contracts boundary. */
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
} from "@bflow/contracts";
export { createHerdrAdapter, HerdrCliTransport } from "./adapter.js";
export type { HerdrAdapterOptions, HerdrStartRequest } from "./adapter.js";
export { createProcessRunner } from "./runner.js";
export type { HerdrCommandRunner, CommandInvocation, CommandOutcome } from "./runner.js";
