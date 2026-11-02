import { describe, expect, test } from 'vitest';
import { FpsGovernor, initialTier, isSoftwareRenderer, settingsFor } from '../src/features/office/scene/quality';

describe('quality tiers', () => {
  test('software rasterisers start on the low tier, real GPUs and unknown names on the high tier', () => {
    for (const name of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 17.0.6, 256 bits)', 'Microsoft Basic Render Driver']) {
      expect(isSoftwareRenderer(name), name).toBe(true);
      expect(initialTier(name)).toBe('low');
    }
    expect(initialTier('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)')).toBe('high');
    expect(initialTier(undefined)).toBe('high');
  });
  test('the low tier has no shadows or accent lights and a pixel ratio of 1; the high tier caps the ratio at 2', () => {
    expect(settingsFor('low', 3)).toEqual({ tier: 'low', shadows: false, pixelRatio: 1, accentLights: false });
    expect(settingsFor('high', 3)).toEqual({ tier: 'high', shadows: true, pixelRatio: 2, accentLights: true });
    expect(settingsFor('high', 1.5).pixelRatio).toBe(1.5);
    expect(settingsFor('high', Number.NaN).pixelRatio).toBe(1);
  });
});

describe('FpsGovernor', () => {
  const run = (gap: number, frames: number, active = true): boolean[] => { const g = new FpsGovernor(); return Array.from({ length: frames }, (_, i) => g.frame(1000 + i * gap, active)); };
  test('slow back-to-back frames demote exactly once per window', () => {
    expect(run(80, 40).filter(Boolean)).toHaveLength(1);
  });
  test('smooth frames never demote', () => {
    expect(run(33, 200).some(Boolean)).toBe(false);
  });
  test('gaps from a sleeping loop and idle frames are not a slow machine', () => {
    expect(run(400, 60).some(Boolean)).toBe(false);
    expect(run(80, 60, false).some(Boolean)).toBe(false);
  });
});
