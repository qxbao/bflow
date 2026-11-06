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
/** Chamfered box: 6 faces, 12 edge strips and 8 corner triangles. `r` is the bevel width; 0 gives a plain six-face box (for small, many pieces). */
function box(w, h, d, r = 0.02) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  if (r <= 0) {
    const V = (sx, sy, sz) => [sx * hx, sy * hy, sz * hz];
    return orient([[0, 1, 2], [1, 2, 0], [2, 0, 1]].flatMap(([a, b2, c2]) => [-1, 1].map(s => {
      const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const p = []; p[a] = s; p[b2] = u; p[c2] = v; return V(p[0], p[1], p[2]); });
      return { v: q };
    })));
  }
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
  g.material('shirt', '#f7f5ef', { rough: 0.6 });
  g.material('tie', '#a3192b', { rough: 0.45 });
  g.material('lapel', '#1b2436', { rough: 0.5 });
  g.material('lips', '#d4677a', { rough: 0.5 });
  g.material('frame', '#141416', { rough: 0.35 });
  g.material('vest', '#18191d', { rough: 0.55 });
  g.material('logo', '#f2c230', { rough: 0.4, emissive: '#3a2a04' });
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
        // Two dress-up children of the shin: `pants_<k>`, the trouser leg (default), and `calf_<k>`, a bare lower leg under shorts.
        { name: `shin_${k}`, t: [0, -0.135, 0], parts: [{ g: place(box(0.105, 0.05, 0.15, 0.02), { t: [0, -0.2, 0.025] }), m: 'shoe' }], children: [
          { name: `pants_${k}`, parts: [limb(0.09, 0.19, 0.1, -0.085, 'trousers')] },
          { name: `calf_${k}`, parts: [limb(0.075, 0.19, 0.08, -0.085, 'skin')] },
        ] },
      ] },
    ];
  };
  // Each arm has three dress-up children: `sleeve_<k>` in the outfit colour (default), `bare_<k>`, a skin arm for a sleeveless top or a T-shirt, and
  // `tsleeve_<k>`, the short T-shirt sleeve worn over the bare arm.
  const arm = k => {
    const x = k === 'l' ? -1 : 1;
    return { name: `arm_${k}`, t: [x * 0.2, 0.25, 0], parts: [{ g: place(ball(0.05, 0.05, 0.05, 8, 6), { t: [0, -0.215, 0] }), m: 'skin' }], children: [
      { name: `sleeve_${k}`, parts: [limb(0.085, 0.2, 0.09, -0.09, 'outfit', 0.03)] },
      { name: `bare_${k}`, parts: [limb(0.07, 0.2, 0.075, -0.09, 'skin', 0.03)] },
      { name: `tsleeve_${k}`, parts: [limb(0.095, 0.085, 0.1, -0.03, 'outfit', 0.03)] },
    ] };
  };
  // Three dress-up hair styles under the head (the scene shows one): `hair_short` (dome with a straight fringe, the default), `hair_spiky`
  // (a close cap with spikes standing up) and `hair_long` (dome, side-swept fringe, locks framing the face and long hair down the back).
  const spike = (t, r) => ({ g: place(cyl(0, 0.07, 0.17, 6), { t, r }), m: 'hair' });
  const hair = [
    { name: 'hair_short', parts: [
      { g: place(ball(0.25, 0.19, 0.235, 14, 7), { t: [0, 0.255, -0.03] }), m: 'hair' },
      { g: place(box(0.34, 0.045, 0.04, 0.015), { t: [0, 0.31, 0.175] }), m: 'hair' },
    ] },
    { name: 'hair_spiky', parts: [
      { g: place(ball(0.245, 0.16, 0.23, 14, 7), { t: [0, 0.27, -0.03] }), m: 'hair' },
      spike([0, 0.45, -0.02], [0, 0, 0]), spike([-0.1, 0.43, 0.04], [12, 0, 25]), spike([0.1, 0.43, 0.04], [12, 0, -25]), spike([0, 0.43, 0.11], [28, 0, 0]),
      spike([-0.08, 0.42, -0.12], [-22, 0, 20]), spike([0.08, 0.42, -0.12], [-22, 0, -20]), spike([-0.18, 0.37, -0.03], [0, 0, 48]), spike([0.18, 0.37, -0.03], [0, 0, -48]),
    ] },
    { name: 'hair_long', parts: [
      { g: place(ball(0.255, 0.2, 0.24, 14, 7), { t: [0, 0.255, -0.03] }), m: 'hair' },
      // fringe parted in the middle, sweeping down to either side
      ...[-1, 1].map(x => ({ g: place(box(0.17, 0.06, 0.05, 0.02), { t: [x * 0.085, 0.31, 0.172], r: [0, 0, x * -16] }), m: 'hair' })),
      ...[-1, 1].map(x => ({ g: place(box(0.075, 0.36, 0.15, 0.03), { t: [x * 0.215, 0.1, 0.03] }), m: 'hair' })),
      { g: place(box(0.42, 0.38, 0.12, 0.05), { t: [0, 0.09, -0.15] }), m: 'hair' },
      { g: place(ball(0.2, 0.06, 0.06, 10, 6), { t: [0, -0.1, -0.15] }), m: 'hair' },
    ] },
    // Large round black glasses: a thin rim of fourteen short bars round each eye, a bridge and temples back to the ears.
    { name: 'glasses', parts: [
      ...[-1, 1].flatMap(x => Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2, r = 0.076;
        return { g: place(box(0.036, 0.008, 0.008, 0), { t: [x * 0.09 + r * Math.cos(a), 0.155 + r * Math.sin(a), 0.236], r: [0, 0, (a * 180) / Math.PI + 90] }), m: 'frame' };
      })),
      { g: place(box(0.03, 0.008, 0.008, 0), { t: [0, 0.165, 0.236] }), m: 'frame' },
      ...[-1, 1].map(x => ({ g: place(box(0.007, 0.007, 0.2, 0), { t: [x * 0.18, 0.16, 0.13], r: [0, x * 18, 0] }), m: 'frame' })),
    ] },
    // Feminine face details (lashes and lips), shown with `hair_long`.
    { name: 'face_f', parts: [
      ...[-1, 1].map(x => ({ g: place(box(0.06, 0.014, 0.014, 0.004), { t: [x * 0.088, 0.203, 0.205] }), m: 'eye' })),
      { g: place(ball(0.035, 0.014, 0.012, 8, 6), { t: [0, 0.075, 0.175] }), m: 'lips' },
    ] },
  ];
  const root = g.node({
    name: 'character', s: [1.6, 1.6, 1.6],
    children: [{
      name: 'hips', t: [0, 0.365, 0], parts: [{ g: box(0.27, 0.11, 0.19, 0.03), m: 'trousers' }],
      children: [
        ...side('l'), ...side('r'),
        {
          // Blocky body in the role colour. Two dress-up children: `hoodie` (front pocket, hood ridge, name-tag plate; no text in the model) is shown by
          // default, `suit` (lapels over a shirt, a tie, collar and pocket square) replaces it for a suited role; the scene picks one per character.
          name: 'torso', t: [0, 0.05, 0], parts: [limb(0.32, 0.27, 0.22, 0.135, 'outfit', 0.06)],
          children: [
            { name: 'hoodie', parts: [
              { g: place(box(0.2, 0.07, 0.03, 0.012), { t: [0, 0.06, 0.115] }), m: 'accent' },
              { g: place(box(0.22, 0.09, 0.08, 0.03), { t: [0, 0.29, -0.09] }), m: 'outfit' },
              { g: place(box(0.095, 0.05, 0.016, 0.006), { t: [0.075, 0.2, 0.113] }), m: 'tag' },
            ] },
            // `tank` (a sleeveless top): bare shoulders and a scoop neck over the outfit torso, worn with the `bare_<k>` arms.
            { name: 'tank', parts: [
              ...[-1, 1].map(x => ({ g: place(box(0.075, 0.03, 0.226, 0.01), { t: [x * 0.124, 0.262, 0] }), m: 'skin' })),
              { g: place(box(0.13, 0.06, 0.014, 0.006), { t: [0, 0.24, 0.111] }), m: 'skin' },
              { g: place(box(0.13, 0.04, 0.014, 0.006), { t: [0, 0.25, -0.111] }), m: 'skin' },
            ] },
            // `dress_shirt`: a white business shirt over the outfit torso (the scene colours the outfit white), worn with the long `sleeve_<k>`:
            // a turned-down collar, a button placket and a breast pocket.
            { name: 'dress_shirt', parts: [
              ...[-1, 1].map(x => ({ g: place(box(0.075, 0.04, 0.016, 0.006), { t: [x * 0.045, 0.262, 0.114], r: [0, 0, x * -28] }), m: 'shirt' })),
              { g: place(box(0.06, 0.04, 0.014, 0.005), { t: [0, 0.245, 0.111] }), m: 'skin' },
              { g: place(box(0.022, 0.2, 0.012, 0.004), { t: [0, 0.13, 0.112] }), m: 'shirt' },
              ...[0.2, 0.15, 0.1, 0.05].map(y => ({ g: place(ball(0.008, 0.008, 0.005, 6, 4), { t: [0, y, 0.12] }), m: 'lapel' })),
              { g: place(box(0.06, 0.05, 0.01, 0.004), { t: [0.08, 0.17, 0.113] }), m: 'shirt' },
              { g: place(box(0.3, 0.06, 0.2, 0.025), { t: [0, 0.272, -0.02] }), m: 'shirt' },
            ] },
            // `vest`: a black waistcoat over the `dress_shirt`, open in a V at the neck so the collar and placket show, with a row of buttons.
            { name: 'vest', parts: [
              { g: place(box(0.3, 0.17, 0.016, 0.006), { t: [0, 0.095, 0.121] }), m: 'vest' },
              ...[-1, 1].map(x => ({ g: place(box(0.1, 0.1, 0.016, 0.006), { t: [x * 0.1, 0.215, 0.121], r: [0, 0, x * 12] }), m: 'vest' })),
              { g: place(box(0.3, 0.25, 0.016, 0.006), { t: [0, 0.13, -0.121] }), m: 'vest' },
              ...[-1, 1].map(x => ({ g: place(box(0.016, 0.25, 0.23, 0.006), { t: [x * 0.163, 0.13, 0] }), m: 'vest' })),
              ...[0.16, 0.115, 0.07, 0.025].map(y => ({ g: place(ball(0.009, 0.009, 0.005, 6, 4), { t: [0, y, 0.131] }), m: 'logo' })),
            ] },
            // `tshirt`: a crew neck and a small logo on the left chest over the outfit torso, worn with the bare arms and `tsleeve_<k>`.
            { name: 'tshirt', parts: [
              { g: place(box(0.12, 0.03, 0.014, 0.006), { t: [0, 0.258, 0.111] }), m: 'skin' },
              { g: place(box(0.15, 0.016, 0.016, 0.006), { t: [0, 0.24, 0.112] }), m: 'outfit' },
              { g: place(box(0.03, 0.022, 0.01, 0.003), { t: [0.072, 0.2, 0.114] }), m: 'logo' }, { g: place(box(0.022, 0.03, 0.01, 0.003), { t: [0.088, 0.172, 0.114] }), m: 'logo' },
              { g: place(box(0.02, 0.02, 0.01, 0.003), { t: [0.058, 0.176, 0.114] }), m: 'tag' },
            ] },
            { name: 'suit', parts: [
              { g: place(box(0.11, 0.17, 0.012, 0.004), { t: [0, 0.19, 0.112] }), m: 'shirt' },
              ...[-1, 1].map(x => ({ g: place(box(0.03, 0.035, 0.012, 0.004), { t: [x * 0.03, 0.262, 0.116], r: [0, 0, x * -35] }), m: 'shirt' })),
              ...[-1, 1].map(x => ({ g: place(box(0.06, 0.19, 0.014, 0.005), { t: [x * 0.052, 0.17, 0.118], r: [0, 0, x * -20] }), m: 'lapel' })),
              { g: place(box(0.038, 0.032, 0.016, 0.006), { t: [0, 0.246, 0.124] }), m: 'tie' },
              { g: place(box(0.042, 0.13, 0.012, 0.004), { t: [0, 0.165, 0.123] }), m: 'tie' },
              { g: place(box(0.03, 0.03, 0.012, 0.004), { t: [0, 0.1, 0.123], r: [0, 0, 45] }), m: 'tie' },
              ...[0.055, 0.095].map(y => ({ g: place(ball(0.011, 0.011, 0.007, 8, 6), { t: [0, y, 0.114] }), m: 'lapel' })),
              { g: place(box(0.05, 0.022, 0.01, 0.003), { t: [0.1, 0.205, 0.116] }), m: 'shirt' },
              { g: place(box(0.24, 0.06, 0.08, 0.025), { t: [0, 0.272, -0.075] }), m: 'outfit' },
            ] },
            arm('l'), arm('r'),
            { name: 'paper', t: [0, 0.07, 0.19], r: [-12, 0, 0], parts: [{ g: box(0.22, 0.28, 0.014, 0.004), m: 'paper' }] },
            {
              // Oversized round head; the hair styles are dress-up children.
              name: 'head', t: [0, 0.27, 0], s: [1.12, 1.12, 1.12],
              parts: [
                { g: place(ball(0.235, 0.215, 0.215, 14, 10), { t: [0, 0.2, 0] }), m: 'skin' },
                { g: place(ball(0.034, 0.046, 0.024, 8, 6), { t: [-0.085, 0.15, 0.2] }), m: 'eye' },
                { g: place(ball(0.034, 0.046, 0.024, 8, 6), { t: [0.085, 0.15, 0.2] }), m: 'eye' },
              ],
              children: hair,
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
  // Standing leisure clips of the Creative Space and the pool: a relaxed stand, leaning over a game (arcade buttons, a billiard shot)
  // and treading water.
  const standing = (extra = {}) => ({
    hips: { t: [0, STAND_Y, 0], r: [0, 0, 0] }, thigh_l: { r: [0, 0, 0] }, thigh_r: { r: [0, 0, 0] }, shin_l: { r: [0, 0, 0] }, shin_r: { r: [0, 0, 0] },
    arm_l: { r: [-4, 0, -6] }, arm_r: { r: [-4, 0, 6] }, head: { r: [0, 0, 0] }, torso: { r: [0, 0, 0] }, ...extra,
  });
  clip('stand', 3.0, (s, k) => merge(standing(), { hips: { t: [0, STAND_Y + 0.004 * s, 0], r: [0, 3 * s, 0] }, head: { r: [0, 18 * s, 0] }, arm_l: { r: [-4 + 3 * k, 0, -6] }, arm_r: { r: [-4 - 3 * k, 0, 6] } }));
  clip('play', 0.6, (s, k) => merge(standing(), {
    hips: { t: [0, STAND_Y - 0.012, 0] }, thigh_l: { r: [-8, 0, 0] }, thigh_r: { r: [-8, 0, 0] }, shin_l: { r: [14, 0, 0] }, shin_r: { r: [14, 0, 0] },
    torso: { r: [16, 0, 0] }, head: { r: [-10, 4 * s, 0] }, arm_l: { r: [-74 + 8 * s, 0, 6] }, arm_r: { r: [-74 - 8 * s, 0, -6] },
  }), 4);
  clip('swim', 1.6, (s, k) => merge(standing(), {
    hips: { t: [0, STAND_Y + 0.02 * s, 0] }, thigh_l: { r: [-20 * s, 0, 0] }, thigh_r: { r: [20 * s, 0, 0] }, shin_l: { r: [12, 0, 0] }, shin_r: { r: [12, 0, 0] },
    head: { r: [-4, 10 * k, 0] }, arm_l: { r: [-30 + 12 * s, 0, -58 - 14 * k] }, arm_r: { r: [-30 + 12 * s, 0, 58 + 14 * k] },
  }));
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
  M('cushionLight', '#5fb0ab', { rough: 0.9 }); M('chairSeat', '#3b4048', { rough: 0.7 }); M('chairMesh', '#5a6270', { rough: 0.85 }); M('greenLight', '#7ac96b'); M('key', '#e9e9ee', { rough: 0.6 }); M('panel', '#f4f0e6', { rough: 0.9 }); M('panelCap', '#fbf9f3', { rough: 0.8 });
  M('rug', '#e0a458', { rough: 1 }); M('rugInner', '#f3dcae', { rough: 1 }); M('paper', P.paper); M('skyPane', '#9fd4f5', { rough: 0.2, emissive: '#5c9fcf' }); M('waterBlue', '#9fd3f0', { rough: 0.2, emissive: '#2c5d7d' });
  M('bookRed', '#d9534f'); M('bookBlue', '#3d6fb5'); M('bookGreen', '#4aa66a'); M('bookYellow', '#f0c43c');
  // Conversation office (the chairman's room): walnut, brass, leather, marble and a deep red rug.
  M('walnut', '#6e4529', { rough: 0.55 }); M('walnutDark', '#432a1a', { rough: 0.6 }); M('gold', '#d6aa4c', { rough: 0.3, metal: 0.65, emissive: '#3a2a08' });
  M('leather', '#4f2a1f', { rough: 0.45 }); M('leatherDark', '#2f1813', { rough: 0.5 }); M('cognac', '#9a5530', { rough: 0.5 }); M('cognacLight', '#b4703f', { rough: 0.55 });
  M('marble', '#f1ede6', { rough: 0.22 }); M('marbleVein', '#c8c1b4', { rough: 0.3 }); M('china', '#f8f6f1', { rough: 0.25 }); M('leatherGreen', '#2f5a45', { rough: 0.5 });
  M('lampGreen', '#2f7a52', { rough: 0.35, emissive: '#1d4d33' }); M('ocean', '#2f5f8f', { rough: 0.4 }); M('rugLux', '#7d2a33', { rough: 1 }); M('rugGold', '#c99a4e', { rough: 1 }); M('rugCream', '#ecdfc4', { rough: 1 }); M('bronze', '#8a6a3a', { rough: 0.4, metal: 0.5 });
  // Director Team black leather and chrome; Developer red plastic stools; the Creative Space games and bar; the pool.
  M('blackLeather', '#232428', { rough: 0.38 }); M('blackLeatherDark', '#111215', { rough: 0.45 }); M('chrome', '#c9ced6', { rough: 0.22, metal: 0.8 });
  M('plasticRed', '#d8322a', { rough: 0.42 }); M('plasticRedDark', '#9e1f1a', { rough: 0.5 });
  M('felt', '#1f7a4d', { rough: 0.95 }); M('feltDark', '#165c39', { rough: 0.95 }); M('ttBlue', '#2b5fa8', { rough: 0.6 }); M('net', '#f2f2ee', { rough: 0.8 });
  M('glassTint', '#bfe0e6', { rough: 0.15, emissive: '#2a4a52' }); M('bottleGreen', '#2f6b3a', { rough: 0.2, emissive: '#10301a' }); M('bottleAmber', '#9a5a1c', { rough: 0.2, emissive: '#3a1e06' });
  M('bottleClear', '#d7ecef', { rough: 0.15, emissive: '#3c5a60' }); M('wineRed', '#6a1c2a', { rough: 0.2, emissive: '#2a0810' });
  M('neonPink', '#c43a8a', { rough: 0.45, emissive: '#4a0f32' }); M('neonTeal', '#1f8f9a', { rough: 0.45, emissive: '#0b3a40' });
  M('arcadeScreen', '#7fe0ff', { rough: 0.2, emissive: '#3fa8d8' }); M('marqueeA', '#ffd34d', { rough: 0.3, emissive: '#c98f12' }); M('marqueeB', '#ff7ab8', { rough: 0.3, emissive: '#c2397a' });
  M('poolTile', '#eef4f5', { rough: 0.5 }); M('poolCap', '#d9e3e6', { rough: 0.45 }); M('water', '#39b6e0', { rough: 0.1, emissive: '#1a6f96' }); M('laneBlue', '#1d5f9a', { rough: 0.3, emissive: '#0d3456' });
  M('laneRope', '#f2d479', { rough: 0.5, emissive: '#5c4d1c' }); M('boardBlue', '#3a7fd0', { rough: 0.5 });
  M('bookNavy', '#2a3d66'); M('bookBurgundy', '#7a2333'); M('bookForest', '#2e5a3e'); M('bookTan', '#b08a5a'); M('bookBlack', '#2a2522');
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

  // Desk for a 1.7 high character: top at 0.73. `desk` carries a low laptop (its back, a glowing dot, faces the camera) so the face stays visible;
  // `desk_pc` (Developer zone) carries a desktop PC instead: a monitor kept low enough (top 1.2) that the camera still sees the seated face over it,
  // and a tower on the floor under the open side of the desk.
  const deskFrame = [
    b(1.5, 0.05, 0.74, [0, 0.705, 0], 'wood', 0.015), b(1.5, 0.014, 0.02, [0, 0.665, 0.36], 'amberSoft', 0.004),
    b(0.05, 0.68, 0.68, [-0.69, 0.34, 0], 'woodDark', 0.012), b(0.05, 0.68, 0.68, [0.69, 0.34, 0], 'woodDark', 0.012), b(1.34, 0.4, 0.03, [0, 0.45, 0.3], 'woodDark', 0.01),
    b(0.4, 0.46, 0.62, [0.46, 0.43, 0], 'woodDark', 0.015), b(0.34, 0.1, 0.02, [0.46, 0.56, 0.315], 'metalDark', 0.006), b(0.34, 0.1, 0.02, [0.46, 0.3, 0.315], 'metalDark', 0.006),
  ];
  add({ name: 'desk', parts: [
    ...deskFrame,
    // laptop: base, and a lid tilted back towards the seated character (the -z side)
    b(0.5, 0.025, 0.34, [0, 0.743, 0.02], 'metalDark', 0.01),
    { g: place(box(0.5, 0.3, 0.02, 0.008), { t: [0, 0.9, 0.16], r: [-14, 0, 0] }), m: 'metalDark' },
    { g: place(box(0.45, 0.25, 0.01, 0.004), { t: [0, 0.9, 0.148], r: [-14, 0, 0] }), m: 'screen' },
    { g: place(box(0.07, 0.07, 0.008, 0.002), { t: [0, 0.9, 0.172], r: [-14, 0, 0] }), m: 'lamp' },
    b(0.14, 0.012, 0.1, [0.3, 0.737, -0.06], 'metal', 0.004), c(0.05, 0.05, 0.1, [-0.5, 0.78, 0.0], 'lemon'),
    ...keyboard(-0.02, 0.73, -0.27, 0.36),
  ] });
  add({ name: 'desk_pc', parts: [
    ...deskFrame,
    // monitor: foot, neck and a slightly tilted panel whose screen faces the seated character (-z); its back, with a glowing dot, faces the camera
    b(0.26, 0.012, 0.18, [0, 0.736, 0.2], 'metalDark', 0.005), b(0.05, 0.2, 0.03, [0, 0.83, 0.24], 'metalDark', 0.008),
    { g: place(box(0.66, 0.38, 0.035, 0.01), { t: [0, 1.0, 0.205], r: [-6, 0, 0] }), m: 'dark' },
    { g: place(box(0.61, 0.33, 0.01, 0.003), { t: [0, 1.0, 0.184], r: [-6, 0, 0] }), m: 'screen' },
    { g: place(box(0.06, 0.06, 0.008, 0.002), { t: [0, 1.04, 0.227], r: [-6, 0, 0] }), m: 'lamp' },
    // tower under the open (left) side of the desk: front with power LED towards the chair, a blue light strip on the camera side
    b(0.2, 0.46, 0.46, [-0.43, 0.23, -0.02], 'dark', 0.015), b(0.03, 0.03, 0.01, [-0.43, 0.4, -0.255], 'ledGreen', 0.004), b(0.12, 0.012, 0.01, [-0.43, 0.32, -0.255], 'metal', 0.003),
    b(0.012, 0.36, 0.012, [-0.43, 0.23, 0.215], 'sky', 0.003),
    b(0.14, 0.012, 0.1, [0.42, 0.737, -0.02], 'metal', 0.004), c(0.05, 0.05, 0.1, [-0.56, 0.78, 0.05], 'lemon'),
    ...keyboard(-0.02, 0.73, -0.2, 0.36),
  ] });
  // `desk_dual` (QA / Reviewer): the same PC with two monitors side by side, each turned 10 deg towards the seated character, kept as low as `desk_pc`.
  const monitor = (x, ry) => {
    const t = (rad => (d, y) => [x + d * Math.sin(rad), y, 0.205 + d * Math.cos(rad)])((ry * Math.PI) / 180);
    return [
      b(0.2, 0.012, 0.16, [x, 0.736, 0.2], 'metalDark', 0.005), b(0.04, 0.2, 0.03, [x, 0.83, 0.24], 'metalDark', 0.008),
      { g: place(box(0.52, 0.32, 0.035, 0.01), { t: t(0, 1.0), r: [-6, ry, 0] }), m: 'dark' },
      { g: place(box(0.48, 0.28, 0.01, 0.003), { t: t(-0.021, 1.0), r: [-6, ry, 0] }), m: 'screen' },
      { g: place(box(0.05, 0.05, 0.008, 0.002), { t: t(0.022, 1.04), r: [-6, ry, 0] }), m: 'lamp' },
    ];
  };
  add({ name: 'desk_dual', parts: [
    ...deskFrame, ...monitor(-0.27, -10), ...monitor(0.27, 10),
    b(0.2, 0.46, 0.46, [-0.43, 0.23, -0.02], 'dark', 0.015), b(0.03, 0.03, 0.01, [-0.43, 0.4, -0.255], 'ledGreen', 0.004), b(0.12, 0.012, 0.01, [-0.43, 0.32, -0.255], 'metal', 0.003),
    b(0.012, 0.36, 0.012, [-0.43, 0.23, 0.215], 'sky', 0.003),
    b(0.14, 0.012, 0.1, [0.42, 0.737, -0.06], 'metal', 0.004), b(0.22, 0.012, 0.3, [-0.52, 0.736, -0.12], 'paper', 0.003),
    ...keyboard(-0.02, 0.73, -0.24, 0.36),
  ] });
  // Chair (seat on the -z side of the desk): low seat, tall back, swivel base.
  add({ name: 'chair', parts: [
    b(0.5, 0.07, 0.5, [0, 0.31, -0.62], 'cushion', 0.025), b(0.46, 0.5, 0.06, [0, 0.62, -0.88], 'cushion', 0.025), c(0.03, 0.03, 0.2, [0, 0.19, -0.62], 'metalDark', 6),
    b(0.46, 0.035, 0.04, [0, 0.04, -0.62], 'metalDark', 0.008), b(0.04, 0.035, 0.46, [0, 0.04, -0.62], 'metalDark', 0.008),
  ] });
  // Executive desk (Conversation, node `counter`): 2.3 x 1.0 walnut with brass trim, a green leather inlay, drawer pedestals and a raised front panel.
  // The seat is on the -z side, so the low laptop, the banker's lamp and the name plate leave the face visible from the camera.
  const TOP = 0.76;
  add({ name: 'counter', parts: [
    b(2.3, 0.06, 1.0, [0, TOP - 0.03, 0], 'walnut', 0.02), b(2.3, 0.02, 0.012, [0, TOP - 0.045, 0.505], 'gold', 0.004), b(1.7, 0.008, 0.6, [0, TOP + 0.004, -0.1], 'leatherGreen', 0.002),
    b(2.24, 0.04, 0.96, [0, 0.02, 0], 'walnutDark', 0.01), b(2.26, 0.014, 0.014, [0, 0.045, 0.48], 'gold', 0.004),
    ...[-1, 1].flatMap(s => [
      b(0.55, 0.66, 0.92, [s * 0.85, 0.37, 0], 'walnutDark', 0.015),
      ...[0.17, 0.39, 0.6].flatMap(y => [b(0.48, 0.19, 0.02, [s * 0.85, y, 0.465], 'walnut', 0.01), b(0.14, 0.022, 0.022, [s * 0.85, y + 0.03, 0.485], 'gold', 0.008)]),
    ]),
    b(1.16, 0.56, 0.04, [0, 0.42, 0.44], 'walnutDark', 0.012), b(1.0, 0.4, 0.02, [0, 0.42, 0.465], 'walnut', 0.008), b(1.04, 0.012, 0.012, [0, 0.64, 0.47], 'gold', 0.003), b(1.04, 0.012, 0.012, [0, 0.2, 0.47], 'gold', 0.003),
    { g: place(cyl(0.06, 0.06, 0.012, 14), { t: [0, 0.42, 0.478], r: [90, 0, 0] }), m: 'gold' },
    // laptop: base, and a lid tilted back towards the seated character (the -z side)
    b(0.5, 0.025, 0.34, [-0.1, TOP + 0.013, 0.02], 'metalDark', 0.01),
    { g: place(box(0.5, 0.3, 0.02, 0.008), { t: [-0.1, TOP + 0.17, 0.18], r: [-14, 0, 0] }), m: 'metalDark' }, { g: place(box(0.45, 0.25, 0.01, 0.004), { t: [-0.1, TOP + 0.17, 0.168], r: [-14, 0, 0] }), m: 'screen' },
    ...keyboard(-0.1, TOP, -0.3, 0.34),
    // banker's lamp
    c(0.08, 0.09, 0.03, [0.78, TOP + 0.015, 0.15], 'gold', 12), c(0.012, 0.012, 0.3, [0.78, TOP + 0.17, 0.15], 'gold', 6), b(0.32, 0.075, 0.14, [0.78, TOP + 0.33, 0.15], 'lampGreen', 0.035), b(0.27, 0.01, 0.1, [0.78, TOP + 0.29, 0.15], 'lamp', 0.003),
    // name plate on the front edge, papers, pen cup, tea cup and a small desk globe
    { g: place(box(0.36, 0.08, 0.04, 0.008), { t: [0.38, TOP + 0.04, 0.4], r: [-20, 0, 0] }), m: 'walnutDark' }, { g: place(box(0.32, 0.05, 0.01, 0.003), { t: [0.38, TOP + 0.042, 0.42], r: [-20, 0, 0] }), m: 'gold' },
    b(0.3, 0.012, 0.4, [0.42, TOP + 0.006, -0.18], 'paper', 0.003), b(0.28, 0.01, 0.38, [0.45, TOP + 0.017, -0.16], 'white', 0.003),
    c(0.035, 0.035, 0.1, [-0.7, TOP + 0.05, -0.2], 'gold', 10), c(0.006, 0.006, 0.14, [-0.71, TOP + 0.1, -0.2], 'ink', 4), c(0.006, 0.006, 0.13, [-0.69, TOP + 0.09, -0.21], 'red', 4),
    c(0.06, 0.06, 0.008, [0.75, TOP + 0.004, -0.25], 'china', 12), c(0.04, 0.032, 0.06, [0.75, TOP + 0.038, -0.25], 'china', 12),
    c(0.06, 0.07, 0.03, [-0.85, TOP + 0.015, 0.25], 'gold', 10), c(0.012, 0.012, 0.1, [-0.85, TOP + 0.08, 0.25], 'gold', 6), bl(0.1, 0.1, 0.1, [-0.85, TOP + 0.21, 0.25], 'ocean', 12, 8),
    bl(0.04, 0.03, 0.035, [-0.8, TOP + 0.25, 0.32], 'greenDark', 8, 6), bl(0.035, 0.035, 0.03, [-0.9, TOP + 0.18, 0.31], 'greenDark', 8, 6), c(0.11, 0.11, 0.012, [-0.85, TOP + 0.21, 0.25], 'gold', 14),
  ] });
  // Executive chair for the counter seat (origin at the desk centre like `chair`): tall tufted leather back, brass crown, armrests and a five-star base.
  // The back stands 0.44 further back than the plain chair so the large head clears it.
  const ZC = -0.62, BACK_R = [-7, 0, 0], qBack = euler(BACK_R);
  /**
   * The executive chair in a leather, its darker piping and tufts, and a trim metal (crown, arm posts, column and five-star base). `backH` is the
   * height of the back; its bottom stays on the seat.
   */
  const execChair = (leather, dark, trim, backH = 1.36) => {
    const k = backH / 1.36, centre = [0, 0.34 + backH / 2, ZC - 0.44];
    const onBack = (w, h, d, l, m, r = 0.02) => { const o = rotate(qBack, l); return { g: place(box(w, h, d, r), { t: [centre[0] + o[0], centre[1] + o[1], centre[2] + o[2]], r: BACK_R }), m }; };
    return [
      onBack(0.7, backH, 0.16, [0, 0, 0], leather, 0.07), onBack(0.76, 0.05, 0.19, [0, backH / 2 + 0.01, 0], trim, 0.012),
      ...[-1, 1].map(s => onBack(0.03, backH - 0.06, 0.17, [s * 0.355, 0, 0], k < 1 ? trim : dark, 0.01)),
      ...[-0.38, -0.12, 0.14, 0.4].flatMap((y, row) => [-0.22, 0, 0.22].map(x => onBack(0.028, 0.028, 0.014, [x + (row % 2 ? 0.11 : 0) * (x > 0 ? -1 : x < 0 ? 1 : 0), y * k, 0.083], dark, 0))),
      b(0.68, 0.13, 0.68, [0, 0.28, ZC - 0.1], leather, 0.05), { g: place(cyl(0.065, 0.065, 0.68, 10), { t: [0, 0.28, ZC + 0.24], r: [0, 0, 90] }), m: leather },
      ...[-1, 1].flatMap(s => [b(0.05, 0.24, 0.05, [s * 0.43, 0.45, ZC - 0.05], trim, 0.01), b(0.1, 0.06, 0.5, [s * 0.43, 0.6, ZC - 0.1], dark, 0.025)]),
      c(0.035, 0.035, 0.16, [0, 0.135, ZC - 0.1], trim, 8),
      ...[0, 1, 2, 3, 4].flatMap(n => {
        const a = n * 72 + 18, rad = (a * Math.PI) / 180, cx = Math.cos(rad), cz = Math.sin(rad);
        return [{ g: place(box(0.34, 0.035, 0.05, 0.01), { t: [0.17 * cx, 0.055, ZC - 0.1 + 0.17 * cz], r: [0, -a, 0] }), m: trim }, bl(0.03, 0.03, 0.03, [0.33 * cx, 0.03, ZC - 0.1 + 0.33 * cz], 'ink', 8, 6)];
      }),
    ];
  };
  add({ name: 'exec_chair', parts: execChair('leather', 'leatherDark', 'gold') });
  // Director Team desk chair: the executive chair in black leather on chrome, with a lower back (top at 1.3) that frames the seated head without hiding the room.
  add({ name: 'chair_black', parts: execChair('blackLeather', 'blackLeatherDark', 'chrome', 0.96) });
  // Developer seat: a backless red plastic stool (origin at the desk centre like `chair`), seat top at the chair's height, four splayed legs with
  // cross bars and the hand slot in the seat.
  const SZ = -0.62, ST = 0.33;
  add({ name: 'stool_red', parts: [
    b(0.4, 0.045, 0.4, [0, ST, SZ], 'plasticRed', 0.06), b(0.42, 0.05, 0.42, [0, ST - 0.04, SZ], 'plasticRed', 0.03), b(0.14, 0.012, 0.04, [0, ST + 0.018, SZ], 'plasticRedDark', 0.01),
    ...[-1, 1].flatMap(sx => [-1, 1].map(sz => ({ g: place(box(0.06, 0.32, 0.06, 0.015), { t: [sx * 0.15, 0.15, SZ + sz * 0.15], r: [-sz * 7, 0, sx * 7] }), m: 'plasticRed' }))),
    ...[-1, 1].flatMap(s => [b(0.34, 0.03, 0.03, [0, 0.08, SZ + s * 0.165], 'plasticRed', 0.01), b(0.03, 0.03, 0.34, [s * 0.165, 0.08, SZ], 'plasticRed', 0.01)]),
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
  // Long meeting table of the Task Board zone (5.0 x 1.3, seated height, top at 0.74) on three trestle legs, with notebooks, cups and a speaker puck.
  // `meeting_chair` stands around it: its sitter faces +z, the back is on the -z side.
  const MT = 0.74;
  add({ name: 'table', parts: [
    b(5.0, 0.06, 1.3, [0, MT - 0.03, 0], 'wood', 0.025), b(4.9, 0.03, 1.2, [0, MT - 0.075, 0], 'woodDark', 0.01), b(5.04, 0.014, 0.02, [0, MT - 0.05, 0.66], 'amberSoft', 0.004), b(5.04, 0.014, 0.02, [0, MT - 0.05, -0.66], 'amberSoft', 0.004),
    ...[-1.9, 0, 1.9].flatMap(x => [b(0.16, MT - 0.09, 0.16, [x, (MT - 0.09) / 2, 0], 'woodDark', 0.02), b(0.22, 0.03, 0.9, [x, 0.015, 0], 'metalDark', 0.008)]),
    c(0.13, 0.15, 0.03, [0, MT + 0.015, 0], 'dark', 14), c(0.05, 0.05, 0.006, [0, MT + 0.033, 0], 'ledGreen', 10),
    ...[-2, -1, 0, 1, 2].flatMap(k => [-1, 1].flatMap(s => [
      b(0.26, 0.012, 0.34, [k * 1.0 + s * 0.05, MT + 0.006, s * 0.36], (k + s) % 2 ? 'paper' : 'white', 0.003),
      c(0.04, 0.034, 0.08, [k * 1.0 + 0.24, MT + 0.04, s * 0.3], ['china', 'lemon', 'sky', 'coral'][(k + 2 + (s > 0 ? 1 : 0)) % 4], 10),
    ])),
  ] });
  add({ name: 'meeting_chair', parts: [
    b(0.5, 0.07, 0.48, [0, 0.43, 0.04], 'chairSeat', 0.025), b(0.48, 0.52, 0.06, [0, 0.76, -0.22], 'chairSeat', 0.03), b(0.4, 0.4, 0.02, [0, 0.77, -0.188], 'chairMesh', 0.01),
    c(0.03, 0.03, 0.34, [0, 0.23, 0.02], 'metalDark', 6),
    ...[0, 1, 2, 3, 4].flatMap(k => {
      const a = k * 72 + 18, rad = (a * Math.PI) / 180, cx = Math.cos(rad), cz = Math.sin(rad);
      return [{ g: place(box(0.26, 0.03, 0.045, 0.008), { t: [0.13 * cx, 0.045, 0.02 + 0.13 * cz], r: [0, -a, 0] }), m: 'metalDark' }, bl(0.025, 0.025, 0.025, [0.25 * cx, 0.025, 0.02 + 0.25 * cz], 'ink', 6, 4)];
    }),
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
  // Paper cabinet beside the printer (0.8 x 0.45, front +z): two doors, reams of paper and a tray of coloured folders on top.
  add({ name: 'paper_cabinet', parts: [
    b(0.8, 0.74, 0.45, [0, 0.37, 0], 'wood', 0.02), b(0.37, 0.6, 0.02, [-0.195, 0.39, 0.23], 'woodDark', 0.006), b(0.37, 0.6, 0.02, [0.195, 0.39, 0.23], 'woodDark', 0.006),
    b(0.025, 0.12, 0.025, [-0.03, 0.42, 0.25], 'metalDark', 0.005), b(0.025, 0.12, 0.025, [0.03, 0.42, 0.25], 'metalDark', 0.005),
    ...[0, 1, 2].map(i => b(0.3, 0.06, 0.21, [-0.18, 0.77 + i * 0.062, 0.02], i === 1 ? 'sky' : 'paper', 0.006)),
    b(0.34, 0.03, 0.26, [0.18, 0.755, 0], 'metalDark', 0.006), ...['coral', 'lemon', 'mint'].map((m, i) => b(0.26, 0.02, 0.22, [0.18, 0.78 + i * 0.022, 0], m, 0.004)),
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

  // ---------- the Conversation office (chairman's room) ----------
  // Wall-to-wall walnut bookcase, 2.9 x 2.6 x 0.45: three bays, closed cupboards below, four rows of books with brass bands, vases, stacks and orbs.
  // `seed` varies the rows, so the two cases flanking the statue are not copies.
  const BOOK_MATS = ['bookNavy', 'bookBurgundy', 'bookForest', 'bookTan', 'bookBlack'];
  const bookcase = seed => {
    const W = 2.9, parts = [
      b(W, 2.42, 0.03, [0, 1.33, -0.21], 'walnutDark', 0.008), b(W + 0.04, 0.14, 0.47, [0, 0.07, 0], 'walnutDark', 0.015), b(W + 0.06, 0.012, 0.012, [0, 0.142, 0.236], 'gold', 0.003),
      b(W + 0.12, 0.09, 0.5, [0, 2.585, 0.01], 'walnut', 0.02), b(W + 0.06, 0.03, 0.47, [0, 2.525, 0], 'walnutDark', 0.008), b(W + 0.08, 0.016, 0.016, [0, 2.52, 0.24], 'gold', 0.004),
      ...[-1.425, -0.475, 0.475, 1.425].flatMap(x => [b(0.05, 2.38, 0.45, [x, 1.33, 0], 'walnut', 0.01), b(0.012, 2.3, 0.012, [x, 1.33, 0.228], 'gold', 0.003)]),
      ...[0.16, 0.62, 1.08, 1.54, 2.0].map(y => b(W - 0.1, 0.04, 0.43, [0, y, 0], 'walnut', 0.008)),
    ];
    [-0.95, 0, 0.95].forEach((bx, bi) => {
      parts.push(b(0.86, 0.4, 0.025, [bx, 0.39, 0.205], 'walnut', 0.01), b(0.7, 0.28, 0.01, [bx, 0.39, 0.222], 'walnutDark', 0.004), bl(0.018, 0.018, 0.018, [bx + (bi === 1 ? 0 : -bx * 0.36), 0.42, 0.235], 'gold', 8, 6));
      [0.64, 1.1, 1.56, 2.02].forEach((y, r) => {
        const kind = (seed + r * 2 + bi) % 4, end = kind === 0 ? bx + 0.43 : bx + 0.05 - ((r + seed) % 2) * 0.12;
        let x = bx - 0.43;
        for (let i = 0; ; i++) {
          const w = 0.045 + ((i * 7 + r * 3 + seed * 5 + bi) % 4) * 0.012, h = 0.27 + ((i * 5 + r + seed * 3 + bi * 2) % 4) * 0.028;
          if (x + w > end) break;
          x += w / 2;
          parts.push(b(w, h, 0.3, [x, y + h / 2, 0], BOOK_MATS[(i * 3 + r + seed + bi) % 5], 0));
          if ((i + r + bi) % 3 === 0) parts.push(b(w * 0.8, 0.014, 0.008, [x, y + h * 0.78, 0.153], 'gold', 0));
          x += w / 2 + 0.003;
        }
        const dx = (x + bx + 0.43) / 2;
        if (kind === 1) parts.push(c(0.05, 0.07, 0.2, [dx, y + 0.1, 0], 'china', 12), c(0.035, 0.05, 0.05, [dx, y + 0.225, 0], 'china', 12), c(0.04, 0.04, 0.012, [dx, y + 0.256, 0], 'gold', 12));
        if (kind === 2) {
          for (let k = 0; k < 3; k++) parts.push(b(0.26 - k * 0.02, 0.045, 0.22, [dx, y + 0.0225 + k * 0.045, 0], BOOK_MATS[(k + seed + r) % 5], 0.005));
          parts.push(bl(0.04, 0.05, 0.04, [dx, y + 0.185, 0], 'gold', 8, 6));
        }
        if (kind === 3) parts.push(c(0.05, 0.06, 0.03, [dx, y + 0.015, 0], 'gold', 10), bl(0.09, 0.09, 0.09, [dx, y + 0.12, 0], 'ocean', 12, 8), c(0.1, 0.1, 0.01, [dx, y + 0.12, 0], 'gold', 14));
      });
    });
    return parts;
  };
  add({ name: 'bookcase_lux_w', parts: bookcase(0) });
  add({ name: 'bookcase_lux_e', parts: bookcase(1) });
  // Statue console (1.0 x 0.5, stands flush against the wall; the wall is at z -0.25): walnut table on brass legs, a marble plinth with a gilded bust,
  // and a brass-framed painting on the wall above it (below the room sign).
  add({ name: 'statue', parts: [
    b(1.0, 0.05, 0.48, [0, 0.86, 0], 'walnut', 0.015), b(1.0, 0.02, 0.012, [0, 0.845, 0.243], 'gold', 0.004), b(0.94, 0.1, 0.44, [0, 0.79, 0], 'walnutDark', 0.01),
    ...[-0.44, 0.44].flatMap(x => [-0.19, 0.19].map(z => c(0.025, 0.016, 0.74, [x, 0.37, z], 'gold', 8))), b(0.9, 0.03, 0.4, [0, 0.18, 0], 'walnutDark', 0.008),
    b(0.4, 0.03, 0.34, [0, 0.9, 0], 'marbleVein', 0.008), b(0.34, 0.3, 0.28, [0, 1.065, 0], 'marble', 0.01), b(0.38, 0.03, 0.32, [0, 1.23, 0], 'marbleVein', 0.008),
    // gilded bust: socle, broad shoulders and chest, neck, head with a nose and a laurel band
    c(0.07, 0.1, 0.08, [0, 1.285, 0], 'gold', 12), bl(0.24, 0.15, 0.13, [0, 1.42, 0], 'gold', 16, 10), b(0.3, 0.12, 0.16, [0, 1.36, 0], 'gold', 0.05),
    c(0.055, 0.06, 0.1, [0, 1.6, 0], 'gold', 10), bl(0.105, 0.13, 0.115, [0, 1.75, 0.005], 'gold', 14, 10), bl(0.02, 0.03, 0.03, [0, 1.74, 0.12], 'gold', 6, 4),
    c(0.112, 0.112, 0.025, [0, 1.81, 0], 'bronze', 16), bl(0.1, 0.05, 0.1, [0, 1.85, -0.01], 'gold', 12, 6),
    b(0.9, 0.56, 0.035, [0, 2.36, -0.23], 'gold', 0.01), b(0.78, 0.44, 0.012, [0, 2.36, -0.208], 'bookNavy', 0.003), b(0.78, 0.14, 0.014, [0, 2.21, -0.205], 'bookForest', 0.003),
    { g: place(cyl(0.07, 0.07, 0.014, 14), { t: [0.18, 2.46, -0.204], r: [90, 0, 0] }), m: 'gold' }, b(0.5, 0.05, 0.014, [-0.1, 2.3, -0.203], 'bookTan', 0.003),
  ] });
  // Long chesterfield sofa, 2.4 x 0.95: cognac leather, rolled arms and back, tufted buttons, three seat cushions, cushions and brass feet.
  add({ name: 'sofa_lux', parts: [
    b(2.4, 0.22, 0.95, [0, 0.2, 0], 'cognac', 0.04), ...[-1.1, 1.1].flatMap(x => [-0.38, 0.38].map(z => c(0.035, 0.025, 0.09, [x, 0.045, z], 'gold', 8))),
    b(2.2, 0.5, 0.22, [0, 0.58, -0.36], 'cognac', 0.06), { g: place(cyl(0.11, 0.11, 2.2, 12), { t: [0, 0.83, -0.36], r: [0, 0, 90] }), m: 'cognac' },
    ...[0.5, 0.68].flatMap((y, row) => Array.from({ length: 10 - row }, (_, i) => b(0.026, 0.026, 0.012, [-0.86 + i * 0.19 + row * 0.095, y, -0.246], 'leatherDark', 0))),
    ...[-1, 1].flatMap(s => [b(0.2, 0.42, 0.95, [s * 1.1, 0.48, 0], 'cognac', 0.04), { g: place(cyl(0.12, 0.12, 0.95, 12), { t: [s * 1.1, 0.7, 0], r: [90, 0, 0] }), m: 'cognac' }, b(0.02, 0.34, 0.01, [s * 1.1, 0.46, 0.477], 'gold', 0.003)]),
    ...[-0.67, 0, 0.67].map(x => b(0.66, 0.14, 0.68, [x, 0.38, 0.08], 'cognacLight', 0.05)),
    ...[-1, 1].map(s => ({ g: place(box(0.36, 0.32, 0.1, 0.05), { t: [s * 0.74, 0.62, -0.18], r: [-12, 0, s * 6] }), m: 'rugLux' })),
  ] });
  // Tea table, 1.0 x 0.6: marble top on a brass frame, a walnut shelf, and a tea set (tray, teapot, two cups) with a small flower vase.
  add({ name: 'tea_table', parts: [
    b(1.0, 0.04, 0.6, [0, 0.42, 0], 'marble', 0.012), b(0.6, 0.003, 0.02, [0.12, 0.4415, 0.06], 'marbleVein', 0.001), b(0.3, 0.003, 0.015, [-0.25, 0.4415, -0.12], 'marbleVein', 0.001),
    b(1.02, 0.02, 0.62, [0, 0.39, 0], 'gold', 0.006),
    ...[-0.46, 0.46].flatMap(x => [-0.26, 0.26].map(z => c(0.02, 0.02, 0.38, [x, 0.19, z], 'gold', 8))), b(0.9, 0.025, 0.5, [0, 0.1, 0], 'walnutDark', 0.008),
    b(0.5, 0.02, 0.32, [0.02, 0.45, 0], 'gold', 0.006),
    bl(0.08, 0.065, 0.08, [-0.08, 0.525, 0], 'china', 12, 8), bl(0.02, 0.02, 0.02, [-0.08, 0.6, 0], 'gold', 8, 6),
    { g: place(cyl(0.012, 0.02, 0.1, 6), { t: [0.01, 0.55, 0], r: [0, 0, -55] }), m: 'china' }, b(0.02, 0.07, 0.03, [-0.17, 0.53, 0], 'china', 0.008),
    ...[-0.08, 0.08].flatMap(z => [c(0.045, 0.045, 0.006, [0.14, 0.463, z], 'china', 12), c(0.032, 0.026, 0.045, [0.14, 0.488, z], 'china', 12)]),
    c(0.03, 0.035, 0.1, [-0.38, 0.49, 0.16], 'china', 10), bl(0.045, 0.04, 0.045, [-0.39, 0.57, 0.16], 'coral', 8, 6), bl(0.035, 0.03, 0.035, [-0.35, 0.575, 0.18], 'lemon', 8, 6), bl(0.03, 0.025, 0.03, [-0.4, 0.56, 0.13], 'greenLight', 8, 6),
  ] });
  // Deep red rug with a brass-coloured border and a cream medallion, 3.4 x 2.6.
  add({ name: 'rug_lux', parts: [
    b(3.4, 0.02, 2.6, [0, 0.01, 0], 'rugLux', 0.005), b(3.2, 0.023, 2.4, [0, 0.0115, 0], 'rugGold', 0.004), b(3.06, 0.026, 2.26, [0, 0.013, 0], 'rugLux', 0.004),
    b(1.7, 0.029, 1.1, [0, 0.0145, 0], 'rugCream', 0.004), { g: place(box(0.62, 0.032, 0.62, 0.004), { t: [0, 0.016, 0], r: [0, 45, 0] }), m: 'rugLux' },
    ...[-1, 1].flatMap(x => [-1, 1].map(z => b(0.28, 0.029, 0.28, [x * 1.3, 0.0145, z * 0.9], 'rugCream', 0.004))),
  ] });
  // Floor globe on a walnut stand with a brass horizon ring.
  add({ name: 'globe', parts: [
    c(0.18, 0.2, 0.05, [0, 0.025, 0], 'walnutDark', 12), c(0.03, 0.045, 0.5, [0, 0.3, 0], 'walnut', 8), c(0.06, 0.04, 0.06, [0, 0.57, 0], 'gold', 10),
    bl(0.22, 0.22, 0.22, [0, 0.82, 0], 'ocean', 14, 10), ...[[0.1, 0.9, 0.16, 0.09], [-0.12, 0.78, 0.15, 0.08], [0.16, 0.74, -0.08, 0.07], [-0.05, 0.95, -0.15, 0.08]].map(([x, y, z, r]) => bl(r, r * 0.8, r, [x, y, z], 'greenDark', 8, 6)),
    c(0.255, 0.255, 0.025, [0, 0.82, 0], 'gold', 18), { g: place(cyl(0.008, 0.008, 0.56, 4), { t: [0, 0.82, 0], r: [0, 0, 23] }), m: 'gold' },
  ] });
  // Brass-framed landscape for a wall.
  add({ name: 'painting', parts: [
    b(1.0, 0.75, 0.04, [0, 1.75, 0.02], 'gold', 0.01), b(0.86, 0.6, 0.012, [0, 1.75, 0.045], 'bookNavy', 0.003), b(0.86, 0.2, 0.014, [0, 1.55, 0.047], 'bookForest', 0.003),
    b(0.5, 0.08, 0.016, [0.12, 1.66, 0.048], 'bookTan', 0.003), { g: place(cyl(0.07, 0.07, 0.014, 14), { t: [-0.2, 1.9, 0.048], r: [90, 0, 0] }), m: 'gold' },
  ] });
  // ---------- the Creative Space (bar, billiards, arcades) ----------
  // Rounded bar counter, 8.0 x 1.4 overall, top at 1.05, the patrons' side facing +z: a straight front run 5.8 long whose ends curve back (radius 0.8)
  // into two short legs that meet the wine wall behind, so the bartender works inside the curve. Panelled front with an amber strip and a brass
  // foot rail; beer taps, shakers and glasses on the marble top.
  const BT = 1.05, BA = 2.9, BR = 0.8, BF = 0.4, BW = 0.6;
  const run = (x0, z0, x1, z1, extra = 0) => {
    const len = Math.hypot(x1 - x0, z1 - z0) + extra, ry = (Math.atan2(-(z1 - z0), x1 - x0) * 180) / Math.PI, t = [(x0 + x1) / 2, 0, (z0 + z1) / 2];
    return [
      { g: place(box(len, BT - 0.06, BW, 0.02), { t: [t[0], (BT - 0.06) / 2, t[2]], r: [0, ry, 0] }), m: 'walnut' },
      { g: place(box(len, 0.06, BW + 0.1, 0.02), { t: [t[0], BT - 0.03, t[2]], r: [0, ry, 0] }), m: 'marble' },
    ];
  };
  const arc = [];
  for (const sx of [-1, 1]) {
    const pts = Array.from({ length: 7 }, (_, i) => { const f = (i / 6) * (Math.PI / 2); return [sx * (BA + BR * Math.sin(f)), BF - BR + BR * Math.cos(f)]; });
    for (let i = 0; i < 6; i++) arc.push(...run(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 0.06));
    arc.push(...run(sx * (BA + BR), BF - BR, sx * (BA + BR), -0.7));
  }
  add({ name: 'bar_counter', parts: [
    ...run(-BA, BF, BA, BF), ...arc,
    b(2 * BA, 0.8, 0.02, [0, 0.52, BF + 0.305], 'walnutDark', 0.008), ...[-2, -1, 0, 1, 2].map(k => b(0.04, 0.72, 0.02, [k * 1.16, 0.52, BF + 0.318], 'walnut', 0.006)),
    b(2 * BA, 0.02, 0.02, [0, 0.13, BF + 0.322], 'amber', 0.005), b(2 * BA, 0.012, 0.012, [0, BT - 0.065, BF + 0.352], 'gold', 0.004),
    { g: place(cyl(0.025, 0.025, 2 * BA, 8), { t: [0, 0.2, BF + 0.43], r: [0, 0, 90] }), m: 'gold' }, ...[-2.4, 0, 2.4].map(x => b(0.03, 0.2, 0.14, [x, 0.1, BF + 0.37], 'gold', 0.006)),
    b(0.5, 0.06, 0.1, [0, BT + 0.03, BF - 0.12], 'chrome', 0.01), b(0.08, 0.32, 0.08, [0, BT + 0.16, BF - 0.12], 'chrome', 0.01), b(0.5, 0.05, 0.08, [0, BT + 0.31, BF - 0.12], 'chrome', 0.01),
    ...[-0.18, 0, 0.18].map(x => c(0.016, 0.02, 0.14, [x, BT + 0.4, BF - 0.12], 'walnutDark', 6)),
    ...[-2.4, -1.7, -1.0, 1.0, 1.7, 2.4].map((x, i) => c(0.04, 0.034, 0.13, [x, BT + 0.065, BF + 0.12], i % 2 ? 'glassTint' : 'bottleAmber', 10)),
    ...[-1, 1].map(s => c(0.04, 0.045, 0.18, [s * 0.7, BT + 0.09, BF - 0.15], 'chrome', 10)),
  ] });
  // Wine wall, 8.0 wide and kept low (1.3, bottles to about 1.6) so it does not hide the bar from the camera: a closed base cabinet with open
  // shelving above it (bottles show from both sides), nine posts, two shelves lit by amber strips and a row of bottles on top; low-poly bottles
  // keep the models small.
  const bottleColors = ['bottleGreen', 'bottleAmber', 'bottleClear', 'wineRed'];
  const wineBottles = [];
  [0.47, 0.87, 1.29].forEach((y, row) => {
    for (let i = 0; i < 24; i++) {
      const bay = Math.floor(i / 3), x = -3.5 + bay - 0.28 + (i % 3) * 0.28, m = bottleColors[(i + row * 3) % 4], h = 0.22 + ((i * 7 + row) % 3) * 0.03;
      wineBottles.push(c(0.036, 0.036, h, [x, y + h / 2, 0], m, 6), c(0.012, 0.022, 0.07, [x, y + h + 0.035, 0], m, 4));
    }
  });
  add({ name: 'wine_wall', parts: [
    b(8.0, 0.45, 0.4, [0, 0.225, 0], 'walnutDark', 0.02), ...[-3, -1, 1, 3].map(x => b(1.9, 0.34, 0.02, [x, 0.225, 0.205], 'walnut', 0.008)),
    ...Array.from({ length: 9 }, (_, i) => b(0.05, 0.82, 0.38, [-4 + 0.025 + i * (7.95 / 8), 0.86, 0], 'walnut', 0.01)),
    ...[0.46, 0.86].flatMap(y => [b(8.0, 0.03, 0.38, [0, y, 0], 'walnut', 0.006), b(7.9, 0.012, 0.012, [0, y - 0.022, 0.19], 'amber', 0.003)]),
    b(8.04, 0.05, 0.42, [0, 1.26, 0], 'walnutDark', 0.01), b(7.9, 0.012, 0.012, [0, 1.23, 0.21], 'amber', 0.003), ...wineBottles,
  ] });
  add({ name: 'bar_stool', parts: [
    c(0.19, 0.21, 0.03, [0, 0.015, 0], 'chrome', 14), c(0.028, 0.028, 0.68, [0, 0.36, 0], 'chrome', 8), c(0.16, 0.16, 0.018, [0, 0.3, 0], 'chrome', 14),
    c(0.2, 0.19, 0.08, [0, 0.72, 0], 'blackLeather', 14), c(0.16, 0.18, 0.03, [0, 0.67, 0], 'chrome', 12),
  ] });
  // Billiard table, 2.2 x 1.2, felt at 0.8: walnut rails with brass corners, six pockets, a racked triangle and the cue ball, a cue lying on it.
  const BH = 0.8;
  add({ name: 'billiard_table', parts: [
    b(2.2, 0.14, 1.2, [0, BH - 0.07, 0], 'walnut', 0.04), b(1.96, 0.02, 0.96, [0, BH + 0.005, 0], 'felt', 0.004),
    ...[-1, 1].map(s => b(1.96, 0.045, 0.06, [0, BH + 0.025, s * 0.45], 'feltDark', 0.01)), ...[-1, 1].map(s => b(0.06, 0.045, 0.84, [s * 0.95, BH + 0.025, 0], 'feltDark', 0.01)),
    b(2.0, 0.26, 1.0, [0, BH - 0.27, 0], 'walnutDark', 0.03), ...[-1, 1].flatMap(sx => [-1, 1].map(sz => b(0.15, BH - 0.3, 0.15, [sx * 0.9, (BH - 0.3) / 2, sz * 0.42], 'walnutDark', 0.03))),
    ...[-1, 0, 1].flatMap(x => [-1, 1].map(z => c(0.05, 0.05, 0.03, [x * 0.99, BH + 0.012, z * 0.51], 'ink', 10))),
    ...[-1, 1].flatMap(sx => [-1, 1].map(sz => b(0.09, 0.02, 0.09, [sx * 1.06, BH + 0.002, sz * 0.56], 'gold', 0.008))),
    ...[[0, 0, 'lemon'], [1, -1, 'sky'], [1, 1, 'red'], [2, -2, 'lav'], [2, 0, 'ink'], [2, 2, 'mint'], [3, -1, 'coral'], [3, 1, 'bookGreen']].map(([r, k, m]) => bl(0.03, 0.03, 0.03, [0.45 + r * 0.052, BH + 0.045, k * 0.031], m, 8, 6)),
    bl(0.03, 0.03, 0.03, [-0.5, BH + 0.045, 0], 'white', 8, 6), { g: place(cyl(0.008, 0.014, 1.3, 6), { t: [-0.1, BH + 0.06, 0.3], r: [0, 8, 90] }), m: 'wood' },
  ] });
  // Arcade cabinet, 0.75 x 0.7, the screen and controls facing +z: coloured sides, a lit marquee, a tilted screen, a joystick and buttons, a coin door.
  const arcade = (side, marquee) => [
    ...[-1, 1].map(s => b(0.06, 1.8, 0.7, [s * 0.345, 0.9, 0], side, 0.015)), b(0.63, 1.8, 0.6, [0, 0.9, -0.04], 'dark', 0.01), b(0.63, 0.85, 0.02, [0, 0.425, 0.31], side, 0.006),
    { g: place(box(0.65, 0.06, 0.3, 0.012), { t: [0, 0.95, 0.3], r: [15, 0, 0] }), m: 'dark' },
    c(0.012, 0.012, 0.08, [-0.15, 1.0, 0.31], 'metalDark', 6), bl(0.03, 0.03, 0.03, [-0.15, 1.05, 0.31], 'red', 8, 6),
    ...[0.04, 0.12, 0.2].map((x, i) => c(0.022, 0.022, 0.02, [x, 0.99, 0.3], ['lemon', 'sky', 'coral'][i], 10)),
    { g: place(box(0.58, 0.48, 0.03, 0.01), { t: [0, 1.32, 0.2], r: [-12, 0, 0] }), m: 'ink' }, { g: place(box(0.52, 0.42, 0.01, 0.003), { t: [0, 1.32, 0.217], r: [-12, 0, 0] }), m: 'arcadeScreen' },
    b(0.63, 0.2, 0.08, [0, 1.7, 0.26], marquee, 0.01), b(0.16, 0.2, 0.01, [0, 0.45, 0.322], 'metal', 0.003), ...[-1, 1].map(s => b(0.03, 0.05, 0.006, [s * 0.04, 0.49, 0.329], 'ledAmber', 0.002)),
  ];
  add({ name: 'arcade_a', parts: arcade('neonPink', 'marqueeA') });
  add({ name: 'arcade_b', parts: arcade('neonTeal', 'marqueeB') });
  // ---------- the pool ----------
  // Long raised pool, 7.0 x 2.6: tiled coping 0.4 high around an opaque water surface at 0.3 (it hides a swimmer below the waterline), three lane
  // markings, two lane ropes and a chrome ladder in the middle of each long side.
  add({ name: 'pool', parts: [
    ...[-1, 1].map(s => b(7.0, 0.36, 0.25, [0, 0.18, s * 1.175], 'poolTile', 0.02)), ...[-1, 1].map(s => b(0.25, 0.36, 2.1, [s * 3.375, 0.18, 0], 'poolTile', 0.02)),
    ...[-1, 1].map(s => b(7.06, 0.04, 0.29, [0, 0.38, s * 1.175], 'poolCap', 0.01)), ...[-1, 1].map(s => b(0.29, 0.04, 2.06, [s * 3.375, 0.38, 0], 'poolCap', 0.01)),
    b(6.5, 0.02, 2.1, [0, 0.3, 0], 'water', 0.002), ...[-0.7, 0, 0.7].map(z => b(6.0, 0.004, 0.08, [0, 0.312, z], 'laneBlue', 0.001)),
    ...[-0.35, 0.35].map(z => b(6.4, 0.025, 0.025, [0, 0.318, z], 'laneRope', 0.005)),
    ...[-1, 1].flatMap(s => [-0.15, 0.15].flatMap(x => [c(0.016, 0.016, 0.55, [x, 0.6, s * 1.06], 'chrome', 6), b(0.03, 0.03, 0.18, [x, 0.87, s * 1.14], 'chrome', 0.008)])),
  ] });
  // Diving board: a tiled pedestal with steps at the back, chrome hand rails, and a 1.7 long plank reaching +z over the water.
  add({ name: 'diving_board', parts: [
    b(0.5, 0.5, 0.5, [0, 0.25, -0.05], 'poolTile', 0.02), b(0.54, 0.03, 0.54, [0, 0.51, -0.05], 'poolCap', 0.008),
    ...[0.12, 0.27].map(y => b(0.4, 0.03, 0.1, [0, y, -0.34], 'poolCap', 0.008)), ...[-1, 1].map(s => b(0.06, 0.18, 0.36, [s * 0.18, 0.61, 0.02], 'chrome', 0.01)),
    b(0.42, 0.06, 1.7, [0, 0.72, 0.65], 'boardBlue', 0.02), b(0.42, 0.01, 1.6, [0, 0.755, 0.7], 'net', 0.004), { g: place(cyl(0.04, 0.04, 0.4, 8), { t: [0, 0.66, 0.3], r: [0, 0, 90] }), m: 'chrome' },
    ...[-1, 1].flatMap(s => [c(0.014, 0.014, 0.6, [s * 0.26, 0.82, -0.2], 'chrome', 6), { g: place(cyl(0.014, 0.014, 0.5, 6), { t: [s * 0.26, 1.1, 0.02], r: [90, 0, 0] }), m: 'chrome' }]),
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
