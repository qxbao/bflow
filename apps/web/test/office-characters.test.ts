import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { Character } from '../src/features/office/scene/characters';

/** A stand-in rig: a torso in the `outfit` material with the two dress-up children of character.glb. */
function template(): Group {
  const root = new Group(), geo = new BoxGeometry(1, 1, 1);
  const torso = new Mesh(geo, new MeshStandardMaterial({ name: 'outfit' }));
  const hoodie = new Group(), suit = new Group();
  hoodie.name = 'hoodie'; suit.name = 'suit';
  torso.add(hoodie, suit);
  root.add(torso);
  return root;
}
const make = (role: string): Character => new Character(template(), [], `id-${role}`, role, new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
const outfitOf = (c: Character): string => {
  let hex = '';
  c.root.traverse(o => { if (o instanceof Mesh && (o.material as MeshStandardMaterial).name === 'outfit') hex = (o.material as MeshStandardMaterial).color.getHexString(); });
  return hex;
};

describe('character outfits', () => {
  test('Conversation wears the suit and tie in navy instead of the hoodie', () => {
    const c = make('conversation');
    expect(c.root.getObjectByName('suit')!.visible).toBe(true);
    expect(c.root.getObjectByName('hoodie')!.visible).toBe(false);
    expect(outfitOf(c)).toBe('2c3a55');
  });
  test('other roles keep the hoodie in their role colour', () => {
    const c = make('developer');
    expect(c.root.getObjectByName('suit')!.visible).toBe(false);
    expect(c.root.getObjectByName('hoodie')!.visible).toBe(true);
    expect(outfitOf(c)).toBe('9bb8f0');
  });
});
