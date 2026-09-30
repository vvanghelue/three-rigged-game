// "Street" map: a city crossroads closed in by buildings, with dead-end alleys (enemy spawns),
// an arcade (covered walkway lit by shop windows), a bus shelter, parked cars, barriers and crates.
// Flat colors only (vertex colors + per-vertex emissive), built with the probe-GI Builder so the
// whole static world is a single draw call for the probe bake.
import * as THREE from 'three';
import { Builder, C, mulberry32, noisyGround } from '../lighting/builder.js';

const COL = {
  ASPHALT: [0.13, 0.13, 0.145],
  SIDEWALK: [0.5, 0.49, 0.46],
  CURB: [0.62, 0.6, 0.56],
  LINE: [0.85, 0.75, 0.35],
  ZEBRA: [0.8, 0.8, 0.78],
  GLASS: [0.05, 0.07, 0.09],
  LIT: [1.0, 0.78, 0.45],
  DOOR: [0.12, 0.08, 0.06],
  CORNICE: [0.28, 0.27, 0.26],
  METAL: [0.15, 0.15, 0.16],
  LAMP: [1.0, 0.85, 0.62],
  DUMPSTER: [0.08, 0.28, 0.16],
  CONCRETE: [0.6, 0.58, 0.54],
  SOIL: [0.16, 0.1, 0.06],
};
const FX = { collide: false, solid: false }; // visual detail only

// Map extents: building fronts at x = +-22 and z = +-18
const X = 22, Z = 18, SW = 3; // sidewalk width

/**
 * Windows on one face of a building.
 * face: 'n' (+z), 's' (-z), 'e' (+x), 'w' (-x). y0: first upper floor.
 */
function facade(b, rnd, box, face, { y0 = 3.8, shops = true, litChance = 0.12 } = {}) {
  const [x0, , z0] = box.min, [x1, h, z1] = box.max;
  const alongX = face === 'n' || face === 's';
  const u0 = alongX ? x0 : z0, u1 = alongX ? x1 : z1;
  const plane = { n: z1, s: z0, e: x1, w: x0 }[face];
  const out = face === 'n' || face === 'e' ? 1 : -1;
  const panel = (ua, ub, ya, yb, color, emissive = 0, depth = 0.06) => {
    const ta = Math.min(plane - out * 0.01, plane + out * depth), tb = Math.max(plane - out * 0.01, plane + out * depth);
    if (alongX) b.box([ua, ya, ta], [ub, yb, tb], color, { ...FX, emissive });
    else b.box([ta, ya, ua], [tb, yb, ub], color, { ...FX, emissive });
  };
  // upper floors
  const n = Math.floor((u1 - u0 - 1) / 3);
  const start = (u0 + u1) / 2 - ((n - 1) * 3) / 2;
  for (let y = y0; y + 1.6 < h - 0.8; y += 3.2) {
    for (let i = 0; i < n; i++) {
      const u = start + i * 3;
      const lit = rnd() < litChance;
      panel(u - 0.7, u + 0.7, y, y + 1.6, lit ? COL.LIT : COL.GLASS, lit ? 1.4 : 0);
    }
  }
  // ground floor: shop windows + doors
  if (shops) {
    const m = Math.floor((u1 - u0 - 1) / 5);
    const s0 = (u0 + u1) / 2 - ((m - 1) * 5) / 2;
    for (let i = 0; i < m; i++) {
      const u = s0 + i * 5;
      const lit = rnd() < 0.55;
      panel(u - 1.6, u + 0.9, 0.6, 2.8, lit ? COL.LIT : COL.GLASS, lit ? 0.9 : 0);
      panel(u + 1.2, u + 2.2, 0, 2.3, COL.DOOR);
    }
  }
}

function building(b, rnd, min, max, color, faces = [], opts) {
  b.box(min, max, color);
  // cornice
  b.box([min[0] - 0.25, max[1], min[2] - 0.25], [max[0] + 0.25, max[1] + 0.45, max[2] + 0.25], COL.CORNICE, { collide: false });
  for (const f of faces) facade(b, rnd, { min, max }, f, opts);
}

function streetLamp(b, x, z, dx, dz) {
  b.box([x - 0.08, 0, z - 0.08], [x + 0.08, 5, z + 0.08], COL.METAL);
  const ax = x + dx * 1.2, az = z + dz * 1.2;
  b.box([Math.min(x, ax) - 0.05, 4.9, Math.min(z, az) - 0.05], [Math.max(x, ax) + 0.05, 5.0, Math.max(z, az) + 0.05], COL.METAL, FX);
  b.box([ax - 0.25, 4.78, az - 0.18], [ax + 0.25, 4.9, az + 0.18], COL.LAMP, { ...FX, emissive: 9 });
}

function crate(b, x, z, y = 0, s = 0.9) {
  b.box([x - s / 2, y, z - s / 2], [x + s / 2, y + s, z + s / 2], C.WOOD);
  b.box([x - s / 2 - 0.02, y + s * 0.42, z - s / 2 - 0.02], [x + s / 2 + 0.02, y + s * 0.58, z + s / 2 + 0.02], [0.3, 0.19, 0.09], FX);
}

function car(b, x0, z0, alongZ, color) {
  // footprint 2 x 4.4 m
  const box = (a, c, col, o) => (alongZ ? b.box([x0 + a[0], a[1], z0 + a[2]], [x0 + c[0], c[1], z0 + c[2]], col, o) : b.box([x0 + a[2], a[1], z0 + a[0]], [x0 + c[2], c[1], z0 + c[0]], col, o));
  box([0, 0.3, 0], [2, 1.05, 4.4], color);
  box([0.15, 1.05, 1.1], [1.85, 1.65, 3.4], COL.GLASS);
  box([0.05, 0, 0.5], [1.95, 0.45, 1.2], [0.04, 0.04, 0.04], FX);
  box([0.05, 0, 3.2], [1.95, 0.45, 3.9], [0.04, 0.04, 0.04], FX);
  box([0.2, 0.7, 4.4], [0.6, 0.9, 4.45], COL.LAMP, { ...FX, emissive: 3 }); // headlights
  box([1.4, 0.7, 4.4], [1.8, 0.9, 4.45], COL.LAMP, { ...FX, emissive: 3 });
  box([0.2, 0.75, -0.05], [0.6, 0.9, 0], [0.9, 0.05, 0.03], { ...FX, emissive: 2 }); // tail lights
  box([1.4, 0.75, -0.05], [1.8, 0.9, 0], [0.9, 0.05, 0.03], { ...FX, emissive: 2 });
}

function dumpster(b, x0, z0, x1, z1) {
  b.box([x0, 0, z0], [x1, 1.25, z1], COL.DUMPSTER);
  b.box([x0 - 0.05, 1.25, z0 - 0.05], [x1 + 0.05, 1.33, z1 + 0.05], [0.05, 0.15, 0.08], FX);
}

function doorLight(b, face, x, z, color = COL.LIT) {
  // door + small wall lamp above it on an alley wall; face: direction the wall faces
  const [ox, oz] = { e: [1, 0], w: [-1, 0], n: [0, 1], s: [0, -1] }[face];
  // extent from the wall plane outward by d, along the facing axis
  const span = (p, o, d) => [Math.min(p, p + o * d), Math.max(p, p + o * d)];
  if (ox) {
    const [a, c] = span(x, ox, 0.08), [la, lc] = span(x, ox, 0.22);
    b.box([a, 0, z - 0.6], [c, 2.2, z + 0.6], COL.DOOR, FX);
    b.box([la, 2.45, z - 0.18], [lc, 2.6, z + 0.18], color, { ...FX, emissive: 10 });
  } else {
    const [a, c] = span(z, oz, 0.08), [la, lc] = span(z, oz, 0.22);
    b.box([x - 0.6, 0, a], [x + 0.6, 2.2, c], COL.DOOR, FX);
    b.box([x - 0.18, 2.45, la], [x + 0.18, 2.6, lc], color, { ...FX, emissive: 10 });
  }
}

// South-east building (6 m) with a walkable roof: a parapet instead of the solid cornice slab,
// and an outdoor stair along its street front (sidewalk, rising toward +x) through a gap in it.
function roofStairsBuilding(b, rnd) {
  const x0 = 14, x1 = 36, z0 = -30, z1 = -Z, H = 6, P = 0.45; // P: parapet height (> STEP)
  const color = [0.58, 0.3, 0.22];
  b.box([x0, 0, z0], [x1, H, z1], color);
  facade(b, rnd, { min: [x0, 0, z0], max: [x1, H, z1] }, 'n');
  // parapet rim (0.25 m past the walls, like the cornice), gap at the top of the stairs
  const gap = [20.3, 21.9];
  const rim = (min, max) => b.box(min, max, COL.CORNICE);
  rim([x0 - 0.25, H, z0 - 0.25], [x1 + 0.25, H + P, z0 + 0.25]);
  rim([x0 - 0.25, H, z0 + 0.25], [x0 + 0.25, H + P, z1 + 0.25]);
  rim([x1 - 0.25, H, z0 + 0.25], [x1 + 0.25, H + P, z1 + 0.25]);
  rim([x0 + 0.25, H, z1 - 0.25], [gap[0], H + P, z1 + 0.25]);
  rim([gap[1], H, z1 - 0.25], [x1 - 0.25, H + P, z1 + 0.25]);
  // stairs: 20 steps of 0.3 m (under STEP) from x = 14.2 up to the landing in the gap
  const sz0 = z1 + 0.25, sz1 = z1 + 1.45; // 1.2 m wide, along the facade
  const n = 20, rise = H / n, sx0 = x0 + 0.2, run = (gap[0] - sx0) / n;
  const STAIR = [0.46, 0.44, 0.42];
  for (let i = 0; i < n; i++) b.box([sx0 + i * run, 0, sz0], [sx0 + (i + 1) * run, (i + 1) * rise, sz1], STAIR);
  b.box([gap[0], 0, z1 - 0.1], [gap[1], H, sz1], STAIR); // landing, bridges into the roof
  // handrail on the street side (visual)
  const rail = [0.15, 0.15, 0.16];
  for (let i = 0; i <= n; i += 4) {
    const x = sx0 + i * run + run / 2, y = Math.min(n, i + 1) * rise;
    b.box([x - 0.03, y, sz1 - 0.08], [x + 0.03, y + 0.95, sz1 - 0.02], rail, FX);
  }
  {
    const len = Math.hypot(gap[0] - sx0, H);
    const g = new THREE.BoxGeometry(len, 0.05, 0.05);
    g.rotateZ(Math.atan2(H, gap[0] - sx0));
    g.translate((sx0 + gap[0]) / 2, H / 2 + rise + 0.95, sz1 - 0.05);
    b.addGeom(g, rail);
  }
}

function build() {
  const b = new Builder();
  const rnd = mulberry32(1337);

  // ground: asphalt visual + one big collider
  noisyGround(b, COL.ASPHALT, { size: 400, segments: 100, seed: 3 });
  b.box([-200, -2, -200], [200, 0, 200], COL.ASPHALT, { visual: false });

  // sidewalks (0.15 m, steppable) with a lighter curb line
  const walk = (min, max) => b.box(min, max, COL.SIDEWALK);
  walk([-X, 0, Z - SW], [-8, 0.15, Z]);
  walk([-8, 0, Z - SW], [10, 0.15, 24]); // runs under the arcade
  walk([10, 0, Z - SW], [X, 0.15, Z]);
  walk([-X, 0, -Z], [X, 0.15, -Z + SW]);
  walk([-X, 0, -Z + SW], [-X + SW, 0.15, Z - SW]);
  walk([X - SW, 0, -Z + SW], [X, 0.15, Z - SW]);
  const curb = (min, max) => b.box(min, max, COL.CURB, FX);
  curb([-X + SW, 0, -Z + SW], [X - SW, 0.16, -Z + SW + 0.2]);
  curb([-X + SW, 0, Z - SW - 0.2], [X - SW, 0.16, Z - SW]);
  curb([-X + SW, 0, -Z + SW + 0.2], [-X + SW + 0.2, 0.16, Z - SW - 0.2]);
  curb([X - SW - 0.2, 0, -Z + SW + 0.2], [X - SW, 0.16, Z - SW - 0.2]);

  // road markings: dashed center lines + two crosswalks
  for (let u = -X + SW + 1; u < X - SW - 1; u += 4) {
    if (Math.abs(u + 1) < 5) continue;
    b.box([u, 0, -0.08], [u + 2, 0.012, 0.08], COL.LINE, FX);
  }
  for (let u = -Z + SW + 1; u < Z - SW - 1; u += 4) {
    if (Math.abs(u + 1) < 5 || Math.abs(Math.abs(u + 1) - 10.5) < 3) continue; // planter, crosswalks
    b.box([-0.08, 0, u], [0.08, 0.012, u + 2], COL.LINE, FX);
  }
  for (const zc of [-10.5, 10.5]) for (let x = -3; x < 3; x += 1) b.box([x + 0.1, 0, zc - 1.5], [x + 0.6, 0.012, zc + 1.5], COL.ZEBRA, FX);

  // ---- buildings: north row (fronts face -z) --------------------------------
  const BRICK = [0.5, 0.24, 0.17];
  building(b, rnd, [-36, 0, Z], [-12, 15, 30], BRICK, ['s']);
  b.box([-12, 0, 27], [-8, 15, 30], BRICK); // north alley back wall
  // arcade building: upper floors over a covered walkway, recessed shop fronts at z = 24
  const ARC = [0.72, 0.68, 0.6];
  b.box([-8, 4.4, Z], [10, 19, 30], ARC);
  b.box([-8.25, 19, Z - 0.25], [10.25, 19.45, 30], COL.CORNICE, { collide: false });
  facade(b, rnd, { min: [-8, 0, Z], max: [10, 19, 30] }, 's', { y0: 6, shops: false });
  b.box([-8, 0, 24], [10, 4.4, 30], ARC);
  facade(b, rnd, { min: [-8, 0, 24], max: [10, 4.4, 30] }, 's', { y0: 99 });
  for (const x of [-7.7, -3.2, 1.0, 5.4, 9.7]) b.box([x - 0.3, 0, Z], [x + 0.3, 4.4, Z + 0.6], ARC);
  b.box([-6, 3.1, 23.9], [-2, 3.7, 24], [1.0, 0.15, 0.5], { ...FX, emissive: 5 }); // neon signs
  b.box([2, 3.1, 23.9], [6.5, 3.7, 24], [0.1, 0.8, 1.0], { ...FX, emissive: 5 });
  building(b, rnd, [10, 0, Z], [36, 12, 30], [0.3, 0.36, 0.45], ['s']);

  // ---- south row (fronts face +z) ---------------------------------------------
  const OCHRE = [0.62, 0.48, 0.3];
  building(b, rnd, [-36, 0, -30], [-4, 7, -Z], OCHRE, ['n']);
  b.box([-4, 0, -30], [0, 7, -27], OCHRE); // south alley back wall
  building(b, rnd, [0, 0, -30], [14, 9, -Z], [0.42, 0.47, 0.4], ['n']);
  roofStairsBuilding(b, rnd);

  // ---- west column (fronts face +x) ---------------------------------------------
  const GREY = [0.52, 0.53, 0.56];
  building(b, rnd, [-36, 0, -Z], [-X, 11, -2], GREY, ['e']);
  b.box([-36, 0, -2], [-30, 11, 2], GREY); // west alley back wall
  building(b, rnd, [-36, 0, 2], [-X, 9, Z], [0.68, 0.62, 0.52], ['e']);
  b.box([-X, 3.4, -12], [-X + 0.1, 4.2, -6], [0.2, 0.4, 1.0], { ...FX, emissive: 4 });

  // ---- east column (fronts face -x) ---------------------------------------------
  const PALE = [0.72, 0.7, 0.66];
  building(b, rnd, [X, 0, -Z], [36, 8, 4], PALE, ['w']);
  b.box([30, 0, 4], [36, 8, 8], PALE); // east alley back wall
  building(b, rnd, [X, 0, 8], [36, 13, Z], [0.4, 0.3, 0.34], ['w']);
  b.box([X - 0.1, 4, 11], [X, 9, 11.8], [1.0, 0.35, 0.1], { ...FX, emissive: 4 });

  // alley dressing: dumpsters + door lamps (dark, lamp-lit dead ends)
  dumpster(b, -11.7, 24.6, -10.2, 26.6);
  doorLight(b, 'e', -12, 22.5);
  dumpster(b, -3.8, -26.6, -2.3, -24.8);
  doorLight(b, 'e', -4, -23.5, [0.5, 0.8, 1.0]);
  dumpster(b, -29.6, 0.3, -27.8, 1.8);
  doorLight(b, 's', -26, 2);
  crate(b, 28.8, 4.6);
  crate(b, 28.8, 5.5);
  crate(b, 28.8, 5.05, 0.9);
  doorLight(b, 'n', 26, 4, [1.0, 0.45, 0.2]);

  // ---- street furniture ----------------------------------------------------------
  // central planter with a tree
  b.box([-3, 0, -3], [3, 0.35, 3], COL.CONCRETE);
  b.box([-2.6, 0.35, -2.6], [2.6, 0.4, 2.6], COL.SOIL, FX);
  b.box([-0.2, 0.4, -0.2], [0.2, 3.2, 0.2], C.TRUNK);
  {
    const g = new THREE.IcosahedronGeometry(2.1, 1);
    g.scale(1, 0.85, 1);
    g.translate(0, 4.4, 0);
    b.addGeom(g, [0.12, 0.3, 0.07]);
  }

  // bus shelter (south sidewalk)
  b.box([6, 0.15, -17.7], [11, 2.5, -17.55], [0.25, 0.32, 0.36]);
  for (const x of [6.1, 10.9]) b.box([x - 0.06, 0.15, -16.0], [x + 0.06, 2.5, -15.88], COL.METAL);
  b.box([5.8, 2.5, -17.8], [11.2, 2.62, -15.6], [0.2, 0.2, 0.22], { collide: false });
  b.box([6.2, 2.45, -16.9], [10.8, 2.5, -16.6], [0.85, 0.95, 1.0], { ...FX, emissive: 4 });
  b.box([6.6, 0.15, -17.5], [10.4, 0.55, -17.05], C.WOOD);
  b.box([10.95, 0.5, -17.5], [11.05, 2.2, -16.2], [0.9, 0.95, 1.0], { ...FX, emissive: 2.5 });

  // street lamps along the sidewalks (arm toward the road)
  for (const x of [-15, 15]) streetLamp(b, x, Z - SW + 0.5, 0, -1);
  for (const x of [-12, 16]) streetLamp(b, x, -Z + SW - 0.5, 0, 1);
  for (const z of [-9, 9]) streetLamp(b, -X + SW - 0.5, z, 1, 0);
  for (const z of [-13, 13]) streetLamp(b, X - SW + 0.5, z, -1, 0);

  // parked cars
  car(b, 16.4, -10.4, true, [0.6, 0.07, 0.05]);
  car(b, -18.6, 5.6, true, [0.07, 0.18, 0.5]);
  car(b, -14, 12.6, false, [0.75, 0.72, 0.65]);

  // jersey barriers (cover, jumpable)
  b.box([6, 0, 5.7], [9, 0.8, 6.3], COL.CONCRETE);
  b.box([-9.3, 0, -7.5], [-8.7, 0.8, -4.5], COL.CONCRETE);
  b.box([10, 0, -6.3], [13, 0.8, -5.7], COL.CONCRETE);

  // crates
  crate(b, -15, -10); crate(b, -14.1, -10); crate(b, -14.55, -10, 0.9);
  crate(b, 13.5, 10.5); crate(b, 14.3, 11.4, 0, 0.8);
  crate(b, -17.8, -15.5);

  // distant skyline (visual only)
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + rnd() * 0.15;
    const r = 60 + rnd() * 70;
    const w = 10 + rnd() * 14, h = 18 + rnd() * 40;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    const k = 0.35 + rnd() * 0.3;
    b.box([cx - w / 2, 0, cz - w / 2], [cx + w / 2, h, cz + w / 2], [k, k * 1.02, k * 1.08], FX);
  }

  return { geometry: b.finish(), colliders: b.colliders, solids: b.solids };
}

export default {
  id: 'street',
  name: 'Street',
  build,
  // coarse global fallback + fine volume over the street, alleys and arcade
  volumes: (Q) => [
    ['global', [-40, 0.5, -36], [40, 22.5, 36], Q.coarse],
    ['street', [-31, 0.5, -28], [31, 6.5, 28], [Q.fine, Q.fine, Q.fine]],
  ],
  shadow: { radius: 50, center: [0, 0, 0] }, // static sun map, must cover the probes
  fog: { near: 60, far: 320 },
  timeOfDay: 0.26,
  refPoint: [0, 1.6, -8], // open sunlit air (auto-exposure reference)
  playerSpawn: [0, 0, -8],
  playerYaw: Math.PI, // camera yaw at spawn (PI = looking toward +z)
  // enemy spawns: the four dead-end alleys + the arcade
  spawns: [[-10, 0, 22], [-2, 0, -22], [-26, 0, 0], [26, 0, 6], [1, 0, 21]],
};
