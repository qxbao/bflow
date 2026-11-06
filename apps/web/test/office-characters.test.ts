import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { Character } from '../src/features/office/scene/characters';

const DRESS_UP = ['hoodie', 'suit', 'tank', 'tshirt', 'sleeve_l', 'sleeve_r', 'bare_l', 'bare_r', 'tsleeve_l', 'tsleeve_r', 'hair_short', 'hair_spiky', 'face_f', 'glasses', 'dress_shirt', 'vest', 'pants_l', 'pants_r', 'calf_l', 'calf_r'] as const;
/** A stand-in rig: a torso in the `outfit` material with the dress-up children of character.glb (`hair_long` holds a mesh in the `hair` material). */
function template(): Group {
  const root = new Group(), geo = new BoxGeometry(1, 1, 1);
  const torso = new Mesh(geo, new MeshStandardMaterial({ name: 'outfit' }));
  for (const name of DRESS_UP) { const g = new Group(); g.name = name; torso.add(g); }
  const long = new Mesh(geo, new MeshStandardMaterial({ name: 'hair', color: '#2a1d19' }));
  long.name = 'hair_long';
  torso.add(long);
  root.add(torso);
  return root;
}
const shown = (c: Character): string[] => [...DRESS_UP, 'hair_long'].filter(n => c.root.getObjectByName(n)!.visible).sort();
const hairOf = (c: Character): string => (c.root.getObjectByName('hair_long') as Mesh).material instanceof MeshStandardMaterial ? ((c.root.getObjectByName('hair_long') as Mesh).material as MeshStandardMaterial).color.getHexString() : '';
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
  test('the Director Team wears a white business shirt with long sleeves and trousers', () => {
    for (const role of ['planner', 'architect', 'specifier', 'coordinator']) {
      const c = make(role);
      expect(shown(c), role).toEqual(['dress_shirt', 'hair_short', 'pants_l', 'pants_r', 'sleeve_l', 'sleeve_r']);
      expect(outfitOf(c), role).toBe('f4f3ee');
    }
  });
  test('the bartender wears a white business shirt under a black vest', () => {
    const c = make('bartender');
    expect(shown(c)).toEqual(['dress_shirt', 'hair_short', 'pants_l', 'pants_r', 'sleeve_l', 'sleeve_r', 'vest']);
    expect(outfitOf(c)).toBe('f4f3ee');
  });
  test('other roles keep the hoodie in their role colour', () => {
    const c = make('tester');
    expect(shown(c)).toEqual(['hair_short', 'hoodie', 'pants_l', 'pants_r', 'sleeve_l', 'sleeve_r']);
    expect(outfitOf(c)).toBe('7fcfd0');
  });
  test('Developers wear only a sleeveless top in their role colour and shorts, with bare arms and legs', () => {
    const c = make('developer');
    expect(shown(c)).toEqual(['bare_l', 'bare_r', 'calf_l', 'calf_r', 'hair_short', 'tank']);
    expect(outfitOf(c)).toBe('9bb8f0');
  });
  test('QA has jet-black spiky hair and the black team T-shirt with short sleeves', () => {
    const c = make('qa');
    expect(shown(c)).toEqual(['bare_l', 'bare_r', 'hair_spiky', 'pants_l', 'pants_r', 'tshirt', 'tsleeve_l', 'tsleeve_r']);
    expect(outfitOf(c)).toBe('1e1f24');
    expect(hairOf(c)).toBe('141417');
  });
  test('the Reviewer is a woman with long crimson hair and round glasses, in the black team T-shirt; other roles keep the dark default hair', () => {
    const c = make('reviewer');
    expect(shown(c)).toEqual(['bare_l', 'bare_r', 'face_f', 'glasses', 'hair_long', 'pants_l', 'pants_r', 'tshirt', 'tsleeve_l', 'tsleeve_r']);
    expect(outfitOf(c)).toBe('1e1f24');
    expect(hairOf(c)).toBe('8a1538');
    expect(hairOf(make('planner'))).toBe('2a1d19');
  });
});
