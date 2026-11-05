import { expect,it,vi } from 'vitest';
import { captureDirectorMachineEnvironment,restoreDirectorMachineEnvironment,DIRECTOR_MACHINE_ENV } from '../src/director-machine-environment.js';
it('retains the Web owner machine state without leaking provider authentication into the binding',()=>{
 const encoded=captureDirectorMachineEnvironment({HOME:'/native',PATH:'/native/bin:/usr/bin',XDG_CONFIG_HOME:'/machine/config',BFLOW_HOME:'/machine/bflow',ANTHROPIC_API_KEY:'native-secret'});
 expect(Buffer.from(encoded,'base64url').toString()).not.toContain('native-secret');
 const restored=restoreDirectorMachineEnvironment({[DIRECTOR_MACHINE_ENV]:encoded,HOME:'/profiles/claude--work/home',PATH:'/provider/bin',XDG_CONFIG_HOME:'/profiles/work/config',
  XDG_DATA_HOME:'/profiles/work/data',CODEX_HOME:'/other/profile',ANTHROPIC_API_KEY:'profile-secret',AI_ISOLATOR_PROFILE:'work',BFLOW_DIRECTOR_PROVIDER:'claude',HERDR_SESSION:'stale',DISPLAY:':0'});
 expect(restored).toEqual({HOME:'/native',PATH:'/native/bin:/usr/bin',XDG_CONFIG_HOME:'/machine/config',BFLOW_HOME:'/machine/bflow',DISPLAY:':0'});
});
it('uses the real machine home for a manually launched ai-isolator Director and refuses malformed bindings',()=>{
 expect(restoreDirectorMachineEnvironment({AI_ISOLATOR:'1',AI_ISOLATOR_REAL_HOME:'/native',HOME:'/profile/home',PATH:'/usr/bin',XDG_STATE_HOME:'/profile/state'}))
  .toMatchObject({HOME:'/native',XDG_STATE_HOME:'/native/.local/state'});
 expect(()=>restoreDirectorMachineEnvironment({[DIRECTOR_MACHINE_ENV]:'not json'})).toThrow();
 expect(()=>restoreDirectorMachineEnvironment({[DIRECTOR_MACHINE_ENV]:Buffer.from(JSON.stringify({HOME:'relative',PATH:'/bin'})).toString('base64url')})).toThrow();
 expect(restoreDirectorMachineEnvironment({HOME:'/native'})).toBeUndefined();
});

it('starts the host in the captured machine environment without mixing child stdout into Director JSON',async()=>{
 const {defaultDirectorDeps}=await import('../src/director-commands.js');
 const {environmentProcessRunner}=await import('../src/environment-process.js');
 const encoded=captureDirectorMachineEnvironment({HOME:'/native',PATH:'/usr/bin',XDG_STATE_HOME:'/machine-state'});
 vi.stubEnv(DIRECTOR_MACHINE_ENV,encoded);
 const run=vi.spyOn(environmentProcessRunner,'run').mockResolvedValue({exitCode:0,stdout:'{"ok":true,"command":"up"}\n',stderr:''});
 try{
  await (await defaultDirectorDeps('/repo')).ensureUp('/repo');
  expect(run).toHaveBeenCalledWith(expect.objectContaining({args:[expect.stringMatching(/bin\.js$/),'up','--json'],mode:'capture',cwd:'/repo',env:expect.objectContaining({HOME:'/native',XDG_STATE_HOME:'/machine-state'})}));
 }finally{run.mockRestore();vi.unstubAllEnvs();}
});
