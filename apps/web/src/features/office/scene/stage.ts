// Static office built from the furniture GLB: bright floor zones, slat walls, partitions with doorways, zone signs, decor, desks, chairs, the
// interactive objects and a little lighting dressing (spot beams, floor light pools and screen glows are faint additive geometry, so no
// postprocessing is needed and the low quality tier needs no dynamic light). Repeated pieces are instanced. Nothing here reads the model except the desk plan.
import {
  AdditiveBlending, BufferAttribute, CanvasTexture, Color, CylinderGeometry, DirectionalLight, DoubleSide, Euler, Group, HemisphereLight, InstancedMesh, Light, Matrix4, Mesh, MeshBasicMaterial,
  PlaneGeometry, Quaternion, SpotLight, SRGBColorSpace, Vector3, type Object3D,
} from 'three';
import type { OfficeObjectId } from '../model/types';
import { BOARD_X, DECOR, GRID_H, GRID_W, OBJECT_CELLS, PLANT_CELLS, ZONE_SIGNS, cellCentre, decorPlacement, deskPlan, partitionPieces, zoneAt, zones, type DeskPlan, type Vec2, type ZoneSign } from './world';

export const BACKGROUND = '#dfe5e6';
/** Light carpet with a distinct tint per room: warm oak, blue-grey, lavender, mint and sand; the lobby is neutral. */
const FLOOR: Readonly<Record<string, string>> = {
  lobby: '#d9d8d2', conversation: '#d9bc92', coordination: '#c9d6df', taskboard: '#d2d3e6', developer: '#cbe0d2', verification: '#e6d6c2',
};
/** Sky fill of the full tier; the low tier (no spot pools, no shadows) lifts it a little. */
export const HEMI_HIGH = 1.0, HEMI_LOW = 1.5;
/** The amber floor LED is only a subtle edge line in the bright office. */
const TRIM_TONE = new Color('#8a806d');
/** Scale of the tall wall furniture (server, cabinet, mailbox, settings) against the 1.7 high characters. */
const OBJECT_SCALE = 1.2;
/** The mailbox is about 40% smaller than the other tall furniture. */
const MAILBOX_SCALE = OBJECT_SCALE * 0.6;

const m4 = (x: number, y: number, z: number, ry = 0, s = 1): Matrix4 =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(0, ry, 0)), new Vector3(s, s, s));

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

/** Interaction volumes (world units, before the object's own scale) used for picking. */
export const OBJECT_SIZES: Readonly<Record<OfficeObjectId, { w: number; h: number; d: number }>> = {
  counter: { w: 2.3, h: 1.3, d: 1.0 }, board: { w: 8.4, h: 3.4, d: 0.5 }, mailbox: { w: 0.7, h: 1.3, d: 0.6 }, cabinet: { w: 0.9, h: 1.5, d: 0.55 },
  server: { w: 0.8, h: 1.75, d: 0.7 }, settings: { w: 1.1, h: 1.6, d: 0.4 }, door: { w: 1.1, h: 2.5, d: 0.3 },
};

/** The shadow of the key light is only needed on the high tier; turning it off must also free its depth map. */
export function setShadowCasting(light: DirectionalLight, on: boolean): void {
  light.castShadow = on;
  if (!on) light.shadow.dispose();
}

/** Soft radial falloff drawn on a canvas (no image file, so the CSP needs no new source). */
function glowTexture(): CanvasTexture {
  const size = 128, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,0.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
  }
  const t = new CanvasTexture(canvas);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A zone sign's text plane: cream bold capitals on a transparent canvas laid over the dark `sign_board`. Redrawn once when the web font arrives. */
class SignText {
  readonly texture: CanvasTexture;
  private readonly canvas = document.createElement('canvas');
  private dead = false;
  constructor(private readonly sign: ZoneSign, onChange: () => void) {
    this.canvas.width = Math.round(sign.w * 0.9 * 200); this.canvas.height = Math.round(sign.h * 0.8 * 200);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    if (!this.draw()) void document.fonts?.ready.then(() => { if (!this.dead) { this.draw(); this.texture.needsUpdate = true; onChange(); } });
  }
  /** Returns false while the sign font is not loaded yet (this draw used a fallback). Without a 2D context nothing is drawn. */
  private draw(): boolean {
    const g = this.canvas.getContext('2d');
    if (!g) return true;
    const family = '"IBM Plex Sans", system-ui, sans-serif', loaded = document.fonts?.check('700 40px "IBM Plex Sans"') ?? true;
    const { width, height } = this.canvas, text = this.sign.text.toUpperCase();
    g.clearRect(0, 0, width, height);
    let px = Math.round(height * 0.7);
    g.font = `700 ${px}px ${family}`;
    const w = g.measureText(text).width;
    if (w > width * 0.92) { px = Math.floor((px * width * 0.92) / w); g.font = `700 ${px}px ${family}`; }
    g.fillStyle = '#f3ead0'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, width / 2, height / 2 + px * 0.04);
    return loaded;
  }
  dispose(): void { this.dead = true; this.texture.dispose(); }
}

export class Stage {
  readonly group = new Group();
  readonly lights: { key: DirectionalLight; hemi: HemisphereLight; accents: Light[] };
  readonly objects: StageObject[] = [];
  private readonly instances: Instances[] = [];
  private readonly floor: Instances;
  private readonly trim: Instances;
  private readonly desks: Instances;
  private readonly dualDesks: Instances;
  private readonly pcDesks: Instances;
  private readonly chairs: Instances;
  private readonly glowTex = glowTexture();
  private readonly glowMats: MeshBasicMaterial[] = [];
  private readonly glowGeo = new PlaneGeometry(1, 1);
  private readonly beamGeo: CylinderGeometry;
  private readonly beamMat: MeshBasicMaterial;
  private readonly pools: { zone: string; mesh: Mesh }[] = [];
  private readonly deskGlow: InstancedMesh;
  private readonly deskGlowMat: MeshBasicMaterial;
  private readonly signs: { text: SignText; mat: MeshBasicMaterial }[] = [];
  private readonly signGeo = new PlaneGeometry(1, 1);
  private plan: DeskPlan | undefined;

  /** `onChange` fires when something drawn changes outside a layout call (a sign texture redrawn once its font loaded). */
  constructor(furniture: Group, onChange: () => void = () => {}) {
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
    const CAP = 56;
    this.floor = make('floor_tile', GRID_W * GRID_H, false, true);
    this.trim = make('trim_bar', 420, false, false);
    this.desks = make('desk', CAP);
    this.pcDesks = make('desk_pc', CAP);
    this.dualDesks = make('desk_dual', CAP);
    this.chairs = make('chair', CAP);

    // Walls: north (back), west and east. The south side stays open so the camera sees into the room.
    const wallOf = (name: string, list: Matrix4[]): void => { if (list.length) make(name, list.length).set(list); };
    const plain: Matrix4[] = [], led: Matrix4[] = [];
    for (let i = 0; i < GRID_W; i++) (i % 5 === 2 ? led : plain).push(m4(i + 0.5, 0, 0));
    for (let j = 0; j < GRID_H; j++) {
      if (j === OBJECT_CELLS.door.gy) continue; // the door stands in this wall slot
      (j % 6 === 2 ? led : plain).push(m4(0, 0, j + 0.5, Math.PI / 2));
      (j % 6 === 2 ? led : plain).push(m4(GRID_W, 0, j + 0.5, -Math.PI / 2));
    }
    wallOf('wall', plain); wallOf('wall_led', led);

    // Spot fixtures on the walls, each with a faint beam (additive, vertex-faded) reaching the floor.
    const TILT = 1.07, BEAM = 3.6, beamDir = (ry: number): Vector3 => new Vector3(0, -Math.cos(Math.PI / 2 - TILT), Math.sin(Math.PI / 2 - TILT)).applyQuaternion(new Quaternion().setFromEuler(new Euler(0, ry, 0)));
    this.beamGeo = new CylinderGeometry(0.08, 0.9, BEAM, 18, 1, true);
    const fade = new Float32Array(this.beamGeo.attributes['position']!.count * 3);
    for (let i = 0; i < this.beamGeo.attributes['position']!.count; i++) { const k = this.beamGeo.attributes['position']!.getY(i) > 0 ? 1 : 0; fade.set([k, k * 0.62, k * 0.3], i * 3); }
    this.beamGeo.setAttribute('color', new BufferAttribute(fade, 3));
    this.beamMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.03, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
    const spots: Matrix4[] = [];
    const addSpot = (x: number, y: number, z: number, ry: number): void => {
      spots.push(m4(x, y, z, ry).multiply(new Matrix4().makeRotationX(TILT)));
      const dir = beamDir(ry), beam = new Mesh(this.beamGeo, this.beamMat);
      beam.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), dir);
      beam.position.set(x, y, z).addScaledVector(dir, BEAM / 2);
      beam.frustumCulled = false; beam.renderOrder = 2;
      this.group.add(beam);
    };
    for (const x of [3, 7, 11.5, 15.5, 21, 25]) addSpot(x, 3.3, 0.16, 0); // the Coordination pair sits over its two windows
    for (const z of [4, 10, 15]) { addSpot(0.16, 3.3, z, Math.PI / 2); addSpot(GRID_W - 0.16, 3.3, z, -Math.PI / 2); }
    wallOf('spot', spots);

    // Single objects. Tall wall furniture stands flush against its wall.
    const place = (name: string, x: number, z: number, ry = 0, id?: OfficeObjectId, scale = OBJECT_SCALE): void => {
      const clone = node(name).clone(true);
      clone.position.set(x, 0, z); clone.rotation.y = ry; clone.scale.setScalar(scale);
      clone.traverse(o => { if (o instanceof Mesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(clone);
      if (id) { const s = OBJECT_SIZES[id]; this.objects.push({ id, position: { x, z }, size: { w: s.w * scale, h: s.h * scale, d: s.d * scale } }); }
    };
    const at = (id: OfficeObjectId): Vec2 => cellCentre(OBJECT_CELLS[id]);
    const flush = (depth: number): number => 0.07 + (depth * OBJECT_SCALE) / 2;
    place('counter', at('counter').x, at('counter').z, 0, 'counter', 1);
    place('exec_chair', at('counter').x, at('counter').z, 0, undefined, 1);
    place('board', BOARD_X, 0.07, 0, 'board', 1);
    // The mailbox is small and stands against the west wall, facing into the room.
    place('mailbox', 0.07 + (OBJECT_SIZES.mailbox.d * MAILBOX_SCALE) / 2, at('mailbox').z, Math.PI / 2, 'mailbox', MAILBOX_SCALE);
    place('cabinet', flush(0.52), at('cabinet').z, Math.PI / 2, 'cabinet');
    place('server', at('server').x, flush(0.7), 0, 'server');
    place('settings', at('settings').x, 8.85, 0, 'settings');
    place('door', 0.1, at('door').z, Math.PI / 2, 'door', 1);
    place('table', BOARD_X, 4.5, 0, undefined, 1);
    for (const cell of PLANT_CELLS) { const p = cellCentre(cell); place('plant', p.x, p.z, (cell.gx * 7) % 6, undefined, 1); }

    // Partition walls (segments are scaled along their length where they meet a wall or another partition) and end posts at the free ends.
    const pieces = partitionPieces();
    make('partition', pieces.segments.length).set(pieces.segments.map(g => new Matrix4().compose(new Vector3(g.x, 0, g.z), new Quaternion().setFromEuler(new Euler(0, g.ry, 0)), new Vector3(g.len, 1, 1))));
    make('partition_end', pieces.posts.length).set(pieces.posts.map(p => m4(p.x, 0, p.z)));

    // Decor: one instanced set per model.
    const byNode = new Map<string, Matrix4[]>();
    for (const d of DECOR) { const p = decorPlacement(d); byNode.set(d.node, [...(byNode.get(d.node) ?? []), m4(p.x, p.y, p.z, p.ry)]); }
    for (const [name, list] of byNode) make(name, list.length, !name.startsWith('rug') && name !== 'pendant_lamp').set(list);

    // Zone signs: the dark board scaled to size plus a text plane in front of it (canvas texture, no image file).
    make('sign_board', ZONE_SIGNS.length).set(ZONE_SIGNS.map(g => new Matrix4().compose(new Vector3(g.x, g.y, g.z), new Quaternion(), new Vector3(g.w, g.h, 1))));
    for (const g of ZONE_SIGNS) {
      const text = new SignText(g, onChange), mat = new MeshBasicMaterial({ map: text.texture, transparent: true, toneMapped: false, depthWrite: false, fog: false });
      const plane = new Mesh(this.signGeo, mat);
      plane.scale.set(g.w * 0.9, g.h * 0.8, 1); plane.position.set(g.x, g.y, g.z + 0.022); plane.renderOrder = 3;
      this.group.add(plane);
      this.signs.push({ text, mat });
    }

    // Lights: a bright white-warm key (soft shadows on the high tier), a white sky fill, and faint warm spot pools over each room (high tier only).
    const hemi = new HemisphereLight('#ffffff', '#d9cfc0', HEMI_HIGH);
    const key = new DirectionalLight('#fff4e4', 1.5);
    key.position.set(-6, 22, 18); key.target.position.set(GRID_W / 2, 0, GRID_H / 2);
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -22, right: 22, top: 18, bottom: -18, near: 1, far: 70 });
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.04;
    const accents = [[4.5, 4], [13.5, 4], [23.5, 5], [9, 13], [23.5, 13]].map(([x, z]) => {
      const l = new SpotLight('#fff0dc', 30, 16, 0.85, 0.9, 1.5);
      l.position.set(x as number, 5.2, (z as number) + 1.5); l.target.position.set(x as number, 0, z as number);
      this.group.add(l.target);
      return l;
    });
    this.group.add(hemi, key, key.target, ...accents);
    this.lights = { key, hemi, accents };

    // Additive glows: the hero board's halo, its spill on the floor, a warm pool per room, and a faint blue pool at every desk.
    const glow = (color: string, opacity: number, w: number, h: number, pos: Vector3, flat: boolean): Mesh => {
      const mat = new MeshBasicMaterial({ map: this.glowTex, color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, fog: false });
      this.glowMats.push(mat);
      const mesh = new Mesh(this.glowGeo, mat);
      mesh.scale.set(w, h, 1); mesh.position.copy(pos); mesh.frustumCulled = false; mesh.renderOrder = 1;
      if (flat) mesh.rotation.x = -Math.PI / 2;
      this.group.add(mesh);
      return mesh;
    };
    glow('#6f9bd6', 0.14, 12.5, 5.2, new Vector3(BOARD_X, 2.05, 0.35), false);
    glow('#5d86c4', 0.08, 11, 5, new Vector3(BOARD_X, 0.02, 3.4), true);
    for (const [zone, x, z, w, h] of [['conversation', 4.5, 4, 8, 7], ['coordination', 13.5, 4, 10, 7], ['verification', 23.5, 13, 10, 9]] as const) {
      this.pools.push({ zone, mesh: glow('#ff9d4d', 0.05, w, h, new Vector3(x, 0.02, z), true) });
    }
    this.pools.push({ zone: 'developer', mesh: glow('#ff9d4d', 0.045, 18, 9, new Vector3(9.5, 0.02, 13), true) });
    this.deskGlowMat = new MeshBasicMaterial({ map: this.glowTex, color: '#6fb4e8', transparent: true, opacity: 0.1, blending: AdditiveBlending, depthWrite: false, fog: false });
    const dg = new InstancedMesh(this.glowGeo, this.deskGlowMat, CAP);
    dg.frustumCulled = false; dg.count = 0; dg.renderOrder = 1;
    this.group.add(dg);
    this.deskGlow = dg;
    this.layout(deskPlan([]));
  }

  /** Re-lays everything that depends on which desks are drawn: floors, edges, desks, chairs, desk glows and the developer light pool. */
  layout(plan: DeskPlan): void {
    const prev = this.plan;
    if (prev && prev.developerRows === plan.developerRows && prev.desks.length === plan.desks.length && prev.desks.every((c, i) => c.gx === plan.desks[i]?.gx && c.gy === plan.desks[i]?.gy)) return;
    this.plan = plan;
    const rows = plan.developerRows;
    const matrices: Matrix4[] = [], colors: Color[] = [];
    for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) { matrices.push(m4(gx + 0.5, 0, gy + 0.5)); colors.push(new Color(FLOOR[zoneAt({ gx, gy })])); }
    this.floor.set(matrices, colors);
    // Dim amber floor LED along each room's edge, one bar per cell.
    const bars: Matrix4[] = [];
    for (const z of zones(rows)) {
      const x0 = z.x0, x1 = z.x1 + 1, y0 = z.y0, y1 = z.y1 + 1;
      for (let x = x0; x < x1; x++) { bars.push(m4(x + 0.5, 0, y0)); bars.push(m4(x + 0.5, 0, y1)); }
      for (let y = y0; y < y1; y++) { bars.push(m4(x0, 0, y + 0.5, Math.PI / 2)); bars.push(m4(x1, 0, y + 0.5, Math.PI / 2)); }
    }
    this.trim.set(bars, bars.map(() => TRIM_TONE));
    // The Conversation seat has its own executive chair (placed once in the constructor). Developers work at desktop PCs, QA / Reviewer at PCs
    // with two monitors, everyone else at laptops.
    const desks: Matrix4[] = [], pcDesks: Matrix4[] = [], dualDesks: Matrix4[] = [], chairs: Matrix4[] = [], glows: Matrix4[] = [];
    for (const cell of plan.desks) {
      const p = cellCentre(cell), zone = zoneAt(cell);
      (zone === 'developer' ? pcDesks : zone === 'verification' ? dualDesks : desks).push(m4(p.x, 0, p.z)); chairs.push(m4(p.x, 0, p.z));
      glows.push(new Matrix4().compose(new Vector3(p.x, 0.03, p.z + 0.1), new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0)), new Vector3(1.9, 1.3, 1)));
    }
    this.desks.set(desks); this.pcDesks.set(pcDesks); this.dualDesks.set(dualDesks); this.chairs.set(chairs);
    this.deskGlow.count = Math.min(glows.length, this.deskGlow.instanceMatrix.count);
    glows.forEach((m, i) => { if (i < this.deskGlow.count) this.deskGlow.setMatrixAt(i, m); });
    this.deskGlow.instanceMatrix.needsUpdate = true;
    // The developer pool follows the rows drawn.
    const dev = this.pools.find(p => p.zone === 'developer');
    const z = zones(rows).find(q => q.id === 'developer');
    if (dev && z) { dev.mesh.scale.set((z.x1 - z.x0 + 1) * 1.1, (z.y1 - z.y0 + 1) * 1.15, 1); dev.mesh.position.set((z.x0 + z.x1 + 1) / 2, 0.02, (z.y0 + z.y1 + 1) / 2); }
  }

  dispose(): void {
    for (const i of this.instances) i.dispose();
    this.deskGlowMat.dispose(); this.deskGlow.dispose();
    for (const m of this.glowMats) m.dispose();
    this.glowGeo.dispose(); this.signGeo.dispose(); for (const g of this.signs) { g.mat.dispose(); g.text.dispose(); }
    this.beamGeo.dispose(); this.beamMat.dispose(); this.glowTex.dispose();
    this.lights.key.shadow.dispose();
    this.group.clear();
  }
}
