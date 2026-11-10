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
  const dockClearance = 76;
  const maxWinH = Math.max(240, viewport.height - taskbar - dockClearance);
  if (kind === 'app') return clampRect({ x: 120 + (viewport.width - 120) * .32, y: 16, w: Math.max(420, Math.min(920, viewport.width * .52)), h: Math.min(maxWinH, viewport.height - taskbar - 88) }, viewport, { w: 420, h: 320 });
  if (kind === 'status') return clampRect({ x: viewport.width - 436, y: 72, w: 420, h: Math.min(380, maxWinH - 56) }, viewport);
  if (kind === 'cabinet' || kind === 'server') return clampRect({ x: viewport.width - 560, y: 140, w: 480, h: Math.min(320, maxWinH - 124) }, viewport);
  const w = Math.min(480, viewport.width - 32), h = Math.min(520, Math.max(240, maxWinH - 140));
  return clampRect({ x: viewport.width - w - 16 - (index % 4) * 32, y: Math.min(136 + (index % 4) * 28, Math.max(16, viewport.height - taskbar - dockClearance - h)), w, h }, viewport);
}

export function cascade(rect: WindowRect, index: number, viewport: Viewport): WindowRect {
  return clampRect({ ...rect, x: rect.x - (index % 4) * 32, y: rect.y + (index % 4) * 32 }, viewport);
}

export function sceneInset(windows: SceneWindow[], viewport: Viewport, chrome = { left: 88, bottom: 112 }): { left: number; right: number; bottom: number } {
  if (viewport.width < 768) return { left: 0, right: 0, bottom: chrome.bottom };
  const visible = windows.filter(window => window.display !== 'minimized');
  if (visible.some(window => window.display === 'maximized')) return { left: chrome.left, right: 0, bottom: chrome.bottom };
  const rightSide = visible.filter(window => window.rect.x + window.rect.w / 2 > viewport.width / 2);
  const leftSide = visible.filter(window => window.rect.x + window.rect.w / 2 <= viewport.width / 2);
  const right = rightSide.length ? Math.min(viewport.width * .6, viewport.width - Math.min(...rightSide.map(window => window.rect.x))) : 0;
  const left = leftSide.length ? Math.min(viewport.width * .6, Math.max(chrome.left, Math.max(...leftSide.map(window => window.rect.x + window.rect.w)))) : chrome.left;
  return { left: Math.max(0, left), right: Math.max(0, right), bottom: chrome.bottom };
}
