import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { Character } from '../src/features/office/scene/characters';

const DRESS_UP = ['hoodie', 'suit', 'tank', 'sleeve_l', 'sleeve_r', 'bare_l', 'bare_r', 'hair_short', 'hair_spiky', 'face_f'] as const;
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
  test('other roles keep the hoodie in their role colour', () => {
    const c = make('planner');
    expect(shown(c)).toEqual(['hair_short', 'hoodie', 'sleeve_l', 'sleeve_r']);
    expect(outfitOf(c)).toBe('8fd3b6');
  });
  test('Developers wear a sleeveless top in their role colour, with bare arms', () => {
    const c = make('developer');
    expect(shown(c)).toEqual(['bare_l', 'bare_r', 'hair_short', 'tank']);
    expect(outfitOf(c)).toBe('9bb8f0');
  });
  test('QA has spiky hair standing up', () => {
    expect(shown(make('qa'))).toEqual(['hair_spiky', 'hoodie', 'sleeve_l', 'sleeve_r']);
  });
  test('the Reviewer is a woman with long red hair; other roles keep the dark default', () => {
    const c = make('reviewer');
    expect(shown(c)).toEqual(['face_f', 'hair_long', 'hoodie', 'sleeve_l', 'sleeve_r']);
    expect(hairOf(c)).toBe('b8382b');
    expect(hairOf(make('qa'))).toBe('2a1d19');
  });
});
