import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
// W09 browser security acceptance: real Chrome, actual Local Server HTTP/cookie/CSRF/static
// stack; deterministic host client only behind UserInteractionClient (browser integration).
let host:AcceptanceHost,hostile:Server,hostileOrigin:string;
test.use({launchOptions:{args:['--host-resolver-rules=MAP rebind.attacker.test 127.0.0.1'],
  ...(process.env.BFLOW_WEB_TEST_BROWSER?{executablePath:process.env.BFLOW_WEB_TEST_BROWSER}:{})}});
test.beforeAll(async()=>{
  host=await startAcceptanceHost();
  hostile=createServer((req,res)=>{
    const target=JSON.stringify(host.origin);
    // A malicious page on another loopback port: same-site for cookies, foreign origin for Bflow.
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    res.end(`<!doctype html><title>hostile</title><iframe id="frame" src=${target}></iframe>
<form id="csrf" method="POST" action=${JSON.stringify(host.origin+'/api/v1/projects')} enctype="text/plain" target="sink"><input name='{"apiVersion":1,"path":"/tmp","x":"' value='"}'></form><iframe name="sink"></iframe>
<script>(async()=>{const out={};const T=${target};
try{const r=await fetch(T+'/api/v1/projects',{credentials:'include'});out.read=r.status+':'+(await r.text()).slice(0,40);}catch(e){out.read='blocked';}
try{const r=await fetch(T+'/api/v1/projects',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({apiVersion:1,path:'/tmp'})});out.preflighted=r.status;}catch(e){out.preflighted='blocked';}
try{await fetch(T+'/api/v1/projects',{method:'POST',mode:'no-cors',credentials:'include',headers:{'content-type':'text/plain'},body:JSON.stringify({apiVersion:1,path:'/tmp'})});out.simple='opaque';}catch(e){out.simple='blocked';}
try{const s=new EventSource(T+'/api/v1/projects/x/events',{withCredentials:true});await new Promise(r=>{s.onerror=r;s.onmessage=()=>{out.sse='READ';r();};setTimeout(r,2000);});s.close();out.sse??='denied';}catch(e){out.sse='blocked';}
document.getElementById('csrf').submit();setTimeout(()=>{window.__done=out;},1500);})();</script>`);
  });
  await new Promise<void>(r=>hostile.listen(0,'127.0.0.1',()=>r()));
  const address=hostile.address();hostileOrigin=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
});
test.afterAll(async()=>{await host?.close();await new Promise<void>(r=>hostile?hostile.close(()=>r()):r());});

test('AC09 pairing leaves no secret in URL/storage; hostile loopback page and DNS rebinding get no data or authority',async({page,context})=>{
  const dialogs:string[]=[];page.on('dialog',d=>{dialogs.push(d.message());void d.dismiss();});
  const secret=new URLSearchParams(new URL(host.pairing).hash.slice(1)).get('bootstrap')!;
  await page.goto(host.pairing);
  await expect(page.getByRole('heading',{name:'Chưa có dự án'})).toBeVisible();
  const traces=await page.evaluate(()=>JSON.stringify({href:location.href,ls:{...localStorage},ss:{...sessionStorage},cookie:document.cookie,history:history.length}));
  expect(traces).not.toContain(secret);
  expect(JSON.parse(traces).cookie).toBe('');
  const [cookie]=await context.cookies(host.origin);
  expect(cookie).toMatchObject({name:'bflow_session',httpOnly:true,sameSite:'Strict',domain:'127.0.0.1'});
  expect(cookie!.expires).toBeGreaterThan(Date.now()/1000+43000);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();
  await expect(page.getByRole('link',{name:/thư viện.*Xem dự án/})).toBeVisible();
  const before=await host.call('inspect');

  const responses:{url:string;status:number}[]=[];
  const attacker=await context.newPage();
  attacker.on('response',r=>{if(r.url().startsWith(host.origin))responses.push({url:new URL(r.url()).pathname,status:r.status()});});
  await attacker.goto(hostileOrigin);
  const out=await attacker.waitForFunction(()=>(window as any).__done,undefined,{timeout:15000}).then(h=>h.jsonValue()) as Record<string,unknown>;
  // Cross-origin reads are refused by the server (403) and are opaque to the attacker either way.
  expect(String(out.read)).not.toContain('projectId');
  expect(['blocked','denied']).toContain(out.sse);
  for(const r of responses)expect(r.status,r.url).toBeGreaterThanOrEqual(400);
  // The embedded app does not render inside a foreign frame.
  const framed=attacker.frames().find(f=>f.url().startsWith(host.origin));
  if(framed)expect(await framed.locator('#root').count().catch(()=>0)).toBe(0);
  const after=await host.call('inspect');
  expect(after.lifecycleCalls).toEqual(before.lifecycleCalls);expect(after.commands).toHaveLength(before.commands.length);
  const projects=await page.evaluate(async()=>(await (await fetch('/api/v1/projects')).json()).items.length);
  expect(projects).toBe(1);
  await attacker.close();

  // DNS rebinding: a foreign hostname resolving to 127.0.0.1 is refused before any route, including static UI.
  const port=new URL(host.origin).port;
  const rebound=await page.goto(`http://rebind.attacker.test:${port}/`);
  expect(rebound?.status()).toBe(403);
  expect(await page.locator('#root').count()).toBe(0);
  // Same-origin script on the rebound name cannot reach the API either (page.request bypasses the browser resolver).
  expect(await page.evaluate(async()=>(await fetch('/api/v1/projects')).status)).toBe(403);
  expect(dialogs).toEqual([]);
});

test('AC09 malicious HTML/SVG artifacts download inert; Markdown preview renders as text, never markup',async({page,context})=>{
  const dialogs:string[]=[];page.on('dialog',d=>{dialogs.push(d.message());void d.dismiss();});
  await page.goto(await host.call('pair'));
  const link=page.getByRole('link',{name:/thư viện.*Xem dự án/});
  await expect(page.getByRole('heading',{name:/Dự án/}).first()).toBeVisible();
  if(!await link.isVisible().catch(()=>false)){await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();}
  await link.click();
  const base=new URL(page.url()).pathname;
  await page.goto(new URL(base+'/runs/run',page.url()).href);
  const sections=page.locator('section.evidence');
  await expect(sections).toHaveCount(3);
  // HTML artifact: the safe reader refuses inline rendering and explains download-only.
  await sections.nth(0).getByRole('button',{name:'Đọc nội dung an toàn'}).click();
  await expect(sections.nth(0).getByRole('alert')).toContainText('chỉ hỗ trợ tải xuống');
  await sections.nth(1).getByRole('button',{name:'Đọc nội dung an toàn'}).click();
  await expect(sections.nth(1).getByRole('alert')).toContainText('chỉ hỗ trợ tải xuống');
  // Markdown with script/javascript: link is shown verbatim as text.
  await sections.nth(2).getByRole('button',{name:'Đọc nội dung an toàn'}).click();
  const preview=sections.nth(2).getByLabel('Nội dung tài liệu');
  await expect(preview).toContainText('<script>alert("md-xss")</script>');
  expect(await page.locator('section.evidence script, section.evidence a[href^="javascript:"]').count()).toBe(0);
  // Download link: browser treats the bytes as an attachment, never navigates to executable content.
  const [download]=await Promise.all([page.waitForEvent('download'),sections.nth(0).getByRole('link',{name:'Tải tài liệu'}).click()]);
  expect(await download.failure()).toBeNull();
  for(const [id,inline] of [['artifact-html',false],['artifact-svg',false],['artifact-md',true]] as const){
    const r=await page.request.get(new URL(`/api/v1${base.replace(/^\//,'/')}/artifacts/${id}`.replace('/api/v1/projects','/api/v1/projects'),host.origin).href);
    expect(r.status(),id).toBe(200);
    const h=r.headers();
    expect(h['content-type']).toBe(inline?'text/plain; charset=utf-8':'application/octet-stream');
    expect(h['content-disposition']).toMatch(inline?/^inline;/:/^attachment;/);
    expect(h['content-security-policy']).toContain('sandbox');
    expect(h['x-content-type-options']).toBe('nosniff');
  }
  // Direct navigation to an SVG artifact is a download, not a rendered document.
  const nav=page.waitForEvent('download');
  await page.goto(new URL(`/api/v1${base}/artifacts/artifact-svg`,host.origin).href).catch(()=>undefined);
  await nav;
  expect(dialogs).toEqual([]);
  const reads=(await host.call('inspect')).artifactReads as string[];
  expect(reads).toEqual(expect.arrayContaining(['artifact-html','artifact-svg','artifact-md']));
  void context;
});
