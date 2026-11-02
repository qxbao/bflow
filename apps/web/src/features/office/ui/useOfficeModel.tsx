import { useEffect, useMemo, useRef, useState } from 'react';
import type { WebDecision, WebProjectSession, WebRunView, WebWorkforceView } from '@bflow/contracts/web';
import { ApiClient, ApiError } from '../../../api/client';
import type { Connection } from '../../../api/events';
import { useRead } from '../../data';
import { deriveOffice } from '../model/derive';
import { applySeats } from '../model/seats';
import type { OfficeModel, SeatMap } from '../model/types';

/** A lease can expire without any invalidating event, so the visible workforce is re-read on this period. */
export const WORKFORCE_POLL_MS = 15_000;
/** Backends without D-WEB-03 answer one of these. Remembered per ApiClient (one page load) so the read is never repeated. */
const AUTH_CODES = new Set(['session_required', 'forbidden']);
const UNSUPPORTED_CODES = new Set(['operation_not_allowed', 'not_found']);
const unsupportedBy = new WeakMap<ApiClient, Set<string>>();

export interface OfficeModelState {
  model: OfficeModel | undefined;
  runs: readonly WebRunView[];
  /** Developers that no seat could hold (the HUD's "+n" chip). */
  overflow: number;
  /** The newest failed read, whichever it was. The HUD tells "failed" (error, no data) from "not available" (unsupported). */
  error: unknown;
  /** The session cookie is gone or refused: needs re-pairing, never shown as plain stale data. */
  authRequired: boolean;
  /** A non-auth re-read failed and the model on screen comes from earlier reads. */
  stale: boolean;
  /** The sorted workforce view behind the model (inspector inputs), absent in the degraded tier. */
  workforce: WebWorkforceView | undefined;
  decisions: readonly WebDecision[];
  /** The backend has no workforce view: the model is the degraded tier. */
  unsupported: boolean;
}

const byBoundAt = (a: { boundAt: string; instanceId: string }, b: { boundAt: string; instanceId: string }): number => a.boundAt.localeCompare(b.boundAt) || a.instanceId.localeCompare(b.instanceId);

/**
 * The office model of visual mode. Mounted only while visual mode shows, so Classic never reads /workforce. Reads follow the page
 * revision (SSE invalidation) plus a 15 s re-read while the tab is visible. A failed re-read keeps the last model and sets `stale`.
 */
export function useOfficeModel({ api, id, session, connection, revision }: { api: ApiClient; id: string; session: WebProjectSession | undefined; connection: Connection; revision: number }): OfficeModelState {
  const runs = useRead(`office-runs:${id}`, () => api.runs(id), revision);
  const decisions = useRead(`office-decisions:${id}`, () => api.decisions(id), revision);
  const [tick, setTick] = useState(0);
  const isUnsupported = (): boolean => unsupportedBy.get(api)?.has(id) ?? false;
  // The timer runs only while the tab is visible; becoming visible re-reads once at once.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const bump = (): void => { if (!document.hidden && !(unsupportedBy.get(api)?.has(id) ?? false)) setTick(value => value + 1); };
    const start = (): void => { if (timer === undefined) timer = setInterval(bump, WORKFORCE_POLL_MS); };
    const stop = (): void => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const onVisibility = (): void => { if (document.hidden) stop(); else { bump(); start(); } };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [api, id]);
  const workforce = useRead<WebWorkforceView | undefined>(`office-workforce:${id}`, async () => {
    if (isUnsupported()) return undefined;
    try { return await api.readWorkforce(id); } catch (error) {
      if (error instanceof ApiError && UNSUPPORTED_CODES.has(error.code)) {
        const set = unsupportedBy.get(api) ?? new Set<string>();
        set.add(id); unsupportedBy.set(api, set);
        return undefined;
      }
      throw error;
    }
  }, revision + tick);
  const sorted = useMemo(() => (workforce.data ? { ...workforce.data, agents: [...workforce.data.agents].sort(byBoundAt) } : undefined), [workforce.data]);
  const seats = useRef<SeatMap>({ entries: [], overflow: 0 });
  const seated = useMemo(() => {
    if (!session) return undefined;
    const derived = deriveOffice({ session, runs: runs.data?.items ?? [], decisions: decisions.data?.items ?? [], ...(sorted ? { workforce: sorted } : {}), connection, now: Date.now() });
    return applySeats(seats.current, derived);
  }, [session, runs.data, decisions.data, sorted, connection]);
  // Seats are remembered after commit, so rendering itself never mutates the ref.
  useEffect(() => { if (seated) seats.current = seated.seats; }, [seated]);
  const error = [workforce.error, runs.error, decisions.error].find(e => e !== undefined);
  const authRequired = [workforce.error, runs.error, decisions.error].some(e => e instanceof ApiError && AUTH_CODES.has(e.code));
  const stale = !authRequired && [runs, decisions, workforce].some(r => r.error !== undefined && r.data !== undefined);
  return { model: seated?.model, overflow: seated?.seats.overflow ?? 0, runs: runs.data?.items ?? [], decisions: decisions.data?.items ?? [], workforce: sorted, error, authRequired, stale, unsupported: isUnsupported() };
}
