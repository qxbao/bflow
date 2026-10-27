import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../src/parser.js';

describe('execution preview ingress', () => {
  it('parses preview as an actual binary command without spec or mutations', () => {
    const parsed = parseCliArgs(['task','preview','--run','run-1','--compare','prior.json','--json']);
    expect(parsed).toMatchObject({ok:true,value:{command:'task preview',runId:'run-1',comparePath:'prior.json',json:true}});
  });
  it('rejects execution flags on preview', () => {
    expect(parseCliArgs(['task','preview','--auto-approve'])).toMatchObject({ok:false});
  });
});

import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadExecutionPreview} from '../src/execution-preview.js';
import {initializeEnvironmentConfig} from '../src/environment-config.js';

it('loads intake from an absent machine state without creating stores or a DAG',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preview-intake-'));
 const previous=process.env.BFLOW_HOME;
 try{
  execFileSync('git',['init','--quiet',root]);
  await initializeEnvironmentConfig({cwd:root});
  process.env.BFLOW_HOME=join(root,'absent-machine');
  const before=await readdir(root);
  const plan=await loadExecutionPreview(root);
  expect(plan.mode).toBe('intake');expect(plan.accepted).toBeUndefined();
  expect(plan.observations.some(item=>item.status==='not_checked')).toBe(true);
  expect(await readdir(root)).toEqual(before);
 }finally{if(previous===undefined)delete process.env.BFLOW_HOME;else process.env.BFLOW_HOME=previous;await rm(root,{recursive:true,force:true});}
});

it('fingerprints staged source changes as well as the repository revision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'preview-index-'));
 try{
  const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Test','-c','user.email=test@example.test',...args],{cwd:root});
  git(['init','--quiet']);await initializeEnvironmentConfig({cwd:root});
  await writeFile(join(root,'example.ts'),'export const value = 1;\n');git(['add','example.ts']);git(['commit','--quiet','-m','baseline']);
  const before=await loadExecutionPreview(root);
  await writeFile(join(root,'example.ts'),'export const value = 2;\n');git(['add','example.ts']);
  const staged=await loadExecutionPreview(root);
  expect(staged.repository.revision).toBe(before.repository.revision);
  expect(staged.repository.dirtyDigests['example.ts']).toMatch(/^[a-f0-9]{64}$/);
  expect(staged.fingerprint).not.toBe(before.fingerprint);
 }finally{await rm(root,{recursive:true,force:true});}
});
