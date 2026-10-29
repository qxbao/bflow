import { expect, test } from '@playwright/test';
import { startAcceptanceHost, type AcceptanceHost } from './acceptance-fixture';
let host:AcceptanceHost;
test.beforeEach(async()=>{host=await startAcceptanceHost();});
test.afterEach(async()=>{await host?.close();});

test('compact layouts, mobile navigation, skeletons and cursor history work with production assets',async({page})=>{
  test.setTimeout(60000);
  await page.goto(host.pairing);
  await page.getByLabel('Đường dẫn Git tuyệt đối').fill(host.repository);
  await page.getByRole('button',{name:'Đăng ký dự án'}).click();
  await page.getByRole('link',{name:/thư viện.*Xem dự án/}).click();
  const base=new URL(page.url()).pathname;
  let release!:(value:void)=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  // Only the displayed collection is expanded in the test; real same-origin HTTP/session remains in use.
  await page.route('**/api/v1/projects/*/runs?*',async route=>{
    const response=await route.fetch(),data=await response.json();
    await wait;
    const second=new URL(route.request().url()).searchParams.has('cursor');
    const item=data.items[0];
    await route.fulfill({response,json:{...data,items:Array.from({length:second?3:25},(_,i)=>({...item,runId:(second?'second-':'first-')+i,title:i===0?'Công việc có tiêu đề dài để kiểm tra bố cục và khả năng đọc trên màn hình nhỏ':'Công việc '+i})),...(second?{}:{nextCursor:'next-page'})}});
  });
  await page.getByRole('link',{name:'Công việc',exact:true}).click();
  await expect(page.getByText('Đang tải công việc…')).toBeAttached();
  release();
  await expect(page.getByRole('heading',{name:'Công việc',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Công việc 24'})).toBeVisible();
  await page.getByRole('button',{name:'Trang tiếp theo'}).click();
  await expect(page.getByRole('navigation',{name:'Phân trang công việc'})).toContainText('Trang 2');
  await page.getByRole('button',{name:'Trang trước'}).click();
  await expect(page.getByRole('link',{name:'Công việc 24'})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('navigation',{name:'Phân trang công việc'})).toContainText('Trang 2');
  for(const [width,height] of [[1440,900],[1280,900],[768,900],[375,812],[812,375]]){
    await page.setViewportSize({width:width!,height:height!});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await page.locator('body').evaluate(node=>getComputedStyle(node).fontSize)).toBe('16px');
    if(width!<1024){
      const toggle=page.locator('button[aria-controls="workspace-navigation"]');await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded','true');
      await page.getByRole('link',{name:'Tổng quan',exact:true}).click();
      await expect(page.getByRole('button',{name:'Điều hướng',exact:true})).toHaveAttribute('aria-expanded','false');
      await expect(page.locator('#main')).toBeFocused();
      await page.goto(new URL(base+'/runs?cursor=next-page',host.origin).href);
      await expect(page.getByRole('navigation',{name:'Phân trang công việc'})).toContainText('Trang hiện tại');
      await expect(page.getByRole('button',{name:'Trang trước'})).toBeDisabled();
    }
    if(width!<1024){expect(await page.getByLabel('Tìm công việc').evaluate(node=>({size:getComputedStyle(node).fontSize,height:node.getBoundingClientRect().height}))).toEqual({size:'16px',height:44});}
    await page.screenshot({path:`dist/test-results/ux-runs-${width}x${height}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(()=>{document.documentElement.style.zoom='';});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('link',{name:'Cài đặt dự án',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Các phần cài đặt'})).toBeVisible();
  await page.getByRole('link',{name:'Khởi tạo',exact:true}).click();
  await expect(page.locator('#settings-initialize')).toBeInViewport();
  await page.screenshot({path:'dist/test-results/ux-settings-desktop.png',fullPage:true});
  await page.goto(new URL(base+'/runs/run',host.origin).href);
  await expect(page.getByRole('button',{name:'Xem xét gói'})).toBeVisible();
  await page.screenshot({path:'dist/test-results/ux-run-desktop.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'dist/test-results/ux-run-mobile.png',fullPage:true});
  expect((await host.call('inspect')).commands).toHaveLength(0);
});
