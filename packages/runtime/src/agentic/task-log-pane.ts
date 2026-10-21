import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

export interface TaskLogPaneOptions {
  directory: string;
  repositoryPath: string;
  sessionId: string;
  logPath: string;
  herdr: (args: string[]) => Promise<string>;
}

interface Receipt {
  version: 1;
  repositoryPath: string;
  sessionId: string;
  workspaceId: string;
  phase: 'tab_create_intent' | 'created' | 'launch_intent' | 'launch_unknown' | 'running' | 'close_unknown';
  tabId?: string;
  paneId?: string;
  terminalId?: string;
  launchId?: string;
}

type Json = Record<string, unknown>;
type PaneObservation = 'missing' | 'replaced' | 'foreign' | 'viewer' | 'shell' | 'occupied' | 'starting';
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_RECEIPT = 16 * 1024;
const PROCESS_READY_POLL_MS = 100;
const PROCESS_READY_MAX_POLLS = 25;
const PROCESS_READY_DEADLINE_MS = 3_000;
const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const quote = (value: string) => `'${value.replace(/'/g, `'\''`)}'`;
const obj = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const paneError = (message: string): Error => Object.assign(new Error(message), { name: 'TaskLogPaneError' });

function decode(raw: string): Json {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw paneError('Herdr returned malformed JSON'); }
  if (!obj(value) || !obj(value.result)) throw paneError('Herdr returned an unexpected result envelope');
  return typeof value.result.type === 'string' || typeof value.type !== 'string'
    ? value.result
    : { ...value.result, type: value.type };
}

function getErrorCode(error: unknown): string | undefined {
  if (!obj(error)) return undefined;
  for (const key of ['code', 'error_code']) if (typeof error[key] === 'string') return error[key] as string;
  for (const key of ['stderr', 'stdout']) if (typeof error[key] === 'string') {
    try {
      const response: unknown = JSON.parse(error[key] as string);
      if (obj(response) && obj(response.error) && typeof response.error.code === 'string') return response.error.code;
    } catch { /* Text diagnostics do not establish a protocol outcome. */ }
  }
  return undefined;
}

export class TaskLogPane {
  private readonly receiptPath: string;
  private readonly viewerPath: string;
  private readonly repositoryPath: string;
  private chain: Promise<void> = Promise.resolve();
  private current: { paneId: string | undefined; error: string | undefined } = { paneId: undefined, error: undefined };

  constructor(private readonly options: TaskLogPaneOptions) {
    this.repositoryPath = resolve(options.repositoryPath);
    this.receiptPath = resolve(options.directory, 'task-log-pane.json');
    this.viewerPath = fileURLToPath(new URL('./task-log-viewer.js', import.meta.url));
  }

  status(): { paneId?: string; error?: string } {
    return { ...(this.current.paneId ? { paneId: this.current.paneId } : {}), ...(this.current.error ? { error: this.current.error } : {}) };
  }

  ensure(workspaceId: string): Promise<void> {
    return this.serial(async () => { this.current.error = undefined; await this.ensureLocked(workspaceId); });
  }

  close(): Promise<void> {
    return this.serial(async () => { this.current.error = undefined; await this.closeLocked(); });
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.chain.then(action, action);
    this.chain = next.catch(() => undefined);
    return next.catch((error: unknown) => { this.current.error = this.safeError(error); });
  }

  private safeError(error: unknown): string {
    const code = getErrorCode(error);
    if (code === 'not_found' || code === 'pane_not_found') return 'Owned task log pane is missing; it will be recreated on the next safe start.';
    return error instanceof Error && error.name === 'TaskLogPaneError' ? error.message.slice(0, 240) : 'Task log pane operation failed; workflow processing continues.';
  }

  private async ensureLocked(workspaceId: string): Promise<void> {
    if (!ID.test(workspaceId)) throw paneError('Invalid workspace identity');
    let receipt = await this.loadReceipt();
    if (receipt && (receipt.repositoryPath !== this.repositoryPath || receipt.sessionId !== this.options.sessionId)) {
      throw paneError('Task log pane receipt ownership mismatch; refusing to touch pane');
    }
    if (receipt && receipt.workspaceId !== workspaceId) {
      const observed = receipt.paneId ? await this.inspect(receipt) : undefined;
      if (observed !== 'missing' && observed !== 'replaced') throw paneError('Task log pane workspace changed while its prior ownership is unresolved');
      await this.removeReceipt(); this.current.paneId = undefined; receipt = undefined;
    }
    if (receipt?.paneId) {
      const observed = receipt.phase === 'created' ? await this.waitForProcess(receipt, 'shell') : await this.inspect(receipt);
      if (observed === 'missing' || observed === 'replaced') { await this.removeReceipt(); this.current.paneId = undefined; receipt = undefined; }
      else if (observed === 'foreign') throw paneError('Task log pane ownership changed; preserving the foreign pane');
      else if (observed === 'viewer') { receipt.phase = 'running'; await this.saveReceipt(receipt); this.current.paneId = receipt.paneId; return; }
      else if (receipt.phase === 'launch_intent' || receipt.phase === 'launch_unknown' || receipt.phase === 'close_unknown') {
        receipt.phase = 'launch_unknown'; await this.saveReceipt(receipt); throw paneError('Task log viewer launch acknowledgement is uncertain; refusing to replay pane.run');
      } else if (receipt.phase === 'running') throw paneError('Task log pane process is occupied; preserving the pane');
      else if (observed === 'starting') throw paneError('Task log pane shell readiness timed out; refusing pane.run');
    } else if (receipt?.phase === 'tab_create_intent') {
      throw paneError('Task log tab creation acknowledgement is uncertain; manual reconciliation is required');
    }
    if (!receipt) {
      const fresh: Receipt = { version: 1, repositoryPath: this.repositoryPath, sessionId: this.options.sessionId, workspaceId, phase: 'tab_create_intent', launchId: randomUUID() };
      await this.saveReceipt(fresh);
      let result: Json;
      try { result = decode(await this.options.herdr(['tab', 'create', '--workspace', workspaceId, '--cwd', this.repositoryPath, '--label', 'Logs', '--no-focus'])); }
      catch { throw paneError('Task log tab creation acknowledgement is uncertain; refusing duplicate creation'); }
      if (result.type !== 'tab_created' || !obj(result.tab) || !obj(result.root_pane)) throw paneError('Herdr tab create returned an invalid tab_created result');
      const tab = result.tab; const root = result.root_pane;
      if (tab.workspace_id !== workspaceId || typeof tab.tab_id !== 'string' || !ID.test(tab.tab_id) || root.workspace_id !== workspaceId || root.tab_id !== tab.tab_id || typeof root.pane_id !== 'string' || !ID.test(root.pane_id) || typeof root.terminal_id !== 'string' || !ID.test(root.terminal_id) || root.cwd !== this.repositoryPath) throw paneError('Herdr created a task log tab with mismatched identity');
      fresh.phase = 'created'; fresh.tabId = tab.tab_id; fresh.paneId = root.pane_id; fresh.terminalId = root.terminal_id;
      await this.saveReceipt(fresh); receipt = fresh; this.current.paneId = fresh.paneId;
      const renamed = decode(await this.options.herdr(['pane', 'rename', root.pane_id, 'task-log']));
      if (renamed.type !== 'pane_info' || !obj(renamed.pane) || renamed.pane.pane_id !== root.pane_id) throw paneError('Herdr pane rename returned an invalid pane_info result');
    }
    if (!receipt.paneId) throw paneError('Task log receipt has no pane identity');
    const observed = await this.waitForProcess(receipt, 'shell');
    if (observed === 'foreign') throw paneError('Task log pane ownership mismatch; refusing to launch');
    if (observed === 'viewer') { receipt.phase = 'running'; await this.saveReceipt(receipt); this.current.paneId = receipt.paneId; return; }
    if (observed === 'starting' || observed === 'occupied') throw paneError('Task log pane shell readiness timed out; refusing pane.run');
    if (observed !== 'shell') throw paneError('Task log pane is not in a safe shell state; refusing to launch');
    receipt.phase = 'launch_intent'; await this.saveReceipt(receipt);
    const command = `${quote(process.execPath)} ${quote(this.viewerPath)} ${quote(resolve(this.options.logPath))}`;
    try {
      const response = await this.options.herdr(['pane', 'run', receipt.paneId, command]);
      if (response !== '') throw paneError('Herdr pane.run must acknowledge with empty stdout');
    } catch {
      receipt.phase = 'launch_unknown'; await this.saveReceipt(receipt);
      throw paneError('Task log viewer launch acknowledgement is uncertain; refusing to replay pane.run');
    }
    const launched = await this.waitForProcess(receipt, 'viewer');
    if (launched !== 'viewer') {
      receipt.phase = 'launch_unknown'; await this.saveReceipt(receipt);
      throw paneError('Task log viewer process was not confirmed after pane.run; refusing to replay uncertain launch');
    }
    receipt.phase = 'running'; await this.saveReceipt(receipt); this.current.paneId = receipt.paneId;
  }

  private async waitForProcess(receipt: Receipt, target: 'shell' | 'viewer'): Promise<PaneObservation> {
    let latest: PaneObservation = 'starting';
    const deadline = Date.now() + PROCESS_READY_DEADLINE_MS;
    for (let attempt = 0; attempt < PROCESS_READY_MAX_POLLS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const observation = await Promise.race([
        this.inspect(receipt),
        new Promise<undefined>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(undefined), remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!observation) break;
      latest = observation;
      if (latest === 'missing' || latest === 'replaced' || latest === 'foreign') return latest;
      if (target === 'shell' && (latest === 'shell' || latest === 'viewer')) return latest;
      if (target === 'viewer' && latest === 'viewer') return latest;
      const pause = Math.min(PROCESS_READY_POLL_MS, deadline - Date.now());
      if (attempt + 1 < PROCESS_READY_MAX_POLLS && pause > 0) await delay(pause);
    }
    return latest;
  }

  private async inspect(receipt: Receipt): Promise<PaneObservation> {
    let paneResult: Json;
    try { paneResult = decode(await this.options.herdr(['pane', 'get', receipt.paneId!])); }
    catch (error) { if (['not_found', 'pane_not_found'].includes(getErrorCode(error) ?? '')) return 'missing'; throw error; }
    if (paneResult.type !== 'pane_info' || !obj(paneResult.pane)) throw paneError('Herdr pane get returned an invalid pane_info result');
    const pane = paneResult.pane;
    if (pane.pane_id !== receipt.paneId || ['terminal_id', 'workspace_id', 'tab_id'].some(key => typeof pane[key] !== 'string' || !ID.test(pane[key] as string)) || typeof pane.cwd !== 'string') throw paneError('Herdr pane get returned mismatched or malformed identity');
    // Public pane IDs can be reused by a restarted server. The old terminal is gone; never touch its replacement.
    if (pane.terminal_id !== receipt.terminalId) return 'replaced';
    if (pane.workspace_id !== receipt.workspaceId || pane.tab_id !== receipt.tabId || pane.cwd !== this.repositoryPath) return 'foreign';
    let processResult: Json;
    try { processResult = decode(await this.options.herdr(['pane', 'process-info', '--pane', receipt.paneId!])); }
    catch (error) { if (['not_found', 'pane_not_found'].includes(getErrorCode(error) ?? '')) return 'missing'; throw error; }
    if (processResult.type !== 'pane_process_info' || !obj(processResult.process_info)) throw paneError('Herdr process-info returned an invalid pane_process_info result');
    const info = processResult.process_info;
    if (info.pane_id !== receipt.paneId || !Array.isArray(info.foreground_processes)) throw paneError('Herdr process-info returned mismatched or malformed identity');
    if (info.foreground_processes.some(proc => !obj(proc) || !Number.isSafeInteger(proc.pid) || (proc.pid as number) <= 0 || !Array.isArray(proc.argv) || proc.argv.some(arg => typeof arg !== 'string'))) throw paneError('Herdr process-info returned malformed foreground processes');
    const processes = info.foreground_processes as Json[];
    if (processes.length === 0) return 'starting';
    const viewer = processes.length === 1 && processes.some((proc) => {
      const argv = proc.argv;
      return info.foreground_process_group_id === proc.pid && Array.isArray(argv) && argv.length === 3 && typeof argv[0] === 'string' && resolve(argv[0]) === resolve(process.execPath) && argv[1] === this.viewerPath && argv[2] === resolve(this.options.logPath);
    });
    if (viewer) return 'viewer';
    const shellPid = info.shell_pid;
    const shell = processes.some((proc) => proc.pid === shellPid && ['zsh', 'bash', 'sh', 'fish'].includes(String(proc.name)));
    if (Number.isInteger(shellPid) && info.foreground_process_group_id === shellPid && shell) return processes.length === 1 && processes.every((proc) => proc.pid === shellPid) ? 'shell' : 'occupied';
    return 'occupied';
  }

  private async closeLocked(): Promise<void> {
    const receipt = await this.loadReceipt();
    if (!receipt?.paneId) { this.current.paneId = undefined; return; }
    if (receipt.repositoryPath !== this.repositoryPath || receipt.sessionId !== this.options.sessionId) throw paneError('Task log pane receipt ownership mismatch; refusing to close pane');
    const observed = await this.inspect(receipt);
    if (observed === 'missing' || observed === 'replaced') { await this.removeReceipt(); this.current.paneId = undefined; return; }
    const emptyOwnedShell = receipt.phase === 'created' && observed === 'shell';
    if (observed !== 'viewer' && !emptyOwnedShell) throw paneError('Task log pane ownership cannot be proven; preserving pane');
    receipt.phase = 'close_unknown'; await this.saveReceipt(receipt);
    try {
      const result = decode(await this.options.herdr(['pane', 'close', receipt.paneId]));
      if (result.type !== 'ok') throw paneError('invalid pane close acknowledgement');
      await this.removeReceipt(); this.current.paneId = undefined;
    } catch { throw paneError('Task log pane close acknowledgement is uncertain; preserving receipt for reconciliation'); }
  }

  private async loadReceipt(): Promise<Receipt | undefined> {
    let handle;
    try { handle = await open(this.receiptPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_RECEIPT || (info.mode & 0o077) !== 0) throw paneError('Task log pane receipt is not a private regular file');
      const text = await handle.readFile({ encoding: 'utf8' });
      const parsed: unknown = JSON.parse(text);
      if (!obj(parsed) || parsed.version !== 1 || typeof parsed.repositoryPath !== 'string' || typeof parsed.sessionId !== 'string' || typeof parsed.workspaceId !== 'string' || !ID.test(parsed.workspaceId) || !['tab_create_intent', 'created', 'launch_intent', 'launch_unknown', 'running', 'close_unknown'].includes(String(parsed.phase))) throw paneError('Task log pane receipt is malformed');
      for (const key of ['paneId', 'tabId', 'terminalId'] as const) if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || !ID.test(parsed[key]))) throw paneError('Task log pane receipt contains invalid identity');
      return parsed as unknown as Receipt;
    } finally { await handle.close(); }
  }

  private async saveReceipt(receipt: Receipt): Promise<void> {
    await mkdir(dirname(this.receiptPath), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(this.receiptPath));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw paneError('Task log pane state directory is not a private directory');
    await chmod(dirname(this.receiptPath), 0o700);
    const temp = `${this.receiptPath}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.receiptPath); await chmod(this.receiptPath, 0o600);
    const directoryHandle = await open(dirname(this.receiptPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  }

  private async removeReceipt(): Promise<void> { try { await unlink(this.receiptPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
