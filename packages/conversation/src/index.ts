/**
 * @bflow/conversation
 *
 * Conversation Agent & Delegation Gateway for Bflow Agentic SDLC v2.
 * Serves as the sole user interface in Herdr multi-pane orchestration,
 * handling requirement intake, clarification dialogue, intent detection,
 * substantive progress reporting, approval mediation, and structured DelegationRequest handoff.
 */

export * from "./types.js";
export * from "./safety.js";
export * from "./prompts.js";
export * from "./intent-classifier.js";
export * from "./delegation-builder.js";
export * from "./response-formatter.js";
export * from "./context-store.js";
export * from "./herdr-bridge.js";
export * from "./conversation-gateway.js";
