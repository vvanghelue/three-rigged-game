// World queries shared by every map (src/maps/*.js): character collision (circle vs boxes in XZ,
// with step-up), ground height, and raycasts (bullets, camera, aiming).
//
// A map module default-exports a plain definition:
//   { id, name,
//     build() -> { geometry, colliders, solids }          (Builder output, see lighting/builder.js)
//     volumes(Q) -> [[name, min, max, spacing], ...]       (first = coarse global, then fine local)
//     shadow: { radius, center }                           (static sun map, must cover the probes)
//     fog: { near, far }, timeOfDay,                       (0..1 day, 1..2 night)
//     refPoint: [x, y, z]                                  (open sunlit air, auto-exposure reference)
//     playerSpawn: [x, y, z], playerYaw,
//     spawns: [[x, y, z], ...] }                           (enemy spawn points)
import * as THREE from 'three';
import { MAPS, pickMap } from './maps/index.js';

export { MAPS, pickMap };
export const STEP = 0.4; // max step-up height (sidewalks, stairs, planter)
const clamp = THREE.MathUtils.clamp;

export function createMap(def) {
  const world = def.build();
  const boxes = world.colliders.map((c) => ({ min: c.min, max: c.max, box: new THREE.Box3(new THREE.Vector3(...c.min), new THREE.Vector3(...c.max)) }));
  const _hit = new THREE.Vector3();

  /** Push a vertical capsule (circle in XZ, feet at pos.y) out of every box taller than a step. */
  function collide(pos, r, height = 1.7) {
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (const b of boxes) {
        if (b.max[1] <= pos.y + STEP || b.min[1] >= pos.y + height) continue;
        if (pos.x < b.min[0] - r || pos.x > b.max[0] + r || pos.z < b.min[2] - r || pos.z > b.max[2] + r) continue;
        const dx = pos.x - clamp(pos.x, b.min[0], b.max[0]);
        const dz = pos.z - clamp(pos.z, b.min[2], b.max[2]);
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2), k = (r - d) / d;
          pos.x += dx * k; pos.z += dz * k;
        } else {
          // centre inside the box: leave through the nearest side
          const opts = [
            [pos.x - b.min[0] + r, -1, 0], [b.max[0] - pos.x + r, 1, 0],
            [pos.z - b.min[2] + r, 0, -1], [b.max[2] - pos.z + r, 0, 1],
          ].sort((a, c) => a[0] - c[0]);
          pos.x += opts[0][1] * opts[0][0]; pos.z += opts[0][2] * opts[0][0];
        }
        moved = true;
      }
      if (!moved) break;
    }
  }

  /** Highest walkable surface under a circle whose top is at most maxY. */
  function groundAt(pos, r, maxY) {
    let h = -Infinity;
    for (const b of boxes) {
      const top = b.max[1];
      if (top > maxY || top <= h) continue;
      const dx = pos.x - clamp(pos.x, b.min[0], b.max[0]);
      const dz = pos.z - clamp(pos.z, b.min[2], b.max[2]);
      if (dx * dx + dz * dz < r * r) h = top;
    }
    return h === -Infinity ? 0 : h;
  }

  /** Distance along a (normalized) ray to the first box, or maxDist. minTop skips low boxes. */
  function raycast(ray, maxDist = Infinity, minTop = -Infinity) {
    let best = maxDist;
    for (const b of boxes) {
      if (b.max[1] < minTop) continue;
      if (ray.intersectBox(b.box, _hit)) {
        const d = _hit.distanceTo(ray.origin);
        if (d < best) best = d;
      }
    }
    return best;
  }

  return {
    playerYaw: Math.PI,
    fog: { near: 60, far: 320 },
    timeOfDay: 0.3,
    ...def,
    ...world,
    collide, groundAt, raycast,
  };
}
