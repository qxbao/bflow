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
  const taskbar=page.getByRole('navigation',{name:'Thanh tác vụ'});
  await mirror(page,/Bảng nhiệm vụ/);
  await expect(page).toHaveURL(/\/runs$/);
  await expect(appWindow).toBeVisible();
  await appWindow.getByRole('button',{name:'Phóng to Công việc'}).click();
  await expect(appWindow).toHaveAttribute('data-display','maximized');
  await appWindow.getByRole('button',{name:'Khôi phục Công việc'}).click();
  await expect(appWindow).toHaveAttribute('data-display','normal');
  await page.waitForTimeout(150);
  await shot(page,'1440-runs-app-window');

  const mirrorRegion=page.getByRole('region',{name:'Bản văn bản của văn phòng'});
  await mirror(page,/Tủ tài liệu/);
  const documents=page.getByRole('dialog',{name:'Tài liệu'});
  await expect(documents).toBeVisible();
  await page.waitForTimeout(160);
  await expect(appWindow).toBeVisible();
  const desktopRect=await documents.boundingBox();
  const appRect=await appWindow.boundingBox();
  expect(desktopRect&&appRect).toBeTruthy();
  const overlap={left:Math.max(desktopRect!.x,appRect!.x),top:Math.max(desktopRect!.y,appRect!.y),right:Math.min(desktopRect!.x+desktopRect!.width,appRect!.x+appRect!.width),bottom:Math.min(desktopRect!.y+desktopRect!.height,appRect!.y+appRect!.height)};
  expect(overlap.right-overlap.left).toBeGreaterThan(0);
  expect(overlap.bottom-overlap.top).toBeGreaterThan(0);
  const topHit=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-window-id]')?.dataset.windowId,{x:(overlap.left+overlap.right)/2,y:(overlap.top+overlap.bottom)/2});
  expect(topHit).toBe('cabinet');
  await expect(documents.getByRole('heading',{name:'Tủ tài liệu'})).toBeVisible();
  await shot(page,'1440-documents-over-app');
  await documents.getByRole('heading',{name:'Tủ tài liệu'}).click();
  const title=documents.locator('.bwin-titlebar'),titleBox=await title.boundingBox();
  expect(titleBox).not.toBeNull();
  await page.mouse.move(titleBox!.x+titleBox!.width/2,titleBox!.y+titleBox!.height/2);
  await page.mouse.down();
  await page.mouse.move(titleBox!.x+titleBox!.width/2+56,titleBox!.y+titleBox!.height/2+32,{steps:4});
  await page.mouse.up();
  const moved=await documents.boundingBox();
  expect(moved!.x).toBeGreaterThan(desktopRect!.x+32);

  // Closing the app follows the route back to the project index; the tool window remains open.
  await appWindow.getByRole('button',{name:'Đóng cửa sổ Công việc'}).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(page.locator('#main')).toBeHidden();
  await expect(documents).toBeVisible();
  await page.reload();
  await sceneReady(page);
  await mirror(page,/Tủ tài liệu/);
  await expect(documents).toBeVisible();
  await page.waitForTimeout(160);
  const projectId=decodeURIComponent(base.split('/').at(-1)!);
  const savedRect=await page.evaluate(id=>{const raw=localStorage.getItem(`bflow:ui:windows:${encodeURIComponent(id)}`);return raw?(JSON.parse(raw) as {cabinet?:{rect?:{x?:number}}}).cabinet?.rect?.x:undefined;},projectId);
  const cssLeft=await documents.evaluate(element=>Number.parseFloat((element as HTMLElement).style.left));
  expect(savedRect).toBeDefined();
  expect(cssLeft).toBe(savedRect);
  expect(Math.abs(cssLeft-moved!.x)).toBeLessThan(1);

  // At tile size the active route window owns the right 62%; the 3D scene still occupies the open left zone.
  await page.setViewportSize({width:900,height:768});
  await taskbar.getByRole('button',{name:'◆ Bflow'}).click();
  await taskbar.getByRole('group',{name:'Menu Bflow'}).getByRole('button',{name:'Công việc'}).click();
  await expect(appWindow).toBeVisible();
  await expect(documents).toBeHidden();
  const tileApp=await appWindow.boundingBox();
  expect(tileApp!.x).toBeGreaterThanOrEqual(300);
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCSS('visibility','visible');
  await page.getByRole('group',{name:'Góc nhìn camera'}).getByRole('button',{name:'Lập trình'}).click();
  await page.waitForTimeout(500);
  await shot(page,'900-tile-app-scene-after-camera-focus');
  // A physical pointer click on the tile region's canvas is routed to the renderer while the app window remains open.
  const canvas=page.getByLabel('Cảnh văn phòng').locator('canvas');
  await canvas.evaluate((node:HTMLCanvasElement)=>{node.dataset.tilePointerProbe='armed';});
  const tilePoint={x:300,y:425};
  const targetTag=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName,{...tilePoint});
  expect(targetTag).toBe('CANVAS');
  await page.mouse.click(tilePoint.x,tilePoint.y);
  await expect(appWindow).toBeVisible();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCSS('visibility','visible');
  // The AccessibleOffice object button remains operable alongside the tiled route window.
  await mirror(page,/Bảng nhiệm vụ/);
  await expect(page).toHaveURL(/\/runs$/);
  await expect(appWindow).toBeVisible();
  await expect(page.getByLabel('Cảnh văn phòng')).toHaveCSS('visibility','visible');
  await shot(page,'900-tile-app-and-scene');
  await mirror(page,/Máy chủ/);
  const server=page.getByRole('dialog',{name:'Máy chủ'});
  await expect(server).toBeVisible();
  await taskbar.getByRole('button',{name:/Mở trạng thái:/}).click();
  const status=page.getByRole('dialog',{name:'Trạng thái văn phòng'});
  await expect(status).toBeVisible();
  await expect(taskbar.getByRole('group',{name:'Cửa sổ đang mở'}).getByRole('button')).toHaveCount(4);
  await taskbar.getByRole('button',{name:'◆ Bflow'}).click();
  await taskbar.getByRole('group',{name:'Menu Bflow'}).getByRole('button',{name:'Đóng mọi cửa sổ'}).click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await expect(page.locator('#main')).toBeHidden();
  await expect(documents).toBeHidden();
  await expect(server).toBeHidden();
  await expect(status).toBeHidden();
  await mirror(page,/Tủ tài liệu/);
  await expect(documents).toBeVisible();
  await page.setViewportSize({width:1440,height:900});

  await documents.getByRole('button',{name:'Thu nhỏ Tài liệu'}).click();
  await expect(documents).toBeHidden();
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
  await page.route('**/api/v1/projects/*/workforce',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({apiVersion:1,code:'session_required',message:'pair again',retryable:false,correlationId:'window-repair'})}));
  await page.reload();
  const repair=page.getByRole('dialog',{name:'Cần ghép nối lại'});
  await expect(repair).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(repair).toBeVisible();
  await expect(repair.getByRole('button',{name:'Đóng cửa sổ Cần ghép nối lại'})).toHaveCount(0);
  await shot(page,'390-repair-window-is-modal');
});
