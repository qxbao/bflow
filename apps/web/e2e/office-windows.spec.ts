import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserOptions, enterVisual, mirror, openProject, sceneReady, startDirectHost, type DirectHost } from './office-fixture';

test.use({ ...browserOptions(), viewport:{width:1440,height:900} });
test.describe.configure({mode:'serial'});
const evidence=process.env.BFLOW_WINDOW_EVIDENCE??'/tmp/bflow-game-windows';
let host:DirectHost;
test.beforeAll(async()=>{host=await startDirectHost();await mkdir(evidence,{recursive:true});});
test.afterAll(async()=>{await host?.close();});
const shot=(page:Page,name:string)=>page.screenshot({path:resolve(evidence,`${name}.png`),fullPage:false});

test('visual routes stay in the app window; tool windows restore and adapt at all three widths',async({page})=>{
  test.setTimeout(120000);
  const base=await openProject(page,host.pairing,host.repository,/books.*Xem dự án/);
  await enterVisual(page);
  await sceneReady(page);
  const appWindow=page.getByRole('dialog',{name:'Công việc'});
  await mirror(page,/Bảng nhiệm vụ/);
  await expect(page).toHaveURL(/\/runs$/);
  await expect(appWindow).toBeVisible();
  await appWindow.getByRole('button',{name:'Phóng to Công việc'}).click();
  await expect(appWindow).toHaveAttribute('data-display','maximized');
  await appWindow.getByRole('button',{name:'Khôi phục Công việc'}).click();
  await shot(page,'1440-runs-app-window');

  // App close follows the route back to the project index; the route remains the source of truth.
  await appWindow.getByRole('button',{name:'Đóng cửa sổ Công việc'}).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(page.locator('#main')).toHaveClass(/hidden/);

  const mirrorRegion=page.getByRole('region',{name:'Bản văn bản của văn phòng'});
  await mirror(page,/Tủ tài liệu/);
  const documents=page.getByRole('dialog',{name:'Tài liệu'});
  await expect(documents).toBeVisible();
  const desktopRect=await documents.boundingBox();
  await documents.getByRole('button',{name:'Thu nhỏ Tài liệu'}).click();
  await expect(documents).toBeHidden();
  const taskbar=page.getByRole('navigation',{name:'Thanh tác vụ'});
  await taskbar.getByRole('button',{name:'Tài liệu'}).click();
  await expect(documents).toBeVisible();
  await documents.getByRole('button',{name:'Phóng to Tài liệu'}).click();
  await expect(documents).toHaveAttribute('data-display','maximized');
  await documents.getByRole('button',{name:'Khôi phục Tài liệu'}).click();

  for(const [width,height,expected] of [[1440,900,'free'],[900,768,'tile'],[390,844,'sheet']] as const){
    await page.setViewportSize({width,height});
    await expect(documents).toBeVisible();
    const rect=await documents.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x+rect!.width).toBeLessThanOrEqual(width+1);
    expect(rect!.y+rect!.height).toBeLessThanOrEqual(height+1);
    if(expected==='sheet')expect(rect!.width).toBe(width);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await shot(page,`${width}-${expected}-documents-window`);
  }

  await page.keyboard.press('Escape');
  await expect(documents).toBeHidden();
  expect(desktopRect?.x).toBeGreaterThanOrEqual(0);
  await expect(mirrorRegion).toBeAttached();
});
