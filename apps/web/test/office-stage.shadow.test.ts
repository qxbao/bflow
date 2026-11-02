import { DirectionalLight } from 'three';
import { describe, expect, test, vi } from 'vitest';
import { setShadowCasting } from '../src/features/office/scene/stage';

describe('key light shadow', () => {
  test('turning shadows off (high -> low tier) disposes the depth map, turning them on does not', () => {
    const light = new DirectionalLight();
    const dispose = vi.spyOn(light.shadow, 'dispose');
    setShadowCasting(light, true);
    expect(light.castShadow).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    setShadowCasting(light, false);
    expect(light.castShadow).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
