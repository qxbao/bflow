// Pure presentation model. Types only from @bflow/contracts/web; no React, Pixi, fetch or clock.
import type { WebAgentView, WebDecision, WebHandoffView, WebProjectSession, WebRunView, WebTaskView, WebWorkforceView } from '@bflow/contracts/web';

export type OfficeRole = WebAgentView['role'];
export type Certainty = 'confirmed' | 'inferred' | 'unknown';
export type OfficePose = 'disconnected' | 'question' | 'hand_raised' | 'working' | 'typing' | 'preparing' | 'sleeping' | 'ghost';
export type OfficeTier = 'full' | 'degraded' | 'closed';
/** Structurally identical to api/events Connection; redeclared so the model never imports api/**. */
export type OfficeConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface OfficeInput {
  session: WebProjectSession;
  runs: readonly WebRunView[];
  decisions: readonly WebDecision[];
  /** Undefined means the degraded tier (backend without /workforce). */
  workforce?: WebWorkforceView;
  connection: OfficeConnection;
  /** Browser clock in ms. Used ONLY for the 30-second snapshot staleness check. */
  now: number;
}

export interface OfficeAgent {
  instanceId: string;
  label: string;
  role: OfficeRole;
  pose: OfficePose;
  certainty: Certainty;
  statusText: string;
  /** Wall time of the transport observation, for the inspector. Absent for degraded placeholders. */
  observedAt?: string;
  /** Filled by the seat assignment (V2.2). */
  seat?: string;
  runId?: string;
  taskId?: string;
}

export interface OfficeTask extends WebTaskView { runId: string }

export interface OfficeHandoff {
  handoffId: string;
  ordinal: number;
  direction: WebHandoffView['direction'];
  state: WebHandoffView['state'];
  fromInstanceId?: string;
  toInstanceId?: string;
  fromRole: string;
  toRole: string;
}

export interface OfficeModel {
  tier: OfficeTier;
  /** Office-level certainty and label; meaningful for the closed tier ("Phiên đang dừng"). */
  certainty: Certainty;
  statusText: string;
  agents: OfficeAgent[];
  tasks: OfficeTask[];
  pendingDecisions: number;
  handoffs: OfficeHandoff[];
  observedAt?: string;
  connection: OfficeConnection;
}
