import { expect, test, type Page } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
// W09 browser recovery acceptance: actual Local Server + real Chrome; deterministic host
// client. Assertions read host-side effect/command logs, not only DOM text.
let host:AcceptanceHost;
test.beforeEach(async()=>{host=await startAcceptanceHost();});
test.afterEach(async()=>{await host?.close();});
async function openRun(page:Page,pairing=host.pairing){
  await page.goto(pairing);
  const link=page.getByRole('link',{name:/thư viện.*Xem dự án/});
  if(!await link.isVisible().catch(()=>false)){
    await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);await page.getByRole('button',{name:'Đăng ký dự án'}).click();
  }
  await link.click();
  const base=new URL(page.url()).pathname;await page.goto(new URL(base+'/runs/run',page.url()).href);
  await expect(page.getByRole('button',{name:'Xem xét gói'})).toBeVisible();
  return base;
}
const distinct=(commands:any[],kind:string)=>new Set(commands.filter(c=>c.kind===kind).map(c=>c.commandId)).size;

test('AC08 response lost after commit, Local Server restart mid-operation and browser close keep one effect per intent',async({browser})=>{
  test.setTimeout(90000);
  const context=await browser.newContext(),page=await context.newPage();
  const base=await openRun(page);
  // Drop the HTTP response after the host committed the decision.
  let dropped=0;
  await page.route('**/api/v1/projects/*/commands',async route=>{const response=await route.fetch();dropped++;expect(response.status()).toBe(202);await route.abort('connectionreset');},{times:1});
  await page.getByRole('button',{name:'Xem xét gói'}).click();await page.getByRole('button',{name:'Duyệt gói'}).click();
  await expect.poll(()=>dropped).toBe(1);
  await expect.poll(async()=>(await host.call('inspect')).effects.filter((k:string)=>k==='answer_decision').length).toBe(1);
  await expect(page.getByText(/Mất phản hồi|Chưa xác định kết quả|Đã áp dụng thao tác/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText('Đã áp dụng thao tác. Trạng thái công việc được đọc riêng.').first()).toBeVisible({timeout:15000});
  let state=await host.call('inspect');
  expect(state.effects.filter((k:string)=>k==='answer_decision')).toHaveLength(1);
  expect(distinct(state.commands,'answer_decision')).toBe(1);
  expect(state.decisionOutcome).toBe('approved');

  // Restart the actual Local Server while a cancel is in flight inside the host.
  await host.call('configure',{hold:3000});
  await page.getByRole('button',{name:'Hủy công việc',exact:true}).click();await page.getByLabel('Lý do hủy').fill('Đổi ưu tiên');
  await page.getByRole('button',{name:'Gửi yêu cầu hủy'}).click();
  await expect.poll(async()=>(await host.call('inspect')).effects.filter((k:string)=>k==='cancel').length).toBe(1);
  const repair=await host.call('restart');
  await page.goto(repair);await expect(page.getByRole('link',{name:/thư viện.*Xem dự án/})).toBeVisible();await page.goto(new URL(base+'/runs/run',repair).href);
  await expect(page.getByText('Yêu cầu hủy đã áp dụng; chỉ trạng thái công việc mới xác nhận đã hủy.')).toBeVisible({timeout:15000});
  state=await host.call('inspect');
  expect(state.effects).toEqual(['answer_decision','cancel']);
  expect(distinct(state.commands,'cancel')).toBe(1);

  // Closing the browser is not a lifecycle or workflow action.
  await context.close();
  await new Promise(r=>setTimeout(r,1000));
  const closed=await host.call('inspect');
  expect(closed.lifecycleCalls).toEqual([]);expect(closed.effects).toEqual(state.effects);expect(closed.commands.length).toBe(state.commands.length);
});

test('AC08/AC05 two tabs with conflicting decisions commit exactly one; the opposite outcome is never sent',async({browser})=>{
  const context=await browser.newContext(),a=await context.newPage();
  await openRun(a);
  const b=await context.newPage();await b.goto(a.url());
  for(const tab of [a,b])await tab.getByRole('button',{name:'Xem xét gói'}).click();
  await b.getByLabel(/Lý do \(bắt buộc/).fill('Thiếu tiêu chí hiệu năng');
  await Promise.all([a.getByRole('button',{name:'Duyệt gói'}).evaluate((el:HTMLButtonElement)=>el.click()),b.getByRole('button',{name:'Từ chối'}).evaluate((el:HTMLButtonElement)=>el.click())]);
  await expect.poll(async()=>(await host.call('inspect')).effects.length).toBe(1);
  await new Promise(r=>setTimeout(r,1500));
  const state=await host.call('inspect');
  expect(state.effects).toEqual(['answer_decision']);
  // Authority invariant: exactly one decision effect and no POST of the opposite outcome.
  expect(state.commands.map((c:any)=>c.outcome)).toHaveLength(1);
  const winner=state.decisionOutcome==='approved'?a:b,loser=winner===a?b:a;
  const loserText=(await loser.locator('main').innerText()).replace(/\s+/g,' ');
  expect(loserText).not.toMatch(/Từ chối.*Đã áp dụng|đã từ chối/i);
  await expect(winner.getByText(/Đã áp dụng thao tác|Mất phản hồi/).first()).toBeVisible();
  // Finding W09-F03 (Web owner): same-context tabs share the decision operation record, so the
  // tab whose "Từ chối" was never sent shows the other tab's "Quyết định gói — Đã áp dụng" without
  // the applied outcome or a "your decision was not applied" explanation. Recorded, not asserted away.
  if(/Quyết định gói Đã áp dụng thao tác/.test(loserText) && !/không được áp dụng|Đọc lại gói hiện hành/.test(loserText))
    test.info().annotations.push({type:'finding W09-F03',description:'Losing tab shows shared applied decision without outcome; its own reject is silently absorbed'});
  await context.close();
});

test('AC08 SSE eviction after a dropped stream yields reset and a snapshot reload; no mutation is replayed',async({page})=>{
  test.setTimeout(60000);
  await openRun(page);
  await expect(page.getByText('Phiên bản 1').first()).toBeVisible();
  await expect.poll(async()=>(await host.call('inspect')).eventStreams).toBeGreaterThanOrEqual(1);
  const before=await host.call('inspect');
  // Host advances past the client's cursor (ring buffer eviction) and drops the stream.
  await host.call('configure',{bump:true,evict:1500,drop:true});
  await expect.poll(async()=>(await host.call('inspect')).eventStreams,{timeout:20000}).toBeGreaterThan(before.eventStreams);
  await expect(page.getByText('Phiên bản 2').first()).toBeVisible({timeout:20000});
  const after=await host.call('inspect');
  expect(after.readRuns).toBeGreaterThan(before.readRuns);
  expect(after.commands).toHaveLength(0);expect(after.effects).toHaveLength(0);
});
