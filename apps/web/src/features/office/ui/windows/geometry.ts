import type { WindowKind, WindowRect } from './GameWindow';

export interface Viewport { width: number; height: number }
export interface SceneWindow { rect: WindowRect; display: 'normal' | 'minimized' | 'maximized' }

export function clampRect(rect: WindowRect, viewport: Viewport, min = { w: 320, h: 240 }): WindowRect {
  const w = Math.max(min.w, Math.min(rect.w, viewport.width));
  const h = Math.max(min.h, Math.min(rect.h, viewport.height));
  return { x: Math.max(0, Math.min(rect.x, viewport.width - w)), y: Math.max(0, Math.min(rect.y, viewport.height - h)), w, h };
}

export function defaultRect(kind: WindowKind, viewport: Viewport, index = 0): WindowRect {
  const taskbar = 56;
  if (kind === 'app') return clampRect({ x: 120 + (viewport.width - 120) * .32, y: 16, w: Math.max(420, Math.min(920, viewport.width * .52)), h: viewport.height - taskbar - 32 }, viewport, { w: 420, h: 320 });
  if (kind === 'status') return clampRect({ x: viewport.width - 436, y: 72, w: 420, h: 380 }, viewport);
  if (kind === 'cabinet' || kind === 'server') return clampRect({ x: viewport.width - 560, y: 168, w: 480, h: 320 }, viewport);
  const w = Math.min(480, viewport.width - 32), h = Math.min(560, viewport.height - 200);
  return clampRect({ x: viewport.width - w - 16 - (index % 4) * 32, y: 168 + (index % 4) * 32, w, h }, viewport);
}

export function cascade(rect: WindowRect, index: number, viewport: Viewport): WindowRect {
  return clampRect({ ...rect, x: rect.x - (index % 4) * 32, y: rect.y + (index % 4) * 32 }, viewport);
}

export function sceneInset(windows: SceneWindow[], viewport: Viewport, chrome = { left: 88, bottom: 112 }): { left: number; right: number; bottom: number } {
  const visible = windows.filter(window => window.display !== 'minimized');
  const rightSide = visible.filter(window => window.rect.x + window.rect.w / 2 > viewport.width / 2);
  const right = rightSide.length ? Math.min(viewport.width * .6, viewport.width - Math.min(...rightSide.map(window => window.rect.x))) : 0;
  return { left: viewport.width < 768 ? 0 : chrome.left, right: viewport.width < 768 ? 0 : Math.max(0, right), bottom: chrome.bottom };
}
