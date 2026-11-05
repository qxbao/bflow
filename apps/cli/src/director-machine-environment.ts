import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { sanitizeDirectorLaunchEnvironment } from './director-terminal.js';

export const DIRECTOR_MACHINE_ENV='BFLOW_DIRECTOR_MACHINE_ENV';
const absolute=z.string().min(1).max(4096).refine(isAbsolute);
const Schema=z.object({HOME:absolute,PATH:z.string().max(16000),XDG_CONFIG_HOME:absolute.optional(),XDG_DATA_HOME:absolute.optional(),
 XDG_STATE_HOME:absolute.optional(),XDG_CACHE_HOME:absolute.optional(),BFLOW_HOME:absolute.optional()}).strict();
/** Non-secret machine selectors only. Provider authentication is never serialized into terminal argv. */
export function captureDirectorMachineEnvironment(env:Readonly<Record<string,string|undefined>>):string{
 const home=env.AI_ISOLATOR_REAL_HOME||env.HOME||homedir();
 const nested=env.AI_ISOLATOR==='1'&&Boolean(env.AI_ISOLATOR_REAL_HOME);
 const values=Schema.parse({HOME:home,PATH:env.PATH??'',
  XDG_CONFIG_HOME:nested?join(home,'.config'):env.XDG_CONFIG_HOME,
  XDG_DATA_HOME:nested?join(home,'.local/share'):env.XDG_DATA_HOME,
  XDG_STATE_HOME:nested?join(home,'.local/state'):env.XDG_STATE_HOME,
  XDG_CACHE_HOME:nested?join(home,'.cache'):env.XDG_CACHE_HOME,BFLOW_HOME:env.BFLOW_HOME});
 return Buffer.from(JSON.stringify(values)).toString('base64url');
}
/** Bflow host startup uses its machine state, while the Director CLI keeps its chosen provider profile. */
export function restoreDirectorMachineEnvironment(env:Readonly<Record<string,string|undefined>>):Record<string,string>|undefined{
 const encoded=env[DIRECTOR_MACHINE_ENV]??(env.AI_ISOLATOR==='1'&&env.AI_ISOLATOR_REAL_HOME?captureDirectorMachineEnvironment(env):undefined);
 if(encoded===undefined)return undefined;
 if(encoded.length>32000||!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('Invalid Director machine environment binding');
 const machine=Schema.parse(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')));
 const restored=sanitizeDirectorLaunchEnvironment(env,'claude');
 for(const key of Object.keys(restored))if(/^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(key)||
  /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_OAUTH_TOKEN|_BASE_URL)$/.test(key)||
  ['AI_ISOLATOR','CODEX_HOME','CLAUDE_CONFIG_DIR','AGY_CONFIG_DIR','AGY_HOME','GEMINI_HOME','TMPDIR','BFLOW_DIRECTOR_PROVIDER'].includes(key))delete restored[key];
 for(const [key,value] of Object.entries(machine))if(value!==undefined)restored[key]=value;
 return restored;
}
