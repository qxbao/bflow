#!/usr/bin/env node
// Dependency-free generator of the office models (public/office/*.glb). Pure Node: no packages, no images, no network.
// Output is deterministic: running it twice yields byte-identical files. Everything is flat-shaded low-poly with bevelled edges and
// colour-only materials (baseColorFactor), so the strict CSP needs no blob: image sources. Final art may replace the files as long as
// node names, material names and clip names stay as listed in the scene code (character.glb: rig nodes + the nine clips).
//
// Conventions: glTF y-up, the front of every model faces +z, one world unit is one grid cell. The character is about 1.07 high.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/office');

// ---------- colour palette (harmonised with the Bflow tokens in src/styles/global.css) ----------
const PALETTE = {
  canvas: '#ffffff', faint: '#e7e5de', line: '#d4d1c7', ink: '#1a1a1a', steel: '#3b536f', brand: '#ffc400', accent: '#ffb347',
  wall: '#262a31', slat: '#31363e', trim: '#1c1f24', wood: '#3a3f47', woodDark: '#2a2e35', metal: '#6f7884', metalDark: '#2f343b', glass: '#4a6a80',
  screen: '#bfe6ff', skin: '#f3c9a5', hair: '#2a1d19', paper: '#f5f1e6', white: '#e9e6dc', green: '#5aa56a', greenDark: '#2f6e3d',
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
    name: 'character',
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
              name: 'head', t: [0, 0.27, 0],
              parts: [
                { g: place(ball(0.235, 0.215, 0.215, 14, 10), { t: [0, 0.2, 0] }), m: 'skin' },
                { g: place(ball(0.25, 0.19, 0.235, 14, 7), { t: [0, 0.255, -0.03] }), m: 'hair' },
                { g: place(box(0.36, 0.07, 0.05, 0.02), { t: [0, 0.285, 0.17] }), m: 'hair' },
                { g: place(ball(0.03, 0.04, 0.022, 8, 6), { t: [-0.085, 0.16, 0.2] }), m: 'eye' },
                { g: place(ball(0.03, 0.04, 0.022, 8, 6), { t: [0.085, 0.16, 0.2] }), m: 'eye' },
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

  clip('sleep', 3.2, (s, k) => merge(seated(), { hips: { t: [0, SEAT_Y + 0.004 * s, 0] }, head: { r: [28 + 2 * s, 0, 4] }, torso: { r: [8 + 1.5 * s, 0, 0] }, arm_l: { r: [-22, 0, 8] }, arm_r: { r: [-22, 0, -8] } }));
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
  M('wall', P.wall, { rough: 0.9 }); M('slat', P.slat, { rough: 0.8 }); M('wallTrim', P.trim, { rough: 0.8 }); M('floor', P.canvas, { rough: 0.92 });
  M('wood', P.wood, { rough: 0.7 }); M('woodDark', P.woodDark, { rough: 0.7 }); M('metal', P.metal, { rough: 0.45, metal: 0.4 }); M('metalDark', P.metalDark, { rough: 0.5, metal: 0.4 });
  M('white', P.white); M('dark', P.dark, { rough: 0.55 }); M('screen', P.screen, { rough: 0.3, emissive: '#7fb8e0' }); M('amber', '#d9892b', { rough: 0.4, emissive: '#b8691a' });
  M('green', P.green); M('greenDark', P.greenDark); M('pot', P.pot); M('red', P.red); M('ledGreen', P.ledGreen, { emissive: P.ledGreen }); M('ledAmber', P.ledAmber, { emissive: P.ledAmber });
  M('ink', P.ink, { rough: 0.5 }); M('cushion', '#4c5a69', { rough: 0.9 }); M('mint', '#7cc4a6'); M('coral', '#ee8f86'); M('sky', '#8ec1ea'); M('lemon', '#f2d479'); M('lav', '#b4a7e0');
  M('boardFace', '#1d2736', { rough: 0.35, emissive: '#2a3c57' }); M('line', '#55606e');
  const b = (w, h, d, t, m, r) => ({ g: place(box(w, h, d, r ?? 0.02), { t }), m });
  const c = (rt, rb, h, t, m, seg = 10) => ({ g: place(cyl(rt, rb, h, seg), { t }), m });
  const nodes = [];
  const add = spec => nodes.push(g.node(spec));

  add({ name: 'floor_tile', parts: [b(1, 0.1, 1, [0, -0.05, 0], 'floor', 0.012)] });
  // Wall modules: dark panel with vertical slats; the front (+z) face is the room side.
  const slats = [-0.375, -0.125, 0.125, 0.375].map(x => b(0.18, 2.7, 0.05, [x, 1.4, 0.02], 'slat', 0.012));
  add({ name: 'wall', parts: [b(1, 3, 0.2, [0, 1.5, -0.1], 'wall', 0.02), ...slats, b(1, 0.12, 0.26, [0, 0.06, -0.1], 'wallTrim', 0.012)] });
  add({ name: 'wall_led', parts: [b(1, 3, 0.2, [0, 1.5, -0.1], 'wall', 0.02), ...slats.filter((_, i) => i !== 1 && i !== 2), b(0.045, 2.6, 0.045, [0, 1.45, 0.03], 'amber', 0.01), b(1, 0.12, 0.26, [0, 0.06, -0.1], 'wallTrim', 0.012)] });
  add({ name: 'spot', parts: [b(0.1, 0.1, 0.12, [0, 0, 0], 'dark', 0.02), { g: place(cyl(0.07, 0.07, 0.14, 10), { t: [0, 0, 0.1], r: [90, 0, 0] }), m: 'metalDark' }, { g: place(cyl(0.05, 0.05, 0.02, 10), { t: [0, 0, 0.175], r: [90, 0, 0] }), m: 'amber' }] });
  add({ name: 'trim_bar', parts: [b(1, 0.02, 0.045, [0, 0.01, 0], 'amber', 0.005)] });

  add({ name: 'desk', parts: [
    b(1.5, 0.05, 0.72, [0, 0.455, 0], 'wood', 0.015), b(1.5, 0.014, 0.02, [0, 0.43, 0.35], 'amber', 0.004),
    b(0.05, 0.43, 0.66, [-0.69, 0.215, 0], 'woodDark', 0.012), b(0.05, 0.43, 0.66, [0.69, 0.215, 0], 'woodDark', 0.012), b(1.34, 0.28, 0.03, [0, 0.3, 0.3], 'woodDark', 0.01),
    b(0.4, 0.3, 0.6, [0.46, 0.27, 0], 'woodDark', 0.015), b(0.34, 0.07, 0.02, [0.46, 0.38, 0.305], 'metalDark', 0.006), b(0.34, 0.07, 0.02, [0.46, 0.2, 0.305], 'metalDark', 0.006),
    b(0.62, 0.34, 0.025, [0, 0.76, 0.22], 'dark', 0.01), b(0.56, 0.28, 0.01, [0, 0.76, 0.2], 'screen', 0.004), b(0.06, 0.12, 0.05, [0, 0.55, 0.22], 'metalDark', 0.01), b(0.22, 0.015, 0.14, [0, 0.49, 0.2], 'metalDark', 0.006),
    b(0.4, 0.018, 0.13, [-0.1, 0.489, -0.08], 'metal', 0.007), b(0.06, 0.02, 0.09, [0.28, 0.49, -0.08], 'metal', 0.008), c(0.04, 0.04, 0.08, [-0.55, 0.5, 0.1], 'lemon'),
  ] });
  add({ name: 'chair', parts: [
    b(0.38, 0.06, 0.38, [0, 0.19, -0.5], 'cushion', 0.02), b(0.36, 0.34, 0.05, [0, 0.4, -0.68], 'cushion', 0.02), c(0.025, 0.025, 0.14, [0, 0.1, -0.5], 'metalDark', 6),
    b(0.34, 0.03, 0.03, [0, 0.025, -0.5], 'metalDark', 0.008), b(0.03, 0.03, 0.34, [0, 0.025, -0.5], 'metalDark', 0.008),
  ] });
  // Reception desk (Conversation): wider and lower, with an amber front strip and a standing sign plate.
  add({ name: 'counter', parts: [
    b(1.9, 0.05, 0.8, [0, 0.455, 0], 'wood', 0.015), b(1.9, 0.43, 0.04, [0, 0.215, 0.38], 'woodDark', 0.012), b(1.9, 0.43, 0.04, [0, 0.215, -0.38], 'woodDark', 0.012), b(1.7, 0.03, 0.03, [0, 0.36, -0.4], 'amber', 0.006), b(0.05, 0.43, 0.7, [-0.9, 0.215, 0], 'woodDark', 0.012), b(0.05, 0.43, 0.7, [0.9, 0.215, 0], 'woodDark', 0.012),
    b(1.7, 0.03, 0.03, [0, 0.36, 0.4], 'amber', 0.006), b(0.62, 0.34, 0.025, [-0.4, 0.76, 0.22], 'dark', 0.01), b(0.56, 0.28, 0.01, [-0.4, 0.76, 0.2], 'screen', 0.004), b(0.06, 0.12, 0.05, [-0.4, 0.55, 0.22], 'metalDark', 0.01),
    b(0.34, 0.2, 0.03, [0.55, 0.57, 0.3], 'lemon', 0.01), c(0.05, 0.045, 0.1, [0.15, 0.53, 0.1], 'white'), c(0.05, 0.05, 0.12, [0.75, 0.55, 0], 'metal'),
  ] });
  // Task Board: the hero wall object. A wide display mounted on the wall with a kanban of cards and an amber frame.
  const cards = [];
  [[-1.75, 'lemon'], [-0.6, 'sky'], [0.55, 'mint'], [1.7, 'coral']].forEach(([x, m], col) => {
    cards.push(b(0.9, 0.05, 0.012, [x, 1.9, 0.112], 'line', 0.004));
    for (let r = 0; r < 4 - (col % 2); r++) cards.push(b(0.8, 0.2, 0.014, [x, 1.65 - r * 0.28, 0.112], m, 0.015));
  });
  add({ name: 'board', parts: [
    b(5.2, 2.1, 0.1, [0, 1.5, 0.02], 'dark', 0.04), b(4.95, 1.85, 0.03, [0, 1.5, 0.08], 'boardFace', 0.015), b(5.3, 0.04, 0.12, [0, 0.43, 0.04], 'amber', 0.01), b(5.3, 0.04, 0.12, [0, 2.57, 0.04], 'amber', 0.01),
    b(5.0, 0.4, 0.2, [0, 0.2, 0.08], 'woodDark', 0.03), ...cards,
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
    b(0.05, 0.3, 0.05, [0.34, 1.1, 0.1], 'metalDark', 0.008), b(0.16, 0.1, 0.03, [0.34, 1.26, 0.1], 'red', 0.008), b(0.46, 0.04, 0.4, [0, 0.77, 0], 'metalDark', 0.01),
  ] });
  add({ name: 'settings', parts: [
    b(1.1, 0.95, 0.12, [0, 1.15, 0], 'metalDark', 0.035), b(0.96, 0.8, 0.03, [0, 1.15, 0.07], 'boardFace', 0.015), b(0.08, 0.7, 0.08, [-0.4, 0.35, -0.02], 'metal', 0.01), b(0.08, 0.7, 0.08, [0.4, 0.35, -0.02], 'metal', 0.01),
    ...[-0.3, 0, 0.3].flatMap((x, i) => [{ g: place(cyl(0.09, 0.09, 0.05, 10), { t: [x, 1.32, 0.1], r: [90, 0, 0] }), m: 'metal' }, b(0.02, 0.1, 0.03, [x, 1.34, 0.13], 'amber', 0.004),
      b(0.12, 0.025, 0.02, [x, 1.05, 0.09], 'line', 0.005), b(0.035, 0.07, 0.03, [x + (i - 1) * 0.03, 1.05, 0.105], 'coral', 0.008), b(0.1, 0.05, 0.02, [x, 0.9, 0.09], i === 1 ? 'ledAmber' : 'ledGreen', 0.006)]),
  ] });
  add({ name: 'door', parts: [
    b(1.2, 2.4, 0.2, [0, 1.2, -0.1], 'wallTrim', 0.02), b(0.94, 2.24, 0.08, [0, 1.12, -0.08], 'wood', 0.02), b(0.74, 0.8, 0.02, [0, 1.55, -0.035], 'woodDark', 0.012), b(0.74, 0.8, 0.02, [0, 0.6, -0.035], 'woodDark', 0.012),
    b(0.04, 2.3, 0.03, [-0.52, 1.15, 0.0], 'amber', 0.008), b(0.04, 2.3, 0.03, [0.52, 1.15, 0.0], 'amber', 0.008), b(0.1, 0.03, 0.03, [0.34, 1.05, 0.0], 'metal', 0.008),
  ] });
  add({ name: 'plant', parts: [
    c(0.2, 0.15, 0.32, [0, 0.16, 0], 'pot', 10), c(0.17, 0.17, 0.03, [0, 0.32, 0], 'woodDark', 10),
    ...[[0, 0.62, 0, 0.17, 0.3, 0.17, 'green'], [-0.14, 0.55, 0.04, 0.12, 0.24, 0.12, 'greenDark'], [0.13, 0.56, -0.05, 0.13, 0.26, 0.13, 'green'], [0.03, 0.45, 0.14, 0.11, 0.2, 0.11, 'greenDark'], [-0.06, 0.78, -0.03, 0.1, 0.2, 0.1, 'green']]
      .map(([x, y, z, rx, ry, rz, m]) => ({ g: place(ball(rx, ry, rz, 8, 6), { t: [x, y, z] }), m })),
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
