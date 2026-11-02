// Placeholder office atlas generator. Dependency-free (node:zlib PNG writer); output is committed under public/office/.
// Usage: node scripts/generate-office-atlas.mjs   (deterministic: same input, same bytes). Final art replaces the output, not this contract.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'office');
const ATLAS_W = 512;

const hex = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255];
const OUTLINE = hex(0x2a1c24);

class Sprite {
  constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 4); }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px.set(c, i);
  }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  /** Scanline fill of a convex polygon given as [[x,y],...] (pixel centres). */
  poly(pts, c) {
    const ys = pts.map(p => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        const yc = y + 0.5;
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) this.set(x, y, typeof c === 'function' ? c(x, y) : c);
    }
  }
  /** Dark 1px outline around every opaque pixel that touches a transparent one. */
  outline(c = OUTLINE) {
    const copy = this.px.slice();
    const solid = (x, y) => x >= 0 && y >= 0 && x < this.w && y < this.h && copy[(y * this.w + x) * 4 + 3] > 0;
    for (let y = -1; y <= this.h; y++) for (let x = -1; x <= this.w; x++) {
      if (solid(x, y)) continue;
      if (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1)) this.set(x, y, c);
    }
  }
}

/** Iso diamond occupying the whole w x h box. */
const diamond = (s, c) => s.poly([[s.w / 2, 0], [s.w, s.h / 2], [s.w / 2, s.h], [0, s.h / 2]], c);

const frames = {};
const sprite = (name, w, h, draw) => { const s = new Sprite(w, h); draw(s); frames[name] = s; };

// --- floor (32x16, §5.0 warm wood) ---
const wood = (a, b) => (x, y) => ((x >> 3) + (y >> 2)) % 2 === 0 ? hex(a) : hex(b);
sprite('floor_a', 32, 16, s => diamond(s, wood(0xb07a4a, 0xa87244)));
sprite('floor_b', 32, 16, s => diamond(s, wood(0x9e6c40, 0x96653a)));
sprite('floor_rug', 32, 16, s => diamond(s, (x, y) => (x + y) % 6 < 3 ? hex(0x4f7a8a) : hex(0x5b8a9a)));

// --- brick walls (16x40, one tile edge each) ---
const brick = (x, y) => (y % 6 === 5 || (x + (Math.floor(y / 6) % 2) * 4) % 8 === 7) ? hex(0x6e3a30) : hex(0x8c4a3c);
sprite('wall_ne', 16, 40, s => s.poly([[0, 0], [16, 8], [16, 40], [0, 32]], brick));
sprite('wall_nw', 16, 40, s => s.poly([[0, 8], [16, 0], [16, 32], [0, 40]], brick));
for (const n of ['wall_ne', 'wall_nw']) frames[n].outline();

// --- furniture, anchored at bottom centre ---
const box = (s, x, y, w, h, top, left, right) => {
  // Iso block: top diamond plus two side faces; (x,y) is the top-left of the bounding box.
  const hw = w / 2, dh = Math.round(w / 4);
  s.poly([[x, y + dh], [x + hw, y + dh * 2], [x + hw, y + h], [x, y + h - dh]], left);
  s.poly([[x + hw, y + dh * 2], [x + w, y + dh], [x + w, y + h - dh], [x + hw, y + h]], right);
  s.poly([[x + hw, y], [x + w, y + dh], [x + hw, y + dh * 2], [x, y + dh]], top);
};
sprite('desk', 32, 32, s => {
  box(s, 0, 12, 32, 20, hex(0xc8c0b0), hex(0x8e8678), hex(0x706a5e));
  box(s, 10, 0, 12, 14, hex(0x3a4a58), hex(0x2c3844), hex(0x1c2630)); // CRT
  s.rect(13, 4, 5, 3, hex(0x6adf9a));
  s.outline();
});
sprite('plant', 16, 32, s => {
  s.poly([[8, 2], [14, 12], [8, 20], [2, 12]], hex(0x3f8a45));
  s.poly([[8, 8], [12, 16], [8, 22], [4, 16]], hex(0x58a85a));
  s.rect(5, 22, 6, 8, hex(0x8a5a3a));
  s.outline();
});
sprite('counter', 48, 36, s => {
  box(s, 0, 10, 48, 26, hex(0xd8c8a8), hex(0x9a7a52), hex(0x7e6240));
  s.rect(30, 4, 8, 8, hex(0xe8e0d0)); // cup stand
  s.outline();
});
sprite('board', 40, 44, s => {
  s.rect(2, 2, 36, 28, hex(0xf2f0ea));
  s.rect(6, 6, 10, 6, hex(0xf2c94c)); s.rect(20, 6, 10, 6, hex(0x7fc8f8)); s.rect(6, 16, 10, 6, hex(0xa6e3a1));
  s.rect(18, 30, 4, 12, hex(0x6a5a4a));
  s.outline();
});
sprite('mailbox', 24, 32, s => {
  box(s, 0, 8, 24, 20, hex(0xd8685a), hex(0xa84a40), hex(0x8a3a32));
  s.rect(8, 28, 8, 4, hex(0x5a4a40));
  s.outline();
});
sprite('cabinet', 24, 40, s => {
  box(s, 0, 4, 24, 36, hex(0x9aa4a8), hex(0x6e787c), hex(0x56606a));
  s.rect(4, 16, 7, 2, OUTLINE); s.rect(4, 26, 7, 2, OUTLINE);
  s.outline();
});
sprite('server', 24, 48, s => {
  box(s, 0, 4, 24, 44, hex(0x4a5260), hex(0x343a46), hex(0x262c36));
  for (let i = 0; i < 5; i++) s.rect(3, 16 + i * 6, 7, 2, i % 2 ? hex(0x6adf9a) : hex(0xf2c94c));
  s.outline();
});
sprite('settings', 24, 32, s => {
  s.rect(2, 2, 20, 22, hex(0x7a8088));
  s.rect(5, 5, 14, 3, hex(0xd8d8d0)); s.rect(5, 11, 14, 3, hex(0xd8d8d0)); s.rect(5, 17, 14, 3, hex(0xd8d8d0));
  s.rect(10, 4, 3, 5, hex(0xf2c94c)); s.rect(14, 10, 3, 5, hex(0xf2c94c)); s.rect(7, 16, 3, 5, hex(0xf2c94c));
  s.rect(10, 24, 4, 6, hex(0x5a4a40));
  s.outline();
});
sprite('door', 24, 40, s => {
  s.poly([[0, 6], [12, 0], [24, 6], [24, 36], [12, 40], [0, 34]], hex(0x7a4a2c));
  s.poly([[4, 10], [12, 6], [20, 10], [20, 32], [12, 36], [4, 30]], hex(0x9acfe8));
  s.rect(19, 22, 2, 3, hex(0xf2c94c));
  s.outline();
});

// --- characters: 32x48, one idle frame per role colour ---
const ROLES = {
  conversation: 0x3aa6a0, coordinator: 0xd8a02a, planner: 0x8a6ad0, architect: 0x5a7ad0, specifier: 0xc860a0,
  reviewer: 0xd86a3a, qa: 0x4aa860, tester: 0x7ab83a, security: 0xb83a3a, developer: 0x3a78c8,
};
for (const [role, color] of Object.entries(ROLES)) {
  sprite(`agent_${role}`, 32, 48, s => {
    const shade = hex(((color >> 1) & 0x7f7f7f));
    s.rect(11, 34, 4, 10, hex(0x3a3a4a)); s.rect(17, 34, 4, 10, hex(0x3a3a4a)); // legs
    s.rect(9, 18, 14, 18, hex(color)); s.rect(9, 30, 14, 6, shade); // torso
    s.rect(6, 19, 3, 12, hex(color)); s.rect(23, 19, 3, 12, hex(color)); // arms
    s.rect(11, 6, 10, 12, hex(0xf0c8a0)); // head
    s.rect(11, 4, 10, 5, hex(0x4a3428)); // hair
    s.rect(13, 12, 2, 2, OUTLINE); s.rect(17, 12, 2, 2, OUTLINE);
    s.outline();
  });
}

// --- pack (shelf) and encode ---
const order = Object.keys(frames);
const placed = {};
let x = 0, y = 0, rowH = 0;
for (const name of order) {
  const f = frames[name];
  if (x + f.w > ATLAS_W) { x = 0; y += rowH + 1; rowH = 0; }
  placed[name] = { x, y, w: f.w, h: f.h };
  x += f.w + 1; rowH = Math.max(rowH, f.h);
}
const ATLAS_H = y + rowH;
const atlas = new Sprite(ATLAS_W, ATLAS_H);
for (const name of order) {
  const f = frames[name], p = placed[name];
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    const k = (j * f.w + i) * 4;
    if (f.px[k + 3]) atlas.set(p.x + i, p.y + j, f.px.subarray(k, k + 4));
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(s) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s.w, 0); ihdr.writeUInt32BE(s.h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((s.w * 4 + 1) * s.h);
  for (let j = 0; j < s.h; j++) { raw[j * (s.w * 4 + 1)] = 0; Buffer.from(s.px.buffer, j * s.w * 4, s.w * 4).copy(raw, j * (s.w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'atlas.png'), png(atlas));
writeFileSync(join(OUT, 'atlas.json'), JSON.stringify({
  frames: Object.fromEntries(order.map(n => [n, { frame: placed[n], sourceSize: { w: placed[n].w, h: placed[n].h }, spriteSourceSize: { x: 0, y: 0, w: placed[n].w, h: placed[n].h } }])),
  meta: { image: 'atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
}, null, 1) + '\n');
writeFileSync(join(OUT, 'LICENSE.txt'), [
  'Bflow office atlas: PLACEHOLDER art.',
  '',
  'These images are generated by apps/web/scripts/generate-office-atlas.mjs (no third-party artwork, no text).',
  'They are released under the project licence (AGPL-3.0-only). Final art is pending and will replace this atlas.',
  '',
].join('\n'));
console.log(`atlas ${ATLAS_W}x${ATLAS_H}, ${order.length} frames`);
