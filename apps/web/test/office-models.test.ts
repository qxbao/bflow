import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const DIR = join(__dirname, '../public/office');
interface GltfJson { nodes: { name: string; mesh?: number }[]; materials: { name: string }[]; animations?: { name: string }[]; images?: unknown[]; textures?: unknown[]; samplers?: unknown[]; }
function readJson(file: string): GltfJson {
  const buf = readFileSync(join(DIR, file));
  expect(buf.toString('ascii', 0, 4)).toBe('glTF');
  const len = buf.readUInt32LE(12);
  expect(buf.toString('ascii', 16, 20)).toBe('JSON');
  return JSON.parse(buf.toString('utf8', 20, 20 + len)) as GltfJson;
}

const NEW_NODES = ['partition', 'partition_end', 'sign_board', 'sofa', 'armchair', 'coffee_table', 'rug', 'bookshelf', 'water_cooler', 'floor_lamp', 'printer', 'whiteboard', 'window', 'pendant_lamp', 'plant_tall', 'plant_small', 'wall_art',
  'exec_chair', 'bookcase_lux_w', 'bookcase_lux_e', 'statue', 'sofa_lux', 'tea_table', 'rug_lux', 'globe', 'painting', 'desk_pc', 'meeting_chair'];
const OLD_NODES = ['floor_tile', 'wall', 'wall_led', 'spot', 'trim_bar', 'desk', 'chair', 'counter', 'board', 'table', 'server', 'cabinet', 'mailbox', 'settings', 'door', 'plant'];
const CLIPS = ['sleep', 'idle', 'type', 'type_fast', 'raise_hand', 'blocked', 'ghost', 'walk', 'carry'];

describe('generated office models', () => {
  test('furniture keeps the old nodes and has every new one as a top-level mesh node', () => {
    const j = readJson('furniture.glb');
    const names = j.nodes.map(n => n.name);
    for (const n of [...OLD_NODES, ...NEW_NODES]) {
      const node = j.nodes.find(x => x.name === n);
      expect(node, n).toBeDefined();
      expect(node!.mesh, `${n} mesh`).toBeDefined();
    }
    expect(new Set(names).size).toBe(names.length);
    expect(j.materials.map(m => m.name)).toEqual(expect.arrayContaining(['wall', 'slat', 'wallTrim', 'floor', 'wood', 'woodDark', 'metalDark', 'cushion', 'amber', 'amberSoft']));
  });
  test('character has the nine clips', () => {
    const names = (readJson('character.glb').animations ?? []).map(a => a.name);
    expect(names.sort()).toEqual([...CLIPS].sort());
  });
  test('colour only: no images or textures, and the two files stay under 4 MiB', () => {
    for (const f of ['character.glb', 'furniture.glb']) {
      const j = readJson(f);
      expect(j.images ?? []).toHaveLength(0);
      expect(j.textures ?? []).toHaveLength(0);
    }
    expect(statSync(join(DIR, 'character.glb')).size + statSync(join(DIR, 'furniture.glb')).size).toBeLessThan(4 * 1024 * 1024);
  });

  test('window panes and whiteboard notes are not buried inside the slab behind them', () => {
    const buf = readFileSync(join(DIR, 'furniture.glb'));
    const j = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12))) as GltfJson & {
      meshes: { name: string; primitives: { attributes: { POSITION: number }; material: number }[] }[]; accessors: { min: number[]; max: number[] }[];
    };
    /** [min, max] of the POSITION bounds of one primitive. */
    const bounds = (node: string, material: string) => {
      const mesh = j.meshes.find(m => m.name === node)!;
      const prim = mesh.primitives.find(p => j.materials[p.material]!.name === material);
      expect(prim, `${node}/${material}`).toBeDefined();
      const a = j.accessors[prim!.attributes.POSITION]!;
      return { min: a.min, max: a.max };
    };
    expect(bounds('window', 'skyPane').max[2]!).toBeGreaterThan(bounds('window', 'wallTrim').max[2]!);
    for (const m of ['lemon', 'sky', 'coral', 'mint']) expect(bounds('whiteboard', m).max[2]!, m).toBeGreaterThan(bounds('whiteboard', 'white').max[2]! + 0.005);
    // Books rest on the first shelf top (0.04) or above, never inside a board.
    for (const m of ['coral', 'bookBlue', 'lemon', 'bookGreen', 'lav', 'bookRed']) expect(bounds('bookshelf', m).min[1]!, m).toBeGreaterThanOrEqual(0.04 - 1e-4);
  });
});
