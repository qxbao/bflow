import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveNativeAgyPrompt } from '../src/native-agy-prompt.js';
const roots: string[] = [];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture() {
  const root=await mkdtemp('/tmp/agy-prompt-');roots.push(root);
  const home=join(root,'agy-home','coordinator'), config=join(home,'.gemini','config');
  await mkdir(config,{recursive:true,mode:0o700});
  const promptPath=join(root,'coordinator.system-prompt.txt'), scriptPath=join(config,'bflow-session-start.mjs');
  const script=`import { readFileSync } from "node:fs";\nconst systemMessage = readFileSync(${JSON.stringify(promptPath)}, "utf8");\nprocess.stdout.write(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] }));\n`;
  await writeFile(promptPath,'Original Coordinator\nHost policy',{mode:0o600});await writeFile(scriptPath,script,{mode:0o600});
  await writeFile(join(config,'hooks.json'),JSON.stringify({bflow:{SessionStart:[{type:'command',command:`'/trusted/node' '${scriptPath}'`,timeout:30}]}}),{mode:0o600});
  return {root,home,config,promptPath,scriptPath,script};
}
it('follows the native scoped SessionStart reference to the original role prompt',async()=>{
  const f=await fixture();expect(await resolveNativeAgyPrompt(f.home,'coordinator','Original Coordinator')).toBe(f.promptPath);
});
it('rejects unrelated prompt text, disabled hook groups and missing native references',async()=>{
  const f=await fixture();expect(await resolveNativeAgyPrompt(f.home,'coordinator','Another role')).toBeUndefined();
  await writeFile(join(f.config,'hooks.json'),JSON.stringify({bflow:{enabled:false,SessionStart:[{command:`'/node' '${f.scriptPath}'`}]}}));
  expect(await resolveNativeAgyPrompt(f.home,'coordinator','Original Coordinator')).toBeUndefined();
});
it('rejects a symlinked prompt or hook script',async()=>{
  const f=await fixture();await rm(f.scriptPath);await writeFile(join(f.root,'external.mjs'),f.script,{mode:0o600});await symlink(join(f.root,'external.mjs'),f.scriptPath);
  expect(await resolveNativeAgyPrompt(f.home,'coordinator','Original Coordinator')).toBeUndefined();
});
