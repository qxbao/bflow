import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('task log viewer', () => {
  it('keeps the P15 mismatch path and remediation visible in the existing viewer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bflow-viewer-assess-')); dirs.push(directory);
    const log = join(directory, 'activity.jsonl');
    await writeFile(log, JSON.stringify({ at: '2026-10-22T15:23:10Z', kind: 'error', role: 'coordinator', action: 'assess:failed',
      outcome: 'specification.metadata.sdd: P15 assess requires an explicit impact object; read planning_reference' }) + '\n');
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/runtime/dist/agentic/task-log-viewer.js'), log], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    try {
      await expect.poll(() => output, { timeout: 3000, interval: 30 }).toContain('assess:failed');
      expect(output).toContain('specification.metadata.sdd');
      expect(output).toContain('planning_reference');
    } finally { child.kill('SIGTERM'); await exited; }
  });

  it('shows every retained event in a large burst and does not replay it on atomic replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bflow-viewer-burst-')); dirs.push(directory);
    const log = join(directory, 'activity.jsonl');
    const rows = Array.from({ length: 1000 }, (_, index) => JSON.stringify({ at: '2026-10-20T04:05:06Z', kind: 'progress', role: 'developer', action: `event-${String(index).padStart(4, '0')}`, outcome: 'x'.repeat(180) }));
    await writeFile(log, rows.join('\n') + '\n');
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/runtime/dist/agentic/task-log-viewer.js'), log], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    try {
      await expect.poll(() => output.match(/event-\d{4}/g)?.length ?? 0, { timeout: 4000, interval: 30 }).toBe(1000);
      const next = JSON.stringify({ at: '2026-10-20T04:05:07Z', kind: 'progress', role: 'qa', action: 'after-burst' });
      await writeFile(log + '.next', [...rows.slice(1), next].join('\n') + '\n'); await rename(log + '.next', log);
      await expect.poll(() => output, { timeout: 3000, interval: 30 }).toContain('after-burst');
      expect(output.match(/event-\d{4}/g)).toHaveLength(1000);
    } finally { child.kill('SIGTERM'); await exited; }
  });

  it('keeps repeated identical legacy rows as distinct occurrences', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bflow-viewer-repeat-')); dirs.push(directory);
    const log = join(directory, 'activity.jsonl');
    const row = JSON.stringify({ at: '2026-10-20T04:05:06Z', kind: 'progress', role: 'developer', action: 'same-step' });
    await writeFile(log, row + '\n' + row + '\n');
    const child = spawn(process.execPath, [join(process.cwd(), 'packages/runtime/dist/agentic/task-log-viewer.js'), log], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    try {
      await expect.poll(() => output.match(/same-step/g)?.length ?? 0, { timeout: 3000, interval: 30 }).toBe(2);
    } finally { child.kill('SIGTERM'); await exited; }
  });
  it('renders bounded sanitized human-readable entries and follows atomic replacement without replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bflow-viewer-')); dirs.push(directory);
    const log = join(directory, 'activity.jsonl');
    const viewer = join(process.cwd(), 'packages/runtime/dist/agentic/task-log-viewer.js');
    const similar = [
      { at: '2026-10-20T04:05:06.100Z', kind: 'task.started', role: 'developer', action: 'implement', runId: 'run-identifier-1234-A' },
      { at: '2026-10-20T04:05:06.200Z', kind: 'task.started', role: 'developer', action: 'implement', runId: 'run-identifier-1234-B' },
    ];
    await writeFile(log, `${similar.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const child = spawn(process.execPath, [viewer, log], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
    try {
      await expect.poll(() => output, { timeout: 3000, interval: 50 }).toContain('04:05:06');
      await expect.poll(() => output.match(/04:05:06/g)?.length ?? 0, { timeout: 1000, interval: 50 }).toBe(2);
      expect(output).toContain('developer');
      expect(output).toContain('implement');
      await writeFile(`${log}.next`, `${JSON.stringify({ at: '2026-10-20T04:05:07Z', kind: 'task.done', role: 'qa', action: 'verify', outcome: 'passed\u001b[2J' })}\n`);
      const { rename } = await import('node:fs/promises'); await rename(`${log}.next`, log);
      await expect.poll(() => output, { timeout: 3000, interval: 50 }).toContain('04:05:07');
      expect(output).not.toContain('\u001b');
      expect(output.match(/04:05:06/g)).toHaveLength(2);
      expect(output.match(/04:05:07/g)).toHaveLength(1);
    } finally { child.kill('SIGTERM'); await exited; }
  });

  it('formats notice technical details on one readable line with #n, Việc #k, role, runId, messageType, reason and artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bflow-viewer-notice-')); dirs.push(directory);
    const log = join(directory, 'activity.jsonl');
    const viewer = join(process.cwd(), 'packages/runtime/dist/agentic/task-log-viewer.js');
    const noticeEntry = {
      at: '2026-10-20T04:05:08.000Z',
      kind: 'notice',
      role: 'runtime',
      action: 'conversation.progress:workflow_blocked',
      messageType: 'conversation.progress',
      runId: 'run-42',
      shortId: '#3',
      runLabel: 'Việc #1: Thêm trang đăng nhập',
      reason: 'Developer không phản hồi: {"code":"timeout","attempt":3}',
      artifacts: ['artifact://store/spec-1', 'artifact://store/patch-1']
    };
    await writeFile(log, `${JSON.stringify(noticeEntry)}\n`);
    const child = spawn(process.execPath, [viewer, log], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
    try {
      await expect.poll(() => output, { timeout: 3000, interval: 30 }).toContain('04:05:08');
      const lines = output.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('#3');
      expect(lines[0]).toContain('Việc #1');
      expect(lines[0]).toContain('runtime');
      expect(lines[0]).toContain('run:run-42');
      expect(lines[0]).toContain('conversation.progress');
      expect(lines[0]).toContain('Developer không phản hồi: {"code":"timeout","attempt":3}');
      expect(lines[0]).toContain('artifact://store/spec-1');
      expect(lines[0]).toContain('artifact://store/patch-1');
    } finally { child.kill('SIGTERM'); await exited; }
  });
});
