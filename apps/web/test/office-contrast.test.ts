import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Reads the real `.office-3d` block of global.css, so a token edit that breaks contrast fails here.
const css = readFileSync(resolve(WEB_ROOT, 'src/styles/global.css'), 'utf8');
const block = /\.office-3d\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const tokens = new Map([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1]!, m[2]!]));
const channel = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string): number => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const token = (name: string): string => { const v = tokens.get(name); if (!v) throw new Error(`missing token ${name}`); return v; };

test('the scoped dark tokens are all present', () => {
  for (const name of ['canvas', 'ink', 'muted', 'faint', 'line', 'accent', 'steel', 'focus', 'surface', 'input', 'success', 'danger', 'warning', 'code', 'brand', 'on-brand']) expect(tokens.has(name), name).toBe(true);
});

// Text on the brand fill (primary buttons): the fixed on-brand token, not the theme ink, which turns cream in dark mode.
test('on-brand on brand is at least 4.5:1', () => { expect(contrast(token('on-brand'), token('brand'))).toBeGreaterThanOrEqual(4.5); });

// A class list that puts bg-brand and a bare text-ink together gives cream text on yellow in dark mode.
// Variants are compared within their own group: a hover: variant does not count, but aria-expanded:bg-brand with aria-expanded:text-ink does.
const SRC = resolve(WEB_ROOT, 'src');
const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sourceFiles(resolve(dir, e.name)) : /\.tsx?$/.test(e.name) ? [resolve(dir, e.name)] : []);
const brandTextClash = (text: string): boolean => {
  for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\n\\])*)\1/g)) {
    const groups = new Map<string, Set<string>>();
    for (const token of m[2]!.split(/\s+/)) {
      const cut = token.lastIndexOf(':');
      const variant = cut >= 0 ? token.slice(0, cut) : '';
      const utility = token.slice(cut + 1);
      if (utility !== 'bg-brand' && utility !== 'text-ink') continue;
      groups.set(variant, (groups.get(variant) ?? new Set()).add(utility));
    }
    if ([...groups.values()].some(set => set.has('bg-brand') && set.has('text-ink'))) return true;
  }
  return false;
};
test('no source class list pairs bg-brand with text-ink in the same variant group', () => {
  const offenders = sourceFiles(SRC).filter(file => brandTextClash(readFileSync(file, 'utf8'))).map(file => file.slice(SRC.length + 1));
  expect(offenders).toEqual([]);
});
test('the brand clash scan flags a bare pair and an aria-expanded pair, but not a hover-only text-ink', () => {
  expect(brandTextClash('<b className="bg-brand text-ink">')).toBe(true);
  expect(brandTextClash('<b className="aria-expanded:bg-brand aria-expanded:text-ink">')).toBe(true);
  expect(brandTextClash('<b className="bg-brand hover:text-ink">')).toBe(false);
});

// Text on the panel (surface), the page (canvas) and the pressed/hover fills (faint, code): WCAG AA 4.5:1.
const TEXT = ['ink', 'muted', 'accent', 'steel', 'success', 'danger', 'warning'] as const;
const GROUNDS = ['surface', 'canvas', 'faint', 'code'] as const;
for (const fg of TEXT) for (const bg of GROUNDS) {
  test(`text ${fg} on ${bg} is at least 4.5:1`, () => { expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5); });
}
// Non-text indicators (focus ring, control border) need 3:1 against the panel (WCAG 1.4.11).
for (const fg of ['focus', 'input'] as const) test(`${fg} on surface is at least 3:1`, () => { expect(contrast(token(fg), token('surface'))).toBeGreaterThanOrEqual(3); });
test('the HUD hover state (surface text on ink fill) is at least 4.5:1', () => { expect(contrast(token('surface'), token('ink'))).toBeGreaterThanOrEqual(4.5); });
test('the pending-decision badge (canvas text on danger fill) is at least 4.5:1', () => { expect(contrast(token('canvas'), token('danger'))).toBeGreaterThanOrEqual(4.5); });
test('the contrast helper matches the known black on white ratio', () => { expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5); });
