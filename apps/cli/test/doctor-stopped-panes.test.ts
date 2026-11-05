import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultEnvironmentConfig, identifyRepository, runDoctorDiagnostics, type EnvironmentProcessRunner } from '../src/index.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it.each(['stopped','running','unknown'] as const)('distinguishes historical pane observations from live failures (%s)',async(server)=>{
 const root=await mkdtemp(join(tmpdir(),'doctor-pane-'));roots.push(root);execFileSync('git',['init','-q',root]);
 const runner:EnvironmentProcessRunner={run:async r=>{
  if(r.executable==='git')return {exitCode:0,stdout:execFileSync('git',r.args,{cwd:r.cwd,encoding:'utf8'}),stderr:''};
  if(r.args.join(' ')==='status server --json')return server==='unknown'?{exitCode:1,stdout:'',stderr:'probe unavailable'}:
   {exitCode:0,stdout:JSON.stringify({session:r.env?.HERDR_SESSION,running:server==='running'}),stderr:''};
  return {exitCode:127,stdout:'',stderr:'not installed'};
 }};
 const repository=await identifyRepository(root,runner),config=defaultEnvironmentConfig(repository,'doctor',new Date(),'claude');
 config.environment.deepwiki={enabled:false,required:false};
 const manager={doctorSession:async()=>({schemaVersion:2,workspaceRoot:root,sessionId:repository.sessionName,healthy:false,
  checks:[{checkId:'pane-binding-developer-1',name:'Developer',status:'failed',message:'Agent dev-1: disconnected'},
   {checkId:'p13-v2-session',name:'Legacy',status:'warn',message:'Phiên v2 đang chạy.'}],checkedAt:new Date().toISOString()})};
 const report=await runDoctorDiagnostics({repository,config,runner,dependencies:{},integration:async()=>({manager}) as never});
 expect(report.checks.find(c=>c.checkId==='pane-binding-developer-1')).toMatchObject({status:server==='stopped'?'warn':'failed',
  message:server==='stopped'?expect.stringContaining('lịch sử'):expect.stringContaining('disconnected')});
 const legacy=report.checks.find(c=>c.checkId==='p13-v2-session')!;
 if(server==='stopped'){expect(legacy.message).not.toContain('đang chạy');expect(legacy.message).toContain('bflow down');}
});
