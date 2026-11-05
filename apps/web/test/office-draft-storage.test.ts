import { afterEach, expect, test, vi } from 'vitest';
import { decision } from './fixtures';
import { decisionDraftKey, readDecisionDrafts, writeDecisionDrafts } from '../src/features/office/ui/interaction/decision-drafts';

afterEach(() => { sessionStorage.clear(); vi.unstubAllEnvs(); });

test('decision drafts are project scoped, validated, and unavailable while the opt-in flag is off', () => {
  const key = decisionDraftKey(decision.runId, decision.decisionId);
  const drafts = { [key]: { review: decision, reason: 'Giữ lý do sau reload', option: '' } };
  writeDecisionDrafts('p', drafts);
  expect(sessionStorage.length).toBe(0);

  vi.stubEnv('VITE_BFLOW_IMMERSIVE_OFFICE', 'true');
  writeDecisionDrafts('p', drafts);
  expect(readDecisionDrafts('p')[key]).toEqual(drafts[key]);
  expect(readDecisionDrafts('q')).toEqual({});
});

test('corrupt snapshots are discarded while bounded decision reasons remain recoverable', () => {
  vi.stubEnv('VITE_BFLOW_IMMERSIVE_OFFICE', 'true');
  const key = decisionDraftKey(decision.runId, decision.decisionId);
  sessionStorage.setItem('bflow:immersive-office:decision-drafts:v1:p', JSON.stringify({ version: 1, projectId: 'p', drafts: { [key]: { review: { unknown: true }, reason: 'Lý do còn nguyên', option: '' } } }));
  expect(readDecisionDrafts('p')[key]).toEqual({ review: undefined, reason: 'Lý do còn nguyên', option: '' });
  sessionStorage.setItem('bflow:immersive-office:decision-drafts:v1:p', '{');
  expect(readDecisionDrafts('p')).toEqual({});
});
