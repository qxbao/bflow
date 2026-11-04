// Pure presentation model. Types only from @bflow/contracts/web; no React, three.js, fetch or clock.
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
  /** Projection of the shared Director read state (Task 5), handed in by the UI. Absent or not a Director layout: the legacy v2 office. */
  director?: OfficeDirectorInput;
}

export type OfficeDirectorPresence = 'active' | 'waiting' | 'absent' | 'unknown';
/**
 * What the UI hands the model about the Director (D-CD-01). Presence is the host heartbeat projection read by the shared Director view, never a
 * Herdr transport state; `unknown` is a failed or pending read and never means absent. `issues` is present only for a fresh view.
 */
export interface OfficeDirectorInput {
  layout: 'director' | 'not_started' | 'legacy_v2' | 'unknown' | 'unsupported';
  /** The Director state's own `directorLayout` (confirmed view or last confirmed hint). UX only: never enables anything. */
  directorLayout: boolean;
  presence: OfficeDirectorPresence;
  provider?: string | undefined;
  heartbeatAt?: string | undefined;
  waitingSince?: string | undefined;
  issues?: readonly { status: string }[] | undefined;
}

/** The Director desk: a UI entity of its own, never an OfficeAgent (no instanceId, pane or AgentRole). */
export interface OfficeDirector {
  label: 'Director';
  presence: OfficeDirectorPresence;
  certainty: Certainty;
  statusText: string;
  provider?: string;
  heartbeatAt?: string;
  waitingSince?: string;
  /** Filled by the seat assignment: always the dedicated Director seat. */
  seat?: string;
}

/** Summary of the parked-issue queue for the queue board. `unknown` is a read that failed or has not landed; it is never an empty queue. */
export interface OfficeQueue {
  availability: 'ready' | 'unknown';
  open: number;
  retrying: number;
  /** The view caps its issue list; the counts may be a lower bound. */
  truncated: boolean;
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
  /** Present only in a Director layout. */
  director?: OfficeDirector;
  queue?: OfficeQueue;
}

/** One seated instance. Plain data: JSON round-trips unchanged. */
export interface SeatEntry {
  instanceId: string;
  /** Seat id, e.g. `developer:3`, `verification:reviewer`, `verification:reviewer:2`. */
  seat: string;
}

/** Output of the seat assignment (V2.2). `overflow` counts Developers that no seat could hold. */
export interface SeatMap {
  entries: SeatEntry[];
  overflow: number;
}

/** What a click or keypress on the stage selects. Emitted by the scene; resolved by the UI (V4). */
export type OfficeObjectId = 'counter' | 'board' | 'mailbox' | 'cabinet' | 'server' | 'settings' | 'door';
/** `director` is the Director desk and `queue` the queue board; both exist only in a Director layout and are not agents or furniture objects. */
export type OfficeTarget = { kind: 'agent'; instanceId: string } | { kind: 'object'; object: OfficeObjectId } | { kind: 'director' } | { kind: 'queue' };

/** Camera presets the HUD can ask of the scene. */
export type OfficeFocusZone = 'overview' | 'conversation' | 'coordinator' | 'developer' | 'qa';
