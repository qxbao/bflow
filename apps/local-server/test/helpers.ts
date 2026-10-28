import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { expect } from 'vitest';
import * as entry from '../src/index.js';
import type { LocalWorkspaceServices, UserInteractionClient } from '@bflow/contracts/web';

export const unavailable = async () => ({ ok: false as const, error: { code: 'transport_unavailable' as const, retryable: true as const, message: 'private token /secret/socket' } });
export const workspace: LocalWorkspaceServices = { inspectProject: unavailable, startSession: unavailable, stopSession: unavailable, reconcileSessionOperation: unavailable, preview: unavailable };
export const client: UserInteractionClient = { readProjectSession: unavailable, listRuns: unavailable, readRun: unavailable, listDecisions: unavailable, execute: unavailable, readOperation: unavailable, async *events() { throw Error('unsupported'); }, acknowledgeNotice: unavailable, listMessages: unavailable, sendMessage: unavailable, readArtifact: unavailable };
export async function fixture(overrides: Partial<LocalWorkspaceServices> = {}, interaction = async (_id: string) => client) {
  expect(entry).toHaveProperty('createLocalWebServer');
  const directory = await mkdtemp(join(tmpdir(), 'w03-'));
  const assetsDirectory = join(directory, 'assets');
  await mkdir(assetsDirectory); await writeFile(join(assetsDirectory, 'index.html'), '<html>SPA</html>');
  const stateDirectory = join(directory, 'state');
  const options = { host: '127.0.0.1' as const, port: 0, stateDirectory, assetsDirectory, workspace: { ...workspace, ...overrides }, interaction };
  let server = await entry.createLocalWebServer(options);
  const send = (path: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) => new Promise<{status:number; headers: import('node:http').IncomingHttpHeaders; body:string; json: any}>((resolve, reject) => {
    const target = new URL(server.origin);
    const req = request({ hostname: target.hostname, port: target.port, path, method, headers: { 'Origin': server.origin, ...(body === undefined ? {} : {'Content-Type':'application/json', 'Content-Length': String(Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)))}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({status:res.statusCode!, headers:res.headers, body:text, json}); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const login = async () => {
    const secret = await server.issueBootstrap();
    const response = await send('/api/v1/session/bootstrap', 'POST', {apiVersion:1,secret});
    expect(response.status).toBe(200);
    return { response, secret, headers: { Cookie: response.headers['set-cookie']![0]!.split(';')[0]!, 'X-Bflow-CSRF': response.json.csrfToken } };
  };
  const repo = async (name='repo') => { const path=join(directory,name); await mkdir(path); execFileSync('git',['init','-q',path]); return path; };
  return {directory,stateDirectory,assetsDirectory,send,login,repo,get server(){return server;},restart:async()=>{await server.close();server=await entry.createLocalWebServer(options);},close:async()=>{await server.close();await rm(directory,{recursive:true,force:true});}};
}
