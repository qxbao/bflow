// Two quality tiers (§ Điều chỉnh 2026-11-02). Pure: the renderer feeds it names and frame times and applies the settings.
export type Tier = 'high' | 'low';
export interface QualitySettings { tier: Tier; shadows: boolean; pixelRatio: number; accentLights: boolean }

/** WebGL renderer strings of software rasterisers; they cannot hold 30 fps with shadows. */
export const isSoftwareRenderer = (name: string): boolean => /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(name);

export function settingsFor(tier: Tier, devicePixelRatio: number): QualitySettings {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return tier === 'high' ? { tier, shadows: true, pixelRatio: Math.min(dpr, 2), accentLights: true } : { tier, shadows: false, pixelRatio: 1, accentLights: false };
}

/** The tier to start with, from the GPU's own name. Unknown names start high; the governor demotes on a slow machine. */
export const initialTier = (rendererName: string | undefined): Tier => (rendererName && isSoftwareRenderer(rendererName) ? 'low' : 'high');

/**
 * Demotes high -> low when consecutive rendered frames are slow. Only frames rendered back to back count (a gap means the loop
 * slept, not that the machine is slow). Never promotes: flapping would recompile shaders.
 */
export class FpsGovernor {
  private samples: number[] = [];
  private last: number | undefined;
  constructor(private readonly window = 24, private readonly slowMs = 55, private readonly gapMs = 150) {}
  /** `now` in ms. Returns true exactly once, when the tier should drop. */
  frame(now: number, active: boolean): boolean {
    const gap = this.last === undefined ? undefined : now - this.last;
    this.last = now;
    if (!active || gap === undefined || gap > this.gapMs) { if (!active) this.samples = []; return false; }
    this.samples.push(gap);
    if (this.samples.length < this.window) return false;
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples = [];
    return mean > this.slowMs;
  }
  reset(): void { this.samples = []; this.last = undefined; }
}
