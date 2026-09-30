// "Cloister" map: a monastery brawl arena, mostly interior.
// - open-sky courtyard (18 m square) with a fountain, four raised lawns, two cypresses and a cart,
// - a 4 m wide arcaded gallery on all four sides under a lean-to roof (sun reaches the north and
//   west galleries through the arches, the south gallery through slit windows),
// - north: a tall chapel with red / blue / ochre walls, clerestory windows and a stepped dais,
// - west: a refectory-library (long tables, bookshelves, high south windows),
// - east: a windowless reliquary lit only by emissive candles, stained panels and a brazier.
// Flat colors only (vertex colors + per-vertex emissive), built with the probe-GI Builder so the
// whole static world is a single draw call for the probe bake.
// Axes: +x east, +z north. The ring is described per side ('N','S','E','W') with u = coordinate
// along the side and d = distance from the centre, so the four sides share one code path.
import * as THREE from 'three';
import { Builder, C, mulberry32, noisyGround } from '../lighting/builder.js';

const COL = {
  SAND: [0.7, 0.6, 0.46], // arcade stone
  TRIM: [0.55, 0.5, 0.43], // pier bases, cornices
  PLASTER: [0.86, 0.82, 0.74],
  CREAM: [0.8, 0.75, 0.64], // ceilings
  GALLERY: [0.6, 0.56, 0.5], // gallery floor
  PAVING: [0.56, 0.48, 0.38], // courtyard floor
  HALL_FLOOR: [0.5, 0.23, 0.13], // terracotta tiles
  PLANK: [0.62, 0.54, 0.44],
  CRYPT: [0.42, 0.39, 0.35],
  CRYPT_FLOOR: [0.24, 0.22, 0.2],
  ROOF: [0.55, 0.25, 0.14],
  GRASS: [0.2, 0.36, 0.1],
  WATER: [0.08, 0.22, 0.32],
  CYPRESS: [0.06, 0.17, 0.05],
  EARTH: [0.3, 0.3, 0.15],
  GOLD: [0.85, 0.62, 0.2],
  IRON: [0.1, 0.1, 0.11],
  WARM: [1.0, 0.6, 0.25],
  EMBER: [1.0, 0.3, 0.08],
};
const FX = { collide: false, solid: false }; // visual detail only
const PANE = { visual: false, solid: false }; // invisible collider closing a window

// ring layout
const CY = 9; // courtyard half size (arcade courtyard face)
const AW = 9.6; // arcade wall gallery face
const OI = 13.6, OO = 14.2; // outer wall inner / outer face
const HC = 4.2, RS = 4.5; // gallery ceiling / roof slab top
const PIERS = [-9.2, -5.52, -1.84, 1.84, 5.52, 9.2]; // pier centres (0.8 wide)
const OPEN = PIERS.slice(0, -1).map((p, i) => [p + 0.4, PIERS[i + 1] - 0.4]); // 2.88 m arches
// chapel (north, outside the ring)
const HX = 8.6, HT = 0.6, HZ0 = OO, HZ1 = 28, HH = 8.5;
// refectory (west) and reliquary (east)
const RX = -26, RZ = 9; // refectory inner west face, inner half depth
const EX = 22, EZ = 5; // reliquary inner east face, inner half depth

/** map (u along the side, d from the centre) to world boxes for side s */
function sideBox(b, s, u0, u1, d0, d1, y0, y1, color, opts) {
  if (s === 'N') b.box([u0, y0, d0], [u1, y1, d1], color, opts);
  else if (s === 'S') b.box([u0, y0, -d1], [u1, y1, -d0], color, opts);
  else if (s === 'E') b.box([d0, y0, u0], [d1, y1, u1], color, opts);
  else b.box([-d1, y0, u0], [-d0, y1, u1], color, opts);
}
/** Builder.wall with box options (the stock one always makes solid colliders) */
function wall(b, axis, u0, u1, t0, t1, y0, y1, color, openings = [], opts) {
  if (!opts) return b.wall(axis, u0, u1, t0, t1, y0, y1, color, openings);
  Builder.prototype.wall.call({ box: (mn, mx, c) => b.box(mn, mx, c, opts) }, axis, u0, u1, t0, t1, y0, y1, color, openings);
}
function sideWall(b, s, u0, u1, d0, d1, y0, y1, color, openings, opts) {
  if (s === 'N') wall(b, 'x', u0, u1, d0, d1, y0, y1, color, openings, opts);
  else if (s === 'S') wall(b, 'x', u0, u1, -d1, -d0, y0, y1, color, openings, opts);
  else if (s === 'E') wall(b, 'z', u0, u1, d0, d1, y0, y1, color, openings, opts);
  else wall(b, 'z', u0, u1, -d1, -d0, y0, y1, color, openings, opts);
}
const sidePt = (s, u, y, d) => ({ N: [u, y, d], S: [u, y, -d], E: [d, y, u], W: [-d, y, u] })[s];

/** stepped "arch": rectangle + two narrower steps on top */
const arch = ([a, c], y1) => [[a, c, 0, y1], [a + 0.3, c - 0.3, y1, y1 + 0.3], [a + 0.7, c - 0.7, y1 + 0.3, y1 + 0.5]];

/** Convex planar polygon (fan-triangulated), each triangle wound so its normal faces `out`. */
function poly(b, pts, color, out, emissive = 0) {
  const P = [];
  const v = (p) => new THREE.Vector3(...p);
  for (let i = 1; i < pts.length - 1; i++) {
    let [a, c, d] = [v(pts[0]), v(pts[i]), v(pts[i + 1])];
    const n = c.clone().sub(a).cross(d.clone().sub(a));
    if (n.dot(v(out)) < 0) [c, d] = [d, c];
    P.push(...a.toArray(), ...c.toArray(), ...d.toArray());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.computeVertexNormals();
  b.addGeom(g, color, emissive);
}

/** Closed gable roof (visual only): ridge along z (alongZ) or x, eaves at y0, ridge at y0 + h. */
function gableRoof(b, x0, x1, z0, z1, y0, h, alongZ, color) {
  // work in (a = across the ridge, r = along the ridge)
  const P = alongZ ? (a, y, r) => [a, y, r] : (a, y, r) => [r, y, a];
  const O = alongZ ? (a, y, r) => [a, y, r] : (a, y, r) => [r, y, a];
  const [a0, a1, r0, r1] = alongZ ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const am = (a0 + a1) / 2, yr = y0 + h;
  const roofCol = (k) => color.map((c) => c * k);
  poly(b, [P(a0, y0, r0), P(a0, y0, r1), P(am, yr, r1), P(am, yr, r0)], roofCol(1), O(-1, 1, 0));
  poly(b, [P(a1, y0, r0), P(a1, y0, r1), P(am, yr, r1), P(am, yr, r0)], roofCol(0.9), O(1, 1, 0));
  poly(b, [P(a0, y0, r0), P(am, yr, r0), P(a1, y0, r0)], COL.PLASTER, O(0, 0, -1));
  poly(b, [P(a0, y0, r1), P(am, yr, r1), P(a1, y0, r1)], COL.PLASTER, O(0, 0, 1));
  poly(b, [P(a0, y0, r0), P(a1, y0, r0), P(a1, y0, r1), P(a0, y0, r1)], COL.CREAM, [0, -1, 0]);
}

function crate(b, x, z, y = 0, s = 0.9) {
  b.box([x - s / 2, y, z - s / 2], [x + s / 2, y + s, z + s / 2], C.WOOD);
  b.box([x - s / 2 - 0.02, y + s * 0.42, z - s / 2 - 0.02], [x + s / 2 + 0.02, y + s * 0.58, z + s / 2 + 0.02], [0.3, 0.19, 0.09], FX);
}

function cypress(b, rnd, x, z, y, h) {
  b.box([x - 0.15, y, z - 0.15], [x + 0.15, y + 1.3, z + 0.15], C.TRUNK);
  const g = new THREE.ConeGeometry(0.85 + rnd() * 0.3, h, 7);
  g.translate(x, y + 1.1 + h / 2, z);
  b.addGeom(g, COL.CYPRESS.map((v) => v * (0.8 + rnd() * 0.4)));
}

// ---- the cloister ring ----------------------------------------------------------------------
const BAND = { N: C.RED, W: C.BLUE, E: C.GREEN, S: C.OCHRE }; // dado colour per gallery
const HALL_DOORS = [[-5.08, -2.28], [-1.4, 1.4], [2.28, 5.08]];
const REF_DOORS = [[-7.0, -4.4], [-2.2, 2.2], [4.4, 7.0]];
const REL_DOOR = [-1.8, 1.8];

function ring(b) {
  for (const s of ['N', 'S', 'E', 'W']) {
    const ns = s === 'N' || s === 'S'; // N/S walls own the corners, E/W fit between them
    // arcade: 5 stepped arches per side
    sideWall(b, s, ns ? -AW : -CY, ns ? AW : CY, CY, AW, 0, HC, COL.SAND, OPEN.flatMap((o) => arch(o, 3.0)));
    // pier bases + impost blocks (inner piers; the corners get one square block below)
    for (const p of PIERS.slice(1, -1)) {
      sideBox(b, s, p - 0.48, p + 0.48, CY - 0.08, AW + 0.08, 0, 0.3, COL.TRIM, FX);
      sideBox(b, s, p - 0.46, p + 0.46, CY - 0.06, AW + 0.06, 2.85, 3.0, COL.TRIM, FX);
    }
    // courtyard cornice under the eave
    sideBox(b, s, ns ? -8.6 : -8.45, ns ? 8.6 : 8.45, 8.45, 8.6, 4.35, RS, COL.TRIM, FX);

    // outer wall with the room doorways and (sunny south / east sides) slit windows
    const doors = { N: HALL_DOORS.flatMap((o) => arch(o, 3.2)), W: REF_DOORS.flatMap((o) => arch(o, 3.2)), E: arch(REL_DOOR, 3.0), S: [] }[s];
    const slits = { S: [-7.36, -3.68, 0, 3.68, 7.36], E: [-7.36, 7.36], N: [], W: [] }[s].map((u) => [u - 0.45, u + 0.45, 2.2, 3.6]);
    sideWall(b, s, ns ? -OO : -OI, ns ? OO : OI, OI, OO, 0, HC, COL.PLASTER, [...doors, ...slits]);
    for (const [a, c, y0, y1] of slits) sideBox(b, s, a, c, OI + 0.25, OI + 0.35, y0, y1, COL.PLASTER, PANE);
    // saturated dado band on the gallery side of the outer wall
    sideWall(b, s, ns ? -OI : -OI + 0.06, ns ? OI : OI - 0.06, OI - 0.06, OI, 0, 1.2, BAND[s], doors, FX);
    // ceiling beams across the gallery
    for (const p of PIERS.slice(1, -1)) sideBox(b, s, p - 0.14, p + 0.14, AW, OI, HC - 0.25, HC, C.WOOD, FX);
    // hanging lanterns
    for (const u of [-5.52, 5.52]) {
      const [x, , z] = sidePt(s, u, 0, 11.6);
      b.box([x - 0.02, 3.35, z - 0.02], [x + 0.02, HC - 0.25, z + 0.02], COL.IRON, FX);
      b.box([x - 0.16, 2.95, z - 0.16], [x + 0.16, 3.35, z + 0.16], COL.WARM, { ...FX, emissive: 4 });
    }
    // lean-to roof: sloped hip segment from the eave (d 8.6) up to the outer wall + fascia
    poly(b, [sidePt(s, -8.6, RS, 8.6), sidePt(s, 8.6, RS, 8.6), sidePt(s, 14.15, 5.7, 14.15), sidePt(s, -14.15, 5.7, 14.15)], COL.ROOF, sidePt(s, 0, 1, -0.5));
    poly(b, [sidePt(s, -14.15, RS, 14.15), sidePt(s, 14.15, RS, 14.15), sidePt(s, 14.15, 5.7, 14.15), sidePt(s, -14.15, 5.7, 14.15)], COL.PLASTER, sidePt(s, 0, 0, 1));
  }
  // corner pier plinths
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = sx > 0 ? CY - 0.08 : -AW - 0.08, z0 = sz > 0 ? CY - 0.08 : -AW - 0.08;
    b.box([x0, 0, z0], [x0 + 0.76, 0.3, z0 + 0.76], COL.TRIM, FX);
  }

  // floors: gallery ring (runs under the walls and the door thresholds), courtyard paving
  b.slab(-OO, OO, -OO, OO, 0, 0.04, COL.GALLERY, [[-CY, CY, -CY, CY]], { solid: false });
  b.box([-CY, 0, -CY], [CY, 0.04, CY], COL.PAVING, { solid: false });
  // ceiling slab (the chapel's tall south wall cuts through it)
  b.slab(-OO, OO, -OO, OO, HC, RS, COL.CREAM, [[-8.6, 8.6, -8.6, 8.6], [-HX - HT, HX + HT, OI, OO]]);

  // gallery furniture: benches along the south and east outer walls, crate stacks in the corners
  for (const u of [-6.5, 4.3]) sideBox(b, 'S', u, u + 2.2, OI - 0.55, OI - 0.06, 0, 0.45, C.WOOD);
  for (const u of [-8.8, 6.3]) sideBox(b, 'E', u, u + 2.4, OI - 0.55, OI - 0.06, 0, 0.45, C.WOOD);
  crate(b, -12.6, 12.6); crate(b, -11.7, 12.7, 0, 0.8); crate(b, -12.6, 12.6, 0.9, 0.8);
  crate(b, 12.9, -12.9, 0, 0.8);
}

function courtyard(b, rnd) {
  // four raised lawns (0.25 m, steppable) with a stone curb
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = sx > 0 ? 3 : -7.6, z0 = sz > 0 ? 3 : -7.6;
    b.box([x0, 0, z0], [x0 + 4.6, 0.25, z0 + 4.6], COL.TRIM, { solid: false });
    b.box([x0 + 0.15, 0.25, z0 + 0.15], [x0 + 4.45, 0.27, z0 + 4.45], COL.GRASS, FX);
  }
  for (const [x, z, h] of [[-5.3, 5.3, 5.5], [5.3, -5.3, 5]]) {
    cypress(b, rnd, x, z, 0.25, h);
    b.box([x - 0.55, 0.25, z - 0.55], [x + 0.55, 3, z + 0.55], C.LEAF, { visual: false, solid: false }); // foliage blocks
  }

  // fountain: steppable basin (rim 0.38 m, water 0.28 m), blocking central column + bowl
  const R0 = 2, T = 0.3;
  b.box([-R0, 0, -R0], [R0, 0.38, -R0 + T], COL.SAND);
  b.box([-R0, 0, R0 - T], [R0, 0.38, R0], COL.SAND);
  b.box([-R0, 0, -R0 + T], [-R0 + T, 0.38, R0 - T], COL.SAND);
  b.box([R0 - T, 0, -R0 + T], [R0, 0.38, R0 - T], COL.SAND);
  b.box([-R0 + T, 0, -R0 + T], [R0 - T, 0.28, R0 - T], COL.WATER, { solid: false });
  b.box([-0.35, 0.28, -0.35], [0.35, 1.1, 0.35], COL.SAND);
  b.box([-0.8, 1.1, -0.8], [0.8, 1.3, 0.8], COL.SAND);
  b.box([-0.66, 1.3, -0.66], [0.66, 1.32, 0.66], COL.WATER, FX);
  b.box([-0.14, 1.3, -0.14], [0.14, 2.0, 0.14], COL.SAND);
  b.box([-0.28, 2.0, -0.28], [0.28, 2.14, 0.28], COL.TRIM);

  // hay cart on the north-east lawn (cover, climbable)
  const y = 0.25;
  b.box([4.6, y + 0.45, 3.8], [6.0, y + 0.95, 6.6], C.WOOD);
  b.box([4.6, y + 0.95, 3.8], [4.7, y + 1.25, 6.6], C.WOOD, FX); // side boards
  b.box([5.9, y + 0.95, 3.8], [6.0, y + 1.25, 6.6], C.WOOD, FX);
  b.box([4.7, y + 0.95, 4.2], [5.9, y + 1.25, 6.2], [0.75, 0.62, 0.3], FX); // hay
  for (const x of [4.42, 6.0]) b.box([x, y, 4.75], [x + 0.18, y + 0.9, 5.65], [0.25, 0.16, 0.08], FX); // wheels
  for (const x of [4.8, 5.7]) b.box([x, y + 0.55, 6.6], [x + 0.1, y + 0.65, 7.5], C.WOOD, FX); // shafts

  // crates on the south-west lawn
  crate(b, -5.3, -5.3, y); crate(b, -4.4, -5.3, y); crate(b, -4.85, -5.3, y + 0.9);
}

// ---- chapel (north) ---------------------------------------------------------------------------
function chapel(b) {
  const X0 = HX + HT; // outer face
  // tall south wall above the gallery roof, with clerestory windows (let the sun in)
  wall(b, 'x', -X0, X0, OI, OO, HC, HH, COL.PLASTER, [-5, 0, 5].map((u) => [u - 1.2, u + 1.2, 5.7, 8.1]));
  // side + north walls; east windows get direct sun, west ones only sky
  const win = [17.5, 21.5, 25].map((z) => [z - 0.9, z + 0.9, 4.6, 7.8]);
  wall(b, 'z', HZ0, HZ1 + HT, HX, X0, 0, HH, COL.PLASTER, win);
  wall(b, 'z', HZ0, HZ1 + HT, -X0, -HX, 0, HH, COL.PLASTER, win);
  b.box([-HX, 0, HZ1], [HX, HH, HZ1 + HT], COL.PLASTER);
  // saturated inner linings: red west, blue east, ochre behind the dais
  wall(b, 'z', HZ0, HZ1 - 0.1, -HX, -HX + 0.1, 0, HH, C.RED, win, { solid: false });
  wall(b, 'z', HZ0, HZ1 - 0.1, HX - 0.1, HX, 0, HH, C.BLUE, win, { solid: false });
  b.box([-HX, 0, HZ1 - 0.1], [HX, HH, HZ1], C.OCHRE, { solid: false });
  // ceiling + pitched roof
  b.box([-X0, HH, OI], [X0, HH + 0.3, HZ1 + HT], COL.CREAM);
  gableRoof(b, -X0 - 0.2, X0 + 0.2, OI - 0.1, HZ1 + HT + 0.2, HH + 0.3, 3, true, COL.ROOF);

  // floor, carpet
  b.box([-HX, 0, HZ0], [HX, 0.04, HZ1], COL.HALL_FLOOR, { solid: false });
  b.box([-1.2, 0.04, HZ0], [1.2, 0.05, 22], [0.55, 0.05, 0.05], FX);
  // columns
  for (const x of [-6.2, 6.2]) for (const z of [17.5, 21.5]) {
    b.box([x - 0.4, 0, z - 0.4], [x + 0.4, HH, z + 0.4], COL.SAND);
    b.box([x - 0.5, 0, z - 0.5], [x + 0.5, 0.35, z + 0.5], COL.TRIM, FX);
    b.box([x - 0.5, HH - 0.35, z - 0.5], [x + 0.5, HH, z + 0.5], COL.TRIM, FX);
  }
  // benches along the side walls
  for (const sx of [-1, 1]) for (const z0 of [15.2, 19]) {
    const x0 = sx > 0 ? HX - 0.1 - 0.55 : -HX + 0.1;
    b.box([x0, 0, z0], [x0 + 0.55, 0.45, z0 + 1.8], C.WOOD);
  }
  // dais: three 0.3 m steps up to a 0.9 m platform
  const DZ = [22, 22.6, 23.2, HZ1 - 0.1];
  for (let i = 0; i < 3; i++) b.box([-6, 0, DZ[i]], [6, 0.3 * (i + 1), DZ[i + 1]], COL.SAND);
  b.box([-6, 0.9, 23.2], [6, 0.92, 23.35], COL.TRIM, FX); // nosing
  // altar with candles, golden reredos, stained rose window, candle stands
  b.box([-1.4, 0.9, 25.2], [1.4, 1.9, 26.3], COL.PLASTER);
  b.box([-1.5, 1.9, 25.1], [1.5, 1.98, 26.4], COL.GOLD, FX);
  b.box([-1.1, 1.98, 25.6], [1.1, 2.18, 25.9], COL.WARM, { ...FX, emissive: 3 });
  b.box([-3, 1.3, HZ1 - 0.2], [3, 5, HZ1 - 0.1], COL.GOLD, FX);
  b.box([-1.3, 5.6, HZ1 - 0.18], [1.3, 7.6, HZ1 - 0.1], [0.1, 0.25, 1.0], { ...FX, emissive: 0.8 });
  b.box([-0.5, 6.1, HZ1 - 0.2], [0.5, 7.1, HZ1 - 0.18], [1.0, 0.12, 0.05], { ...FX, emissive: 0.8 });
  for (const x of [-4.5, 4.5]) {
    b.box([x - 0.06, 0.9, 24.44], [x + 0.06, 2.2, 24.56], COL.IRON);
    b.box([x - 0.2, 2.2, 24.3], [x + 0.2, 2.45, 24.7], COL.WARM, { ...FX, emissive: 4 });
  }
}

// ---- refectory / library (west) ----------------------------------------------------------------
function refectory(b, rnd) {
  const X1 = -OO; // shares the cloister's west outer wall
  // south windows take the sun, west ones only sky
  const sWin = [-23.5, -20, -16.8].map((x) => [x - 1.0, x + 1.0, 1.5, 3.8]);
  const wWin = [-6, 0, 6].map((z) => [z - 0.9, z + 0.9, 2.3, 3.8]);
  wall(b, 'x', RX - 0.6, X1, -RZ - 0.6, -RZ, 0, HC, COL.PLASTER, sWin);
  for (const [a, c, y0, y1] of sWin) b.box([a, y0, -RZ - 0.35], [c, y1, -RZ - 0.25], COL.PLASTER, PANE);
  for (const [a, c, y0, y1] of wWin) b.box([RX - 0.35, y0, a], [RX - 0.25, y1, c], COL.PLASTER, PANE);
  b.box([RX - 0.6, 0, RZ], [X1, HC, RZ + 0.6], COL.PLASTER);
  wall(b, 'z', -RZ, RZ, RX - 0.6, RX, 0, HC, COL.PLASTER, wWin);
  b.box([RX - 0.6, HC, -RZ - 0.6], [X1, RS, RZ + 0.6], COL.CREAM);
  gableRoof(b, RX - 0.8, X1 + 0.1, -RZ - 0.8, RZ + 0.8, RS, 2.5, false, COL.ROOF);
  b.box([RX, 0, -RZ], [X1, 0.04, RZ], COL.PLANK, { solid: false });
  // beams
  for (let x = -24; x < -15; x += 3) b.box([x - 0.14, HC - 0.25, -RZ], [x + 0.14, HC, RZ], C.WOOD, FX);

  // two long tables (legs + top, one collider) with benches
  for (const zc of [-5.1, 5.1]) {
    b.box([-24.5, 0, zc - 0.5], [-17.5, 0.8, zc + 0.5], C.WOOD, { visual: false, solid: false });
    b.box([-24.5, 0.72, zc - 0.5], [-17.5, 0.8, zc + 0.5], C.WOOD, FX);
    for (const x of [-24.3, -21.1, -17.8]) for (const dz of [-0.4, 0.3]) b.box([x, 0, zc + dz], [x + 0.1, 0.72, zc + dz + 0.1], C.WOOD, FX);
    for (const dz of [-0.95, 0.55]) b.box([-24.2, 0, zc + dz], [-17.8, 0.45, zc + dz + 0.4], [0.33, 0.2, 0.1]);
  }
  // bookshelves (north wall, west wall between windows) with colored book rows
  const BOOKS = [C.RED, C.BLUE, C.GREEN, C.OCHRE, C.PURPLE, [0.35, 0.2, 0.1]];
  const books = (u0, u1, face) => {
    for (const y of [0.35, 1.05, 1.75]) for (let u = u0 + 0.05; u < u1 - 0.1;) {
      const w = 0.25 + rnd() * 0.35, h = 0.45 + rnd() * 0.15, col = BOOKS[Math.floor(rnd() * BOOKS.length)];
      const ue = Math.min(u + w, u1 - 0.05);
      if (face === 'n') b.box([u, y, RZ - 0.55], [ue, y + h, RZ - 0.5], col, FX);
      else b.box([RX + 0.5, y, u], [RX + 0.55, y + h, ue], col, FX);
      u = ue + 0.02;
    }
  };
  for (const [x0, x1] of [[-25.6, -21.4], [-20.4, -16.2]]) {
    b.box([x0, 0, RZ - 0.5], [x1, 2.6, RZ], C.WOOD);
    books(x0, x1, 'n');
  }
  for (const [z0, z1] of [[-3.8, -1.2], [1.2, 3.8]]) {
    b.box([RX, 0, z0], [RX + 0.5, 2.2, z1], C.WOOD);
    books(z0, z1, 'w');
  }
  // lectern
  b.box([-15.9, 0, -7.8], [-15.3, 1.2, -7.2], C.WOOD);
}

// ---- reliquary (east): no windows, only emissive light -----------------------------------------
function reliquary(b) {
  const X0 = OO; // shares the cloister's east outer wall
  b.box([X0, 0, -EZ - 0.6], [EX + 0.6, HC, -EZ], COL.CRYPT);
  b.box([X0, 0, EZ], [EX + 0.6, HC, EZ + 0.6], COL.CRYPT);
  b.box([EX, 0, -EZ], [EX + 0.6, HC, EZ], COL.CRYPT);
  b.box([X0, HC, -EZ - 0.6], [EX + 0.6, RS, EZ + 0.6], COL.CRYPT);
  gableRoof(b, X0 - 0.1, EX + 0.8, -EZ - 0.8, EZ + 0.8, RS, 1.8, false, COL.ROOF);
  b.box([X0, 0, -EZ], [EX, 0.04, EZ], COL.CRYPT_FLOOR, { solid: false });

  // shrine with a candle bank against the east wall
  b.box([EX - 0.8, 0, -2], [EX, 1.0, 2], COL.CRYPT);
  b.box([EX - 0.7, 1.0, -1.6], [EX - 0.1, 1.25, 1.6], COL.WARM, { emissive: 2.5, solid: false });
  // brazier (pedestal + glowing embers)
  b.box([18.05, 0, 2.45], [18.75, 0.8, 3.15], COL.IRON);
  const ember = new THREE.IcosahedronGeometry(0.38, 1);
  ember.translate(18.4, 1.05, 2.8);
  b.addGeom(ember, COL.EMBER, 3);
  // stained-glass panels (emissive) on the north and south walls
  const glass = [[16.2, [0.2, 0.4, 1.0]], [19.3, [1.0, 0.15, 0.1]]];
  for (const [x, col] of glass) b.box([x - 0.6, 1.5, EZ - 0.05], [x + 0.6, 3.5, EZ], col, { ...FX, emissive: 3 });
  for (const [x, col] of [[16.2, [0.15, 0.9, 0.3]], [19.3, [0.7, 0.25, 1.0]]]) b.box([x - 0.6, 1.5, -EZ], [x + 0.6, 3.5, -EZ + 0.05], col, { ...FX, emissive: 3 });
  // stone tomb (cover) + hanging lantern
  b.box([17, 0, -4.4], [19.6, 0.85, -3.3], COL.CRYPT);
  b.box([16.9, 0.85, -4.5], [19.7, 0.95, -3.2], COL.TRIM, FX);
  b.box([16.48, 3.1, -1.02], [16.52, HC, -0.98], COL.IRON, FX);
  b.box([16.3, 2.7, -1.2], [16.7, 3.1, -0.8], [0.45, 0.7, 1.0], { ...FX, emissive: 3 });
}

// ---- outside (visual) -------------------------------------------------------------------------
function outside(b, rnd) {
  // bell tower south-east of the cloister
  const [x0, z0, x1, z1] = [16, -20, 20, -16];
  b.box([x0, 0, z0], [x1, 13, z1], COL.PLASTER);
  for (const s of ['x0', 'x1', 'z0', 'z1']) {
    const op = [[-1.2, 1.2, 13.6, 15.8]].map(([a, c, y, yy]) => [(s[0] === 'x' ? (z0 + z1) / 2 : (x0 + x1) / 2) + a, (s[0] === 'x' ? (z0 + z1) / 2 : (x0 + x1) / 2) + c, y, yy]);
    if (s === 'z0') b.wall('x', x0, x1, z0, z0 + 0.5, 13, 16.5, COL.PLASTER, op);
    if (s === 'z1') b.wall('x', x0, x1, z1 - 0.5, z1, 13, 16.5, COL.PLASTER, op);
    if (s === 'x0') b.wall('z', z0 + 0.5, z1 - 0.5, x0, x0 + 0.5, 13, 16.5, COL.PLASTER, op);
    if (s === 'x1') b.wall('z', z0 + 0.5, z1 - 0.5, x1 - 0.5, x1, 13, 16.5, COL.PLASTER, op);
  }
  b.box([17.4, 14.2, -18.6], [18.6, 15.6, -17.4], [0.35, 0.28, 0.12]); // bell
  b.box([x0 - 0.2, 16.5, z0 - 0.2], [x1 + 0.2, 16.9, z1 + 0.2], COL.TRIM);
  const cone = new THREE.ConeGeometry(3.1, 4.5, 4);
  cone.rotateY(Math.PI / 4);
  cone.translate((x0 + x1) / 2, 16.9 + 2.25, (z0 + z1) / 2);
  b.addGeom(cone, COL.ROOF);

  // cypresses around the walls
  for (let i = 0; i < 26; i++) {
    const a = rnd() * Math.PI * 2, r = 32 + rnd() * 45;
    const x = Math.cos(a) * r, z = Math.sin(a) * r + 5;
    cypress(b, rnd, x, z, 0, 6 + rnd() * 5);
  }
  // low rolling hills on the horizon
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + rnd() * 0.25, r = 130 + rnd() * 50, hh = 10 + rnd() * 16;
    const g = new THREE.ConeGeometry(35 + rnd() * 25, hh, 9);
    g.translate(Math.cos(a) * r, hh / 2 - 1, Math.sin(a) * r);
    const k = 0.7 + rnd() * 0.5;
    b.addGeom(g, [0.2 * k, 0.25 * k, 0.12 * k]);
  }
}

function build() {
  const b = new Builder();
  const rnd = mulberry32(2024);
  noisyGround(b, COL.EARTH, { size: 400, segments: 100, seed: 9 });
  b.box([-200, -2, -200], [200, 0, 200], COL.EARTH, { visual: false });

  ring(b);
  courtyard(b, rnd);
  chapel(b);
  refectory(b, rnd);
  reliquary(b);
  outside(b, rnd);

  return { geometry: b.finish(), colliders: b.colliders, solids: b.solids };
}

/** top of a probe grid starting at lo with spacing s, kept below `ceil` */
const top = (lo, ceil, s) => lo + Math.floor((ceil - lo) / s) * s;

export default {
  id: 'cloister',
  name: 'Cloister',
  build,
  // coarse global fallback, one fine volume over the whole ground floor (below the 4.2 m
  // ceilings), one over the tall chapel (listed last, so it wins there)
  volumes: (Q) => {
    const f = Q.fine;
    return [
      ['global', [-34, 0.5, -24], [30, 14.5, 38], Q.coarse],
      ['ground', [-27, 0.5, -14.6], [23, top(0.5, HC - 0.3, f), 29], [f, f, f]],
      ['chapel', [-HX - HT - 2 * f, 0.5, OI + 0.3], [HX + HT + 2 * f, top(0.5, HH - 0.4, f), HZ1 + HT + 2 * f], [f, f, f]],
    ];
  },
  shadow: { radius: 50, center: [-2, 0, 7] }, // static sun map, must cover the probes
  fog: { near: 50, far: 240 },
  timeOfDay: 0.3,
  refPoint: [3, 1.6, 0], // courtyard, open sunlit air (auto-exposure reference)
  playerSpawn: [0, 0, -5],
  playerYaw: Math.PI, // looking north: fountain, sunlit north arcade, chapel doors
  // enemy spawns: chapel (2), refectory, reliquary, south-east and west galleries
  spawns: [[4.5, 0, 19], [-4.5, 0, 21], [-19.5, 0, 0.5], [19.5, 0, 0.5], [11.3, 0, -11.3], [-11.5, 0, 7]],
};
