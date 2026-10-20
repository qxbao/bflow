import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskLogPane } from '../../src/agentic/task-log-pane.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'bflow-task-log-')); dirs.push(directory); return directory; }
function pane(directory: string, herdr: (args: string[]) => Promise<string>) {
  return new TaskLogPane({ directory, repositoryPath: '/repo', sessionId: 'session-a', logPath: '/repo/.bflow/task.log', herdr });
}
const created = JSON.stringify({ result: { type: 'tab_created', tab: { tab_id: 'tab-1', workspace_id: 'ws-1' }, root_pane: { pane_id: 'pane-1', terminal_id: 'term-1', tab_id: 'tab-1', workspace_id: 'ws-1', cwd: '/repo' } } });
const getPane = JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: 'pane-1', terminal_id: 'term-1', workspace_id: 'ws-1', tab_id: 'tab-1', cwd: '/repo' } } });
const shellInfo = JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: "pane-1", shell_pid: 9, foreground_process_group_id: 9, foreground_processes: [{ pid: 9, argv: ['/bin/zsh'], name: 'zsh' }] } } });
const shellStartupChildrenInfo = JSON.stringify({ id: 'cli:pane:process_info', result: { process_info: { pane_id: "pane-1", shell_pid: 9, foreground_process_group_id: 9, foreground_processes: [{ pid: 11, argv: ['/bin/sh', '-c', 'initialization'], name: 'sh' }, { pid: 9, argv: ['-zsh'], name: 'zsh' }] } }, type: 'pane_process_info' });
const viewerInfo = JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: "pane-1", shell_pid: 9, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, argv: [process.execPath, new URL('../../src/agentic/task-log-viewer.js', import.meta.url).pathname, '/repo/.bflow/task.log'], name: 'node' }] } } });
const paneInfo = JSON.stringify({ id: 'cli:pane:get', result: { pane: { pane_id: 'pane-1', terminal_id: 'term-1', workspace_id: 'ws-1', tab_id: 'tab-1', cwd: '/repo' } }, type: 'pane_info' });

describe('TaskLogPane', () => {
  it('recreates its log pane when a restarted server reuses the old pane ID for another terminal', async () => {
    const directory = await fixture();
    const receipt = { version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' };
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify(receipt), { mode: 0o600 });
    const replacement = { pane_id: 'pane-2', terminal_id: 'term-2', workspace_id: 'ws-1', tab_id: 'tab-2', cwd: '/repo' };
    const replacementInfo = JSON.stringify({ result: { type: 'pane_info', pane: replacement } });
    let launched = false;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return JSON.stringify({ result: { type: 'tab_created', tab: { tab_id: 'tab-2', workspace_id: 'ws-1' }, root_pane: replacement } });
      if (args[1] === 'get' && args[2] === 'pane-1') return JSON.stringify({ result: { type: 'pane_info', pane: { ...replacement, pane_id: 'pane-1', tab_id: 'tab-1' } } });
      if (args[1] === 'get' || args[1] === 'rename') return replacementInfo;
      if (args[1] === 'process-info') { const info = JSON.parse(launched ? viewerInfo : shellInfo); info.result.process_info.pane_id = 'pane-2'; return JSON.stringify(info); }
      if (args[1] === 'run') { launched = true; return ''; }
      throw new Error('Unexpected mutation');
    });
    const subject = pane(directory, herdr); await subject.ensure('ws-1');
    expect(subject.status()).toEqual({ paneId: 'pane-2' });
    expect(herdr.mock.calls.some(([args]) => args[1] === 'close' || args[1] === 'run' && args[2] === 'pane-1')).toBe(false);
  });

  it('preserves a pane with a viewer and another foreground process', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify({ version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' }), { mode: 0o600 });
    const mixed = JSON.parse(viewerInfo);
    mixed.result.process_info.pane_id = 'pane-1'; mixed.result.process_info.foreground_processes.push({ pid: 11, name: 'editor', argv: ['/usr/bin/editor'] });
    const herdr = vi.fn(async (args: string[]) => args[1] === 'get' ? paneInfo : args[1] === 'process-info' ? JSON.stringify(mixed) : JSON.stringify({ result: { type: 'ok' } }));
    const subject = pane(directory, herdr); await subject.close();
    expect(herdr.mock.calls.some(([args]) => args[1] === 'close')).toBe(false);
    expect(subject.status().error).toMatch(/ownership|occupied/);
  });

  it('rejects process information for a different pane before closing anything', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify({ version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' }), { mode: 0o600 });
    const wrong = JSON.parse(viewerInfo); wrong.result.process_info.pane_id = 'foreign-pane';
    const herdr = vi.fn(async (args: string[]) => args[1] === 'get' ? paneInfo : args[1] === 'process-info' ? JSON.stringify(wrong) : JSON.stringify({ result: { type: 'ok' } }));
    const subject = pane(directory, herdr); await subject.close();
    expect(herdr.mock.calls.some(([args]) => args[1] === 'close')).toBe(false);
    expect(subject.status().error).toBeDefined();
  });

  it('never treats unstructured error text as proof that an owned pane is absent', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify({ version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' }), { mode: 0o600 });
    const herdr = vi.fn(async () => { throw Object.assign(new Error('transport failed'), { stderr: 'diagnostic code: not_found before malformed reply' }); });
    const subject = pane(directory, herdr); await subject.ensure('ws-1');
    expect(herdr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(directory, 'task-log-pane.json'), 'utf8')).phase).toBe('running');
  });

  it('uses a new workspace only after a structured response proves the old pane absent', async () => {
    const directory = await fixture();
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify({ version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-old', tabId: 'tab-old', paneId: 'pane-old', terminalId: 'term-old', phase: 'running' }), { mode: 0o600 });
    let launched = false;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[1] === 'get' && args[2] === 'pane-old') throw Object.assign(new Error('command failed'), { code: 1, stderr: JSON.stringify({ id: 'cli:pane:get', error: { code: 'not_found', message: 'absent' } }) });
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename' || args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') return launched ? viewerInfo : shellInfo;
      if (args[1] === 'run') { launched = true; return ''; }
      throw new Error('unexpected');
    });
    const subject = pane(directory, herdr); await subject.ensure('ws-1');
    expect(subject.status()).toEqual({ paneId: 'pane-1' });
    expect(herdr.mock.calls.find(([args]) => args[0] === 'tab')?.[0]).toContain('ws-1');
  });
  it('creates a no-focus Logs tab and launches viewer only after saving ownership intent', async () => {
    const directory = await fixture();
    const calls: string[][] = [];
    const herdr = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'tab') return created;
      if (args[0] === 'pane' && args[1] === 'rename') return paneInfo;
      if (args[0] === 'pane' && args[1] === 'get') return paneInfo;
      if (args[0] === 'pane' && args[1] === 'process-info') return calls.filter((call) => call[1] === 'run').length ? viewerInfo : shellInfo;
      if (args[0] === 'pane' && args[1] === 'run') {
        const receipt = JSON.parse(await readFile(join(directory, 'task-log-pane.json'), 'utf8'));
        expect(receipt.phase).toBe('launch_intent');
        return '';
      }
      if (args[0] === 'pane' && args[1] === 'close') return JSON.stringify({ result: { type: 'ok' } });
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(subject.status()).toEqual({ paneId: 'pane-1' });
    expect(calls[0]).toEqual(['tab', 'create', '--workspace', 'ws-1', '--cwd', '/repo', '--label', 'Logs', '--no-focus']);
    expect(calls[1]).toEqual(['pane', 'rename', 'pane-1', 'task-log']);
    expect(calls.some((call) => call[1] === 'run')).toBe(true);
    await subject.close();
  });

  it('waits for Herdr shell startup before launching the viewer', async () => {
    const directory = await fixture();
    let processReads = 0;
    let runStarted = false;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') {
        if (runStarted) return viewerInfo;
        return processReads++ === 0 ? JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: "pane-1", foreground_processes: [] } } }) : shellInfo;
      }
      if (args[1] === 'run') { runStarted = true; return ''; }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(processReads).toBeGreaterThanOrEqual(2);
    expect(herdr.mock.calls.filter(([args]) => args[1] === 'process-info').length).toBeGreaterThanOrEqual(3);
    expect(subject.status()).toEqual({ paneId: 'pane-1' });
  });

  it('waits through shell startup children until the shell is alone', async () => {
    const directory = await fixture();
    let processReads = 0;
    let runStarted = false;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') {
        if (runStarted) return viewerInfo;
        processReads++;
        return processReads === 1 ? shellStartupChildrenInfo : shellInfo;
      }
      if (args[1] === 'run') { runStarted = true; return ''; }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(processReads).toBeGreaterThanOrEqual(2);
    expect(herdr.mock.calls.some(([args]) => args[1] === 'run')).toBe(true);
    expect(subject.status()).toEqual({ paneId: 'pane-1' });
  });

  it('bounds shell readiness polling without running an unready pane', async () => {
    const directory = await fixture();
    let processReads = 0;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') { processReads++; return shellStartupChildrenInfo; }
      if (args[1] === 'run') return '';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(processReads).toBeGreaterThan(1);
    expect(processReads).toBeLessThanOrEqual(32);
    expect(herdr.mock.calls.some(([args]) => args[1] === 'run')).toBe(false);
    expect(subject.status().error).toMatch(/readiness|starting|safe shell/i);
  });

  it('does not replay pane.run after an uncertain acknowledgement', async () => {
    const directory = await fixture();
    let runCount = 0;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'run') { runCount++; throw new Error('timeout'); }
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') return shellInfo;
      throw new Error('unexpected');
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(subject.status().error).toMatch(/uncertain/i);
    await subject.ensure('ws-1');
    expect(runCount).toBe(1);
    expect(subject.status().error).toMatch(/uncertain/i);
  });

  it('requires the viewer process after a successful run acknowledgement and never retries it', async () => {
    const directory = await fixture();
    let runCount = 0;
    const herdr = vi.fn(async (args: string[]) => {
      if (args[0] === 'tab') return created;
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') return shellInfo;
      if (args[1] === 'run') { runCount++; return ''; }
      throw new Error('unexpected');
    });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    expect(subject.status().error).toMatch(/not confirmed/i);
    await subject.ensure('ws-1');
    expect(runCount).toBe(1);
    expect(subject.status().error).toMatch(/uncertain/i);
  });

  it('does not duplicate a tab after an uncertain tab.create acknowledgement', async () => {
    const directory = await fixture();
    let createCount = 0;
    const herdr = vi.fn(async () => { createCount++; throw new Error('timeout'); });
    const subject = pane(directory, herdr);
    await subject.ensure('ws-1');
    await subject.ensure('ws-1');
    expect(createCount).toBe(1);
    expect(subject.status().error).toMatch(/uncertain/i);
  });

  it('keeps a foreign pane and reports ownership mismatch', async () => {
    const directory = await fixture();
    const herdr = vi.fn(async (args: string[]) => args[1] === 'get'
      ? JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: 'pane-1', terminal_id: 'term-1', workspace_id: 'ws-other', tab_id: 'tab-1', cwd: '/repo' } } })
      : '{}');
    const receipt = { version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' };
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify(receipt), { mode: 0o600 });
    const subject = pane(directory, herdr);
    await subject.close();
    expect(subject.status().error).toMatch(/ownership/i);
    expect(herdr).toHaveBeenCalledTimes(1);
    expect(herdr.mock.calls[0]?.[0][1]).toBe('get');
  });

  it('reuses an owned viewer after host restart and recreates a definitively missing pane', async () => {
    const directory = await fixture();
    const { writeFile } = await import('node:fs/promises');
    const receipt = { version: 1, repositoryPath: '/repo', sessionId: 'session-a', workspaceId: 'ws-1', tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', phase: 'running' };
    await writeFile(join(directory, 'task-log-pane.json'), JSON.stringify(receipt), { mode: 0o600 });
    const reuse = vi.fn(async (args: string[]) => args[1] === 'get' ? paneInfo : args[1] === 'process-info' ? viewerInfo : '');
    const restarted = pane(directory, reuse);
    await restarted.ensure('ws-1');
    expect(restarted.status()).toEqual({ paneId: 'pane-1' });
    expect(reuse.mock.calls.map(([args]) => args[0])).toEqual(['pane', 'pane']);
    expect(reuse.mock.calls.map(([args]) => args[1])).toEqual(['get', 'process-info']);

    let createdTabs = 0;
    let paneGetCount = 0;
    let runAck = false;
    const recreate = vi.fn(async (args: string[]) => {
      if (args[0] === 'pane' && args[1] === 'get' && paneGetCount++ === 0) throw Object.assign(new Error('pane absent'), { code: 'not_found' });
      if (args[0] === 'tab') { createdTabs++; return created; }
      if (args[1] === 'rename') return paneInfo;
      if (args[1] === 'get') return paneInfo;
      if (args[1] === 'process-info') return runAck ? viewerInfo : shellInfo;
      if (args[1] === 'run') { runAck = true; return ''; }
      throw new Error('unexpected');
    });
    const next = pane(directory, recreate);
    await next.ensure('ws-1');
    expect(createdTabs).toBe(1);
    expect(next.status()).toEqual({ paneId: 'pane-1' });
  });
});
