import { expect, test } from 'vitest';
import { LabelPlacer } from '../src/features/office/scene/labelPlacement';

const TAG_W = 80, TAG_H = 18, BOX_W = 224, BOX_H = 72;

test('a message box placed after every tag never hides a later agent name tag', () => {
  const placer = new LabelPlacer();
  placer.begin();
  // Agent A's box would sit exactly where agent B's tag is (B stands right above A on screen).
  const a = placer.tag(100, 300, TAG_W, TAG_H, true);
  const b = placer.tag(100, 260, TAG_W, TAG_H, true);
  expect(a && b).toBe(true);
  // Box for A is at tagY - 22 = 278: covers y 206..278, overlapping B's tag (242..260) -> hidden far out.
  expect(placer.bubble(100, 278, BOX_W, BOX_H, true)).toBe(false);
});

test('tags only compete with tags, so an earlier box cannot hide a tag', () => {
  const placer = new LabelPlacer();
  placer.begin();
  expect(placer.tag(100, 300, TAG_W, TAG_H, true)).toBe(true);
  // First pass finishes before any box exists; a tag in the area a box will cover is still shown.
  expect(placer.tag(100, 250, TAG_W, TAG_H, true)).toBe(true);
  expect(placer.bubble(100, 278, BOX_W, BOX_H, true)).toBe(false);
  expect(placer.bubble(600, 278, BOX_W, BOX_H, true)).toBe(true);
});

test('two boxes never overlap even close in, close in tags show, begin() clears the frame', () => {
  const placer = new LabelPlacer();
  placer.begin();
  expect(placer.bubble(100, 200, BOX_W, BOX_H, true)).toBe(true);
  expect(placer.bubble(120, 200, BOX_W, BOX_H, true)).toBe(false);
  expect(placer.bubble(120, 200, BOX_W, BOX_H, false)).toBe(false);
  expect(placer.tag(100, 200, TAG_W, TAG_H, false)).toBe(true);
  placer.begin();
  expect(placer.bubble(100, 200, BOX_W, BOX_H, true)).toBe(true);
});
