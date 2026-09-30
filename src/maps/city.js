// "City": a Manhattan-like street grid, about 700 x 480 m of blocks, plus a river with a pier and a
// low skyline on the far bank.
// - avenues run north-south (along z) and are 20 m wide, streets run east-west and are 14 m wide.
//   Blocks are 60 x 28 m lots on 15 cm sidewalks, filled with procedural towers: glass curtain
//   walls, Art Deco setbacks with piers, stone and brick mid-rises with water tanks, and lit
//   storefronts with coloured awnings at street level.
// - the walkable core (3 x 5 blocks) holds the probes and the detail:
//     * a Grand-Central-like terminal: a 23 m tall concourse with sun beams through mullioned
//       arched windows, a teal star ceiling, mezzanines on grand staircases, an info booth clock,
//     * a subway station under the avenue: two side platforms, a parked train, lit only by
//       fluorescent strips and the daylight coming down the two stairs from the sidewalk,
//     * a chrome corner diner with a neon sign, booths and a counter,
//     * a row of brownstones; one of them can be entered, with stairs up three floors to the roof,
//     * a "Times Square" crossing lined with emissive billboards, a two-block park with a pond.
// Axes: +x east, +z north. Floors and sidewalks are at y = 0.15, the roadway at y = 0.
// Ported from threejs-probe-gi/src/scenes/city.js (the "City PBR" variant); the game map
// definition is at the bottom of the file.
import * as THREE from 'three';
import { Builder, C, mulberry32, surface } from '../lighting/builder.js';

// PBR texture sets (freepbr.com, public/textures/freepbr/): size = tile size in metres,
// avg = mean linear albedo of the map. Surfaces are tinted by palette / avg, so each keeps the
// palette's average colour (and the city's overall look) and only gains the texture's detail.
const MATS = {
  asphalt: { path: 'freepbr/pebbled-asphalt', size: 3, avg: [0.065, 0.064, 0.062] },
  sidewalk: { path: 'freepbr/clean-concrete', size: 2.5, avg: [0.1, 0.098, 0.097] },
  brick: { path: 'freepbr/brick-wall', size: 0.7, avg: [0.201, 0.088, 0.039] },
  brick2: { path: 'freepbr/alley-brick-wall', size: 1.6, avg: [0.131, 0.08, 0.062] },
  limestone: { path: 'freepbr/flat-textured-limestone', size: 3, normalScale: 0.6, avg: [0.503, 0.507, 0.522] }, // albedo contrast reduced to 45%
  stone: { path: 'freepbr/sandstone-blocks', size: 3.5, avg: [0.107, 0.107, 0.107] }, // albedo desaturated (tinted per use)
  spandrel: { path: 'freepbr/concrete3', size: 2.4, avg: [0.355, 0.351, 0.337] },
  marble: { path: 'freepbr/white-marble', size: 3, avg: [0.839, 0.839, 0.839] },
  tile: { path: 'freepbr/base-white-tile', size: 1.5, avg: [0.501, 0.501, 0.501] },
};
// `pbr` switches the palette entries below between plain vertex colours and textured surfaces
// (set by build(); the game map uses the textured variant).
let pbr = false;
/** textured surface whose mean albedo is the palette colour c (plain colour c without PBR) */
const tex = (id, c) => (pbr ? surface(id, c.map((v, i) => v / MATS[id].avg[i])) : c);

const K = {}, STYLES = {};
const setPalette = (on) => {
  pbr = on;
  Object.assign(K, palette());
  Object.assign(STYLES, styles());
};
const palette = () => ({
  ASPHALT: tex('asphalt', [0.12, 0.12, 0.13]),
  SIDEWALK: tex('sidewalk', [0.5, 0.49, 0.46]),
  MARK: [0.8, 0.8, 0.76],
  MARK_Y: [0.8, 0.6, 0.1],
  LIMESTONE: tex('limestone', [0.72, 0.66, 0.55]),
  STONE: tex('stone', [0.6, 0.57, 0.51]),
  BRICK: tex('brick', [0.5, 0.22, 0.14]),
  BRICK2: tex('brick2', [0.58, 0.34, 0.22]),
  BROWN: tex('limestone', [0.34, 0.2, 0.13]),
  SPANDREL: tex('spandrel', [0.28, 0.3, 0.32]),
  GLASS: [0.14, 0.22, 0.3],
  GLASS_DARK: [0.1, 0.11, 0.13],
  STORE: [0.2, 0.15, 0.09],
  TEAL: [0.22, 0.42, 0.4],
  MARBLE: tex('marble', [0.82, 0.77, 0.66]),
  BRASS: [0.62, 0.46, 0.2],
  TILE: tex('tile', [0.84, 0.84, 0.8]),
  MOSAIC: [0.55, 0.12, 0.08],
  STEEL: [0.1, 0.24, 0.18],
  SILVER: [0.66, 0.68, 0.7],
  CHROME: [0.74, 0.76, 0.8],
  MINT: [0.3, 0.62, 0.56],
  WATER: [0.05, 0.14, 0.18],
  TAXI: [0.85, 0.62, 0.04],
  PARK: [0.14, 0.3, 0.07],
  GRAVEL: [0.55, 0.5, 0.4],
});
const WARM = [1.0, 0.62, 0.28], COOL = [0.82, 0.92, 1.0];
const NEON = [[1.0, 0.1, 0.45], [0.1, 0.5, 1.0], [1.0, 0.8, 0.1], [0.1, 0.9, 0.9], [0.9, 0.15, 0.1], [0.3, 1.0, 0.3], [0.65, 0.2, 1.0], [1, 1, 1]];
const DECOR = { collide: false, solid: false }; // visual only

// street grid
const AX = [-360, -280, -200, -120, -40, 40, 120, 200]; // avenue centres (x)
const SZ = [-231, -189, -147, -105, -63, -21, 21, 63, 105, 147, 189, 231]; // street centres (z)
const AVE = 10, STR = 7, WALK_AVE = 4, WALK_STR = 3; // half widths, sidewalk widths
const RA = AVE - WALK_AVE, RS = STR - WALK_STR; // roadway half widths
const CORE_X = [-80, 0, 80]; // core block centres
const CORE_Z = [-84, -42, 0, 42, 84];
const RIVER_X = 212; // seawall
const Y0 = 0.15; // sidewalk / floor level

// subway station under the avenue at x = 40
const ST = { x0: 28, x1: 52, z0: -50, z1: 4, floor: -6, pit: -7.1, ceil: -1.0 };
const STAIR_W = [30.2, 33.2, 4.5, 13.5]; // [x0, x1, z0, z1] sidewalk stair next to the terminal
const STAIR_E = [46.8, 49.8, -40, -31]; // sidewalk stair next to the diner
const REF = [-96, 1.8, 35]; // auto-exposure reference: the park lawn

// ------------------------------------------------------------------ geometry helpers
/** the 4 side faces of a box (no caps): stacked facade bands don't need the hidden caps */
function sides(b, min, max, color, emissive = 0) {
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) return;
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const a = g.attributes[name].array;
    const r = new Float32Array(24 * 3);
    r.set(a.subarray(0, 36), 0); // +x, -x
    r.set(a.subarray(72, 108), 36); // +z, -z (skip +y, -y)
    out.setAttribute(name, new THREE.BufferAttribute(r, 3));
  }
  b.addGeom(out, color, emissive);
}
/** an up-facing quad (road markings, carpets): 2 triangles */
function flat(b, x0, z0, x1, z1, y, color, emissive = 0) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  b.addGeom(g, color, emissive);
}
function cyl(b, x, y0, z, r, h, color, { seg = 8, emissive = 0, collide = true } = {}) {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  g.translate(x, y0 + h / 2, z);
  b.addGeom(g, color, emissive);
  if (collide) b.box([x - r, y0, z - r], [x + r, y0 + h, z + r], color, { visual: false });
}
function blob(b, x, y, z, r, color, emissive = 0, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.translate(x, y, z);
  b.addGeom(g, color, emissive);
}
const shade = (c, k) => (c.mat ? surface(c.mat, c.tint.map((v) => v * k)) : c.map((v) => Math.min(1, v * k)));
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

function tree(b, rnd, x, z, y = Y0, s = 1) {
  const h = (2 + rnd() * 1.5) * s;
  b.box([x - 0.15, y, z - 0.15], [x + 0.15, y + h, z + 0.15], C.TRUNK);
  const r = (1.3 + rnd() * 0.9) * s;
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(1, 1.2, 1);
  g.rotateY(rnd() * 6);
  g.translate(x, y + h + r * 0.7, z);
  b.addGeom(g, shade(C.LEAF, 0.75 + rnd() * 0.6));
}

function waterTank(b, x, y, z, r = 1.5) {
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box([x + dx * r * 0.6 - 0.1, y, z + dz * r * 0.6 - 0.1], [x + dx * r * 0.6 + 0.1, y + 2.4, z + dz * r * 0.6 + 0.1], C.DARK);
  cyl(b, x, y + 2.4, z, r, r * 2.1, C.WOOD);
  const g = new THREE.ConeGeometry(r * 1.05, r * 0.8, 8);
  g.translate(x, y + 2.4 + r * 2.1 + r * 0.4, z);
  b.addGeom(g, C.DARK);
}

// ------------------------------------------------------------------ buildings
const styles = () => ({
  glass: { wall: K.SPANDREL, glass: K.GLASS, floorH: 3.8, glassFrac: 0.68, piers: 0, setbacks: 0, cornice: false },
  deco: { wall: K.LIMESTONE, glass: K.GLASS_DARK, floorH: 3.6, glassFrac: 0.45, piers: 2.4, setbacks: 3, cornice: false },
  stone: { wall: K.STONE, glass: K.GLASS_DARK, floorH: 3.5, glassFrac: 0.42, piers: 2.2, setbacks: 1, cornice: true },
  brick: { wall: K.BRICK, glass: K.GLASS_DARK, floorH: 3.2, glassFrac: 0.45, piers: 3, setbacks: 0, cornice: true, water: true },
  brick2: { wall: K.BRICK2, glass: K.GLASS_DARK, floorH: 3.2, glassFrac: 0.45, piers: 3, setbacks: 0, cornice: true, water: true },
});

/**
 * Procedural tower on footprint [x0..x1] x [z0..z1], total height h above the sidewalk.
 * lod 0 = core (piers, awnings, storefronts), 1 = next ring, 2 = distant filler.
 * lot = the block's lot, so faces lying on it know they face a street.
 */
function tower(b, x0, z0, x1, z1, h, st, rnd, { lod = 0, lot = null, wall = null } = {}) {
  const W = wall ?? st.wall;
  const fh = lod === 2 ? 9 : lod === 1 ? st.floorH * 2 : st.floorH;
  const gf = lod === 2 ? 0.3 : st.glassFrac;
  const nTiers = h > 45 ? st.setbacks + 1 : 1;
  const bounds = [0.55, 0.78, 0.9, 1];
  let tx0 = x0, tz0 = z0, tx1 = x1, tz1 = z1;
  let y = Y0;
  for (let t = 0; t < nTiers; t++) {
    const top = Y0 + h * (nTiers === 1 ? 1 : bounds[Math.max(0, bounds.length - nTiers + t)]);
    let body = y;
    if (t === 0) {
      // storefront band + lintel
      if (lod < 2) {
        // the band itself is a regular lit wall; only the shop windows glow
        sides(b, [tx0, y, tz0], [tx1, y + 4.5, tz1], K.STORE);
        sides(b, [tx0, y + 4.5, tz0], [tx1, y + 5.3, tz1], W);
        body = y + 5.3;
      }
      if (lod === 0 && lot) {
        shopfronts(b, tx0, tz0, tx1, tz1, lot);
        awnings(b, rnd, tx0, tz0, tx1, tz1, lot);
      }
    }
    // alternating spandrel / window bands
    for (let yy = body; yy < top - 0.4; yy += fh) {
      const yb = Math.min(top - 0.4, yy + fh);
      const ym = Math.min(yb, yy + fh * (1 - gf));
      sides(b, [tx0, yy, tz0], [tx1, ym, tz1], W);
      sides(b, [tx0, ym, tz0], [tx1, yb, tz1], st.glass);
    }
    // piers make the bands read as a grid of windows
    if (lod === 0 && st.piers) {
      const p = 0.18, w = 0.24;
      for (let x = tx0 + st.piers / 2; x < tx1 - 0.5; x += st.piers) {
        b.box([x - w, body, tz0 - p], [x + w, top - 0.4, tz0], W, DECOR);
        b.box([x - w, body, tz1], [x + w, top - 0.4, tz1 + p], W, DECOR);
      }
      for (let z = tz0 + st.piers / 2; z < tz1 - 0.5; z += st.piers) {
        b.box([tx0 - p, body, z - w], [tx0, top - 0.4, z + w], W, DECOR);
        b.box([tx1, body, z - w], [tx1 + p, top - 0.4, z + w], W, DECOR);
      }
    }
    // roof / cornice cap (slightly proud, so it never z-fights the last band)
    const o = st.cornice && lod < 2 ? 0.45 : 0.12;
    b.box([tx0 - o, top - 0.4, tz0 - o], [tx1 + o, top, tz1 + o], shade(W, 0.9), { collide: false });
    b.box([tx0, Y0, tz0], [tx1, top, tz1], W, { visual: false }); // collider + probe solid
    y = top;
    // setback for the next tier
    const ins = Math.min(tx1 - tx0, tz1 - tz0) * 0.14;
    tx0 += ins; tz0 += ins; tx1 -= ins; tz1 -= ins;
  }
  // rooftop: water tank, mechanical box or a deco crown
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  if (lod < 2) {
    if (st.water && rnd() < 0.8) waterTank(b, cx + (rnd() - 0.5) * (tx1 - tx0) * 0.4, y, cz + (rnd() - 0.5) * (tz1 - tz0) * 0.4, 1.3 + rnd() * 0.5);
    else if (st.setbacks >= 2 && h > 60) {
      const w = (tx1 - tx0) * 0.3, d = (tz1 - tz0) * 0.3;
      b.box([cx - w, y, cz - d], [cx + w, y + 6, cz + d], W);
      const g = new THREE.ConeGeometry(Math.min(w, d) * 0.9, 14, 4);
      g.rotateY(Math.PI / 4);
      g.translate(cx, y + 13, cz);
      b.addGeom(g, K.SILVER);
    } else b.box([cx - 2.5, y, cz - 2], [cx + 2.5, y + 3, cz + 2], C.ROOF);
  }
}

/** deterministic 0..1 hash (keeps the tower rng sequence, hence the city layout, unchanged) */
const hash2 = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** shop windows on the faces of a building that lie on the lot edge: a few lit, the rest dark glass */
function shopfronts(b, x0, z0, x1, z1, lot) {
  const yA = Y0 + 0.5, yB = Y0 + 2.9, t = 0.04;
  const run = (u0, u1, v, fn) => {
    const n = Math.max(1, Math.round((u1 - u0) / 4.5));
    const step = (u1 - u0) / n;
    for (let i = 0; i < n; i++) {
      const a = u0 + i * step + 0.5, c = u0 + (i + 1) * step - 0.5;
      if (c - a < 1) continue;
      const r = hash2(a + v, c - v);
      if (r < 0.55) fn(a, c, r < 0.42 ? WARM : COOL, r < 0.42 ? 0.5 : 0.4);
      else fn(a, c, K.GLASS_DARK, 0);
    }
  };
  const box = (min, max, col, em) => b.box(min, max, col, { ...DECOR, emissive: em });
  if (Math.abs(z0 - lot[1]) < 0.01) run(x0, x1, z0, (a, c, col, em) => box([a, yA, z0 - t], [c, yB, z0], col, em));
  if (Math.abs(z1 - lot[3]) < 0.01) run(x0, x1, z1, (a, c, col, em) => box([a, yA, z1], [c, yB, z1 + t], col, em));
  if (Math.abs(x0 - lot[0]) < 0.01) run(z0, z1, x0, (a, c, col, em) => box([x0 - t, yA, a], [x0, yB, c], col, em));
  if (Math.abs(x1 - lot[2]) < 0.01) run(z0, z1, x1, (a, c, col, em) => box([x1, yA, a], [x1 + t, yB, c], col, em));
}

/** coloured awnings over the storefronts on the faces of a building that lie on the lot edge */
function awnings(b, rnd, x0, z0, x1, z1, lot) {
  const cols = [C.RED, C.GREEN, C.BLUE, C.OCHRE, [0.12, 0.3, 0.2], [0.5, 0.08, 0.2]];
  const run = (u0, u1, fn) => {
    for (let u = u0 + 0.6; u < u1 - 3; ) {
      const w = 3 + rnd() * 5, e = Math.min(u + w, u1 - 0.6);
      if (rnd() < 0.7) fn(u, e, pick(rnd, cols));
      u = e + 0.8;
    }
  };
  const yA = Y0 + 3.0, yB = Y0 + 3.25, d = 1.4;
  if (Math.abs(z0 - lot[1]) < 0.01) run(x0, x1, (a, c, col) => b.box([a, yA, z0 - d], [c, yB, z0], col, DECOR));
  if (Math.abs(z1 - lot[3]) < 0.01) run(x0, x1, (a, c, col) => b.box([a, yA, z1], [c, yB, z1 + d], col, DECOR));
  if (Math.abs(x0 - lot[0]) < 0.01) run(z0, z1, (a, c, col) => b.box([x0 - d, yA, a], [x0, yB, c], col, DECOR));
  if (Math.abs(x1 - lot[2]) < 0.01) run(z0, z1, (a, c, col) => b.box([x1, yA, a], [x1 + d, yB, c], col, DECOR));
}

/** fill a rectangle of a lot with towers, split along x (and sometimes z) */
function fillLot(b, rnd, x0, z0, x1, z1, { lod = 0, hMin = 20, hMax = 110, lot = null } = {}) {
  const L = lot ?? [x0, z0, x1, z1];
  const styles = lod === 2 ? ['glass', 'stone', 'brick', 'deco'] : ['glass', 'glass', 'deco', 'stone', 'stone', 'brick', 'brick2'];
  let x = x0;
  while (x < x1 - 0.01) {
    let w = 11 + rnd() * 14;
    if (x1 - (x + w) < 10) w = x1 - x;
    const xe = x + w;
    const parts = z1 - z0 > 22 && rnd() < 0.35 ? [[z0, (z0 + z1) / 2], [(z0 + z1) / 2, z1]] : [[z0, z1]];
    for (const [za, zb] of parts) {
      const s = STYLES[pick(rnd, styles)];
      const lowRise = s === STYLES.brick || s === STYLES.brick2;
      const h = lowRise ? Math.min(hMax, 14 + rnd() * 22) : hMin + Math.pow(rnd(), 1.6) * (hMax - hMin);
      tower(b, x, za, xe, zb, h, s, rnd, { lod, lot: L });
    }
    x = xe;
  }
}

/** emissive billboards stacked on one face of a building (face: '-x', '+x', '-z', '+z') */
function billboards(b, rnd, face, u0, u1, plane, y0, y1) {
  for (let y = y0; y < y1 - 2; ) {
    const hgt = 3 + rnd() * 5;
    const col = pick(rnd, NEON);
    const inset = rnd() * 1.5;
    const ya = y, yb = Math.min(y1, y + hgt);
    const [a, c] = [u0 + inset, u1 - inset * rnd()];
    const em = 1.6 + rnd() * 1.6;
    if (face === '-x') b.box([plane - 0.3, ya, a], [plane, yb, c], col, { emissive: em, collide: false, solid: false });
    if (face === '+x') b.box([plane, ya, a], [plane + 0.3, yb, c], col, { emissive: em, collide: false, solid: false });
    if (face === '-z') b.box([a, ya, plane - 0.3], [c, yb, plane], col, { emissive: em, collide: false, solid: false });
    if (face === '+z') b.box([a, ya, plane], [c, yb, plane + 0.3], col, { emissive: em, collide: false, solid: false });
    y = yb + 0.4 + rnd() * 0.8;
  }
}

// ------------------------------------------------------------------ streets
function streets(b, rnd) {
  // roadway: one slab with the two subway stair wells cut out
  const holes = [STAIR_W, STAIR_E].map(([a, c, d, e]) => [a, c, d, e]);
  b.slab(-520, RIVER_X, -520, 520, -0.5, 0, K.ASPHALT, holes);
  // earth around the station (invisible, only rejects probes)
  b.slab(-520, RIVER_X, -520, 520, -8.5, -0.5, K.ASPHALT, [[ST.x0 - 0.5, ST.x1 + 0.5, ST.z0 - 0.5, ST.z1 + 0.5], [29.8, 33.6, STAIR_W[2], STAIR_W[3]]], { visual: false, collide: false });

  // markings in the core: crosswalks at every crossing, dashed lane lines
  for (const ax of [-120, -40, 40, 120]) {
    for (const sz of [-105, -63, -21, 21, 63, 105]) {
      for (const s of [-1, 1]) {
        const zc = sz + s * (RS + 1.8);
        for (let x = ax - RA + 0.4; x < ax + RA - 0.4; x += 1.1) flat(b, x, zc - 1.4, x + 0.55, zc + 1.4, 0.01, K.MARK);
        const xc = ax + s * (RA + 1.8);
        for (let z = sz - RS + 0.3; z < sz + RS - 0.3; z += 1.1) flat(b, xc - 1.4, z, xc + 1.4, z + 0.55, 0.01, K.MARK);
      }
    }
    for (let i = 0; i < SZ.length - 1; i++) {
      const za = SZ[i] + STR + 3.5, zb = SZ[i + 1] - STR - 3.5;
      if (za > 120 || zb < -120) continue;
      for (const dx of [-3, 3]) for (let z = za; z < zb - 3; z += 6) flat(b, ax + dx - 0.07, z, ax + dx + 0.07, z + 3, 0.01, K.MARK);
    }
  }
  for (const sz of [-105, -63, -21, 21, 63, 105]) {
    for (let i = 0; i < AX.length - 1; i++) {
      const xa = AX[i] + AVE + 3.5, xb = AX[i + 1] - AVE - 3.5;
      if (xa > 140 || xb < -140) continue;
      flat(b, xa, sz - 0.18, xb, sz - 0.06, 0.01, K.MARK_Y);
      flat(b, xa, sz + 0.06, xb, sz + 0.18, 0.01, K.MARK_Y);
    }
  }

  // traffic lights on two corners of each core crossing, street lamps along the avenues
  for (const ax of [-120, -40, 40, 120]) {
    for (const sz of [-105, -63, -21, 21, 63, 105]) {
      for (const s of [-1, 1]) {
        const x = ax + s * (AVE - 0.6), z = sz - s * (STR - 0.6);
        b.box([x - 0.1, Y0, z - 0.1], [x + 0.1, 6, z + 0.1], C.DARK);
        const ex = x - s * 5;
        b.box([Math.min(x, ex), 5.7, z - 0.08], [Math.max(x, ex), 5.85, z + 0.08], C.DARK, DECOR);
        b.box([ex - 0.25, 4.7, z - 0.25], [ex + 0.25, 5.7, z + 0.25], C.DARK, DECOR);
        const lit = rnd() < 0.5 ? [1, 0.1, 0.05] : [0.1, 1, 0.4];
        b.box([ex - 0.14, 5.0, z + s * 0.25 - 0.02], [ex + 0.14, 5.3, z + s * 0.25 + 0.02], lit, { emissive: 4, collide: false, solid: false });
      }
    }
    for (let z = -110; z <= 110; z += 26) {
      if (SZ.some((sz) => Math.abs(z - sz) < STR + 3)) continue;
      for (const s of [-1, 1]) {
        const x = ax + s * (AVE - 0.7);
        b.box([x - 0.09, Y0, z - 0.09], [x + 0.09, 7.5, z + 0.09], C.DARK);
        b.box([Math.min(x, x - s * 2), 7.4, z - 0.07], [Math.max(x, x - s * 2), 7.55, z + 0.07], C.DARK, DECOR);
        b.box([x - s * 2 - 0.35, 7.2, z - 0.2], [x - s * 2 + 0.35, 7.45, z + 0.2], [1, 0.9, 0.7], { emissive: 1.2, collide: false, solid: false });
      }
    }
  }

  // yellow cabs, cars and a bus on the core roads (all driving in lanes, parked for eternity)
  const vehicle = (x, z, alongZ, len, wid, hgt, col, cabin = true) => {
    const [hx, hz] = alongZ ? [wid / 2, len / 2] : [len / 2, wid / 2];
    b.box([x - hx + 0.1, 0.05, z - hz + 0.1], [x + hx - 0.1, 0.35, z + hz - 0.1], C.DARK, DECOR);
    b.box([x - hx, 0.35, z - hz], [x + hx, cabin ? 1.05 : hgt, z + hz], col);
    if (cabin) {
      const [cx, cz] = alongZ ? [hx - 0.1, hz * 0.5] : [hx * 0.5, hz - 0.1];
      b.box([x - cx, 1.05, z - cz], [x + cx, hgt, z + cz], K.GLASS_DARK);
      b.box([x - cx, hgt, z - cz], [x + cx, hgt + 0.05, z + cz], col, DECOR);
    } else {
      // bus: window band
      b.box([x - hx - 0.02, 1.6, z - hz + 0.8], [x + hx + 0.02, 2.4, z + hz - 0.8], K.GLASS_DARK, DECOR);
    }
  };
  const carCols = [K.TAXI, K.TAXI, K.TAXI, [0.1, 0.1, 0.12], [0.7, 0.7, 0.72], [0.25, 0.08, 0.06], [0.08, 0.15, 0.3]];
  for (const ax of [-120, -40, 40, 120]) {
    for (let n = 0; n < 9; n++) {
      const z = -115 + rnd() * 230;
      if (SZ.some((sz) => Math.abs(z - sz) < STR + 4)) continue;
      if (ax === 40 && z > -18 && z < -4) continue; // spawn
            const lane = pick(rnd, [-4.5, -1.5, 1.5, 4.5]);
      const col = pick(rnd, carCols);
      vehicle(ax + lane, z, true, 4.6, 1.8, col === K.TAXI ? 1.5 : 1.45, col);
      if (col === K.TAXI) b.box([ax + lane - 0.3, 1.55, z - 0.15], [ax + lane + 0.3, 1.75, z + 0.15], [1, 0.9, 0.6], { emissive: 1.5, collide: false, solid: false });
    }
  }
  for (const sz of [-105, -63, -21, 21, 63, 105]) {
    for (let n = 0; n < 5; n++) {
      const x = -125 + rnd() * 250;
      if ([-120, -40, 40, 120].some((ax) => Math.abs(x - ax) < AVE + 4)) continue;
      if (sz === -21 && Math.abs(x) < 10) continue; // spawn
      vehicle(x, sz + pick(rnd, [-2, 2]), false, 4.6, 1.8, 1.5, pick(rnd, carCols));
    }
  }
  vehicle(-38, 80, true, 12, 2.6, 3.1, [0.85, 0.87, 0.9], false);
  b.box([-39.33, 0.4, 74.2], [-36.67, 0.9, 85.8], [0.1, 0.25, 0.7], DECOR);

  // Con Ed steam stack in the middle of a crossing
  for (let i = 0; i < 6; i++) cyl(b, -40, i * 0.5, -63, 0.45, 0.5, i % 2 ? [0.9, 0.9, 0.88] : [0.9, 0.35, 0.05], { collide: i === 0 });
  b.box([-40.45, 0, -63.45], [-39.55, 3, -62.55], C.DARK, { visual: false });

  // river: promenade, seawall, water, a pier, and a low skyline on the far bank
  b.box([AX[7] + RA, 0, -520], [RIVER_X, Y0, 520], K.SIDEWALK);
  b.box([RIVER_X, -3, -520], [RIVER_X + 0.6, Y0, 520], K.STONE);
  b.box([RIVER_X + 0.2, Y0, -520], [RIVER_X + 0.4, 1.2, 520], C.DARK);
  b.box([RIVER_X + 0.6, -4, -560], [640, -1.6, 560], K.WATER);
  b.box([RIVER_X + 0.6, 0, -8], [262, Y0 + 0.1, 8], C.WOOD);
  b.box([RIVER_X + 0.6, Y0 + 0.1, -8], [262, 1.3, -7.8], C.DARK, { solid: false });
  b.box([RIVER_X + 0.6, Y0 + 0.1, 7.8], [262, 1.3, 8], C.DARK, { solid: false });
  b.box([261.8, Y0 + 0.1, -7.8], [262, 1.3, 7.8], C.DARK, { solid: false });
  for (let x = 222; x < 262; x += 8) for (const z of [-7.5, 7.5]) b.box([x - 0.25, -3, z - 0.25], [x + 0.25, 0, z + 0.25], C.WOOD, DECOR);
  for (let z = -500; z < 500; ) {
    const w = 12 + rnd() * 30, h = 8 + Math.pow(rnd(), 2) * 50;
    b.box([440 + rnd() * 20, -1.6, z], [480 + rnd() * 30, h, z + w], pick(rnd, [K.BRICK, K.STONE, K.SPANDREL, K.BRICK2]), DECOR);
    z += w + rnd() * 6;
  }
}

// ------------------------------------------------------------------ blocks
function sidewalk(b, bx, bz, holes = []) {
  const lx0 = bx - 30, lx1 = bx + 30, lz0 = bz - 14, lz1 = bz + 14;
  b.slab(lx0 - WALK_AVE, lx1 + WALK_AVE, lz0 - WALK_STR, lz1 + WALK_STR, 0, Y0, K.SIDEWALK, holes);
  return [lx0, lz0, lx1, lz1];
}

function terminal(b, rnd) {
  const X0 = -30, X1 = 30, Z0 = -14, Z1 = 14, T = 1, H = 24;
  const bays = [-15, 0, 15];
  const arch = (c, hw, y0, y1) => [[c - hw, c + hw, y0, y1], [c - hw + 1, c + hw - 1, y1, y1 + 1], [c - hw + 2.5, c + hw - 2.5, y1 + 1, y1 + 1.6]];
  const facade = bays.flatMap((c) => [[c - 2, c + 2, Y0, 5.2], ...arch(c, 4.5, 7, 19)]);
  b.wall('x', X0, X1, Z0, Z0 + T, Y0, H + 0.5, K.LIMESTONE, facade);
  b.wall('x', X0, X1, Z1 - T, Z1, Y0, H + 0.5, K.LIMESTONE, facade);
  const side = [[-1.5, 1.5, Y0, 4.6], ...[-8, 0, 8].flatMap((c) => arch(c, 2, 13, 18.4))];
  b.wall('z', Z0 + T, Z1 - T, X0, X0 + T, Y0, H + 0.5, K.LIMESTONE, side);
  b.wall('z', Z0 + T, Z1 - T, X1 - T, X1, Y0, H + 0.5, K.LIMESTONE, side);
  // mullions: striped sun beams on the concourse floor
  for (const zc of [Z0 + 0.5, Z1 - 0.5]) {
    for (const c of bays) {
      for (let k = 1; k < 5; k++) b.box([c - 4.5 + k * 1.8 - 0.07, 7, zc - 0.08], [c - 4.5 + k * 1.8 + 0.07, 20.6, zc + 0.08], C.DARK, DECOR);
      for (const y of [9.6, 12.2, 14.8, 17.4]) b.box([c - 4.5, y - 0.07, zc - 0.08], [c + 4.5, y + 0.07, zc + 0.08], C.DARK, DECOR);
    }
  }
  // roof, ceiling, cornice, clock attic over the south facade
  b.slab(X0, X1, Z0, Z1, H + 0.5, H + 1.3, K.LIMESTONE);
  b.box([X0 + T, H - 0.1, Z0 + T], [X1 - T, H + 0.5, Z1 - T], K.TEAL, { collide: false });
  for (const [a, c, d, e] of [[X0 - 0.5, X1 + 0.5, Z0 - 0.5, Z0], [X0 - 0.5, X1 + 0.5, Z1, Z1 + 0.5], [X0 - 0.5, X0, Z0, Z1], [X1, X1 + 0.5, Z0, Z1]]) b.box([a, 21.6, d], [c, 22.4, e], shade(K.LIMESTONE, 0.9), DECOR);
  b.box([-13, H + 1.3, Z0], [13, H + 5, Z0 + 1.5], K.LIMESTONE);
  const clock = new THREE.CylinderGeometry(1.8, 1.8, 0.2, 20);
  clock.rotateX(Math.PI / 2);
  clock.translate(0, H + 3.2, Z0 - 0.1);
  b.addGeom(clock, [0.95, 0.9, 0.75], 0.6);
  // inner cornice + stars on the ceiling
  for (const [a, c, d, e] of [[X0 + T, X1 - T, Z0 + T, Z0 + T + 0.5], [X0 + T, X1 - T, Z1 - T - 0.5, Z1 - T], [X0 + T, X0 + T + 0.5, Z0 + T, Z1 - T], [X1 - T - 0.5, X1 - T, Z0 + T, Z1 - T]]) b.box([a, 20.4, d], [c, 21, e], K.MARBLE, DECOR);
  for (let i = 0; i < 80; i++) {
    const x = -27 + rnd() * 54, z = -11 + rnd() * 22, s = 0.12 + rnd() * 0.12;
    b.box([x - s, H - 0.14, z - s], [x + s, H - 0.1, z + s], [1, 0.8, 0.4], { emissive: 2, collide: false, solid: false });
  }
  // floor + dado band
  b.box([X0 + T, Y0, Z0 + T], [X1 - T, Y0 + 0.03, Z1 - T], K.MARBLE, DECOR);
  for (let x = -26; x <= 26; x += 4) flat(b, x - 0.6, Z0 + T, x + 0.6, Z1 - T, Y0 + 0.035, shade(K.MARBLE, 0.8));

  // mezzanines on both sides, reached by grand staircases
  for (const s of [-1, 1]) {
    const xw = s * (X1 - T), xe = s * 24;
    const [mx0, mx1] = s < 0 ? [xw, xe] : [xe, xw];
    b.box([mx0, 5.5, Z0 + T], [mx1, 5.9, Z1 - T], K.MARBLE);
    b.box([xe - (s < 0 ? 0 : 0.15), 5.9, Z0 + T], [xe + (s < 0 ? 0.15 : 0), 6.9, -3], K.BRASS);
    b.box([xe - (s < 0 ? 0 : 0.15), 5.9, 3], [xe + (s < 0 ? 0.15 : 0), 6.9, Z1 - T], K.BRASS);
    for (const z of [-10, -6.5, 6.5, 10]) b.box([xe + s * 0.3 - 0.3, Y0, z - 0.3], [xe + s * 0.3 + 0.3, 5.5, z + 0.3], K.MARBLE);
    const steps = 26, rise = (5.9 - Y0) / steps, run = 10 / steps;
    for (let i = 0; i < steps; i++) {
      const xa = s * (14 + i * run), xb = s * (14 + (i + 1) * run);
      b.box([Math.min(xa, xb), Y0, -3], [Math.max(xa, xb), Y0 + (i + 1) * rise, 3], K.MARBLE);
    }
    for (const z of [-3.15, 3]) {
      for (let i = 0; i < steps; i += 2) {
        const xa = s * (14 + i * run), xb = s * (14 + (i + 2) * run);
        b.box([Math.min(xa, xb), Y0 + (i + 1) * rise, z], [Math.max(xa, xb), Y0 + (i + 1) * rise + 1, z + 0.15], K.BRASS, { solid: false });
      }
    }
    // lit shop fronts under the mezzanine
    for (const [za, zb] of [[-11.5, -5], [5, 11.5]]) {
      const xs = s * (X1 - T);
      b.box([Math.min(xs, xs - s * 0.05), 0.9, za], [Math.max(xs, xs - s * 0.05), 3.9, zb], s < 0 ? WARM : [0.6, 0.85, 1.0], { emissive: 1.4, collide: false, solid: false });
    }
  }
  // information booth + four-faced clock
  const booth = new THREE.CylinderGeometry(2.2, 2.2, 2.4, 8);
  booth.translate(0, Y0 + 1.2, 0);
  b.addGeom(booth, K.BRASS);
  const top = new THREE.CylinderGeometry(2.45, 2.45, 0.15, 8);
  top.translate(0, Y0 + 2.47, 0);
  b.addGeom(top, K.MARBLE);
  b.box([-2.2, Y0, -2.2], [2.2, Y0 + 2.55, 2.2], K.BRASS, { visual: false });
  cyl(b, 0, Y0 + 2.55, 0, 0.3, 1.1, K.BRASS, { collide: false });
  blob(b, 0, Y0 + 4.1, 0, 0.6, [1.0, 0.8, 0.45], 3, 1);
  // chandeliers, banners, departure board
  for (const x of [-18, 18]) for (const z of [-6, 6]) {
    b.box([x - 0.03, 14.5, z - 0.03], [x + 0.03, H - 0.1, z + 0.03], C.DARK, DECOR);
    blob(b, x, 14, z, 0.8, WARM, 2.5, 1);
  }
  b.box([-8.5, 8, Z0 + T], [-6.5, 19, Z0 + T + 0.08], [0.75, 0.06, 0.05], DECOR);
  b.box([6.5, 8, Z0 + T], [8.5, 19, Z0 + T + 0.08], [0.08, 0.16, 0.6], DECOR);
  b.box([-4, 5.5, Z1 - T - 0.12], [4, 6.9, Z1 - T], C.DARK, DECOR);
  for (const y of [5.7, 6.1, 6.5]) b.box([-3.7, y, Z1 - T - 0.16], [3.7, y + 0.22, Z1 - T - 0.12], [1, 0.6, 0.1], { emissive: 2, collide: false, solid: false });
}

function station(b, rnd) {
  const { x0, x1, z0, z1, floor, pit, ceil } = ST;
  // shell
  b.box([x0 - 0.5, -8, z0 - 0.5], [x0, -0.5, z1 + 0.5], K.TILE);
  b.box([x1, -8, z0 - 0.5], [x1 + 0.5, -0.5, z1 + 0.5], K.TILE);
  b.box([x0, -8, z0 - 0.5], [x1, -0.5, z0], K.TILE);
  b.wall('x', x0, x1, z1, z1 + 0.5, -8, -0.5, K.TILE, [[STAIR_W[0], STAIR_W[1], floor, ceil]]);
  b.slab(x0, x1, z0, z1, ceil, -0.5, [0.7, 0.7, 0.66], [STAIR_E]);
  // platforms and track bed
  b.box([x0, -8, z0], [35, floor, z1], K.STONE);
  b.box([45, -8, z0], [x1, floor, z1], K.STONE);
  b.box([35, -8, z0], [45, pit, z1], [0.18, 0.16, 0.14]);
  flat(b, 34.4, z0, 35, z1, floor + 0.005, [0.85, 0.7, 0.1]);
  flat(b, 45, z0, 45.6, z1, floor + 0.005, [0.85, 0.7, 0.1]);
  for (const tc of [37.5, 42.5]) for (const dx of [-0.75, 0.75]) b.box([tc + dx - 0.05, pit, z0], [tc + dx + 0.05, pit + 0.16, z1], [0.3, 0.28, 0.26], DECOR);
  // mosaic bands on the walls
  b.box([x0, -3.4, z0], [x0 + 0.05, -2.9, z1], K.MOSAIC, DECOR);
  b.box([x1 - 0.05, -3.4, z0], [x1, -2.9, z1], K.MOSAIC, DECOR);
  b.box([x0, floor, z0], [x0 + 0.05, floor + 0.35, z1], K.STEEL, DECOR);
  b.box([x1 - 0.05, floor, z0], [x1, floor + 0.35, z1], K.STEEL, DECOR);
  // columns
  for (let z = z0 + 3; z < z1 - 1; z += 6) {
    b.box([39.8, pit, z - 0.2], [40.2, ceil, z + 0.2], K.STEEL);
    b.box([33.9, floor, z - 0.2], [34.3, ceil, z + 0.2], K.STEEL);
    if (z < STAIR_E[2] - 1 || z > STAIR_E[3] + 1) b.box([45.7, floor, z - 0.2], [46.1, ceil, z + 0.2], K.STEEL);
  }
  // fluorescent strips (the station's only light besides the stairwells)
  for (let z = z0 + 1.5; z < z1 - 2; z += 5) {
    b.box([31.2, ceil - 0.12, z], [31.8, ceil, z + 3], COOL, { emissive: 3.5, collide: false, solid: false });
    if (z + 3 < STAIR_E[2] - 0.5 || z > STAIR_E[3] + 0.5) b.box([48.2, ceil - 0.12, z], [48.8, ceil, z + 3], COOL, { emissive: 3.5, collide: false, solid: false });
    b.box([39.7, ceil - 0.1, z + 0.5], [40.3, ceil, z + 2.5], COOL, { emissive: 2, collide: false, solid: false });
  }
  // stairs down from the sidewalk (30 steps of 20.5 cm)
  const N = 30, rise = (Y0 - floor) / N, run = 0.3;
  for (let i = 0; i < N; i++) {
    const za = STAIR_W[3] - (i + 1) * run, zb = STAIR_W[3] - i * run; // west: descends southward
    b.box([STAIR_W[0], floor - 0.3, za], [STAIR_W[1], Y0 - (i + 1) * rise, zb], K.STONE);
    const zc = STAIR_E[2] + i * run, zd = STAIR_E[2] + (i + 1) * run; // east: descends northward
    b.box([STAIR_E[0], floor, zc], [STAIR_E[1], Y0 - (i + 1) * rise, zd], K.STONE);
  }
  // stair well walls + railings on the sidewalk, green globe lamps
  b.box([29.8, floor - 0.5, STAIR_W[2]], [STAIR_W[0], Y0, STAIR_W[3]], K.TILE);
  b.box([STAIR_W[1], floor - 0.5, STAIR_W[2]], [STAIR_W[1] + 0.3, Y0, STAIR_W[3]], K.TILE);
  b.box([STAIR_W[1], Y0, STAIR_W[2]], [STAIR_W[1] + 0.15, Y0 + 1.05, STAIR_W[3]], K.STEEL);
  b.box([STAIR_W[0], Y0, STAIR_W[2] - 0.2], [STAIR_W[1] + 0.15, Y0 + 1.05, STAIR_W[2]], K.STEEL);
  b.box([STAIR_E[0] - 0.2, floor, STAIR_E[2]], [STAIR_E[0], Y0 + 1.05, STAIR_E[3]], K.TILE);
  b.box([STAIR_E[1], floor, STAIR_E[2]], [STAIR_E[1] + 0.2, Y0 + 1.05, STAIR_E[3]], K.TILE);
  b.box([STAIR_E[0] - 0.2, Y0, STAIR_E[3]], [STAIR_E[1] + 0.2, Y0 + 1.05, STAIR_E[3] + 0.2], K.STEEL);
  for (const [x, z] of [[STAIR_W[1] + 0.3, STAIR_W[2] - 0.1], [STAIR_W[1] + 0.3, STAIR_W[3] + 0.3], [STAIR_E[0] - 0.4, STAIR_E[2] - 0.3], [STAIR_E[0] - 0.4, STAIR_E[3] + 0.3]]) {
    b.box([x - 0.06, Y0, z - 0.06], [x + 0.06, 2.4, z + 0.06], K.STEEL);
    blob(b, x, 2.6, z, 0.24, [0.2, 1, 0.35], 3, 1);
  }
  // parked train on the east track
  for (const [za, zb] of [[-47, -27.2], [-27, -7.2]]) {
    b.box([41, pit + 0.25, za], [44, -3.2, zb], K.SILVER);
    for (const [xa, xc] of [[40.95, 41], [44, 44.05]]) {
      b.box([xa, -5.0, za + 0.8], [xc, -4.1, zb - 0.8], [0.9, 0.95, 1.0], { emissive: 1.6, collide: false, solid: false });
      b.box([xa, -5.6, za + 0.3], [xc, -5.35, zb - 0.3], [0.6, 0.1, 0.5], DECOR);
    }
  }
  b.box([41.6, -4.2, -7.2], [43.4, -3.7, -7.15], [1, 0.45, 0.05], { emissive: 3, collide: false, solid: false });
  // turnstiles, ticket machines, benches
  for (let x = x0 + 0.3; x < 34.5; x += 1.1) b.box([x, floor, -1], [x + 0.3, floor + 1, -0.6], K.CHROME);
  for (const z of [1.5, 2.6]) {
    b.box([x0, floor, z], [x0 + 0.6, floor + 1.8, z + 0.9], [0.3, 0.32, 0.36]);
    b.box([x0 + 0.6, floor + 1.0, z + 0.2], [x0 + 0.63, floor + 1.4, z + 0.7], [0.2, 0.5, 1], { emissive: 2.5, collide: false, solid: false });
  }
  for (const z of [-44, -32, -20, -8]) {
    b.box([x0 + 0.4, floor, z], [x0 + 0.9, floor + 0.45, z + 2.2], C.WOOD);
    if (z < STAIR_E[2] - 1 || z > STAIR_E[3] + 1) b.box([x1 - 0.9, floor, z], [x1 - 0.4, floor + 0.45, z + 2.2], C.WOOD);
  }
}

// block letters for the diner sign (3x5 pixels)
const FONT = {
  D: ['110', '101', '101', '101', '110'],
  I: ['111', '010', '010', '010', '111'],
  N: ['101', '111', '111', '111', '101'],
  E: ['111', '100', '110', '100', '111'],
  R: ['110', '101', '110', '101', '101'],
};
function diner(b) {
  const X0 = 50, X1 = 64, Z0 = -40, Z1 = -28, T = 0.3, H = 4.6;
  // west (avenue) and north (street) faces are mostly glass
  b.wall('z', Z0, Z1 - T, X0, X0 + T, Y0, H, K.CHROME, [[-39, -35.2, 1.1, 3.3], [-34.8, -31, 1.1, 3.3], [-30.6, -28.8, 1.1, 3.3]]);
  b.wall('x', X0, X1, Z1 - T, Z1, Y0, H, K.CHROME, [[51, 54.6, 1.1, 3.3], [55.2, 56.8, Y0, 2.6], [57.4, 63, 1.1, 3.3]]);
  b.wall('x', X0 + T, X1, Z0, Z0 + T, Y0, H, K.CHROME);
  b.wall('z', Z0 + T, Z1 - T, X1 - T, X1, Y0, H, K.CHROME);
  b.box([X0 + T, H - 0.4, Z0 + T], [X1 - T, H, Z1 - T], [0.85, 0.82, 0.74]);
  sides(b, [X0 - 0.1, 3.4, Z0 - 0.1], [X1 + 0.1, 3.9, Z1 + 0.1], [0.75, 0.08, 0.06]); // red band (sides only)
  b.box([X0 - 0.1, H, Z0 - 0.1], [X1 + 0.1, H + 0.15, Z1 + 0.1], K.CHROME, { collide: false });
  // neon: sign board with letters facing the street, tube along the roof edge
  b.box([52, H + 0.15, Z1 - 0.9], [62, H + 2.3, Z1 - 0.7], C.DARK);
  const s = 0.36, word = 'DINER';
  for (let l = 0; l < word.length; l++) {
    const rows = FONT[word[l]];
    const lx = 52.5 + l * 1.9;
    rows.forEach((row, r) => {
      for (let c = 0; c < 3; ) {
        if (row[c] !== '1') { c++; continue; }
        let e = c;
        while (e < 3 && row[e] === '1') e++;
        const y = H + 2.0 - (r + 1) * s;
        b.box([lx + c * s, y, Z1 - 0.7], [lx + e * s, y + s * 0.8, Z1 - 0.62], [1, 0.2, 0.55], { emissive: 4, collide: false, solid: false });
        c = e;
      }
    });
  }
  b.box([X0 - 0.15, H + 0.15, Z1 - 0.1], [X1, H + 0.3, Z1 + 0.05], [0.2, 0.8, 1], { emissive: 3, collide: false, solid: false });
  b.box([X0 - 0.15, H + 0.15, Z0], [X0, H + 0.3, Z1], [0.2, 0.8, 1], { emissive: 3, collide: false, solid: false });
  // interior: checker floor, mint lining, counter, stools, booths, pendant lamps
  for (let i = 0; i < 13; i++) for (let j = 0; j < 11; j++) {
    const x = X0 + T + i * 1.03, z = Z0 + T + j * 1.04;
    flat(b, x, z, x + 1.03, z + 1.04, Y0 + 0.01, (i + j) % 2 ? [0.08, 0.08, 0.08] : [0.85, 0.84, 0.8]);
  }
  b.box([X1 - T - 0.05, Y0, Z0 + T], [X1 - T, 2.4, Z1 - T], K.MINT, DECOR);
  b.box([X0 + T, Y0, Z0 + T], [X1 - T, 2.4, Z0 + T + 0.05], K.MINT, DECOR);
  b.box([X0 + T + 0.05, 2.2, Z0 + T + 0.05], [X1 - T - 0.05, 2.4, Z0 + T + 0.12], WARM, { emissive: 2, collide: false, solid: false });
  b.box([53, Y0, -38.4], [62.5, 1.1, -37.6], K.CHROME);
  b.box([53, 1.1, -38.5], [62.5, 1.18, -37.4], [0.75, 0.08, 0.06], DECOR);
  for (let x = 54; x < 62.5; x += 1.2) cyl(b, x, Y0, -36.9, 0.22, 0.75, [0.75, 0.08, 0.06], { collide: false });
  for (const z of [-38.2, -34.4, -30.6]) {
    b.box([X0 + T, Y0, z], [X0 + 2.2, 1.3, z + 0.35], [0.75, 0.08, 0.06]);
    b.box([X0 + T, Y0, z + 2.45], [X0 + 2.2, 1.3, z + 2.8], [0.75, 0.08, 0.06]);
    b.box([X0 + T + 0.2, 0.8, z + 0.9], [X0 + 1.9, 0.85, z + 1.9], [0.9, 0.9, 0.86], DECOR);
    b.box([X0 + T + 0.95, Y0, z + 1.3], [X0 + T + 1.1, 0.8, z + 1.5], C.DARK, DECOR);
  }
  for (let x = 53; x < 63; x += 3) {
    b.box([x - 0.02, 3.3, -33.02], [x + 0.02, H - 0.4, -32.98], C.DARK, DECOR);
    blob(b, x, 3.15, -33, 0.25, WARM, 3, 1);
  }
}

function brownstones(b, rnd) {
  // 10 row houses along the north face of the block (x -110..-50), fronts at z = -28
  const cols = [K.BROWN, tex('limestone', [0.42, 0.24, 0.16]), K.BRICK, tex('stone', [0.3, 0.18, 0.12]), tex('limestone', [0.55, 0.47, 0.36])];
  for (let i = 0; i < 10; i++) {
    const x0 = -110 + i * 6, x1 = x0 + 6, col = cols[i % cols.length];
    // stoop: 7 steps from the sidewalk up to the parlor floor
    const rise = (1.5 - Y0) / 7;
    b.box([x0 + 3.6, Y0, -28], [x0 + 5.4, 1.5, -27.2], shade(col, 0.85));
    for (let k = 1; k <= 6; k++) b.box([x0 + 3.6, Y0, -27.2 + (k - 1) * 0.3], [x0 + 5.4, 1.5 - k * rise, -27.2 + k * 0.3], shade(col, 0.85));
    b.box([x0 + 3.45, Y0, -28], [x0 + 3.6, 2.4, -25.4], shade(col, 0.7), { solid: false });
    b.box([x0 + 5.4, Y0, -28], [x0 + 5.55, 2.4, -25.4], shade(col, 0.7), { solid: false });
    const H = i === 7 ? 12.6 : 12.2 + rnd() * 1.2;
    b.box([x0 - 0.02, H, -28], [x1 + 0.02, H + 0.6, -27.55], shade(col, 0.7), DECOR); // cornice
    if (i === 7) { enterableBrownstone(b, x0, x1, col); continue; }
    b.box([x0, Y0, -42], [x1, H, -28], col);
    for (const [zf, dz] of [[-28, 0.05], [-42, -0.05]]) {
      const [za, zb] = dz > 0 ? [zf, zf + dz] : [zf + dz, zf];
      b.box([x0 + 0.8, 2.0, za], [x0 + 2.6, 4.3, zb], K.GLASS_DARK, DECOR);
      b.box([x0 + 3.8, dz > 0 ? 1.5 : 2.0, za], [x0 + 5.2, dz > 0 ? 4.0 : 4.3, zb], dz > 0 ? C.WOOD : K.GLASS_DARK, DECOR);
      for (const fy of [5.0, 8.5]) for (const wx of [0.8, 3.8]) b.box([x0 + wx, fy + 0.9, za], [x0 + wx + 1.4, fy + 2.7, zb], K.GLASS_DARK, DECOR);
    }
    if (i === 8 || i === 2) waterTank(b, x0 + 3, H, -36, 1.4);
  }
  // back yards
  for (let i = 0; i < 10; i++) {
    const x0 = -110 + i * 6;
    b.box([x0 + 0.1, Y0, -49.9], [x0 + 5.9, Y0 + 0.1, -42], C.GRASS, { solid: false });
    b.box([x0 + 5.9, Y0, -50], [x0 + 6, 1.9, -42], C.WOOD, { solid: false });
    if (i % 3 !== 1) tree(b, rnd, x0 + 3, -46, Y0, 0.8);
  }
}

function enterableBrownstone(b, x0, x1, col) {
  const T = 0.3, zf = -28, zb = -42, TOP = 12.6;
  const ix0 = x0 + T, ix1 = x1 - T; // interior x -67.7..-62.3
  const A = [ix0, ix0 + 1.1], B = [ix0 + 1.1, ix0 + 2.2]; // two stair strips side by side
  const floors = [1.5, 5.0, 8.5, 12.0];
  const win = (fy) => [[x0 + 0.8, x0 + 2.2, fy + 0.9, fy + 2.7], [x0 + 3.4, x0 + 4.8, fy + 0.9, fy + 2.7]];
  b.wall('x', x0, x1, zf - T, zf, Y0, TOP, col, [[x0 + 3.8, x0 + 5.2, 1.5, 4.0], [x0 + 0.8, x0 + 2.6, 2.0, 4.3], ...win(5), ...win(8.5)]);
  b.wall('x', x0, x1, zb, zb + T, Y0, TOP, col, [[x0 + 2.0, x0 + 4.6, 2.0, 4.3], ...win(5), ...win(8.5)]);
  b.wall('z', zb + T, zf - T, x0, ix0, Y0, TOP, col);
  b.wall('z', zb + T, zf - T, ix1, x1, Y0, TOP, col);
  // floors (white ceiling below, wood above) with the stair openings
  b.box([ix0, Y0, zb + T], [ix1, 1.5, zf - T], C.WOOD);
  const holeA = [A[0], A[1], -35.8, -30.8], holeB = [B[0], B[1], -36.2, -31.0];
  const floorSlab = (y, holes, topCol) => {
    b.slab(ix0, ix1, zb + T, zf - T, y - 0.3, y - 0.1, C.WHITE, holes);
    b.slab(ix0, ix1, zb + T, zf - T, y - 0.1, y, topCol, holes);
  };
  floorSlab(5.0, [holeA], C.WOOD);
  floorSlab(8.5, [holeB], C.WOOD);
  floorSlab(12.0, [holeA], C.ROOF);
  // stair core: partition between the two flights, 3 flights of 17 steps
  b.box([A[1] - 0.05, 1.5, -36.3], [A[1] + 0.05, TOP + 0.4, -30.8], C.WHITE);
  const n = 17, rise = 3.5 / n, run = 0.28;
  for (let i = 0; i < n; i++) {
    for (const fy of [1.5, 8.5]) b.box([A[0], fy, -31 - (i + 1) * run], [A[1] - 0.05, fy + (i + 1) * rise, -31 - i * run], C.WOOD);
    b.box([B[0] + 0.05, 5.0, -36 + i * run], [B[1], 5.0 + (i + 1) * rise, -36 + (i + 1) * run], C.WOOD);
  }
  // railings at the open ends of the holes
  b.box([A[0], 5.0, -30.8], [A[1], 6.0, -30.65], C.WOOD);
  b.box([A[0], 12.0, -30.8], [A[1], 13.0, -30.65], C.DARK);
  b.box([B[1], 8.5, -36.2], [B[1] + 0.1, 9.5, -31.0], C.WOOD);
  b.box([B[0], 8.5, -36.35], [B[1] + 0.1, 9.5, -36.2], C.WOOD);
  // one coloured wall per floor, a ceiling lamp per floor
  const lining = [[0.14, 0.34, 0.2], [0.6, 0.2, 0.18], C.OCHRE];
  for (let f = 0; f < 3; f++) {
    b.box([ix1 - 0.05, floors[f], zb + T], [ix1, floors[f + 1] - 0.3, zf - T], lining[f], DECOR);
    b.box([-64.5, floors[f + 1] - 0.36, -36], [-63.3, floors[f + 1] - 0.3, -34.8], WARM, { emissive: 6, collide: false, solid: false });
  }
  // furniture: parlor sofa + fireplace, bed on the 2nd floor, desk + shelves on the 3rd
  b.box([ix1 - 1, 1.5, -37.5], [ix1 - 0.1, 2.2, -34.5], [0.55, 0.1, 0.08]);
  b.box([ix1 - 0.4, 1.5, -40.5], [ix1, 2.9, -39.0], C.DARK);
  b.box([ix1 - 0.42, 1.6, -40.1], [ix1 - 0.3, 2.2, -39.4], [1, 0.4, 0.1], { emissive: 3, collide: false, solid: false });
  b.box([-65.2, 5.0, -41.6], [-62.4, 5.5, -39.6], [0.88, 0.86, 0.8]);
  b.box([-65.2, 5.5, -40.6], [-62.4, 5.6, -39.6], C.BLUE, DECOR);
  b.box([-63.2, 8.5, -41.6], [-62.4, 10.6, -38.6], C.WOOD);
  b.box([-65.2, 8.5, -30.5], [-63.2, 9.3, -29.5], C.WOOD);
  // roof: a few chairs and planters
  b.box([-64.8, 12.0, -40.5], [-64.2, 12.45, -39.9], C.RED);
  b.box([-63.4, 12.0, -40.5], [-62.8, 12.45, -39.9], C.BLUE);
  b.box([-65.5, 12.0, -29.2], [-62.6, 12.5, -28.6], C.WOOD);
  b.box([-65.4, 12.5, -29.1], [-62.7, 12.6, -28.7], C.GREEN, DECOR);
}

function park(b, rnd, bz, pond) {
  const lot = [-110, bz - 14, -50, bz + 14];
  // lawns between cross paths, low stone wall with gaps at the paths
  const P = 2;
  for (const [xa, xb] of [[lot[0] + 1, -80 - P], [-80 + P, lot[2] - 1]])
    for (const [za, zb] of [[lot[1] + 1, bz - P], [bz + P, lot[3] - 1]]) b.box([xa, Y0, za], [xb, Y0 + 0.12, zb], K.PARK, { solid: false });
  b.wall('x', lot[0], lot[2], lot[1], lot[1] + 0.4, Y0, 0.8, K.STONE, [[-80 - P, -80 + P, 0, 1]]);
  b.wall('x', lot[0], lot[2], lot[3] - 0.4, lot[3], Y0, 0.8, K.STONE, [[-80 - P, -80 + P, 0, 1]]);
  b.wall('z', lot[1] + 0.4, lot[3] - 0.4, lot[0], lot[0] + 0.4, Y0, 0.8, K.STONE, [[bz - P, bz + P, 0, 1]]);
  b.wall('z', lot[1] + 0.4, lot[3] - 0.4, lot[2] - 0.4, lot[2], Y0, 0.8, K.STONE, [[bz - P, bz + P, 0, 1]]);
  if (pond) {
    b.box([-92, Y0, bz + 3], [-68, Y0 + 0.4, bz + 3.4], K.STONE);
    b.box([-92, Y0, bz + 10.6], [-68, Y0 + 0.4, bz + 11], K.STONE);
    b.box([-92, Y0, bz + 3.4], [-91.6, Y0 + 0.4, bz + 10.6], K.STONE);
    b.box([-68.4, Y0, bz + 3.4], [-68, Y0 + 0.4, bz + 10.6], K.STONE);
    b.box([-91.6, Y0, bz + 3.4], [-68.4, Y0 + 0.2, bz + 10.6], K.WATER, { collide: false });
    cyl(b, -80, Y0, bz + 7, 0.6, 1.4, K.STONE);
  } else {
    // bandstand in the middle
    b.box([-84, Y0, bz - 4], [-76, Y0 + 0.6, bz + 4], K.STONE);
    for (const x of [-83.6, -76.4]) for (const z of [bz - 3.6, bz + 3.6]) b.box([x - 0.15, Y0 + 0.6, z - 0.15], [x + 0.15, 4.2, z + 0.15], C.WHITE);
    b.box([-84.5, 4.2, bz - 4.5], [-75.5, 4.5, bz + 4.5], [0.2, 0.35, 0.25]);
  }
  for (const x of [-95, -65]) for (const s of [-1, 1]) b.box([x - 1, Y0, bz + s * (P + 0.3)], [x + 1, Y0 + 0.45, bz + s * (P + 0.8)], C.WOOD);
  for (let i = 0; i < 26; i++) {
    const x = lot[0] + 3 + rnd() * 54, z = lot[1] + 3 + rnd() * 22;
    if (Math.abs(x + 80) < P + 2 || Math.abs(z - bz) < P + 2) continue;
    if (pond && x > -94 && x < -66 && z > bz + 1 && z < bz + 13) continue;
    if (!pond && Math.hypot(x - REF[0], z - REF[2]) < 10) continue; // keep the exposure reference open
    tree(b, rnd, x, z, Y0 + 0.12, 1 + rnd() * 0.4);
  }
}

function landmarks(b, rnd) {
  // Chrysler-like deco tower north of the terminal
  const deco = STYLES.deco, silver = [0.72, 0.74, 0.78];
  const tiers = [[-12, 32, 12, 52, 70], [-9, 35, 9, 49, 110], [-6.5, 37.5, 6.5, 46.5, 138]];
  let y = Y0;
  for (const [x0, z0, x1, z1, top] of tiers) {
    for (let yy = y; yy < top; yy += deco.floorH) {
      const yb = Math.min(top, yy + deco.floorH);
      sides(b, [x0, yy, z0], [x1, yy + (yb - yy) * 0.55, z1], K.LIMESTONE);
      sides(b, [x0, yy + (yb - yy) * 0.55, z0], [x1, yb, z1], K.GLASS_DARK);
    }
    b.box([x0 - 0.3, top - 0.4, z0 - 0.3], [x1 + 0.3, top, z1 + 0.3], shade(K.LIMESTONE, 0.9), { collide: false });
    b.box([x0, Y0, z0], [x1, top, z1], K.LIMESTONE, { visual: false });
    for (let x = x0 + 1.2; x < x1 - 0.5; x += 2.4) for (const [za, zb] of [[z0 - 0.18, z0], [z1, z1 + 0.18]]) b.box([x - 0.24, y + (y === Y0 ? 5.3 : 0), za], [x + 0.24, top - 0.4, zb], K.LIMESTONE, DECOR);
    y = top;
  }
  for (let k = 0; k < 5; k++) {
    const r = 6 - k * 1.1, rz = r * 0.69;
    b.box([-r, y + k * 5, 42 - rz], [r, y + k * 5 + 5, 42 + rz], k % 2 ? silver : shade(silver, 0.8));
    // sunburst windows of the crown
    b.box([-r * 0.6, y + k * 5 + 1.5, 42 - rz - 0.05], [r * 0.6, y + k * 5 + 3, 42 - rz], [1, 0.85, 0.6], { emissive: 1.5, collide: false, solid: false });
    b.box([-r * 0.6, y + k * 5 + 1.5, 42 + rz], [r * 0.6, y + k * 5 + 3, 42 + rz + 0.05], [1, 0.85, 0.6], { emissive: 1.5, collide: false, solid: false });
  }
  const spire = new THREE.ConeGeometry(1.2, 32, 8);
  spire.translate(0, y + 25 + 16, 42);
  b.addGeom(spire, silver);
  sidewalkTowers(b, rnd, 0, 42, [-12, 12]);

  // Empire-State-like tower two blocks further north
  let ey = Y0;
  for (const [hw, hd, top] of [[26, 13, 24], [17, 9, 100], [12, 7, 160], [7.5, 5, 186], [4, 3, 200]]) {
    for (let yy = ey; yy < top; yy += 3.6) {
      const yb = Math.min(top, yy + 3.6);
      sides(b, [-hw, yy, 126 - hd], [hw, yy + (yb - yy) * 0.55, 126 + hd], K.LIMESTONE);
      sides(b, [-hw, yy + (yb - yy) * 0.55, 126 - hd], [hw, yb, 126 + hd], K.GLASS_DARK);
    }
    b.box([-hw - 0.3, top - 0.4, 126 - hd - 0.3], [hw + 0.3, top, 126 + hd + 0.3], K.LIMESTONE, { collide: false });
    b.box([-hw, Y0, 126 - hd], [hw, top, 126 + hd], K.LIMESTONE, { visual: false });
    ey = top;
  }
  cyl(b, 0, ey, 126, 1.6, 16, K.SILVER, { seg: 10 });
  cyl(b, 0, ey + 16, 126, 0.35, 30, K.SILVER, { seg: 6, collide: false });
}

/** fill the rest of a block around a reserved x-range */
function sidewalkTowers(b, rnd, bx, bz, [ra, rb]) {
  const lot = [bx - 30, bz - 14, bx + 30, bz + 14];
  fillLot(b, rnd, lot[0], lot[1], bx + ra, lot[3], { lot, hMax: 90 });
  fillLot(b, rnd, bx + rb, lot[1], lot[2], lot[3], { lot, hMax: 90 });
}

function blocks(b, rnd) {
  const cols = AX.slice(0, -1).map((a, i) => (a + AX[i + 1]) / 2); // -320 .. 160
  const rows = SZ.slice(0, -1).map((a, i) => (a + SZ[i + 1]) / 2); // -210 .. 210
  for (const bx of cols) {
    for (const bz of rows) {
      const core = CORE_X.includes(bx) && CORE_Z.includes(bz);
      const ring = !core && bx >= -160 && bx <= 160 && Math.abs(bz) <= 126;
      const holes = bx === 0 && bz === 0 ? [STAIR_W] : bx === 80 && bz === -42 ? [STAIR_E] : [];
      const lot = sidewalk(b, bx, bz, holes);
      if (bx === 0 && bz === 126) continue; // Empire State (landmarks)
      if (bx === 0 && bz === 42) continue; // deco tower (landmarks)
      if (!core) {
        const lod = ring ? 1 : 2;
        fillLot(b, rnd, ...lot, { lod, hMin: ring ? 30 : 25, hMax: ring ? 150 : 110 });
        continue;
      }
      if (bx === -80 && (bz === 42 || bz === 84)) { park(b, rnd, bz, bz === 84); continue; }
      if (bx === 0 && bz === 0) { terminal(b, rnd); continue; }
      if (bx === -80 && bz === -42) {
        brownstones(b, rnd);
        fillLot(b, rnd, lot[0], lot[1], lot[2], -50, { lot, hMin: 7, hMax: 9 }); // low garages: sun reaches the back windows
        continue;
      }
      // "Times Square": billboard towers on the four corners of the crossing at (40, -63)
      if (bx === 0 && (bz === -84 || bz === -42)) {
        const n = bz === -84; // corner at the block's north-east
        const [za, zb] = n ? [-84, -70] : [-56, -42];
        tower(b, 16, za, 30, zb, 70 + rnd() * 30, STYLES.stone, rnd, { lot });
        billboards(b, rnd, '+x', za + 0.5, zb - 0.5, 30.18, 5.5, 36);
        billboards(b, rnd, n ? '+z' : '-z', 16.5, 29.5, n ? -70 + 0.18 : -56 - 0.18, 5.5, 36);
        fillLot(b, rnd, lot[0], lot[1], 16, lot[3], { lot });
        fillLot(b, rnd, 16, n ? lot[1] : -42, 30, n ? -84 : lot[3], { lot });
        continue;
      }
      if (bx === 80 && bz === -84) {
        tower(b, 50, -84, 64, -70, 60 + rnd() * 30, STYLES.glass, rnd, { lot });
        billboards(b, rnd, '-x', -83.5, -70.5, 50 - 0.18, 5.5, 36);
        billboards(b, rnd, '+z', 50.5, 63.5, -70 + 0.18, 5.5, 36);
        fillLot(b, rnd, 64, lot[1], lot[2], lot[3], { lot });
        fillLot(b, rnd, 50, lot[1], 64, -84, { lot });
        continue;
      }
      if (bx === 80 && bz === -42) {
        diner(b);
        tower(b, 50, -56, 64, -40, 32, STYLES.brick, rnd, { lot });
        billboards(b, rnd, '-x', -55.5, -40.5, 50 - 0.18, 5.5, 30);
        billboards(b, rnd, '-z', 50.5, 63.5, -56 - 0.18, 5.5, 30);
        fillLot(b, rnd, 64, lot[1], lot[2], lot[3], { lot });
        continue;
      }
      fillLot(b, rnd, ...lot, { lot });
    }
  }
  // sidewalk trees + hydrants along the core streets
  for (const bx of CORE_X) for (const bz of CORE_Z) {
    if (bx === -80 && bz > 0) continue;
    for (const s of [-1, 1]) {
      for (let x = bx - 26; x <= bx + 26; x += 9 + rnd() * 6) {
        if (rnd() < 0.4) continue;
        const z = bz + s * (14 + WALK_STR - 0.9);
        if (bx === 80 && bz === -42 && s > 0 && x < 66) continue; // diner corner
        if (bx === -80 && bz === -42 && s > 0) continue; // stoops
        if (bx === 0 && bz === 0) continue; // terminal plazas stay clear
        tree(b, rnd, x, z, Y0, 0.75);
      }
      const hx = bx + s * 29, hz = bz - 14 - WALK_STR + 0.6;
      if (!(bx === 80 && bz === -42 && s < 0)) cyl(b, hx, Y0, hz, 0.18, 0.75, [0.75, 0.08, 0.05], { seg: 6 });
    }
  }
}

function build(withPbr) {
  setPalette(withPbr);
  const b = new Builder();
  const rnd = mulberry32(1905);
  streets(b, rnd);
  blocks(b, rnd);
  station(b, rnd);
  landmarks(b, rnd);
  return { geometry: b.finish(), textured: b.finishTextured(), colliders: b.colliders, solids: b.solids };
}

export default {
  id: 'city',
  name: 'City (PBR)',
  build: () => build(true),
  // PBR texture sets (public/textures/freepbr/), loaded by Lighting.setWorld before the bake
  materials: MATS,
  // coarse global over the walkable core (3 x 5 blocks and their streets, doubled spacing: a large,
  // mostly open world) + fine local volumes around the interiors. Volumes blend in xz only, so the
  // subway volume also covers the avenue above it. Towers above and outer blocks clamp to the edge.
  volumes: (Q) => {
    const fs = Q.fine, p = fs + 0.2;
    return [
      ['global', [-132, 0.5, -114], [132, 27, 114], Q.coarse.map((v) => v * 2)],
      ['terminal', [-30 - p, 0.75, -14 - p], [30 + p, 25, 14 + p], [2 * fs, 2 * fs, 2 * fs]],
      ['subway', [27.5 - p, ST.pit + 0.5, ST.z0 - p], [52.5 + p, 6, STAIR_W[3] + p], [fs, fs, 2 * fs]],
      ['diner', [50 - p, 0.75, -40 - p], [64 + p, 5, -28 + p], [fs, fs, fs]],
      ['brownstone', [-68 - p, 0.75, -42 - p], [-62 + p, 13.5, -28 + p], [fs, fs, fs]],
    ];
  },
  refPoint: REF, // the park lawn (open sunlit air, auto-exposure reference)
  shadow: { radius: 180, center: [0, 0, 0] }, // static sun map, must cover the probes
  fog: { near: 160, far: 700 },
  timeOfDay: 0.3,
  playerSpawn: [38, 0, -12], // on the avenue, the terminal and a subway entrance ahead
  playerYaw: 2.67,
  // enemy spawns around the player's start: avenue, cross streets, terminal concourse, diner corner
  spawns: [
    [40, 0, -48], [40, 0, 24], [14, 0, -21], [66, 0, -21], [0, Y0, -8], [-20, 0, 21], [60, 0, 21],
  ],
};
