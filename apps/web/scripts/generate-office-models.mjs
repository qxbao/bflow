#!/usr/bin/env node
// Dependency-free generator of the office models (public/office/*.glb). Pure Node: no packages, no images, no network.
// Output is deterministic: running it twice yields byte-identical files. Everything is flat-shaded low-poly with bevelled edges and
// colour-only materials (baseColorFactor), so the strict CSP needs no blob: image sources. Final art may replace the files as long as
// node names, material names and clip names stay as listed in the scene code (character.glb: rig nodes + the nine clips).
//
// Conventions: glTF y-up, the front of every model faces +z, one world unit is one grid cell. The character is about 1.7 high (modelled 1.07, baked x1.6) and the desk and chair are built for that size.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/office');

// ---------- colour palette (harmonised with the Bflow tokens in src/styles/global.css) ----------
const PALETTE = {
  canvas: '#ffffff', faint: '#e7e5de', line: '#d4d1c7', ink: '#1a1a1a', steel: '#3b536f', brand: '#ffc400', accent: '#ffb347',
  wall: '#ece7dc', slat: '#e0d9ca', trim: '#b5ab97', wood: '#cfa97c', woodDark: '#a9825a', metal: '#6f7884', metalDark: '#6d747e', glass: '#4a6a80',
  screen: '#bfe6ff', skin: '#f3c9a5', hair: '#2a1d19', paper: '#f5f1e6', white: '#e9e6dc', green: '#3fae5a', greenDark: '#1f7a3c',
  red: '#cf4a44', pot: '#4a4f58', dark: '#1d2025', ledGreen: '#52e08a', ledAmber: '#e08a2c', tag: '#f3ead0',
};

const srgb = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const hex = h => [1, 3, 5].map(i => srgb(parseInt(h.slice(i, i + 2), 16)));

// ---------- tiny linear algebra ----------
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQ = (axis, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)]; };
/** Euler degrees, order XYZ (the same as three.js 'XYZ'): R = Rx * Ry * Rz. */
const euler = ([x, y, z]) => qMul(axisQ([1, 0, 0], x), qMul(axisQ([0, 1, 0], y), axisQ([0, 0, 1], z)));
const rotate = (q, v) => {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const round = v => Math.round(v * 1e5) / 1e5;

// ---------- geometry: lists of convex polygons {v: [[x,y,z]...], n?: [[x,y,z]...]} ----------
function newell(v) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm([x, y, z]);
}
/** Makes every polygon of an origin-centred convex solid face outward. */
function orient(polys) {
  return polys.map(p => {
    const c = p.v.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]).map(s => s / p.v.length);
    const n = newell(p.v);
    if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] >= 0) return p;
    return { v: [...p.v].reverse(), n: p.n ? [...p.n].reverse() : undefined };
  });
}
/** Chamfered box: 6 faces, 12 edge strips and 8 corner triangles. `r` is the bevel width. */
function box(w, h, d, r = 0.02) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  r = Math.min(r, hx, hy, hz);
  const corner = (sx, sy, sz) => ({
    X: [sx * hx, sy * (hy - r), sz * (hz - r)], Y: [sx * (hx - r), sy * hy, sz * (hz - r)], Z: [sx * (hx - r), sy * (hy - r), sz * hz],
  });
  const C = {};
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) C[`${sx}${sy}${sz}`] = corner(sx, sy, sz);
  const polys = [];
  const S = [-1, 1];
  for (const s of S) {
    polys.push({ v: [C[`${s}-1-1`].X, C[`${s}1-1`].X, C[`${s}11`].X, C[`${s}-11`].X] });
    polys.push({ v: [C[`-1${s}-1`].Y, C[`1${s}-1`].Y, C[`1${s}1`].Y, C[`-1${s}1`].Y] });
    polys.push({ v: [C[`-1-1${s}`].Z, C[`1-1${s}`].Z, C[`11${s}`].Z, C[`-11${s}`].Z] });
  }
  for (const a of S) for (const b of S) {
    polys.push({ v: [C[`-1${a}${b}`].Y, C[`1${a}${b}`].Y, C[`1${a}${b}`].Z, C[`-1${a}${b}`].Z] }); // edge along x
    polys.push({ v: [C[`${a}-1${b}`].X, C[`${a}1${b}`].X, C[`${a}1${b}`].Z, C[`${a}-1${b}`].Z] }); // edge along y
    polys.push({ v: [C[`${a}${b}-1`].X, C[`${a}${b}1`].X, C[`${a}${b}1`].Y, C[`${a}${b}-1`].Y] }); // edge along z
  }
  for (const k of Object.keys(C)) polys.push({ v: [C[k].X, C[k].Y, C[k].Z] });
  return orient(polys);
}
/** Vertical cylinder / cone frustum around the y axis. */
function cyl(rt, rb, h, seg = 10) {
  const polys = [], y0 = -h / 2, y1 = h / 2, ring = (r, y, i) => [r * Math.cos((i / seg) * 2 * Math.PI), y, r * Math.sin((i / seg) * 2 * Math.PI)];
  for (let i = 0; i < seg; i++) polys.push({ v: [ring(rb, y0, i), ring(rb, y0, i + 1), ring(rt, y1, i + 1), ring(rt, y1, i)] });
  if (rt > 0) polys.push({ v: Array.from({ length: seg }, (_, i) => ring(rt, y1, i)) });
  if (rb > 0) polys.push({ v: Array.from({ length: seg }, (_, i) => ring(rb, y0, i)) });
  return orient(polys);
}
/** Smooth-shaded ellipsoid. */
function ball(rx, ry, rz, ws = 12, hs = 8) {
  const P = (i, j) => {
    const th = (j / hs) * Math.PI, ph = (i / ws) * 2 * Math.PI;
    const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
    return { p: [x * rx, y * ry, z * rz], n: norm([x / rx, y / ry, z / rz]) };
  };
  const polys = [];
  for (let j = 0; j < hs; j++) for (let i = 0; i < ws; i++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    const q = j === 0 ? [a, c, d] : j === hs - 1 ? [a, b, c] : [a, b, c, d];
    polys.push({ v: q.map(s => s.p), n: q.map(s => s.n) });
  }
  return orient(polys);
}
/** Applies scale, then Euler rotation (degrees), then translation. */
function place(polys, { t = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const q = euler(r);
  return polys.map(p => ({
    v: p.v.map(v => { const u = rotate(q, [v[0] * s[0], v[1] * s[1], v[2] * s[2]]); return [u[0] + t[0], u[1] + t[1], u[2] + t[2]]; }),
    n: p.n?.map(n => rotate(q, n)),
  }));
}

// ---------- glTF assembly ----------
class Gltf {
  constructor() { this.mats = []; this.matIndex = new Map(); this.nodes = []; this.meshes = []; this.anims = []; this.chunks = []; this.views = []; this.accessors = []; this.offset = 0; }
  material(name, color, { rough = 0.85, metal = 0, emissive } = {}) {
    if (this.matIndex.has(name)) return name;
    this.matIndex.set(name, this.mats.length);
    const m = { name, pbrMetallicRoughness: { baseColorFactor: [...hex(color), 1], metallicFactor: metal, roughnessFactor: rough } };
    if (emissive) m.emissiveFactor = hex(emissive);
    this.mats.push(m);
    return name;
  }
  bytes(buf) {
    const pad = (4 - (buf.length % 4)) % 4, data = Buffer.concat([buf, Buffer.alloc(pad)]);
    this.views.push({ buffer: 0, byteOffset: this.offset, byteLength: buf.length });
    this.chunks.push(data);
    this.offset += data.length;
    return this.views.length - 1;
  }
  accessor(array, type, extra = {}) {
    const f = new Float32Array(array);
    const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const min = Array(comps).fill(Infinity), max = Array(comps).fill(-Infinity);
    for (let i = 0; i < f.length; i++) { min[i % comps] = Math.min(min[i % comps], f[i]); max[i % comps] = Math.max(max[i % comps], f[i]); }
    const view = this.bytes(Buffer.from(f.buffer));
    this.accessors.push({ bufferView: view, componentType: 5126, count: f.length / comps, type, min, max, ...extra });
    return this.accessors.length - 1;
  }
  /** parts: [{ g: polys, m: materialName }]; polygons of one material share one primitive. */
  mesh(name, parts) {
    const byMat = new Map();
    for (const part of parts) byMat.set(part.m, [...(byMat.get(part.m) ?? []), ...part.g]);
    const primitives = [];
    for (const [m, polys] of byMat) {
      const pos = [], nor = [];
      for (const p of polys) {
        const flat = p.n ? undefined : newell(p.v);
        for (let i = 1; i < p.v.length - 1; i++) for (const k of [0, i, i + 1]) { pos.push(...p.v[k].map(round)); nor.push(...(p.n ? p.n[k] : flat)); }
      }
      primitives.push({ attributes: { POSITION: this.accessor(pos, 'VEC3', { }), NORMAL: this.accessor(nor, 'VEC3') }, material: this.matIndex.get(m), mode: 4 });
    }
    // NORMAL accessors must not carry min/max noise, which is harmless but keeps the file smaller when removed.
    for (const p of primitives) delete this.accessors[p.attributes.NORMAL].min, delete this.accessors[p.attributes.NORMAL].max;
    this.meshes.push({ name, primitives });
    return this.meshes.length - 1;
  }
  /** spec: { name, t, r (euler deg), s, parts, children } -> node index */
  node(spec) {
    const n = { name: spec.name };
    if (spec.t) n.translation = spec.t;
    if (spec.r) n.rotation = euler(spec.r);
    if (spec.s) n.scale = spec.s;
    if (spec.parts?.length) n.mesh = this.mesh(spec.name, spec.parts);
    const index = this.nodes.length;
    this.nodes.push(n);
    const kids = (spec.children ?? []).map(c => this.node(c));
    if (kids.length) n.children = kids;
    return index;
  }
  find(name) { const i = this.nodes.findIndex(n => n.name === name); if (i < 0) throw new Error(`no node ${name}`); return i; }
  /** tracks: [{ node, path: 'translation'|'rotation', times, values(array of vec; rotation values are euler degrees) }] */
  animation(name, tracks) {
    const samplers = [], channels = [];
    for (const t of tracks) {
      const flat = t.path === 'rotation' ? t.values.flatMap(e => euler(e)) : t.values.flat();
      samplers.push({ input: this.accessor(t.times, 'SCALAR'), output: this.accessor(flat, t.path === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: this.find(t.node), path: t.path } });
    }
    this.anims.push({ name, samplers, channels });
  }
  glb(rootNodes) {
    const json = {
      asset: { version: '2.0', generator: 'bflow generate-office-models.mjs', copyright: 'AGPL-3.0-only, generated procedurally' },
      scene: 0, scenes: [{ nodes: rootNodes }], nodes: this.nodes, meshes: this.meshes, materials: this.mats,
      accessors: this.accessors, bufferViews: this.views, buffers: [{ byteLength: this.offset }],
    };
    if (this.anims.length) json.animations = this.anims;
    let js = Buffer.from(JSON.stringify(json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const bin = Buffer.concat(this.chunks);
    const head = Buffer.alloc(12);
    head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.write('JSON', 4, 'ascii');
    const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.write('BIN\0', 4, 'binary');
    return Buffer.concat([head, c1, js, c2, bin]);
  }
}

const P = PALETTE;
const mats = g => {
  g.material('outfit', '#9bb8f0'); // replaced per role at run time
  g.material('accent', P.accent);
  g.material('skin', P.skin, { rough: 0.7 });
  g.material('hair', P.hair, { rough: 0.6 });
  g.material('trousers', '#3a3f4a');
  g.material('shoe', P.ink);
  g.material('eye', P.ink, { rough: 0.4 });
  g.material('paper', P.paper);
  g.material('tag', P.tag, { rough: 0.5 });
};

// ---------- character.glb ----------
function character() {
  const g = new Gltf();
  mats(g);
  const limb = (w, h, d, y, m, r = 0.025) => ({ g: place(box(w, h, d, r), { t: [0, y, 0] }), m });
  const side = k => {
    const x = k === 'l' ? -1 : 1;
    return [
      { name: `thigh_${k}`, t: [x * 0.075, 0, 0], parts: [limb(0.1, 0.17, 0.11, -0.065, 'trousers')], children: [
        { name: `shin_${k}`, t: [0, -0.135, 0], parts: [limb(0.09, 0.19, 0.1, -0.085, 'trousers'), { g: place(box(0.105, 0.05, 0.15, 0.02), { t: [0, -0.2, 0.025] }), m: 'shoe' }] },
      ] },
    ];
  };
  const arm = k => {
    const x = k === 'l' ? -1 : 1;
    return { name: `arm_${k}`, t: [x * 0.2, 0.25, 0], parts: [limb(0.085, 0.2, 0.09, -0.09, 'outfit', 0.03), { g: place(ball(0.05, 0.05, 0.05, 8, 6), { t: [0, -0.215, 0] }), m: 'skin' }] };
  };
  const root = g.node({
    name: 'character', s: [1.6, 1.6, 1.6],
    children: [{
      name: 'hips', t: [0, 0.365, 0], parts: [{ g: box(0.27, 0.11, 0.19, 0.03), m: 'trousers' }],
      children: [
        ...side('l'), ...side('r'),
        {
          // Blocky hoodie: body, front pocket, hood ridge behind the neck, and a small name-tag plate (no text in the model).
          name: 'torso', t: [0, 0.05, 0], parts: [
            limb(0.32, 0.27, 0.22, 0.135, 'outfit', 0.06), { g: place(box(0.2, 0.07, 0.03, 0.012), { t: [0, 0.06, 0.115] }), m: 'accent' },
            { g: place(box(0.22, 0.09, 0.08, 0.03), { t: [0, 0.29, -0.09] }), m: 'outfit' },
            { g: place(box(0.095, 0.05, 0.016, 0.006), { t: [0.075, 0.2, 0.113] }), m: 'tag' },
          ],
          children: [
            arm('l'), arm('r'),
            { name: 'paper', t: [0, 0.07, 0.19], r: [-12, 0, 0], parts: [{ g: box(0.22, 0.28, 0.014, 0.004), m: 'paper' }] },
            {
              // Oversized round head, a dark blocky hair dome with a straight fringe.
              name: 'head', t: [0, 0.27, 0], s: [1.12, 1.12, 1.12],
              parts: [
                { g: place(ball(0.235, 0.215, 0.215, 14, 10), { t: [0, 0.2, 0] }), m: 'skin' },
                { g: place(ball(0.25, 0.19, 0.235, 14, 7), { t: [0, 0.255, -0.03] }), m: 'hair' },
                { g: place(box(0.34, 0.045, 0.04, 0.015), { t: [0, 0.31, 0.175] }), m: 'hair' },
                { g: place(ball(0.034, 0.046, 0.024, 8, 6), { t: [-0.085, 0.15, 0.2] }), m: 'eye' },
                { g: place(ball(0.034, 0.046, 0.024, 8, 6), { t: [0.085, 0.15, 0.2] }), m: 'eye' },
              ],
            },
          ],
        },
      ],
    }],
  });

  // Every clip animates the same set of nodes, so a cross-fade never leaves a stale value behind.
  const SEAT_Y = 0.27, STAND_Y = 0.365;
  const nodes = ['hips', 'thigh_l', 'thigh_r', 'shin_l', 'shin_r', 'arm_l', 'arm_r', 'head', 'torso'];
  const sine = (period, steps = 8) => Array.from({ length: steps + 1 }, (_, i) => Math.sin((i / steps) * 2 * Math.PI));
  const times = (dur, steps = 8) => Array.from({ length: steps + 1 }, (_, i) => round((i / steps) * dur));
  /** pose(s, k, c) with s the sine sample, k the cosine sample: returns the euler/translation of each node. */
  const clip = (name, dur, pose, steps = 8) => {
    const tr = times(dur, steps), S = sine(dur, steps), K = Array.from({ length: steps + 1 }, (_, i) => Math.cos((i / steps) * 2 * Math.PI));
    const frames = S.map((s, i) => pose(s, K[i]));
    const tracks = [];
    for (const node of nodes) {
      tracks.push({ node, path: 'rotation', times: tr, values: frames.map(f => f[node]?.r ?? [0, 0, 0]) });
    }
    tracks.push({ node: 'hips', path: 'translation', times: tr, values: frames.map(f => f.hips.t) });
    g.animation(name, tracks);
  };
  const seated = (extra = {}) => ({
    hips: { t: [0, SEAT_Y, 0], r: [0, 0, 0] }, thigh_l: { r: [-90, 0, 0] }, thigh_r: { r: [-90, 0, 0] }, shin_l: { r: [90, 0, 0] }, shin_r: { r: [90, 0, 0] },
    arm_l: { r: [-30, 0, 0] }, arm_r: { r: [-30, 0, 0] }, head: { r: [0, 0, 0] }, torso: { r: [0, 0, 0] }, ...extra,
  });
  const merge = (base, extra) => { for (const k of Object.keys(extra)) base[k] = { ...base[k], ...extra[k] }; return base; };

  // Slumped forward: torso 22 deg, head 30 deg on top of it (about 52 deg overall) and rolled to one side, arms resting out towards the desk; slow breathing.
  clip('sleep', 3.2, (s, k) => merge(seated(), { hips: { t: [0, SEAT_Y + 0.004 * s, 0] }, head: { r: [30 + 1.2 * s, 0, 10] }, torso: { r: [22 + 1.2 * s, 0, 0] }, arm_l: { r: [-100, 0, 8] }, arm_r: { r: [-100, 0, -8] } }));
  clip('idle', 2.4, (s, k) => merge(seated(), { hips: { t: [0, SEAT_Y + 0.004 * s, 0] }, head: { r: [2, 14 * s, 0] }, arm_l: { r: [-62, 0, 6] }, arm_r: { r: [-62, 0, -6] } }));
  clip('type', 1.0, (s, k) => merge(seated(), { head: { r: [10 + 2 * s, 0, 0] }, torso: { r: [4, 0, 0] }, arm_l: { r: [-66 + 7 * s, 0, 5] }, arm_r: { r: [-66 - 7 * s, 0, -5] } }));
  clip('type_fast', 0.5, (s, k) => merge(seated(), { hips: { t: [0, SEAT_Y + 0.005 * k, 0] }, head: { r: [12, 3 * s, 0] }, torso: { r: [6 + 2 * k, 0, 0] }, arm_l: { r: [-68 + 14 * s, 0, 5] }, arm_r: { r: [-68 - 14 * s, 0, -5] } }), 4);
  clip('raise_hand', 1.4, (s, k) => merge(seated(), { head: { r: [-4, 8 * s, 6] }, arm_l: { r: [-30, 0, 8] }, arm_r: { r: [-168, 0, -8 + 10 * s] } }));
  clip('blocked', 0.9, (s, k) => merge(seated(), { head: { r: [14, 24 * s, 0] }, torso: { r: [6, 0, 0] }, arm_l: { r: [-58, 0, -22] }, arm_r: { r: [-58, 0, 22] } }));
  clip('ghost', 3.0, (s, k) => merge(seated(), { hips: { t: [0, SEAT_Y + 0.03 + 0.03 * s, 0] }, head: { r: [0, 8 * s, 0] }, arm_l: { r: [-40, 0, 10 + 4 * s] }, arm_r: { r: [-40, 0, -10 - 4 * s] } }));
  const stride = (s, k, arms) => ({
    hips: { t: [0, STAND_Y + 0.018 * Math.abs(k), 0], r: [0, 4 * s, 0] },
    thigh_l: { r: [-34 * s, 0, 0] }, thigh_r: { r: [34 * s, 0, 0] },
    shin_l: { r: [Math.max(0, 40 * k * (s > 0 ? 1 : 0.2)) + 6, 0, 0] }, shin_r: { r: [Math.max(0, -40 * k * (s < 0 ? 1 : 0.2)) + 6, 0, 0] },
    head: { r: [0, 0, 0] }, torso: { r: [4, -4 * s, 0] }, ...arms(s),
  });
  clip('walk', 0.8, (s, k) => stride(s, k, v => ({ arm_l: { r: [30 * v, 0, 4] }, arm_r: { r: [-30 * v, 0, -4] } })), 8);
  clip('carry', 0.8, (s, k) => stride(s, k, v => ({ arm_l: { r: [-78, 0, -4 + 2 * v] }, arm_r: { r: [-78, 0, 4 - 2 * v] } })), 8);
  return g.glb([root]);
}

// ---------- furniture.glb ----------
function furniture() {
  const g = new Gltf();
  const M = (n, c, o) => g.material(n, c, o);
  M('wall', P.wall, { rough: 0.9 }); M('slat', P.slat, { rough: 0.8 }); M('wallTrim', P.trim, { rough: 0.8 }); M('floor', P.canvas, { rough: 0.95 });
  M('wood', P.wood, { rough: 0.7 }); M('woodDark', P.woodDark, { rough: 0.7 }); M('metal', P.metal, { rough: 0.45, metal: 0.4 }); M('metalDark', P.metalDark, { rough: 0.5, metal: 0.4 });
  M('white', P.white); M('dark', P.dark, { rough: 0.55 }); M('screen', P.screen, { rough: 0.3, emissive: '#6aa6cf' });
  M('amber', '#b9772a', { rough: 0.4, emissive: '#2a190a' }); M('amberSoft', '#b9772a', { rough: 0.4, emissive: '#1c1006' });
  M('green', P.green); M('greenDark', P.greenDark); M('pot', P.pot); M('red', P.red); M('ledGreen', P.ledGreen, { emissive: '#2f9a5a' }); M('ledAmber', '#e08a2c', { emissive: '#a8651a' });
  M('ink', P.ink, { rough: 0.5 }); M('cushion', '#3f8f8c', { rough: 0.9 }); M('mint', '#7cc4a6', { emissive: '#244d3d' }); M('coral', '#ee8f86', { emissive: '#5a2b27' }); M('sky', '#8ec1ea', { emissive: '#27455d' });
  M('lemon', '#f2d479', { emissive: '#5c4d1c' }); M('lav', '#b4a7e0');
  M('boardFace', '#22324a', { rough: 0.35, emissive: '#3a5f95' }); M('line', '#7b8da8', { emissive: '#3b4b66' }); M('lamp', '#fff1c9', { emissive: '#d8b36a' });
  M('cushionLight', '#5fb0ab', { rough: 0.9 }); M('greenLight', '#7ac96b'); M('key', '#e9e9ee', { rough: 0.6 }); M('panel', '#f4f0e6', { rough: 0.9 }); M('panelCap', '#fbf9f3', { rough: 0.8 });
  M('rug', '#e0a458', { rough: 1 }); M('rugInner', '#f3dcae', { rough: 1 }); M('paper', P.paper); M('skyPane', '#9fd4f5', { rough: 0.2, emissive: '#5c9fcf' }); M('waterBlue', '#9fd3f0', { rough: 0.2, emissive: '#2c5d7d' });
  M('bookRed', '#d9534f'); M('bookBlue', '#3d6fb5'); M('bookGreen', '#4aa66a'); M('bookYellow', '#f0c43c');
  const b = (w, h, d, t, m, r) => ({ g: place(box(w, h, d, r ?? 0.02), { t }), m });
  const c = (rt, rb, h, t, m, seg = 10) => ({ g: place(cyl(rt, rb, h, seg), { t }), m });
  const bl = (rx, ry, rz, t, m, ws = 8, hs = 6) => ({ g: place(ball(rx, ry, rz, ws, hs), { t }), m });
  /** Keyboard (dark tray, 3 rows of light key strips, 0.44 x 0.16) centred at (x, z) on a surface at height y, plus a small mouse beside it. */
  const keyboard = (x, y, z, mouseDx = 0.34) => [
    b(0.44, 0.014, 0.16, [x, y + 0.007, z], 'dark', 0.004),
    ...[-1, 0, 1].map(row => b(0.4, 0.008, 0.03, [x, y + 0.018, z + row * 0.045], 'key', 0.002)),
    b(0.06, 0.022, 0.09, [x + mouseDx, y + 0.011, z], 'key', 0.01),
  ];
  const nodes = [];
  const add = spec => nodes.push(g.node(spec));
  const WALL_H = 3.6;

  add({ name: 'floor_tile', parts: [b(1, 0.1, 1, [0, -0.05, 0], 'floor', 0.001)] });
  // Wall modules: off-white panel with vertical slats; the front (+z) face is the room side.
  const slats = [-0.375, -0.125, 0.125, 0.375].map(x => b(0.18, WALL_H - 0.3, 0.05, [x, WALL_H / 2 + 0.1, 0.02], 'slat', 0.012));
  add({ name: 'wall', parts: [b(1, WALL_H, 0.2, [0, WALL_H / 2, -0.1], 'wall', 0.02), ...slats, b(1, 0.12, 0.26, [0, 0.06, -0.1], 'wallTrim', 0.012)] });
  add({ name: 'wall_led', parts: [b(1, WALL_H, 0.2, [0, WALL_H / 2, -0.1], 'wall', 0.02), ...slats.filter((_, i) => i !== 1 && i !== 2), b(0.04, WALL_H - 0.6, 0.04, [0, WALL_H / 2, 0.03], 'amberSoft', 0.01), b(1, 0.12, 0.26, [0, 0.06, -0.1], 'wallTrim', 0.012)] });
  // Spot fixture: housing, barrel and a lens that faces +z (the scene tilts it down into the room).
  add({ name: 'spot', parts: [b(0.12, 0.12, 0.14, [0, 0, 0], 'dark', 0.02), { g: place(cyl(0.08, 0.08, 0.16, 10), { t: [0, 0, 0.12], r: [90, 0, 0] }), m: 'metalDark' }, { g: place(cyl(0.06, 0.06, 0.02, 10), { t: [0, 0, 0.21], r: [90, 0, 0] }), m: 'lamp' }] });
  add({ name: 'trim_bar', parts: [b(1, 0.012, 0.03, [0, 0.006, 0], 'amberSoft', 0.003)] });

  // Desk for a 1.7 high character: top at 0.73, a low laptop (its back, a glowing dot, faces the camera) so the face stays visible.
  add({ name: 'desk', parts: [
    b(1.5, 0.05, 0.74, [0, 0.705, 0], 'wood', 0.015), b(1.5, 0.014, 0.02, [0, 0.665, 0.36], 'amberSoft', 0.004),
    b(0.05, 0.68, 0.68, [-0.69, 0.34, 0], 'woodDark', 0.012), b(0.05, 0.68, 0.68, [0.69, 0.34, 0], 'woodDark', 0.012), b(1.34, 0.4, 0.03, [0, 0.45, 0.3], 'woodDark', 0.01),
    b(0.4, 0.46, 0.62, [0.46, 0.43, 0], 'woodDark', 0.015), b(0.34, 0.1, 0.02, [0.46, 0.56, 0.315], 'metalDark', 0.006), b(0.34, 0.1, 0.02, [0.46, 0.3, 0.315], 'metalDark', 0.006),
    // laptop: base, and a lid tilted back towards the seated character (the -z side)
    b(0.5, 0.025, 0.34, [0, 0.743, 0.02], 'metalDark', 0.01),
    { g: place(box(0.5, 0.3, 0.02, 0.008), { t: [0, 0.9, 0.16], r: [-14, 0, 0] }), m: 'metalDark' },
    { g: place(box(0.45, 0.25, 0.01, 0.004), { t: [0, 0.9, 0.148], r: [-14, 0, 0] }), m: 'screen' },
    { g: place(box(0.07, 0.07, 0.008, 0.002), { t: [0, 0.9, 0.172], r: [-14, 0, 0] }), m: 'lamp' },
    b(0.14, 0.012, 0.1, [0.3, 0.737, -0.06], 'metal', 0.004), c(0.05, 0.05, 0.1, [-0.5, 0.78, 0.0], 'lemon'),
    ...keyboard(-0.02, 0.73, -0.27, 0.36),
  ] });
  // Chair (seat on the -z side of the desk): low seat, tall back, swivel base.
  add({ name: 'chair', parts: [
    b(0.5, 0.07, 0.5, [0, 0.31, -0.62], 'cushion', 0.025), b(0.46, 0.5, 0.06, [0, 0.62, -0.88], 'cushion', 0.025), c(0.03, 0.03, 0.2, [0, 0.19, -0.62], 'metalDark', 6),
    b(0.46, 0.035, 0.04, [0, 0.04, -0.62], 'metalDark', 0.008), b(0.04, 0.035, 0.46, [0, 0.04, -0.62], 'metalDark', 0.008),
  ] });
  // Reception desk (Conversation).
  add({ name: 'counter', parts: [
    b(2.0, 0.06, 0.9, [0, 0.72, 0], 'wood', 0.015), b(2.0, 0.68, 0.05, [0, 0.34, 0.42], 'woodDark', 0.012), b(0.05, 0.68, 0.8, [-0.97, 0.34, 0], 'woodDark', 0.012), b(0.05, 0.68, 0.8, [0.97, 0.34, 0], 'woodDark', 0.012),
    b(1.8, 0.035, 0.03, [0, 0.55, 0.45], 'amber', 0.006), b(0.5, 0.025, 0.34, [-0.45, 0.763, 0.05], 'metalDark', 0.01),
    { g: place(box(0.5, 0.3, 0.02, 0.008), { t: [-0.45, 0.92, 0.2], r: [-14, 0, 0] }), m: 'metalDark' }, { g: place(box(0.45, 0.25, 0.01, 0.004), { t: [-0.45, 0.92, 0.188], r: [-14, 0, 0] }), m: 'screen' },
    b(0.4, 0.24, 0.03, [0.6, 0.86, 0.3], 'lemon', 0.01), ...keyboard(-0.45, 0.75, -0.3, 0.34), c(0.06, 0.05, 0.12, [0.2, 0.81, 0.1], 'white'), c(0.055, 0.055, 0.14, [0.8, 0.82, 0], 'metal'),
  ] });
  // Task Board: the hero wall screen, 8.4 wide, with a kanban of cards and a console below so nothing floats.
  const cards = [];
  [-3.0, -1.0, 1.0, 3.0].forEach((x, col) => {
    cards.push(b(1.7, 0.07, 0.014, [x, 2.95, 0.118], 'line', 0.004));
    const m = ['lemon', 'sky', 'mint', 'coral'][col];
    for (let r = 0; r < 4 - (col % 2); r++) cards.push(b(1.55, 0.28, 0.016, [x, 2.55 - r * 0.4, 0.124], m, 0.02));
  });
  add({ name: 'board', parts: [
    b(8.4, 2.55, 0.12, [0, 2.05, 0.04], 'dark', 0.05), b(8.15, 2.3, 0.03, [0, 2.05, 0.11], 'boardFace', 0.02), b(8.5, 0.05, 0.14, [0, 0.76, 0.05], 'amber', 0.01), b(8.5, 0.05, 0.14, [0, 3.34, 0.05], 'amber', 0.01),
    b(7.6, 0.62, 0.45, [0, 0.31, 0.22], 'woodDark', 0.04), b(7.6, 0.04, 0.46, [0, 0.64, 0.22], 'wood', 0.01), b(7.0, 0.03, 0.03, [0, 0.4, 0.46], 'amber', 0.006), ...cards,
  ] });
  // Standing meeting table for the Task Board zone.
  add({ name: 'table', parts: [
    b(2.8, 0.07, 1.3, [0, 0.98, 0], 'wood', 0.03), b(0.4, 0.95, 0.4, [-0.8, 0.48, 0], 'woodDark', 0.04), b(0.4, 0.95, 0.4, [0.8, 0.48, 0], 'woodDark', 0.04), b(2.9, 0.03, 0.03, [0, 0.95, 0.66], 'amberSoft', 0.006),
    b(0.5, 0.025, 0.36, [-0.6, 1.02, 0.1], 'white', 0.008), b(0.4, 0.025, 0.3, [0.2, 1.02, -0.1], 'lemon', 0.008), c(0.07, 0.06, 0.12, [0.7, 1.07, 0.2], 'white'), c(0.15, 0.15, 0.015, [0.0, 1.02, 0.25], 'metalDark', 12),
  ] });
  add({ name: 'server', parts: [
    b(0.8, 1.75, 0.7, [0, 0.875, 0], 'metalDark', 0.03), b(0.7, 1.6, 0.03, [0, 0.9, 0.34], 'dark', 0.01),
    ...[0, 1, 2, 3, 4, 5].flatMap(i => [b(0.64, 0.19, 0.03, [0, 0.27 + i * 0.25, 0.355], 'metal', 0.01), b(0.035, 0.035, 0.02, [0.25, 0.27 + i * 0.25, 0.375], i % 3 === 1 ? 'ledAmber' : 'ledGreen', 0.004), b(0.035, 0.035, 0.02, [0.19, 0.27 + i * 0.25, 0.375], 'ledGreen', 0.004)]),
    b(0.5, 0.025, 0.02, [-0.05, 0.27, 0.372], 'ink', 0.004), b(0.5, 0.025, 0.02, [-0.05, 0.77, 0.372], 'ink', 0.004), b(0.5, 0.025, 0.02, [-0.05, 1.27, 0.372], 'ink', 0.004),
  ] });
  add({ name: 'cabinet', parts: [
    b(0.9, 1.35, 0.52, [0, 0.675, 0], 'metalDark', 0.03),
    ...[0, 1, 2].flatMap(i => [b(0.78, 0.36, 0.03, [0, 0.27 + i * 0.42, 0.265], 'metal', 0.012), b(0.28, 0.04, 0.04, [0, 0.33 + i * 0.42, 0.295], 'amber', 0.01)]),
    b(0.3, 0.2, 0.2, [0.1, 1.45, 0], 'lemon', 0.03), b(0.35, 0.12, 0.14, [-0.2, 1.41, 0], 'white', 0.02),
  ] });
  add({ name: 'mailbox', parts: [
    b(0.1, 0.8, 0.1, [0, 0.4, 0], 'metalDark', 0.012), b(0.6, 0.42, 0.56, [0, 0.99, 0], 'lemon', 0.07), b(0.5, 0.045, 0.02, [0, 1.04, 0.28], 'dark', 0.006),
    b(0.05, 0.3, 0.05, [0.34, 1.1, 0.1], 'metalDark', 0.008), b(0.16, 0.1, 0.03, [0.34, 1.26, 0.1], 'red', 0.008), b(0.46, 0.04, 0.4, [0, 0.77, 0], 'metalDark', 0.01), b(0.5, 0.05, 0.5, [0, 0.025, 0], 'metalDark', 0.01),
  ] });
  add({ name: 'settings', parts: [
    b(1.1, 0.95, 0.12, [0, 1.15, 0], 'metalDark', 0.035), b(0.96, 0.8, 0.03, [0, 1.15, 0.07], 'boardFace', 0.015), b(0.08, 0.7, 0.08, [-0.4, 0.35, -0.02], 'metal', 0.01), b(0.08, 0.7, 0.08, [0.4, 0.35, -0.02], 'metal', 0.01),
    b(1.0, 0.04, 0.4, [0, 0.02, -0.02], 'metalDark', 0.01),
    ...[-0.3, 0, 0.3].flatMap((x, i) => [{ g: place(cyl(0.09, 0.09, 0.05, 10), { t: [x, 1.32, 0.1], r: [90, 0, 0] }), m: 'metal' }, b(0.02, 0.1, 0.03, [x, 1.34, 0.13], 'amber', 0.004),
      b(0.12, 0.025, 0.02, [x, 1.05, 0.09], 'line', 0.005), b(0.035, 0.07, 0.03, [x + (i - 1) * 0.03, 1.05, 0.105], 'coral', 0.008), b(0.1, 0.05, 0.02, [x, 0.9, 0.09], i === 1 ? 'ledAmber' : 'ledGreen', 0.006)]),
  ] });
  add({ name: 'door', parts: [
    b(1.3, 2.6, 0.2, [0, 1.3, -0.1], 'wallTrim', 0.02), b(1.04, 2.44, 0.08, [0, 1.22, -0.08], 'wood', 0.02), b(0.8, 0.9, 0.02, [0, 1.7, -0.035], 'woodDark', 0.012), b(0.8, 0.9, 0.02, [0, 0.65, -0.035], 'woodDark', 0.012),
    b(0.04, 2.5, 0.03, [-0.58, 1.25, 0.0], 'amber', 0.008), b(0.04, 2.5, 0.03, [0.58, 1.25, 0.0], 'amber', 0.008), b(0.1, 0.03, 0.03, [0.38, 1.05, 0.0], 'metal', 0.008),
  ] });
  add({ name: 'plant', parts: [
    c(0.18, 0.14, 0.3, [0, 0.15, 0], 'pot', 10), c(0.15, 0.15, 0.03, [0, 0.3, 0], 'woodDark', 10),
    ...[[0, 0.58, 0, 0.15, 0.27, 0.15, 'green'], [-0.12, 0.5, 0.04, 0.11, 0.21, 0.11, 'greenDark'], [0.12, 0.52, -0.05, 0.12, 0.23, 0.12, 'green'], [0.03, 0.42, 0.12, 0.1, 0.18, 0.1, 'greenDark']]
      .map(([x, y, z, rx, ry, rz, m]) => ({ g: place(ball(rx, ry, rz, 8, 6), { t: [x, y, z] }), m })),
  ] });

  // ---------- scene dressing (all front +z, origin on the floor, one unit = one cell unless noted) ----------
  add({ name: 'partition', parts: [b(1, 1.3, 0.16, [0, 0.65, 0], 'panel', 0.02), b(1, 0.12, 0.18, [0, 0.06, 0], 'wallTrim', 0.012), b(1, 0.04, 0.2, [0, 1.28, 0], 'panelCap', 0.01)] });
  add({ name: 'partition_end', parts: [b(0.16, 1.35, 0.16, [0, 0.675, 0], 'panel', 0.02), b(0.18, 0.12, 0.18, [0, 0.06, 0], 'wallTrim', 0.012), b(0.2, 0.04, 0.2, [0, 1.33, 0], 'panelCap', 0.01)] });
  // Sign board: a 1 x 1 dark frame centred on its own origin (the scene scales it and adds the text plane in front).
  add({ name: 'sign_board', parts: [b(1, 1, 0.02, [0, 0, -0.005], 'dark', 0.004), b(1, 0.06, 0.03, [0, 0.47, 0], 'metalDark', 0.006), b(1, 0.06, 0.03, [0, -0.47, 0], 'metalDark', 0.006), b(0.06, 0.88, 0.03, [-0.47, 0, 0], 'metalDark', 0.006), b(0.06, 0.88, 0.03, [0.47, 0, 0], 'metalDark', 0.006)] });
  add({ name: 'sofa', parts: [
    b(2, 0.3, 0.9, [0, 0.25, 0], 'cushion', 0.04), b(2, 0.5, 0.22, [0, 0.65, -0.34], 'cushion', 0.05), b(0.2, 0.5, 0.9, [-0.9, 0.55, 0], 'cushion', 0.05), b(0.2, 0.5, 0.9, [0.9, 0.55, 0], 'cushion', 0.05),
    b(0.78, 0.14, 0.62, [-0.38, 0.47, 0.08], 'cushionLight', 0.05), b(0.78, 0.14, 0.62, [0.38, 0.47, 0.08], 'cushionLight', 0.05),
    ...[-0.85, 0.85].flatMap(x => [-0.35, 0.35].map(z => b(0.07, 0.1, 0.07, [x, 0.05, z], 'woodDark', 0.01))),
  ] });
  add({ name: 'armchair', parts: [
    b(0.9, 0.3, 0.85, [0, 0.25, 0], 'cushion', 0.04), b(0.9, 0.5, 0.2, [0, 0.65, -0.32], 'cushion', 0.05), b(0.16, 0.45, 0.85, [-0.37, 0.52, 0], 'cushion', 0.05), b(0.16, 0.45, 0.85, [0.37, 0.52, 0], 'cushion', 0.05),
    b(0.54, 0.13, 0.58, [0, 0.46, 0.08], 'cushionLight', 0.05),
    ...[-0.38, 0.38].flatMap(x => [-0.33, 0.33].map(z => b(0.07, 0.1, 0.07, [x, 0.05, z], 'woodDark', 0.01))),
  ] });
  add({ name: 'coffee_table', parts: [
    b(0.9, 0.05, 0.5, [0, 0.38, 0], 'wood', 0.015), b(0.8, 0.03, 0.4, [0, 0.12, 0], 'woodDark', 0.01),
    ...[-0.38, 0.38].flatMap(x => [-0.2, 0.2].map(z => b(0.05, 0.36, 0.05, [x, 0.18, z], 'woodDark', 0.01))),
    b(0.2, 0.02, 0.15, [-0.15, 0.415, 0.03], 'white', 0.004), c(0.04, 0.035, 0.07, [0.22, 0.445, -0.05], 'coral'),
  ] });
  add({ name: 'rug', parts: [b(3, 0.02, 2, [0, 0.01, 0], 'rug', 0.005), b(2.6, 0.024, 1.6, [0, 0.012, 0], 'rugInner', 0.004), b(1.8, 0.028, 0.9, [0, 0.014, 0], 'rug', 0.004)] });
  const books = [];
  [0.04, 0.47, 0.92, 1.37].forEach((y, row) => { // shelf tops; the gap above each is 0.39-0.41, so books (<= 0.36) stay inside it
    let x = -0.4;
    for (let i = 0; i < 6 - (row % 2); i++) { const w = 0.07 + ((i * 3 + row) % 3) * 0.02, h = 0.26 + ((i + row * 2) % 3) * 0.05; x += w / 2; books.push(b(w, h, 0.26, [x, y + h / 2, 0.0], ['coral', 'bookBlue', 'lemon', 'bookGreen', 'lav', 'bookRed'][(i + row) % 6], 0.006)); x += w / 2 + 0.005; }
  });
  add({ name: 'bookshelf', parts: [
    b(0.05, 2.1, 0.35, [-0.475, 1.05, 0], 'wood', 0.01), b(0.05, 2.1, 0.35, [0.475, 1.05, 0], 'wood', 0.01), b(1, 2.1, 0.03, [0, 1.05, -0.16], 'woodDark', 0.008),
    ...[0.02, 0.45, 0.9, 1.35, 1.8, 2.08].map(y => b(0.9, 0.04, 0.35, [0, y, 0], 'wood', 0.01)), ...books,
  ] });
  add({ name: 'water_cooler', parts: [
    b(0.36, 0.9, 0.36, [0, 0.45, 0], 'white', 0.03), b(0.3, 0.22, 0.02, [0, 0.68, 0.18], 'metalDark', 0.008), b(0.06, 0.04, 0.05, [-0.06, 0.7, 0.21], 'red', 0.008), b(0.06, 0.04, 0.05, [0.06, 0.7, 0.21], 'sky', 0.008), b(0.2, 0.02, 0.12, [0, 0.55, 0.2], 'metalDark', 0.005),
    c(0.15, 0.15, 0.4, [0, 1.12, 0], 'waterBlue', 12), c(0.07, 0.15, 0.08, [0, 1.36, 0], 'waterBlue', 12), c(0.18, 0.18, 0.02, [0, 0.91, 0], 'metalDark', 12),
  ] });
  add({ name: 'floor_lamp', parts: [c(0.17, 0.19, 0.04, [0, 0.02, 0], 'metalDark', 12), c(0.017, 0.017, 1.45, [0, 0.76, 0], 'metalDark', 6), c(0.17, 0.26, 0.32, [0, 1.62, 0], 'lamp', 12), c(0.1, 0.1, 0.02, [0, 1.79, 0], 'metalDark', 8)] });
  add({ name: 'printer', parts: [
    b(0.8, 0.72, 0.5, [0, 0.36, 0], 'wood', 0.02), b(0.74, 0.3, 0.02, [0, 0.5, 0.255], 'woodDark', 0.006), b(0.74, 0.3, 0.02, [0, 0.18, 0.255], 'woodDark', 0.006), b(0.2, 0.025, 0.03, [0, 0.58, 0.275], 'metalDark', 0.006),
    b(0.7, 0.24, 0.42, [0, 0.84, 0], 'white', 0.03), b(0.5, 0.02, 0.3, [0, 0.97, -0.02], 'paper', 0.004), b(0.5, 0.03, 0.2, [0, 0.78, 0.26], 'paper', 0.004), b(0.2, 0.06, 0.02, [0.18, 0.88, 0.215], 'dark', 0.006), b(0.025, 0.025, 0.02, [0.28, 0.9, 0.215], 'ledGreen', 0.004),
  ] });
  const notes = [['lemon', -0.7, 1.95], ['sky', -0.3, 1.9], ['coral', 0.1, 1.97], ['mint', 0.55, 1.92], ['lemon', -0.55, 1.55], ['mint', -0.15, 1.5], ['sky', 0.35, 1.55], ['coral', 0.75, 1.5]].map(([m, x, y]) => b(0.28, 0.24, 0.012, [x, y, 0.066], m, 0.004));
  add({ name: 'whiteboard', parts: [b(2, 1.2, 0.05, [0, 1.75, 0.025], 'metal', 0.015), b(1.9, 1.1, 0.02, [0, 1.75, 0.045], 'white', 0.006), b(1.6, 0.02, 0.01, [0, 2.1, 0.058], 'line', 0.003), b(1.2, 0.02, 0.01, [-0.2, 1.75, 0.058], 'line', 0.003), ...notes, b(1.9, 0.04, 0.08, [0, 1.13, 0.07], 'metal', 0.01), b(0.14, 0.03, 0.03, [-0.5, 1.165, 0.07], 'red', 0.006), b(0.14, 0.03, 0.03, [-0.3, 1.165, 0.07], 'bookBlue', 0.006)] });
  add({ name: 'window', parts: [
    // Frame as four border bars (z 0..0.06) so the pane is not buried; the pane (z 0.05..0.07) and thin mullions (z up to 0.065) sit inside the opening.
    b(2, 0.1, 0.06, [0, 2.65, 0.03], 'wallTrim', 0.01), b(2, 0.1, 0.06, [0, 1.05, 0.03], 'wallTrim', 0.01), b(0.1, 1.5, 0.06, [-0.95, 1.85, 0.03], 'wallTrim', 0.01), b(0.1, 1.5, 0.06, [0.95, 1.85, 0.03], 'wallTrim', 0.01),
    b(1.8, 1.5, 0.02, [0, 1.85, 0.06], 'skyPane', 0.004),
    b(0.05, 1.5, 0.02, [0, 1.85, 0.055], 'wallTrim', 0.005), b(1.8, 0.05, 0.02, [0, 1.85, 0.055], 'wallTrim', 0.005), b(2.1, 0.05, 0.16, [0, 0.97, 0.08], 'wood', 0.01),
  ] });
  add({ name: 'pendant_lamp', parts: [c(0.1, 0.34, 0.24, [0, 0, 0], 'white', 14), c(0.1, 0.1, 0.02, [0, 0.12, 0], 'metalDark', 10), c(0.008, 0.008, 1.2, [0, 0.73, 0], 'dark', 4), bl(0.1, 0.1, 0.1, [0, -0.1, 0], 'lamp', 10, 6)] });
  add({ name: 'plant_tall', parts: [
    c(0.27, 0.2, 0.5, [0, 0.25, 0], 'pot', 12), c(0.25, 0.25, 0.03, [0, 0.5, 0], 'woodDark', 12), c(0.04, 0.05, 0.9, [0, 0.95, 0], 'woodDark', 6),
    ...[[0, 1.75, 0, 0.36, 0.34, 0.36, 'green'], [-0.28, 1.45, 0.08, 0.28, 0.24, 0.28, 'greenDark'], [0.27, 1.4, -0.06, 0.3, 0.26, 0.3, 'green'], [0.05, 1.2, 0.26, 0.24, 0.2, 0.24, 'greenLight'], [-0.1, 1.15, -0.25, 0.26, 0.2, 0.26, 'greenDark'], [0.1, 2.0, 0.05, 0.24, 0.22, 0.24, 'greenLight']]
      .map(([x, y, z, rx, ry, rz, m]) => bl(rx, ry, rz, [x, y, z], m, 10, 7)),
  ] });
  add({ name: 'plant_small', parts: [c(0.08, 0.06, 0.1, [0, 0.05, 0], 'white', 10), ...[[0, 0.16, 0, 0.06, 0.07, 0.06, 'greenLight'], [-0.06, 0.13, 0.03, 0.05, 0.05, 0.05, 'green'], [0.06, 0.13, -0.02, 0.05, 0.05, 0.05, 'greenDark'], [0.01, 0.12, 0.07, 0.045, 0.045, 0.045, 'green']].map(([x, y, z, rx, ry, rz, m]) => bl(rx, ry, rz, [x, y, z], m, 8, 5))] });
  add({ name: 'wall_art', parts: [
    b(0.9, 0.7, 0.03, [0, 1.75, 0.015], 'woodDark', 0.01), b(0.8, 0.6, 0.012, [0, 1.75, 0.03], 'paper', 0.003),
    b(0.3, 0.4, 0.012, [-0.22, 1.75, 0.04], 'coral', 0.003), b(0.26, 0.26, 0.012, [0.1, 1.9, 0.04], 'sky', 0.003), b(0.26, 0.2, 0.012, [0.1, 1.6, 0.04], 'lemon', 0.003), b(0.14, 0.4, 0.012, [0.3, 1.75, 0.04], 'mint', 0.003),
  ] });
  return g.glb(nodes);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'character.glb'), character());
writeFileSync(join(OUT, 'furniture.glb'), furniture());
writeFileSync(join(OUT, 'LICENSE.txt'), [
  'Bflow office models.',
  '',
  'character.glb and furniture.glb are generated by apps/web/scripts/generate-office-models.mjs (no third-party artwork, no images, no text).',
  'They are released under the project licence (AGPL-3.0-only). A later set may replace these files without code changes as long as the node,',
  'material and clip names are kept.',
  '',
].join('\n'));
