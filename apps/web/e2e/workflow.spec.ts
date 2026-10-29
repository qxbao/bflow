import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// W09 LIVE no-chat workflow (opt-in). Real `bflow web`, real agentic host, real Herdr and
// providers on a disposable repository prepared by the operator (`bflow init` done, providers
// authenticated). Without the variables below this test is reported as skipped/not_run;
// fixture tests never substitute for it.
//   BFLOW_W09_LIVE=1 BFLOW_W09_REPO=<abs disposable repo> BFLOW_W09_EVIDENCE=<abs dir outside repo>
//   [BFLOW_W09_HOME=<BFLOW_HOME>] [BFLOW_W09_PORT=4327] [BFLOW_W09_TIMEOUT_MIN=90]
const live=process.env.BFLOW_W09_LIVE==='1',repo=process.env.BFLOW_W09_REPO??'',evidenceDir=process.env.BFLOW_W09_EVIDENCE??'';
const port=Number(process.env.BFLOW_W09_PORT??4327),budget=Number(process.env.BFLOW_W09_TIMEOUT_MIN??90)*60000;
const terminal=['completed','failed','escalated','cancelled'];
let child:ChildProcess|undefined,pairing='';
const log:unknown[]=[];const note=(kind:string,value:unknown)=>{log.push({at:new Date().toISOString(),kind,value});};
test.skip(!live || !repo.startsWith('/') || !evidenceDir.startsWith('/'),'not_run: live Herdr/provider workflow requires BFLOW_W09_LIVE=1, BFLOW_W09_REPO and BFLOW_W09_EVIDENCE');
test.beforeAll(async()=>{
  await mkdir(evidenceDir,{recursive:true});
  const quote=(t:string)=>"'"+t.replaceAll("'","'\\''")+"'";
  child=spawn('script',['-q','-c',`${quote(process.execPath)} ${quote(resolve('../cli/dist/bin.js'))} web --port ${port} --no-open`,'/dev/null'],
    {env:{...process.env,...(process.env.BFLOW_W09_HOME?{BFLOW_HOME:process.env.BFLOW_W09_HOME}:{})},stdio:['pipe','pipe','pipe'],detached:true});
  pairing=await new Promise<string>((accept,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('bflow web did not start: '+out.slice(-300))),20000);
    child!.stdout!.on('data',d=>{out+=String(d);const m=out.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/#bootstrap=[A-Za-z0-9_%+.-]+`));if(m){clearTimeout(timer);accept(m[0]);}});});
});
test.afterAll(async()=>{
  if(evidenceDir)await writeFile(join(evidenceDir,'browser-workflow.json'),JSON.stringify(log,null,1));
  // Ctrl-C closes the web owner only; the project session must keep running (checked by the operator with `bflow status`).
  if(child?.pid){const node=execFileSync('ps',['-o','pid=,args=','-g',String(child.pid)],{encoding:'utf8'}).split('\n').find(l=>l.includes('bin.js web'));
    if(node)process.kill(Number(node.trim().split(/\s+/)[0]),'SIGINT');await new Promise<void>(r=>{child!.once('exit',()=>r());setTimeout(r,10000);});}
});
const api=(page:Page,path:string)=>page.evaluate(async p=>{const r=await fetch(p,{cache:'no-store'});return {status:r.status,body:await r.json().catch(()=>null)};},path);

test('LIVE AC03–AC06/AC11: browser-only create → clarify → review → approve → completed with backend evidence',async({page})=>{
  test.setTimeout(budget+120000);
  await page.goto(pairing);
  const name=repo.split('/').pop()!;
  const link=page.getByRole('link',{name:new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}.*Xem dự án`)});
  if(!await link.isVisible().catch(()=>false)){await page.getByLabel('Đường dẫn Git tuyệt đối').fill(repo);await page.getByRole('button',{name:'Đăng ký dự án'}).click();}
  await link.click();
  const base=new URL(page.url()).pathname,projectId=decodeURIComponent(base.split('/').pop()!),apiBase=`/api/v1/projects/${encodeURIComponent(projectId)}`;
  note('project',{projectId});
  // Start the session through the web lifecycle (EnvironmentLifecycle up); never via traditional run/approve.
  let session=await api(page,`${apiBase}/session`);note('session.initial',session.body);
  if(session.body?.state!=='ready'){
    await page.getByRole('button',{name:'Khởi động phiên',exact:true}).click();
    await expect.poll(async()=>(session=await api(page,`${apiBase}/session`)).body?.state,{timeout:15*60000,intervals:[5000]}).toBe('ready');
  }
  note('session.ready',session.body);
  await page.getByLabel('Tên công việc').fill('Thêm hàm tính tổng');
  await page.getByLabel('Mục tiêu',{exact:true}).fill('Thêm hàm sum(a, b) trả về tổng hai số vào src/sum.js (CommonJS) kèm kiểm thử node:test trong test/sum.test.js.');
  await page.getByLabel('Tiêu chí chấp nhận (mỗi dòng một tiêu chí)').fill('sum(2, 3) trả về 5 và được kiểm chứng bằng node --test');
  await page.getByLabel('Ràng buộc (mỗi dòng một ràng buộc)').fill('Không thêm dependency\nChỉ sửa src/sum.js và test/sum.test.js');
  await page.getByRole('button',{name:'Tạo công việc',exact:true}).click();
  const deadline=Date.now()+budget;let runId:string|undefined,last='';const answered=new Set<string>();
  while(Date.now()<deadline){
    const s=await api(page,`${apiBase}/session`);
    for(const intake of s.body?.pendingIntakes??[])for(const q of intake.clarifications??[]){
      const key=`${intake.intakeId}:${q.questionId}:${q.expectedVersion.revisionToken}`;if(answered.has(key))continue;
      await page.goto(new URL(base,page.url()).href);await answerClarification(page,q);answered.add(key);note('clarification.intake',{intakeId:intake.intakeId,question:q.question});
    }
    const runs=await api(page,`${apiBase}/runs`);
    const current=(runs.body?.items??[]).find((r:any)=>!runId||r.originRunId===runId||r.runId===runId);
    if(current){runId??=current.originRunId;
      const view=(await api(page,`${apiBase}/runs/${encodeURIComponent(current.currentRunId)}`)).body;
      const summary=`${view?.runId}:${view?.sdlcStatus}:${view?.coreStatus}:${view?.decisions?.length}:${view?.clarifications?.length}:${view?.blockers?.map((b:any)=>b.code).join(',')}`;
      if(summary!==last){note('run',view);last=summary;}
      if(view && terminal.includes(view.sdlcStatus)){note('final',view);
        expect(view.sdlcStatus,'business outcome from Runtime/gates, not HTTP').toBe('completed');expect(view.coreStatus).toBe('completed');return;}
      for(const q of view?.clarifications??[]){const key=`${view.runId}:${q.questionId}:${q.expectedVersion.revisionToken}`;if(answered.has(key))continue;
        await page.goto(new URL(`${base}/runs/${encodeURIComponent(view.runId)}`,page.url()).href);await answerClarification(page,q);answered.add(key);note('clarification.run',{runId:view.runId,question:q.question});}
      const pending=(view?.decisions??[]).find((d:any)=>d.status==='pending');
      if(pending){const key=`${pending.decisionId}:${pending.expectedVersion.revision}:${pending.expectedVersion.generation}`;
        if(!answered.has(key)){await page.goto(new URL(`${base}/runs/${encodeURIComponent(view.runId)}`,page.url()).href);
          await page.getByRole('button',{name:'Xem xét gói'}).first().click({timeout:60000});
          await page.getByRole('button',{name:'Duyệt gói'}).first().click();
          await expect(page.getByText(/Đã áp dụng thao tác|Đã tiếp nhận|Đang áp dụng/).first()).toBeVisible({timeout:60000});
          answered.add(key);note('decision.approved',{decisionId:pending.decisionId,version:pending.expectedVersion,evidence:pending.evidence?.length});}}
      const resume=(view?.availableActions??[]).find((a:any)=>a.kind==='resume'&&a.enabled);
      if(resume)note('resume.available',{blockers:view.blockers});
    }
    await page.waitForTimeout(10000);
  }
  throw new Error('live workflow did not reach a terminal status within budget; last='+last);
});
async function answerClarification(page:Page,q:{question:string;options:string[]}){
  const panel=page.locator('article.panel',{hasText:q.question}).first();
  await panel.getByLabel('Câu trả lời').fill(q.options[0]??'Giữ phạm vi tối thiểu: chỉ thực hiện đúng tiêu chí chấp nhận và ràng buộc đã nêu.');
  await panel.getByRole('button',{name:'Gửi câu trả lời'}).click();
  await expect(page.getByText(/Đã áp dụng thao tác|Đã tiếp nhận/).first()).toBeVisible({timeout:60000});
}
