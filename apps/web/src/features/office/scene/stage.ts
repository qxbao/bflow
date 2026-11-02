// Static office built from the furniture GLB: floor zones, slat walls, amber trim, desks, chairs and the interactive objects.
// Repeated pieces are instanced (one draw call per sub-mesh). Nothing here reads the model except the developer row count.
import { Color, DirectionalLight, Euler, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, PointLight, Quaternion, Vector3, type Object3D } from 'three';
import type { OfficeObjectId } from '../model/types';
import { DEVELOPER_COLUMNS, DEVELOPER_ROWS, DESK_CELLS, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, cellCentre, zoneAt, zones, type Cell, type Vec2 } from './world';

export const BACKGROUND = '#121418';
const FLOOR: Readonly<Record<string, [string, string]>> = {
  lobby: ['#30343b', '#343840'], conversation: ['#4a423c', '#4f4741'], coordination: ['#36404f', '#3a4555'], taskboard: ['#333c4d', '#374152'],
  developer: ['#3b4552', '#404a58'], verification: ['#34483f', '#394d44'],
};

const m4 = (x: number, y: number, z: number, ry = 0, s = 1): Matrix4 =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(0, ry, 0)), new Vector3(s, s, s));
/** Furniture next to the characters is built a little larger than life so the chibi proportions read. */
export const PROP_SCALE = 1.2;

/** Desks, chairs and the reception counter are turned half a circle: the monitor stands on the far side facing the camera and the character sits on the near side. */

/** Instanced copies of every mesh of a template node. Matrices can be replaced later; `count` follows. */
export class Instances {
  readonly meshes: InstancedMesh[] = [];
  private readonly local: Matrix4[] = [];
  constructor(template: Object3D, capacity: number, parent: Group, flags: { cast: boolean; receive: boolean }) {
    template.updateWorldMatrix(true, true);
    template.traverse(o => {
      if (!(o instanceof Mesh)) return;
      const inst = new InstancedMesh(o.geometry, o.material, capacity);
      inst.castShadow = flags.cast; inst.receiveShadow = flags.receive; inst.frustumCulled = false; inst.count = 0;
      this.meshes.push(inst); this.local.push(o.matrixWorld.clone());
      parent.add(inst);
    });
  }
  set(matrices: readonly Matrix4[], colors?: readonly Color[]): void {
    this.meshes.forEach((inst, k) => {
      const base = this.local[k] as Matrix4, tmp = new Matrix4();
      inst.count = Math.min(matrices.length, inst.instanceMatrix.count);
      for (let i = 0; i < inst.count; i++) {
        inst.setMatrixAt(i, tmp.multiplyMatrices(matrices[i] as Matrix4, base));
        const c = colors?.[i];
        if (c) inst.setColorAt(i, c);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    });
  }
  dispose(): void { for (const m of this.meshes) m.dispose(); }
}

export interface StageObject { id: OfficeObjectId; position: Vec2; size: { w: number; h: number; d: number } }

/** Interaction volumes (world units) used for picking and for the camera when an object is focused. */
export const OBJECT_SIZES: Readonly<Record<OfficeObjectId, { w: number; h: number; d: number }>> = {
  counter: { w: 1.9, h: 1.0, d: 0.8 }, board: { w: 5.2, h: 2.2, d: 0.4 }, mailbox: { w: 0.7, h: 1.3, d: 0.6 }, cabinet: { w: 0.9, h: 1.5, d: 0.55 },
  server: { w: 0.8, h: 1.75, d: 0.7 }, settings: { w: 1.1, h: 1.6, d: 0.3 }, door: { w: 1.1, h: 2.3, d: 0.3 },
};

export class Stage {
  readonly group = new Group();
  readonly lights: { key: DirectionalLight; hemi: HemisphereLight; accents: PointLight[] };
  readonly objects: StageObject[] = [];
  private readonly instances: Instances[] = [];
  private readonly floor: Instances;
  private readonly trim: Instances;
  private readonly desks: Instances;
  private readonly chairs: Instances;
  private rows = -1;

  constructor(furniture: Group) {
    const node = (name: string): Object3D => {
      const found = furniture.getObjectByName(name);
      if (!found) throw new Error(`office furniture has no node ${name}`);
      return found;
    };
    const make = (name: string, capacity: number, cast = true, receive = true): Instances => {
      const inst = new Instances(node(name), capacity, this.group, { cast, receive });
      this.instances.push(inst);
      return inst;
    };

    this.floor = make('floor_tile', GRID_W * GRID_H, false, true);
    this.trim = make('trim_bar', 520, false, false);
    this.desks = make('desk', DESK_CELLS.length);
    this.chairs = make('chair', DESK_CELLS.length + 1);

    // Walls: north (back), west and east. The south side stays open so the camera sees into the room.
    const wallOf = (name: string, list: Matrix4[]): void => { if (list.length) make(name, list.length).set(list); };
    const plain: Matrix4[] = [], led: Matrix4[] = [];
    for (let i = 0; i < GRID_W; i++) (i % 4 === 2 ? led : plain).push(m4(i + 0.5, 0, 0));
    for (let j = 0; j < GRID_H; j++) {
      if (j === OBJECT_CELLS.door.gy) continue; // the door stands in this wall slot
      (j % 5 === 2 ? led : plain).push(m4(0, 0, j + 0.5, Math.PI / 2));
      (j % 5 === 2 ? led : plain).push(m4(GRID_W, 0, j + 0.5, -Math.PI / 2));
    }
    wallOf('wall', plain); wallOf('wall_led', led);
    // Spot fixtures along the north and west walls, angled down into the room.
    const spots: Matrix4[] = [];
    for (let x = 2; x < GRID_W; x += 4) spots.push(m4(x, 2.72, 0.14).multiply(new Matrix4().makeRotationX(0.85)));
    for (let z = 3; z < GRID_H; z += 5) spots.push(m4(0.14, 2.72, z, Math.PI / 2).multiply(new Matrix4().makeRotationX(0.85)));
    wallOf('spot', spots);

    // Conversation seat has a chair; desks and chairs for developer rows are filled by `layout`.
    this.chairs.set([]);

    // Single objects.
    const place = (name: string, x: number, z: number, ry = 0, id?: OfficeObjectId, scale = PROP_SCALE): void => {
      const clone = node(name).clone(true);
      clone.position.set(x, 0, z); clone.rotation.y = ry; clone.scale.setScalar(scale);
      clone.traverse(o => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(clone);
      if (id) { const s = OBJECT_SIZES[id]; this.objects.push({ id, position: { x, z }, size: { w: s.w * scale, h: s.h * scale, d: s.d * scale } }); }
    };
    const at = (id: OfficeObjectId): Vec2 => cellCentre(OBJECT_CELLS[id]);
    place('counter', at('counter').x, at('counter').z, Math.PI, 'counter');
    place('board', at('board').x, 0.12, 0, 'board', 1);
    place('mailbox', at('mailbox').x, at('mailbox').z, 0, 'mailbox');
    place('cabinet', at('cabinet').x, at('cabinet').z, 0, 'cabinet');
    place('server', at('server').x, at('server').z, 0, 'server');
    place('settings', at('settings').x, at('settings').z, 0, 'settings');
    place('door', 0.1, at('door').z, Math.PI / 2, 'door', 1);
    for (const cell of PLANT_CELLS) { const p = cellCentre(cell); place('plant', p.x, p.z, (cell.gx * 7) % 6, undefined, 1.3); }

    // Lights: a dim warm key, a cool hemisphere fill and a few amber accents over the rooms (high tier only).
    const hemi = new HemisphereLight('#aab9d6', '#3a2e22', 1.9);
    const key = new DirectionalLight('#ffd9ae', 2.6);
    key.position.set(-6, 22, 18); key.target.position.set(GRID_W / 2, 0, GRID_H / 2);
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -22, right: 22, top: 18, bottom: -18, near: 1, far: 70 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.04;
    const accents = [[6, 4], [14, 4], [23.5, 4], [10, 13], [23, 13]].map(([x, z]) => {
      const l = new PointLight('#ffb766', 14, 11, 1.6);
      l.position.set(x as number, 2.4, z as number);
      return l;
    });
    this.group.add(hemi, key, key.target, ...accents);
    this.lights = { key, hemi, accents };
    this.layout(1);
  }

  /** Re-lays the parts that depend on the developer row count: zone floors, amber edges, desks and chairs. */
  layout(developerRows: number): void {
    const rows = Math.max(1, Math.min(DEVELOPER_ROWS.length, developerRows));
    if (rows === this.rows) return;
    this.rows = rows;
    const matrices: Matrix4[] = [], colors: Color[] = [];
    for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) {
      const pair = FLOOR[zoneAt({ gx, gy }, rows)] as [string, string];
      matrices.push(m4(gx + 0.5, 0, gy + 0.5)); colors.push(new Color(pair[(gx + gy) % 2]));
    }
    this.floor.set(matrices, colors);
    // Amber zone edges along each rectangle, one bar per cell; the corner is closed by the next side.
    const bars: Matrix4[] = [];
    for (const z of zones(rows)) {
      const x0 = z.x0, x1 = z.x1 + 1, y0 = z.y0, y1 = z.y1 + 1;
      for (let x = x0; x < x1; x++) { bars.push(m4(x + 0.5, 0.0, y0)); bars.push(m4(x + 0.5, 0.0, y1)); }
      for (let y = y0; y < y1; y++) { bars.push(m4(x0, 0.0, y + 0.5, Math.PI / 2)); bars.push(m4(x1, 0.0, y + 0.5, Math.PI / 2)); }
    }
    this.trim.set(bars);
    const desks: Matrix4[] = [], chairs: Matrix4[] = [];
    const conv = cellCentre(OBJECT_CELLS.counter);
    chairs.push(m4(conv.x, 0, conv.z, Math.PI, PROP_SCALE));
    const visibleDev = rows * DEVELOPER_COLUMNS.length;
    for (const cell of DESK_CELLS) {
      const isDev = (DEVELOPER_COLUMNS as readonly number[]).includes(cell.gx) && (DEVELOPER_ROWS as readonly number[]).includes(cell.gy);
      if (isDev && !this.devVisible(cell, visibleDev)) continue;
      const p = cellCentre(cell);
      desks.push(m4(p.x, 0, p.z, Math.PI, PROP_SCALE)); chairs.push(m4(p.x, 0, p.z, Math.PI, PROP_SCALE));
    }
    this.desks.set(desks); this.chairs.set(chairs);
  }

  private devVisible(cell: Cell, visibleDev: number): boolean {
    const row = (DEVELOPER_ROWS as readonly number[]).indexOf(cell.gy);
    return row >= 0 && row * DEVELOPER_COLUMNS.length < visibleDev;
  }

  dispose(): void { for (const i of this.instances) i.dispose(); this.group.clear(); }
}
