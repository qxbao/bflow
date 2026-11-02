import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// Reads the real `.office-3d` block of global.css, so a token edit that breaks contrast fails here.
const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8');
const block = /\.office-3d\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
const tokens = new Map([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map(m => [m[1]!, m[2]!]));
const channel = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string): number => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const token = (name: string): string => { const v = tokens.get(name); if (!v) throw new Error(`missing token ${name}`); return v; };

test('the scoped dark tokens are all present', () => {
  for (const name of ['canvas', 'ink', 'muted', 'faint', 'line', 'accent', 'steel', 'focus', 'surface', 'input', 'success', 'danger', 'warning', 'code']) expect(tokens.has(name), name).toBe(true);
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
