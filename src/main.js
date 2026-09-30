import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Lighting, LAYERS, PRESETS } from './lighting/index.js';
import { createMap, pickMap, MAPS, STEP } from './map.js';
import { PerfStats } from './perf.js';
import { DEBUG, createDebugGui } from './debug.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CHAR_HEIGHT = 1.8;
const PHYS = { gravity: 22, jumpSpeed: 6.5 }; // jump: ~1 m high, ~0.6 s airtime
// Retargeted jump clips: Jump_Start's crouch is skipped (impulse is immediate),
// Jump_Land is only held briefly so it never blocks movement
const JUMP_ANIM = { startFrom: 0.07, startSpeed: 1.4, landFrom: 0.04, landSpeed: 1.7, landHold: 0.38, landHoldMoving: 0.14 };
// Ground movement speeds (m/s). Shift: tap = dodge roll, hold = sprint. Hold Ctrl to crouch.
const MOVE = { run: 5.5, sprint: 8.5, crouch: 2.3, rollTap: 0.2, crouchCamDrop: 0.55 };
const PLAYER_MODEL = 'adventurer';
const ENEMY_MODELS = ['punk', 'hoodie', 'businessman'];
// Max vertical gap (m) between attacker and target feet for a melee hit to land (~a couple of stair steps)
const MAX_HIT_HEIGHT_DIFF = 0.9;

const ATTACKS = {
  punchL: { anim: 'Punch_Left', speed: 1.7, hitAt: 0.4, damage: 12, range: 1.7, arc: 0.35, knock: 3, lunge: 2.5 },
  punchR: { anim: 'Punch_Right', speed: 1.7, hitAt: 0.4, damage: 14, range: 1.7, arc: 0.35, knock: 3.5, lunge: 2.5 },
  kick: { anim: 'Kick_Right', speed: 1.35, hitAt: 0.45, damage: 26, range: 2.0, arc: 0.2, knock: 9, lunge: 1.5 },
  enemyPunch: { anim: 'Punch_Right', speed: 1.1, hitAt: 0.45, damage: 6, range: 1.6, arc: 0.4, knock: 3, lunge: 1 },
  enemyKick: { anim: 'Kick_Left', speed: 1.0, hitAt: 0.5, damage: 10, range: 1.8, arc: 0.3, knock: 6, lunge: 0.5 },
  // Katana combo: a quick right-to-left cut, then a wide lunging sweep (retargeted UAL clip).
  // hitAt is where the blade crosses in front of the body; arc < 0 reaches past the sides.
  swordSlash: { anim: 'Sword_Slash', speed: 1.4, hitAt: 0.4, damage: 22, range: 2.0, arc: -0.1, knock: 4, lunge: 2, hitStop: 0.06, shake: 0.2 },
  swordSweep: { anim: 'Sword_Attack', speed: 1.3, hitAt: 0.29, damage: 34, range: 2.4, arc: -0.35, knock: 8, lunge: 3, hitStop: 0.1, shake: 0.35 },
};

// Firearms. Both use the two-handed pistol animation set; the uzi trades accuracy and
// per-bullet damage for a much higher fire rate and a bigger magazine.
const WEAPONS = {
  pistol: {
    name: 'PISTOL', color: 0x9fd0ff,
    damage: 11, damageRand: 3, // damage + 0..damageRand
    fireInterval: 0.26, // seconds between shots (hold to auto-fire)
    magSize: 12,
    reloadTime: 1.3,
    range: 40,
    knock: 1.5,
    hipSpread: 0.03, // random aim error (radians-ish) when not aiming with right click
    aimSpread: 0, // error left while aiming
    shake: 0.06,
    hitStop: 0.02, // brief freeze on hit
    shootAnim: true, // replay Pistol_Shoot's recoil kick on every shot (standing still)
    recoil: 0.02, // procedural kick-back of the weapon mesh (m)
  },
  uzi: {
    name: 'UZI', color: 0xffa060,
    damage: 5, damageRand: 2,
    fireInterval: 0.075, // ~800 rpm
    magSize: 32,
    reloadTime: 1.6,
    range: 30,
    knock: 0.5,
    hipSpread: 0.06,
    aimSpread: 0.015,
    shake: 0.035,
    hitStop: 0, // would turn a burst into slow motion
    shootAnim: false, // too fast to restart a clip each shot: procedural recoil only
    recoil: 0.035,
  },
};
const GUNS = Object.keys(WEAPONS);

// Frag grenade: G / middle click, with any weapon out. Hold to wind up and preview the arc,
// release to throw. There is no throw clip in the animation sets, so the right arm is posed
// procedurally on top of whatever is playing (see Fighter.applyThrowPose).
const GRENADE = {
  start: 3, perWave: 2, max: 5, // carried count: at the start, refilled each wave, cap
  speed: 13, lift: 3.2, // launch: m/s along the view + straight up
  gravity: 18, radius: 0.07,
  bounce: 0.35, friction: 0.7, // normal restitution / tangential keep on each bounce
  fuse: 1.9, // seconds from release
  blastRadius: 5, damage: 85, minDamage: 15, // linear falloff from the centre to the edge
  knock: 14, launch: 6, // horizontal shove + upward pop (m/s) at the centre
  selfMult: 0.5, // your own grenades hurt you less
  cooldown: 0.35,
  // throw timing (s): wind-up (min, held longer while aiming), swing (release part way), recover
  windup: 0.14, swing: 0.16, releaseAt: 0.5, recover: 0.22,
};
const MODES = ['hands', 'sword', ...GUNS]; // mouse wheel / Q cycle order
const MELEE_NAMES = { hands: 'FISTS', sword: 'KATANA' };
const GUN_AIM_HOLD = 0.6; // keep aiming pose this long after the last shot

// Bullet hitboxes: capsules between two joints that follow the animated skeleton
// (crouches, hit reactions, death falls...). Radii are metres on the 1.8 m characters;
// HIT_MULT scales the weapon's damage per body part. `aUp` / `bUp` push an end straight up by that many
// metres in the bind pose; `bTop` puts it `r` below the top of the character instead
// (the rig has no head-end joint). F4 shows them.
const HIT_MULT = { head: 2.5, body: 1, limb: 0.7 };
const HITBOXES = [
  { part: 'head', a: 'Head', b: 'Head', aUp: 0.07, bTop: true, r: 0.13 },
  { part: 'body', a: 'Chest', b: 'Head', r: 0.07 }, // neck
  { part: 'body', a: 'Torso', b: 'Chest', bUp: 0.05, r: 0.17 },
  { part: 'body', a: 'Hips', b: 'Torso', r: 0.16 },
  ...['L', 'R'].flatMap((s) => [
    { part: 'limb', a: `UpperArm.${s}`, b: `LowerArm.${s}`, r: 0.06 },
    { part: 'limb', a: `LowerArm.${s}`, b: `Wrist.${s}`, r: 0.055 },
    { part: 'limb', a: `UpperLeg.${s}`, b: `LowerLeg.${s}`, r: 0.09 },
    { part: 'limb', a: `LowerLeg.${s}`, b: `Foot.${s}`, r: 0.07 },
  ]),
];

// Pistol aim (hold right click): camera pulls in over the shoulder and narrows FOV
const AIM = { dist: 2.1, fov: 42, shoulder: 0.55, speed: 12, moveSpeed: 3.2 };
const VIEW = { fov: 60 }; // base (hip) field of view
// First-person mode (debug panel toggle, or ?fps in the URL): the camera sits at the player's
// eyes (head bone + offset, so it follows crouches / hit reactions / the death fall), the head
// is shrunk away for the main view (it still casts its shadow) and the body turns with the view.
const FP = { enabled: new URLSearchParams(location.search).has('fps'), fov: 80, eyeUp: 0.1, eyeFwd: 0.1, smooth: 25, pitchMin: -1.45, pitchMax: 1.45 };
const TP_PITCH = { min: -1.2, max: 0.6 }; // third-person pitch range
// Third-person camera follow stiffness (1/s): the camera target trails the player by roughly
// speed / TP_FOLLOW metres, so higher = tighter framing (smaller "free zone").
const TP_FOLLOW = 18;

// Pistol placement inside the right hand bone (bone-local space, metres + quaternion).
// Solved from the Idle_Gun_Pointing pose so the barrel points straight ahead (pack clips;
// the retargeted UAL clips get their own grip solved at runtime, see attachGun).
const GUN_GRIP = { pos: [-0.0317, 0.0487, 0.0046], quat: [0.4685, -0.5361, -0.5484, -0.4386] };
// Katana fist grip (see attachSword): `along` = fraction of the wrist -> knuckle distance,
// `lateral` / `palm` = metres along the blade axis / toward the palm, `tilt` leans the blade
// toward the knuckles (0 = square to the forearm)
const SWORD_GRIP = { along: 0.62, lateral: 0, palm: 0.02, tilt: 0.25 };

// ---------------------------------------------------------------------------
// Renderer / scene / lighting (probe-volume GI + cascaded sun, see src/lighting)
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const QUALITY = PRESETS[params.get('quality')] ? params.get('quality') : 'medium';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, PRESETS[QUALITY].dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.info.autoReset = false; // reset once per frame in tick() so the debug panel sees every pass
document.body.appendChild(renderer.domElement);
const perf = new PerfStats(renderer);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 800);
const CAM_PIVOT_Y = 1.6; // orbit pivot height (around the shoulders)
const CAM_SHOULDER = 0.5; // over-the-right-shoulder offset
const CAM_MARGIN = 0.3; // keep the camera this far in front of walls

const map = createMap(pickMap(params.get('map')));
document.title = `Street Brawl — ${map.name}`;
camera.position.set(map.playerSpawn[0], 3, map.playerSpawn[2] - 5);
camera.lookAt(map.playerSpawn[0], 1, map.playerSpawn[2]);

const lighting = new Lighting(renderer, scene, camera, {
  quality: QUALITY,
  shadow: map.shadow,
  fog: map.fog,
  timeOfDay: params.has('tod') ? +params.get('tod') : map.timeOfDay,
});
await lighting.setWorld(map); // loads the map's PBR textures (if any) before the bake
lighting.startBake();

// map selector in the menu (reloads with ?map=<id>)
{
  const sel = document.getElementById('map-select');
  for (const m of MAPS) sel.add(new Option(m.name, m.id, false, m.id === map.id));
  sel.onchange = () => { params.set('map', sel.value); location.search = params.toString(); };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
const templates = {};

// The Quaternius exports ship every material at metalness 0.4 / roughness 0.41, which reads as
// glossy plastic. Make cloth/skin/hair matte and keep only real metal bits slightly shiny.
const METAL_MATS = /gold|earring|metal|buckle/i;
function matteCharacterMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.isMeshStandardMaterial) continue;
      if (METAL_MATS.test(m.name)) { m.metalness = 0.6; m.roughness = 0.45; }
      else if (/eye/i.test(m.name) && !/brow/i.test(m.name)) { m.metalness = 0; m.roughness = 0.5; }
      else { m.metalness = 0; m.roughness = 0.9; }
    }
  });
}

// The models are exported flat-shaded: vertices are split per face, each carrying the face normal,
// which gives the faceted low-poly look. Rebuild smooth normals: every vertex averages the normals
// of all faces touching the same *position*, except faces bent more than CHARACTER_CREASE_ANGLE
// away (keeps real hard edges like shoe soles crisp).
// Note: BufferGeometryUtils.toCreasedNormals can't be used here - it welds on a fixed 0.01 grid
// and these meshes are authored ~0.018 units tall (the armature scales them x100), so it would
// weld half the body together. The weld tolerance below is relative to the mesh size instead.
// Only the normal attribute is replaced; index, skin weights, uvs and colors are untouched.
const CHARACTER_CREASE_ANGLE = THREE.MathUtils.degToRad(80);
function smoothGeometryNormals(geo, creaseAngle) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const index = geo.index ? geo.index.array : Array.from({ length: n }, (_, i) => i);
  if (!geo.boundingBox) geo.computeBoundingBox();
  const tol = geo.boundingBox.getSize(new THREE.Vector3()).length() * 1e-4 || 1e-9;

  // weld: vertex -> position id
  const ids = new Int32Array(n), keys = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) / tol)},${Math.round(pos.getY(i) / tol)},${Math.round(pos.getZ(i) / tol)}`;
    let id = keys.get(k);
    if (id === undefined) keys.set(k, (id = keys.size));
    ids[i] = id;
  }

  // area-weighted face normals, faces grouped per position id, and each vertex's own faces
  const faceCount = index.length / 3;
  const fN = new Float32Array(faceCount * 3), fU = new Float32Array(faceCount * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const facesAtPos = Array.from({ length: keys.size }, () => []);
  const own = new Float32Array(n * 3);
  for (let f = 0; f < faceCount; f++) {
    const i0 = index[3 * f], i1 = index[3 * f + 1], i2 = index[3 * f + 2];
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    c.sub(b); a.sub(b); c.cross(a); // area-weighted normal
    fN.set([c.x, c.y, c.z], 3 * f);
    c.normalize();
    fU.set([c.x, c.y, c.z], 3 * f);
    for (const v of [i0, i1, i2]) {
      facesAtPos[ids[v]].push(f);
      own[3 * v] += c.x; own[3 * v + 1] += c.y; own[3 * v + 2] += c.z;
    }
  }

  // each vertex: sum faces around its position that are within the crease angle of its own faces
  const creaseDot = Math.cos(creaseAngle);
  const out = new Float32Array(n * 3), ref = new THREE.Vector3(), acc = new THREE.Vector3();
  for (let v = 0; v < n; v++) {
    ref.fromArray(own, 3 * v).normalize();
    acc.set(0, 0, 0);
    for (const f of facesAtPos[ids[v]]) {
      if (ref.x * fU[3 * f] + ref.y * fU[3 * f + 1] + ref.z * fU[3 * f + 2] >= creaseDot) {
        acc.x += fN[3 * f]; acc.y += fN[3 * f + 1]; acc.z += fN[3 * f + 2];
      }
    }
    if (acc.lengthSq() === 0) acc.copy(ref);
    acc.normalize().toArray(out, 3 * v);
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

function smoothCharacterNormals(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    smoothGeometryNormals(o.geometry, CHARACTER_CREASE_ANGLE);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.flatShading = false;
  });
}

// The Quaternius characters come split into 10-15 skinned meshes (one per material), each with its
// own Skeleton over the same bones: per render pass that is 10-15 bone-matrix updates, bone-texture
// uploads and draw calls per character. Merge them into one skinned mesh with one material: each
// part's colour goes into a vertex colour, its metalness / roughness into a `charMR` attribute (read
// by patchVertexMR). The parts share the bones but not always the bind matrices (the adventurer's
// backpack is bound separately), so every vertex is moved into the kept skeleton's bind space
// through its main bone: v' = B0^-1 * inv(boneInverse0[b]) * boneInverse[b] * B * v.
function mergeCharacterMeshes(root) {
  const parts = [];
  root.traverse((o) => { if (o.isSkinnedMesh) parts.push(o); });
  if (parts.length < 2) return;
  const base = parts[0], sk = base.skeleton;
  if (parts.some((m) => m.skeleton.bones.length !== sk.bones.length || m.skeleton.bones.some((b, i) => b !== sk.bones[i]))) {
    console.warn(`${root.name}: parts use different bones, not merged`);
    return;
  }
  let n = 0, nIdx = 0;
  for (const m of parts) {
    n += m.geometry.attributes.position.count;
    nIdx += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const mr = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const index = n > 65535 ? new Uint32Array(nIdx) : new Uint16Array(nIdx);
  const baseBindInv = base.bindMatrix.clone().invert();
  const v = new THREE.Vector3(), c = new THREE.Color();
  let vo = 0, io = 0;
  for (const m of parts) {
    const g = m.geometry, P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color;
    const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, mat = m.material;
    const xf = new Map(); // bone -> [position matrix, normal matrix]
    const toBase = (b) => {
      let t = xf.get(b);
      if (!t) {
        const M = sk.boneInverses[b].clone().invert().premultiply(baseBindInv).multiply(m.skeleton.boneInverses[b]).multiply(m.bindMatrix);
        xf.set(b, (t = [M, new THREE.Matrix3().getNormalMatrix(M)]));
      }
      return t;
    };
    let flip = false;
    for (let i = 0; i < P.count; i++) {
      const o = vo + i;
      let main = 0, best = -1;
      for (let k = 0; k < 4; k++) {
        const w = SW.getComponent(i, k), b = SI.getComponent(i, k);
        si[o * 4 + k] = b; sw[o * 4 + k] = w;
        if (w > best) { best = w; main = b; }
      }
      const [M, NM] = toBase(main);
      if (i === 0) flip = M.determinant() < 0; // mirrored bind: keep triangles front-facing
      v.fromBufferAttribute(P, i).applyMatrix4(M).toArray(pos, o * 3);
      v.fromBufferAttribute(N, i).applyMatrix3(NM).normalize().toArray(nor, o * 3);
      c.copy(mat.color); // linear, like vertex colours
      if (C) { c.r *= C.getX(i); c.g *= C.getY(i); c.b *= C.getZ(i); }
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
      mr[o * 2] = mat.metalness; mr[o * 2 + 1] = mat.roughness;
    }
    const idx = g.index;
    const count = idx ? idx.count : P.count;
    for (let k = 0; k < count; k += 3) {
      const a = idx ? idx.getX(k) : k, b = idx ? idx.getX(k + 1) : k + 1, d = idx ? idx.getX(k + 2) : k + 2;
      index[io++] = vo + a;
      index[io++] = vo + (flip ? d : b);
      index[io++] = vo + (flip ? b : d);
    }
    vo += P.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('charMR', new THREE.BufferAttribute(mr, 2));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const mat = new THREE.MeshStandardMaterial({ name: 'Character', vertexColors: true, metalness: 1, roughness: 1 });
  mat.userData.vertexMR = true;
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.name = `${root.name || 'Character'}_Merged`;
  mesh.position.copy(base.position);
  mesh.quaternion.copy(base.quaternion);
  mesh.scale.copy(base.scale);
  base.parent.add(mesh);
  mesh.bind(sk, base.bindMatrix);
  for (const m of parts) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
}

// Per-vertex metalness / roughness for the merged characters (charMR = [metalness, roughness],
// multiplied into the material's own values). Applied after lighting.patch, which replaces
// onBeforeCompile (and material clones don't keep it).
function patchVertexMR(mat) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 charMR;\nvarying vec2 vCharMR;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCharMR = charMR;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCharMR;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vCharMR.x;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vCharMR.y;');
  };
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}-charMR`;
  mat.needsUpdate = true;
}

async function loadAssets() {
  const loader = new GLTFLoader();
  const names = [PLAYER_MODEL, ...ENEMY_MODELS];
  const [ual, uzi, sword, grenade] = await Promise.all([
    loader.loadAsync('/models/ual_base.glb'),
    loader.loadAsync('/models/uzi.glb'),
    loader.loadAsync('/models/sword.glb'),
    loader.loadAsync('/models/grenade.glb'),
    ...names.map(async (name) => {
      const gltf = await loader.loadAsync(`/models/${name}.glb`);
      matteCharacterMaterials(gltf.scene);
      smoothCharacterNormals(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      mergeCharacterMeshes(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene, true);
      const h = box.max.y - box.min.y || 1;
      templates[name] = { scene: gltf.scene, animations: [...gltf.animations], scale: CHAR_HEIGHT / h, minY: box.min.y };
    }),
  ]);
  templates.uzi = prepareUzi(uzi.scene);
  templates.sword = prepareSword(sword.scene);
  templates.grenade = prepareGrenade(grenade.scene);
  // All four characters share the same skeleton + bind pose: bake once, share the clips
  const t0 = performance.now();
  const baked = retargetClips(ual, templates[PLAYER_MODEL].scene, UAL_CLIPS);
  baked.push(...deriveGunClips(baked));
  console.info(`Retargeted ${baked.length} UAL clips in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const name of names) templates[name].animations.push(...baked);
  // (derived from the player's clips, the rigs are identical)
  const swordClips = deriveSwordClips(templates[PLAYER_MODEL].animations);
  for (const name of names) templates[name].animations.push(...swordClips);
}

// Sword carry variants (`<clip>_Sword`): locomotion with the right arm replaced by Idle_Sword's,
// which holds the katana low and pointing forward instead of swinging it around
const RIGHT_ARM = /^(Shoulder|UpperArm|LowerArm|Wrist|Index\d|Middle\d|Ring\d|Pinky\d|Thumb\d)R\./;
const SWORD_CARRY = ['Run', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land'];
function deriveSwordClips(clips) {
  const get = (n) => clips.find((c) => c.name.split('|').pop() === n);
  const carry = get('Idle_Sword');
  if (!carry) return [];
  const arm = carry.tracks.filter((t) => RIGHT_ARM.test(t.name));
  return SWORD_CARRY.map(get).filter(Boolean).map((base) => {
    const k = base.duration / carry.duration;
    const tracks = [
      ...base.tracks.filter((t) => !RIGHT_ARM.test(t.name)),
      ...arm.map((t) => { const c = t.clone(); c.scale(k); return c; }),
    ];
    return new THREE.AnimationClip(`${base.name.split('|').pop()}_Sword`, base.duration, tracks);
  });
}

// Upper body = spine above the hips, head, arms, fingers
const UPPER_BONES = /^(Abdomen|Torso|Chest|Neck|Head|Shoulder|UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)/;
const isUpper = (track) => UPPER_BONES.test(track.name.split('.')[0]);

// Clips built from the retargeted ones:
//  - Jump_*_Gun: jump legs + two-handed pistol aim on top (shooting mid-air)
//  - Aim_Up_Add / Aim_Down_Add: upper-body additive aim offsets (+-90 deg) relative
//    to Pistol_Aim_Neutral, layered on any base pose and weighted by aim pitch
function deriveGunClips(clips) {
  const get = (n) => clips.find((c) => c.name === n);
  const neutral = get('Pistol_Aim_Neutral');
  const out = [];
  for (const n of ['Jump_Start', 'Jump_Loop', 'Jump_Land']) {
    const legs = get(n);
    const tracks = [...legs.tracks.filter((t) => !isUpper(t)), ...neutral.tracks.filter(isUpper).map((t) => t.clone())];
    out.push(new THREE.AnimationClip(`${n}_Gun`, legs.duration, tracks));
  }
  // Crouch_*_Aim: crouch legs + two-handed pistol aim (neutral pose, time-fitted to the loop)
  for (const [n, src] of [['Crouch_Idle_Aim', 'Crouch_Idle_Loop'], ['Crouch_Fwd_Aim', 'Crouch_Fwd_Loop']]) {
    const legs = get(src);
    if (!legs) continue;
    const k = legs.duration / neutral.duration;
    const upper = neutral.tracks.filter(isUpper).map((t) => { const c = t.clone(); c.scale(k); return c; });
    out.push(new THREE.AnimationClip(n, legs.duration, [...legs.tracks.filter((t) => !isUpper(t)), ...upper]));
  }
  for (const [n, src] of [['Aim_Up_Add', 'Pistol_Aim_Up'], ['Aim_Down_Add', 'Pistol_Aim_Down']]) {
    const upper = (c) => new THREE.AnimationClip(c.name, c.duration, c.tracks.filter(isUpper).map((t) => t.clone()));
    const add = THREE.AnimationUtils.makeClipAdditive(upper(get(src)), 0, upper(neutral));
    add.name = n;
    out.push(add);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Animation retargeting: Quaternius "Universal Animation Library" (Rigify DEF
// skeleton, faces -Z) -> Quaternius characters ("CharacterArmature", faces +Z).
// Both bind poses are T-poses. Per frame and bone, the source's world-space
// rotation delta from its bind pose is applied to the target's bind rotation
// (after a small per-bone correction so limb directions match at bind time),
// then converted back to local space parent-first.
// ---------------------------------------------------------------------------
const UAL_CLIPS = [
  'Jump_Start', 'Jump_Loop', 'Jump_Land',
  'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop',
  'Pistol_Idle_Loop', 'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Aim_Down', 'Pistol_Shoot', 'Pistol_Reload',
  'Sword_Attack', 'Sword_Idle',
];
// target bone <- source bone (names before GLTFLoader sanitising)
const UAL_MAP = {
  'Body': 'DEF-hips', 'Abdomen': 'DEF-spine.001', 'Torso': 'DEF-spine.002', 'Chest': 'DEF-spine.003',
  'Neck': 'DEF-neck', 'Head': 'DEF-head',
};
for (const s of ['L', 'R']) {
  Object.assign(UAL_MAP, {
    [`Shoulder.${s}`]: `DEF-shoulder.${s}`, [`UpperArm.${s}`]: `DEF-upper_arm.${s}`,
    [`LowerArm.${s}`]: `DEF-forearm.${s}`, [`Wrist.${s}`]: `DEF-hand.${s}`,
    [`UpperLeg.${s}`]: `DEF-thigh.${s}`, [`LowerLeg.${s}`]: `DEF-shin.${s}`, [`Foot.${s}`]: `DEF-foot.${s}`,
  });
  // target fingers have an extra metacarpal (X1) that just follows the wrist
  for (const [t, f] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']])
    for (let i = 1; i <= 3; i++) UAL_MAP[`${t}${i + 1}.${s}`] = `DEF-f_${f}.0${i}.${s}`;
  for (let i = 1; i <= 3; i++) UAL_MAP[`Thumb${i}.${s}`] = `DEF-thumb.0${i}.${s}`;
}
// Limb bones whose bind direction (bone -> child joint) is matched to the source's
// before applying deltas: [target, targetChild, sourceChild]
const UAL_ALIGN = [];
for (const s of ['L', 'R']) {
  UAL_ALIGN.push(
    [`UpperArm.${s}`, `LowerArm.${s}`, `DEF-forearm.${s}`],
    [`LowerArm.${s}`, `Wrist.${s}`, `DEF-hand.${s}`],
    [`Wrist.${s}`, `Middle2.${s}`, `DEF-f_middle.01.${s}`],
    [`UpperLeg.${s}`, `LowerLeg.${s}`, `DEF-shin.${s}`],
    [`LowerLeg.${s}`, `Foot.${s}`, `DEF-foot.${s}`],
    [`Thumb1.${s}`, `Thumb2.${s}`, `DEF-thumb.02.${s}`],
    [`Thumb2.${s}`, `Thumb3.${s}`, `DEF-thumb.03.${s}`],
  );
  for (const [t, f] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Pinky', 'pinky']])
    for (let i = 2; i <= 3; i++) UAL_ALIGN.push([`${t}${i}.${s}`, `${t}${i + 1}.${s}`, `DEF-f_${f}.0${i}.${s}`]);
}

function retargetClips(srcGltf, tgtScene, clipNames, fps = 30) {
  const san = THREE.PropertyBinding.sanitizeNodeName;
  const skinnedSkeleton = (root) => {
    let sk = null;
    root.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o.skeleton; });
    return sk;
  };
  // Source + a private target clone, both put in their bind (T-)pose
  const src = srcGltf.scene;
  const tgt = SkeletonUtils.clone(tgtScene);
  const srcSk = skinnedSkeleton(src), tgtSk = skinnedSkeleton(tgt);
  srcSk.pose(); tgtSk.pose();
  src.updateMatrixWorld(true); tgt.updateMatrixWorld(true);
  const sBone = (n) => srcSk.bones.find((b) => b.name === san(n));
  const tBone = (n) => tgtSk.bones.find((b) => b.name === san(n));
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());

  // Facing fix (yaw only) from the shoulder line: source left->right vs target
  const side = (L, R) => wp(L).sub(wp(R)).setY(0);
  const sSide = side(sBone('DEF-upper_arm.L'), sBone('DEF-upper_arm.R'));
  const tSide = side(tBone('UpperArm.L'), tBone('UpperArm.R'));
  const yaw = Math.atan2(sSide.z, sSide.x) - Math.atan2(tSide.z, tSide.x);
  const Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const Yi = Y.clone().invert();

  // Per-bone bind data
  const bones = tgtSk.bones; // parents come before children
  const info = new Map();
  for (const b of bones) {
    const srcName = Object.keys(UAL_MAP).find((k) => san(k) === b.name);
    info.set(b, {
      src: srcName ? sBone(UAL_MAP[srcName]) : null,
      bindLocal: b.quaternion.clone(),
      bindWorld: wq(b), // becomes the aligned bind rotation below
      world: new THREE.Quaternion(),
      times: [], values: [],
    });
  }
  for (const b of bones) { const i = info.get(b); if (i.src) i.srcBindInv = wq(i.src).invert(); }
  for (const [t, tc, sc] of UAL_ALIGN) {
    const b = tBone(t), i = info.get(b);
    const tDir = wp(tBone(tc)).sub(wp(b)).normalize();
    const sDir = wp(sBone(sc)).sub(wp(i.src)).applyQuaternion(Y).normalize();
    i.bindWorld.premultiply(new THREE.Quaternion().setFromUnitVectors(tDir, sDir));
  }

  // Hips translation: scaled by leg length, target Body in Root space
  const sHips = sBone('DEF-hips'), tBody = tBone('Body'), tRoot = tBody.parent;
  const legLen = (a, b) => wp(a).distanceTo(wp(b));
  const ratio = (legLen(tBone('UpperLeg.L'), tBone('LowerLeg.L')) + legLen(tBone('LowerLeg.L'), tBone('Foot.L'))) /
    (legLen(sBone('DEF-thigh.L'), sBone('DEF-shin.L')) + legLen(sBone('DEF-shin.L'), sBone('DEF-foot.L')));
  const sHipsBind = wp(sHips), tBodyBind = wp(tBody);
  const rootInv = tRoot.matrixWorld.clone().invert();
  // Feet are IK bones parented to Root: keep them at the shin's end
  const feet = ['L', 'R'].map((s) => {
    const foot = tBone(`Foot.${s}`), shin = tBone(`LowerLeg.${s}`);
    return { foot, shin, offset: shin.worldToLocal(wp(foot)), pos: [] };
  });
  const bodyPos = [];

  const mixer = new THREE.AnimationMixer(src);
  const out = [];
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const name of clipNames) {
    const clip = srcGltf.animations.find((c) => c.name.split('|').pop() === name);
    if (!clip) { console.warn('UAL clip missing', name); continue; }
    const action = mixer.clipAction(clip).play();
    const n = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = [];
    for (const i of info.values()) i.values = [];
    bodyPos.length = 0;
    feet.forEach((f) => (f.pos = []));
    for (let k = 0; k < n; k++) {
      const t = (k / (n - 1)) * clip.duration;
      times.push(t);
      action.time = t;
      mixer.update(0);
      src.updateMatrixWorld(true);
      for (const b of bones) {
        const i = info.get(b);
        const parentWorld = b.parent.isBone ? info.get(b.parent).world : wq(b.parent);
        if (i.src) {
          // world = Y * (Rs * Rs_bind^-1) * Y^-1 * Rt_bindAligned
          i.world.copy(wq(i.src)).multiply(i.srcBindInv).premultiply(Y).multiply(Yi).multiply(i.bindWorld);
          q.copy(parentWorld).invert().multiply(i.world);
        } else {
          q.copy(i.bindLocal);
          i.world.copy(parentWorld).multiply(q);
        }
        // keep quaternion keys in one hemisphere for clean interpolation
        const vs = i.values, m = vs.length;
        if (m && q.x * vs[m - 4] + q.y * vs[m - 3] + q.z * vs[m - 2] + q.w * vs[m - 1] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        vs.push(q.x, q.y, q.z, q.w);
        b.quaternion.copy(q);
      }
      // hips: source displacement from bind, rotated + scaled into target space
      v.copy(wp(sHips)).sub(sHipsBind).applyQuaternion(Y).multiplyScalar(ratio).add(tBodyBind).applyMatrix4(rootInv);
      tBody.position.copy(v);
      bodyPos.push(v.x, v.y, v.z);
      tgt.updateMatrixWorld(true);
      for (const f of feet) {
        v.copy(f.offset).applyMatrix4(f.shin.matrixWorld).applyMatrix4(rootInv);
        f.pos.push(v.x, v.y, v.z);
      }
    }
    action.stop();
    const tracks = [];
    for (const b of bones) {
      const i = info.get(b);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, i.values));
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${tBody.name}.position`, times, bodyPos.slice()));
    for (const f of feet) tracks.push(new THREE.VectorKeyframeTrack(`${f.foot.name}.position`, times, f.pos));
    const baked = new THREE.AnimationClip(name, clip.duration, tracks);
    baked.optimize(); // drops constant keys (fingers, IK poles, ...)
    out.push(baked);
  }
  mixer.uncacheRoot(src);
  return out;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
const particles = [];
const particleGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
function burst(pos, color, count = 12, power = 4) {
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    m.layers.set(LAYERS.FX);
    m.position.copy(pos);
    const v = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5 + 0.3, (Math.random() - 0.5) * 2)
      .normalize()
      .multiplyScalar(power * (0.5 + Math.random()));
    scene.add(m);
    particles.push({ mesh: m, vel: v, life: 0.5 + Math.random() * 0.3, max: 0.8 });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vel.y -= 12 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.rotation.x += dt * 10;
    p.mesh.material.opacity = Math.max(0, p.life / p.max);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      particles.splice(i, 1);
    }
  }
}

const labelsEl = document.getElementById('labels');
const _proj = new THREE.Vector3();
function toScreen(v) {
  _proj.copy(v).project(camera);
  return { x: (_proj.x * 0.5 + 0.5) * innerWidth, y: (-_proj.y * 0.5 + 0.5) * innerHeight, visible: _proj.z < 1 };
}
function damageNumber(pos, amount, isPlayer, crit = false) {
  const s = toScreen(pos);
  if (!s.visible) return;
  const el = document.createElement('div');
  el.className = 'dmg' + (isPlayer ? ' player' : '') + (crit ? ' crit' : '');
  el.textContent = amount;
  el.style.left = s.x + (Math.random() - 0.5) * 30 + 'px';
  el.style.top = s.y + 'px';
  labelsEl.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

let shake = 0;
let hitStop = 0;

// ---------------------------------------------------------------------------
// Pistol (procedural low-poly mesh). Local space: barrel along +Z, grip down -Y,
// origin at the grip where the palm holds it.
// ---------------------------------------------------------------------------
const gunMetal = lighting.patch(new THREE.MeshStandardMaterial({ color: 0x2b2d33, metalness: 0.7, roughness: 0.35 }), { specular: true });
const gunGripMat = lighting.patch(new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 0.8 }), { specular: true });
gunMetal.userData.giPatched = gunGripMat.userData.giPatched = true;
function makePistol() {
  const g = new THREE.Group();
  const part = (w, h, d, x, y, z, mat = gunMetal, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    g.add(m);
    return m;
  };
  part(0.032, 0.036, 0.2, 0, 0.045, 0.06); // slide
  part(0.028, 0.02, 0.16, 0, 0.02, 0.05); // frame
  part(0.03, 0.1, 0.045, 0, -0.03, -0.005, gunGripMat, -0.25); // grip
  part(0.006, 0.03, 0.035, 0, 0.0, 0.035); // trigger guard
  part(0.008, 0.01, 0.01, 0, 0.068, 0.15); // front sight
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.02, 8), gunMetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.045, 0.165);
  g.add(barrel);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.045, 0.18);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// Uzi: "Submachine Gun" by Quaternius (CC0, https://poly.pizza/m/nsP3JukU73).
// The export is ~4 m long with the barrel along +X and the wire stock unfolded toward -X.
// It is rebuilt into the pistol's frame (barrel +Z, up +Y, origin where the palm holds the
// grip) so it shares the pistol's hand grip. Grip / barrel points are in the export's units;
// the wire stock (behind stockX, mesh-local units) is cut off: the pistol-aim pose holds the
// gun at arm's length, so an unfolded stock would go straight through the head.
const UZI = { length: 0.5, grip: [-0.02, 0.39], barrelY: 0.48, palm: [0.015, 0.075], stockX: -0.0042 };
function prepareUzi(src) {
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const s = UZI.length / (box.max.x - box.min.x); // scale from the full (stock unfolded) length
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry.index) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index.array, keep = [];
    for (let i = 0; i < idx.length; i += 3)
      if (Math.min(pos.getX(idx[i]), pos.getX(idx[i + 1]), pos.getX(idx[i + 2])) > UZI.stockX) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    o.geometry.setIndex(keep);
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });
  const pivot = new THREE.Group();
  pivot.rotation.y = -Math.PI / 2; // +X (barrel) -> +Z
  pivot.scale.setScalar(s);
  // after the rotation, export (x, y) lands on (z, y): put the grip top on the palm
  pivot.position.set(0, UZI.palm[0] - UZI.grip[1] * s, UZI.palm[1] - UZI.grip[0] * s);
  pivot.add(src);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'Muzzle';
  muzzle.position.set(box.max.x + 0.05, UZI.barrelY, 0);
  pivot.add(muzzle);
  // the export's near-black Phong colours read as a void in shade: lift them, make it gunmetal
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.color.multiplyScalar(2.2);
    o.material.metalness = /metal/i.test(o.material.name) ? 0.7 : 0.4;
    o.material.roughness = /metal/i.test(o.material.name) ? 0.35 : 0.6;
  });
  const g = new THREE.Group();
  g.add(pivot);
  return g;
}
function makeUzi() {
  const g = templates.uzi.clone(true); // shares geometry + materials
  g.userData.muzzle = g.getObjectByName('Muzzle');
  return g;
}

// Katana: "Katana" by dook (CC-BY 3.0, https://poly.pizza/m/zV3WXbyjMf).
// The export stands along +Y (pommel y≈0.82, guard y≈2.25, tip y≈8.45) with the cutting edge
// toward +Z. It is rebuilt so the origin sits where the fist closes on the handle (just below
// the guard), blade along +Y, edge along +Z, in metres. `grip` is that point in export units.
const SWORD = { length: 0.95, grip: [0, 1.9, 0.93] };
function prepareSword(src) {
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const s = SWORD.length / (box.max.y - box.min.y);
  const pivot = new THREE.Group();
  pivot.scale.setScalar(s);
  pivot.position.set(...SWORD.grip).multiplyScalar(-s);
  pivot.add(src);
  // one atlas texture: light blade, dark wrapped handle, gold collar. Using it as the metalness
  // map too makes only the bright steel metallic
  src.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    m.metalnessMap = m.map;
    m.metalness = 0.9;
    m.roughness = 0.38;
  });
  const g = new THREE.Group();
  g.add(pivot);
  return g;
}

// Grenade: "Hand grenade" by CreativeTrio (CC0, https://poly.pizza/m/YWhHlmKOtx).
// Rebuilt to GRENADE_SIZE metres tall (spoon / fuse toward +Y), centred on the origin.
const GRENADE_SIZE = 0.12;
function prepareGrenade(src) {
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const s = GRENADE_SIZE / (box.max.y - box.min.y);
  const pivot = new THREE.Group();
  pivot.scale.setScalar(s);
  pivot.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-s);
  pivot.add(src);
  src.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.material.metalness = 0.3;
    o.material.roughness = 0.55;
  });
  const g = new THREE.Group();
  g.add(pivot);
  return g;
}

// ---------------------------------------------------------------------------
// Grenades in flight: a sphere swept against the map boxes (inflated by its radius, so a fast
// throw can't tunnel through a thin wall), bouncing with restitution + friction. The same step
// drives the live grenades and the aim preview, so the arc you see is the arc you get.
// ---------------------------------------------------------------------------
const GRENADE_STEP = 1 / 90;
let grenadeBoxes = null; // map colliders grown by the grenade radius (built on first use)
function getGrenadeBoxes() {
  if (!grenadeBoxes) {
    const r = GRENADE.radius;
    grenadeBoxes = map.colliders.map((c) => new THREE.Box3(
      new THREE.Vector3(c.min[0] - r, c.min[1] - r, c.min[2] - r),
      new THREE.Vector3(c.max[0] + r, c.max[1] + r, c.max[2] + r),
    ));
  }
  return grenadeBoxes;
}
const _gRay = new THREE.Ray();
const _gHit = new THREE.Vector3();
const _gBest = new THREE.Vector3();
const _gN = new THREE.Vector3();
// Advance { pos, vel } by dt. Returns true when it bounced off something this step.
function stepGrenade(g, dt) {
  g.vel.y -= GRENADE.gravity * dt;
  let remaining = g.vel.length() * dt;
  let bounced = false, onFloor = false;
  for (let it = 0; it < 3 && remaining > 1e-6; it++) {
    _gRay.origin.copy(g.pos);
    _gRay.direction.copy(g.vel).normalize();
    let best = remaining, hitBox = null;
    for (const b of getGrenadeBoxes()) {
      if (b.containsPoint(g.pos)) continue; // resting on a face / spawned inside: ignore that box
      if (!_gRay.intersectBox(b, _gHit)) continue;
      const d = _gHit.distanceTo(g.pos);
      if (d < best) { best = d; hitBox = b; _gBest.copy(_gHit); }
    }
    if (!hitBox) { g.pos.addScaledVector(_gRay.direction, remaining); break; }
    // face normal: the box face the hit point lies on
    const p = _gBest, mn = hitBox.min, mx = hitBox.max;
    const faces = [[p.x - mn.x, -1, 0, 0], [mx.x - p.x, 1, 0, 0], [p.y - mn.y, 0, -1, 0], [mx.y - p.y, 0, 1, 0], [p.z - mn.z, 0, 0, -1], [mx.z - p.z, 0, 0, 1]];
    let f = faces[0];
    for (const c of faces) if (c[0] < f[0]) f = c;
    _gN.set(f[1], f[2], f[3]);
    g.pos.copy(p).addScaledVector(_gN, 1e-3); // stay just outside the face
    remaining -= best;
    // impact: the normal part bounces back damped, the tangential part loses some to friction.
    // A slow contact (resting / rolling) just drops the normal part.
    const vn = g.vel.dot(_gN);
    if (vn < 0) {
      g.vel.addScaledVector(_gN, -vn);
      if (-vn > 1.2) {
        g.vel.multiplyScalar(GRENADE.friction).addScaledVector(_gN, -vn * GRENADE.bounce);
        bounced = true;
      } else if (_gN.y > 0.5) onFloor = true;
    }
    remaining *= GRENADE.bounce;
  }
  // rolling on a floor: grind to a halt
  if (onFloor) {
    const k = 1 - Math.min(1, 3 * dt);
    g.vel.x *= k;
    g.vel.z *= k;
  }
  return bounced;
}

// Where the throw starts, and its launch velocity: along the crosshair, plus some lift
const _throwDir = new THREE.Vector3();
function throwStart(p, outPos, outVel) {
  const fwd = camForward();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const chest = p.pos.clone().setY(p.pos.y + (p.crouched ? 1.1 : 1.65));
  outPos.copy(chest).addScaledVector(fwd, 0.35).addScaledVector(right, 0.2);
  // don't start inside a wall the player is hugging
  _gRay.origin.copy(chest);
  _gRay.direction.subVectors(outPos, chest);
  const len = _gRay.direction.length();
  _gRay.direction.normalize();
  const d = map.raycast(_gRay, len + GRENADE.radius);
  if (d < len + GRENADE.radius) outPos.copy(chest).addScaledVector(_gRay.direction, Math.max(0, d - GRENADE.radius * 2));
  camera.getWorldDirection(_throwDir);
  outVel.copy(_throwDir).multiplyScalar(GRENADE.speed);
  outVel.y += GRENADE.lift;
}

// Live grenades
const grenades = [];
const fuseLightMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
const fuseLightGeo = new THREE.SphereGeometry(0.018, 6, 4);
function spawnGrenade(pos, vel) {
  const mesh = templates.grenade.clone(true);
  mesh.position.copy(pos);
  mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
  lighting.addDynamic(mesh);
  const blink = new THREE.Mesh(fuseLightGeo, fuseLightMat);
  blink.position.y = GRENADE_SIZE * 0.52;
  lighting.addFx(blink);
  mesh.add(blink);
  scene.add(mesh);
  const spin = new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 20);
  grenades.push({ mesh, blink, pos: mesh.position, vel: vel.clone(), spin, fuse: GRENADE.fuse, acc: 0, bouncedOff: new Set() });
}
function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.fuse -= dt;
    g.acc += dt;
    while (g.acc >= GRENADE_STEP) {
      g.acc -= GRENADE_STEP;
      if (stepGrenade(g, GRENADE_STEP)) g.spin.multiplyScalar(0.6);
    }
    // glance off enemies (vertical cylinders) instead of flying through them
    for (const e of enemies) {
      if (e.dead || g.bouncedOff.has(e)) continue;
      const dx = g.pos.x - e.pos.x, dz = g.pos.z - e.pos.z;
      const r = e.radius * 0.8 + GRENADE.radius;
      if (dx * dx + dz * dz > r * r || g.pos.y < e.pos.y || g.pos.y > e.pos.y + CHAR_HEIGHT) continue;
      g.bouncedOff.add(e);
      _gN.set(dx, 0, dz).normalize();
      const vn = g.vel.dot(_gN);
      if (vn < 0) g.vel.addScaledVector(_gN, -vn * 1.3);
      g.vel.multiplyScalar(0.35);
    }
    g.mesh.rotation.x += g.spin.x * dt;
    g.mesh.rotation.y += g.spin.y * dt;
    g.mesh.rotation.z += g.spin.z * dt;
    g.spin.multiplyScalar(Math.max(0, 1 - 0.8 * dt));
    // fuse light blinks faster as it runs down
    const rate = THREE.MathUtils.lerp(3, 14, 1 - g.fuse / GRENADE.fuse);
    g.blink.visible = Math.sin(g.fuse * rate * Math.PI * 2) > 0;
    if (g.fuse <= 0 || g.pos.y < -30) {
      if (g.fuse <= 0) explode(g.pos.clone());
      scene.remove(g.mesh);
      grenades.splice(i, 1);
    }
  }
}
function clearGrenades() {
  for (const g of grenades) scene.remove(g.mesh);
  grenades.length = 0;
  for (const b of blasts) { scene.remove(b.mesh); b.mesh.material.dispose(); }
  blasts.length = 0;
  blastLight.intensity = 0;
  showThrowPreview(false);
}

// Explosion: radial damage with line of sight (a wall or car shields you), knockback + pop-up
const blasts = [];
const blastGeo = new THREE.SphereGeometry(1, 16, 12);
const blastLight = new THREE.PointLight(0xff9040, 0, 14, 2);
scene.add(blastLight);
const _losRay = new THREE.Ray();
function explode(pos) {
  // fireball (bright core) + smoke shell, one light shared by all blasts
  for (const [color, grow, life, alpha] of [[0xffd070, GRENADE.blastRadius * 0.4, 0.28, 0.95], [0x3a3634, GRENADE.blastRadius * 0.3, 0.8, 0.5]]) {
    const mesh = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.2);
    lighting.addFx(mesh);
    scene.add(mesh);
    blasts.push({ mesh, grow, life, max: life, alpha });
  }
  blastLight.position.copy(pos).y += 0.5;
  blastLight.intensity = 60;
  burst(pos, 0xffb040, 22, 10);
  burst(pos, 0xff6020, 14, 7);
  burst(pos, 0x6a6460, 12, 4);
  // screen shake by distance to the camera
  const camD = camera.position.distanceTo(pos);
  shake = Math.max(shake, THREE.MathUtils.clamp(1 - camD / 25, 0.15, 0.8));
  hitStop = Math.max(hitStop, 0.04);

  const R = GRENADE.blastRadius;
  let hitEnemy = false;
  for (const f of [player, ...enemies]) {
    if (!f) continue;
    const center = f.pos.clone().setY(f.pos.y + 0.9);
    const d = center.distanceTo(pos);
    if (d > R) continue;
    _losRay.origin.copy(pos);
    _losRay.direction.subVectors(center, pos).normalize();
    if (d > 0.3 && map.raycast(_losRay, d) < d - 0.15) continue; // behind cover
    const k = 1 - d / R;
    // pop everyone up (dead bodies too, for the show)
    const pop = GRENADE.launch * (0.3 + 0.7 * k);
    f.vy = Math.max(f.vy, pop);
    f.airborne = true;
    f.pos.y += 0.001;
    if (f.dead) { f.knock.add(f.pos.clone().sub(pos).setY(0).normalize().multiplyScalar(GRENADE.knock * k)); continue; }
    if (f.isPlayer && f.invulnerable) continue; // rolled through it
    let dmg = GRENADE.minDamage + (GRENADE.damage - GRENADE.minDamage) * k;
    if (f.isPlayer) { dmg *= GRENADE.selfMult; f.iframe = 0; }
    f.takeHit(Math.round(dmg), pos, GRENADE.knock * (0.4 + 0.6 * k), { crit: k > 0.7 });
    if (!f.isPlayer) hitEnemy = true;
  }
  if (hitEnemy) hitMarker(false);
}
function updateBlasts(dt) {
  if (blastLight.intensity > 0) blastLight.intensity = Math.max(0, blastLight.intensity - 220 * dt);
  for (let i = blasts.length - 1; i >= 0; i--) {
    const b = blasts[i];
    b.life -= dt;
    const t = 1 - b.life / b.max;
    b.mesh.scale.setScalar(0.2 + b.grow * (1 - Math.pow(1 - Math.min(1, t * 1.6), 3)));
    b.mesh.material.opacity = Math.max(0, 1 - t) * b.alpha;
    b.mesh.position.y += dt * 0.6;
    if (b.life <= 0) {
      scene.remove(b.mesh);
      b.mesh.material.dispose();
      blasts.splice(i, 1);
    }
  }
}

// Aim preview while the throw is wound up: the simulated arc + the blast radius where it goes off
const PREVIEW_PTS = 240;
const previewGeo = new THREE.BufferGeometry();
previewGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREVIEW_PTS * 3), 3));
const previewLine = new THREE.Line(previewGeo, new THREE.LineDashedMaterial({ color: 0xffe080, dashSize: 0.25, gapSize: 0.15, transparent: true, opacity: 0.85 }));
previewLine.frustumCulled = false;
const previewRing = new THREE.Mesh(
  new THREE.RingGeometry(GRENADE.blastRadius - 0.08, GRENADE.blastRadius, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff7040, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
);
const previewDot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff7040 }));
for (const o of [previewLine, previewRing, previewDot]) { o.visible = false; lighting.addFx(o); scene.add(o); }
function showThrowPreview(on) {
  previewLine.visible = previewRing.visible = previewDot.visible = on;
}
function updateThrowPreview(p) {
  const g = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
  throwStart(p, g.pos, g.vel);
  const arr = previewGeo.attributes.position.array;
  const every = Math.ceil((GRENADE.fuse / GRENADE_STEP) / PREVIEW_PTS);
  let n = 0, t = 0;
  arr[0] = g.pos.x; arr[1] = g.pos.y; arr[2] = g.pos.z; n = 1;
  for (let i = 1; t < GRENADE.fuse && n < PREVIEW_PTS; i++) {
    stepGrenade(g, GRENADE_STEP);
    t += GRENADE_STEP;
    if (i % every === 0) { arr[n * 3] = g.pos.x; arr[n * 3 + 1] = g.pos.y; arr[n * 3 + 2] = g.pos.z; n++; }
    if (g.vel.lengthSq() < 0.01) break; // came to rest
  }
  previewGeo.setDrawRange(0, n);
  previewGeo.attributes.position.needsUpdate = true;
  previewGeo.computeBoundingSphere();
  previewLine.computeLineDistances();
  previewDot.position.copy(g.pos);
  // ring on the floor under the burst point
  previewRing.position.set(g.pos.x, map.groundAt(g.pos, 0.05, g.pos.y + 0.1) + 0.03, g.pos.z);
  showThrowPreview(true);
}

// Muzzle flash + bullet tracers
const flashMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.07, 8, 6),
  new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false })
);
flashMesh.visible = false;
lighting.addFx(flashMesh);
scene.add(flashMesh);
const flashLight = new THREE.PointLight(0xffb050, 0, 6, 2);
scene.add(flashLight);
let flashT = 0;
const tracers = [];
const tracerMat = new THREE.LineBasicMaterial({ color: 0xfff0b0, transparent: true });
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat.clone());
  lighting.addFx(line);
  scene.add(line);
  tracers.push({ line, life: 0.07 });
}
function updateShotFx(dt) {
  if (flashT > 0) {
    flashT -= dt;
    const k = Math.max(0, flashT / 0.05);
    flashMesh.material.opacity = k;
    flashMesh.scale.setScalar(0.6 + Math.random() * 0.8);
    flashLight.intensity = 8 * k;
    flashMesh.visible = flashT > 0;
  } else flashLight.intensity = 0;
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.07);
    if (t.life <= 0) {
      scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
      tracers.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------
// Distance along a (normalised) ray to where it enters the capsule [pa, pb] of
// radius r, or -1 on a miss (Inigo Quilez's analytic ray/capsule intersection).
const _ba = new THREE.Vector3(), _oa = new THREE.Vector3(), _oc = new THREE.Vector3();
function rayCapsule(ro, rd, pa, pb, r) {
  _ba.subVectors(pb, pa);
  _oa.subVectors(ro, pa);
  const baba = _ba.dot(_ba), bard = _ba.dot(rd), baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa), oaoa = _oa.dot(_oa);
  const a = baba - bard * bard;
  if (a > 1e-9) {
    const b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return -1; // misses the infinite cylinder, so the caps too
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t; // body
    _oc.copy(y <= 0 ? _oa : _oc.subVectors(ro, pb)); // else the nearest cap
  } else _oc.copy(baoa <= 0 ? _oa : _oc.subVectors(ro, pb)); // ray along the axis
  const b = rd.dot(_oc), c = _oc.dot(_oc) - r * r, h = b * b - c;
  return h > 0 ? -b - Math.sqrt(h) : -1;
}
let showHitboxes = false;
const _hbUp = new THREE.Vector3(0, 1, 0), _hbDir = new THREE.Vector3();
const HITBOX_DEBUG_MAT = Object.fromEntries(
  Object.entries({ head: 0xff3040, body: 0xffd040, limb: 0x40c0ff }).map(([k, c]) => [
    k, new THREE.MeshBasicMaterial({ color: c, wireframe: true, transparent: true, opacity: 0.6, depthTest: false }),
  ])
);
function setHitboxDebug(on) {
  showHitboxes = on;
  for (const f of [player, ...enemies]) f?.toggleHitboxDebug(on);
}

// ---------------------------------------------------------------------------
// Fighter (shared by player + enemies)
// ---------------------------------------------------------------------------
// Throw pose keys (see Fighter.applyThrowPose): bone directions as [forward, up, right]
// weights in the fighter's frame, for phase 0 (wound up) .. 1 (follow-through), evenly spaced
const THROW_POSE = {
  upper: [[-0.45, 0.55, 0.75], [0.2, 1, 0.4], [1, 0.3, 0.2], [0.8, -0.55, -0.1]],
  fore: [[-0.4, 1, 0.05], [0.45, 1, 0], [1, 0.1, -0.1], [0.55, -0.8, -0.35]],
};
const _up = new THREE.Vector3(0, 1, 0);
const _tpA = new THREE.Vector3(), _tpB = new THREE.Vector3(), _tpC = new THREE.Vector3(), _tpD = new THREE.Vector3();
const _sbA = new THREE.Vector3(), _sbB = new THREE.Vector3();
const _sbQ = new THREE.Quaternion(), _sbP = new THREE.Quaternion(), _sbX = new THREE.Quaternion();
// Rotate `bone` (world space, by weight w) so the bone -> child joint direction points along dir
function swingBone(bone, child, dir, w) {
  bone.getWorldPosition(_sbA);
  child.getWorldPosition(_sbB).sub(_sbA).normalize();
  _sbQ.setFromUnitVectors(_sbB, dir);
  if (w < 1) _sbQ.slerpQuaternions(_sbX.identity(), _sbQ.clone(), w);
  // world delta -> parent space: local' = P^-1 * dq * P * local
  bone.parent.getWorldQuaternion(_sbP);
  _sbX.copy(_sbP).invert().multiply(_sbQ).multiply(_sbP);
  bone.quaternion.premultiply(_sbX);
  bone.updateMatrixWorld(true);
}

// Culling sphere radius (m) around a character's middle, see Fighter.setCullingSphere
const CULL_RADIUS = 2.2;

// A frame renders the scene several times (sun cascades, SSAO depth, main view) and three.js
// re-runs skeleton.update() (bone matrices + bone texture upload) on every one of them. Bones only
// move between frames, so fighters' skeletons update once per tick() (renderFrame). Code that
// moves bones mid-frame (hideHead) calls forceSkeletonUpdate.
let renderFrame = 0;
const skeletonUpdate = THREE.Skeleton.prototype.update;
function updateSkeletonOncePerFrame() {
  if (this.renderFrame === renderFrame) return;
  this.renderFrame = renderFrame;
  skeletonUpdate.call(this);
}
function forceSkeletonUpdate(fighter) {
  for (const sk of fighter.skeletons) { sk.renderFrame = renderFrame; skeletonUpdate.call(sk); }
}

class Fighter {
  constructor(templateName, { hp, isPlayer = false }) {
    const t = templates[templateName];
    this.root = new THREE.Group();
    this.model = SkeletonUtils.clone(t.scene);
    this.model.scale.setScalar(t.scale);
    this.model.position.y = -t.minY * t.scale;
    this.root.add(this.model);
    this.materials = [];
    this.skeletons = new Set();
    this.model.traverse((o) => {
      if (o.isMesh) {
        // Clone materials so each fighter can flash independently
        o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => this.materials.push(m));
      }
      if (o.isSkinnedMesh && !this.skeletons.has(o.skeleton)) {
        this.skeletons.add(o.skeleton);
        o.skeleton.update = updateSkeletonOncePerFrame;
      }
    });
    scene.add(this.root);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    for (const clip of t.animations) this.actions[clip.name.split('|').pop()] = this.mixer.clipAction(clip);
    this.current = null;

    this.isPlayer = isPlayer;
    this.hp = this.maxHp = hp;
    this.dead = false;
    this.state = 'move';
    this.stateTime = 0;
    this.stateDur = 0;
    this.attack = null;
    this.hitDone = false;
    this.knock = new THREE.Vector3();
    this.flash = 0;
    this.radius = 0.45;
    this.iframe = 0;
    this.vy = 0;
    this.airborne = false;
    this.squash = 0;
    this.baseScale = t.scale;

    this.buildHitboxes(); // before attachGun, which poses the rig to solve the grip
    this.setCullingSphere();
    if (isPlayer) {
      this.attachGun();
      this.headBone = this.model.getObjectByName('Head'); // first-person eye + hidden head
    }
    // receives probe GI + casts sun shadows, never baked into the probes
    lighting.addDynamic(this.root);
    for (const m of this.materials) if (m.userData.vertexMR) patchVertexMR(m);
  }

  // Frustum culling (main view, shadow cascades, AO depth): a fixed sphere around the character,
  // big enough for the widest poses (kicks, lying dead), instead of re-skinning every vertex to
  // fit one. Called while the root still sits at the origin, unrotated.
  setCullingSphere() {
    this.root.updateMatrixWorld(true);
    const center = new THREE.Vector3(0, CHAR_HEIGHT / 2, 0);
    this.model.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.boundingSphere = new THREE.Sphere(o.worldToLocal(center.clone()), CULL_RADIUS / o.matrixWorld.getMaxScaleOnAxis());
    });
  }

  // Resolve HITBOXES against this rig. Each capsule end is stored in its joint's local
  // space (measured in the bind pose), so it follows the joint through any animation.
  buildHitboxes() {
    this.root.updateMatrixWorld(true);
    const bone = (n) => this.model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) ?? this.model.getObjectByName(n);
    const top = new THREE.Box3().setFromObject(this.model, true).max.y;
    const end = (b, up, atTop, r) => {
      const p = b.getWorldPosition(new THREE.Vector3());
      if (atTop) p.y = Math.max(p.y, top - r);
      else if (up) p.y += up;
      return b.worldToLocal(p);
    };
    this.hitboxes = [];
    for (const h of HITBOXES) {
      const a = bone(h.a), b = bone(h.b);
      if (!a || !b) { console.warn(`Hitbox joint missing: ${h.a} / ${h.b}`); continue; }
      this.hitboxes.push({
        ...h, boneA: a, boneB: b,
        localA: end(a, h.aUp, false, h.r), localB: end(b, h.bUp, h.bTop, h.r),
        pa: new THREE.Vector3(), pb: new THREE.Vector3(),
      });
    }
    if (showHitboxes) this.toggleHitboxDebug(true);
  }

  // Nearest hitbox the ray enters between minD and maxD: { box, d } or null.
  // Uses the rig as last rendered (what the player saw when pulling the trigger).
  raycastHitboxes(ray, minD, maxD) {
    this.root.updateMatrixWorld(true);
    let best = null;
    for (const h of this.hitboxes) {
      h.pa.copy(h.localA).applyMatrix4(h.boneA.matrixWorld);
      h.pb.copy(h.localB).applyMatrix4(h.boneB.matrixWorld);
      const d = rayCapsule(ray.origin, ray.direction, h.pa, h.pb, h.r);
      if (d > minD && d < maxD) { maxD = d; best = { box: h, d }; }
    }
    return best;
  }

  // F4: wireframe capsules on every hitbox (debug)
  toggleHitboxDebug(on) {
    for (const h of this.hitboxes) {
      if (!on) { h.debug?.removeFromParent(); h.debug?.geometry.dispose(); h.debug = null; continue; }
      if (h.debug) continue;
      const len = h.pa.copy(h.localA).applyMatrix4(h.boneA.matrixWorld)
        .distanceTo(h.pb.copy(h.localB).applyMatrix4(h.boneB.matrixWorld));
      h.debug = new THREE.Mesh(new THREE.CapsuleGeometry(h.r, len, 3, 8), HITBOX_DEBUG_MAT[h.part]);
      lighting.addFx(h.debug);
      scene.add(h.debug);
    }
  }

  updateHitboxDebug() {
    for (const h of this.hitboxes) {
      if (!h.debug) continue;
      h.pa.copy(h.localA).applyMatrix4(h.boneA.matrixWorld);
      h.pb.copy(h.localB).applyMatrix4(h.boneB.matrixWorld);
      h.debug.position.addVectors(h.pa, h.pb).multiplyScalar(0.5);
      _hbDir.subVectors(h.pb, h.pa);
      if (_hbDir.lengthSq() > 1e-8) h.debug.quaternion.setFromUnitVectors(_hbUp, _hbDir.normalize());
    }
  }

  // Parent a pistol to the right hand bone, cancelling out the armature's scale
  attachGun() {
    const hand = this.model.getObjectByName('WristR') || this.model.getObjectByName('Wrist.R');
    if (!hand) { console.warn('Right hand bone not found'); return; }
    this.model.updateMatrixWorld(true);
    const s = new THREE.Vector3();
    hand.getWorldScale(s);
    this.gun = new THREE.Group(); // holds the grip transform, one child per firearm
    this.weapons = { pistol: makePistol(), uzi: makeUzi() };
    for (const w of Object.values(this.weapons)) { w.visible = false; this.gun.add(w); }
    this.gun.scale.setScalar(1 / s.x);
    this.gun.visible = false;
    hand.add(this.gun);
    this.hand = hand;
    this.recoil = 0;
    // Grips (hand-bone local): the original pack's pose, and one solved from the
    // retargeted Pistol_Aim_Neutral so its barrel points straight ahead too
    const native = { pos: new THREE.Vector3(...GUN_GRIP.pos).multiplyScalar(1 / s.x), quat: new THREE.Quaternion(...GUN_GRIP.quat).normalize() };
    this.grips = { native, ual: native };
    const aim = this.actions.Pistol_Aim_Neutral;
    if (aim) {
      aim.play();
      this.mixer.update(0);
      this.model.updateMatrixWorld(true);
      const q = hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.root.getWorldQuaternion(new THREE.Quaternion()));
      this.grips.ual = { pos: native.pos, quat: q };
      aim.stop();
    }
    this.gripPos = native.pos.clone();
    this.gun.position.copy(native.pos);
    this.gun.quaternion.copy(native.quat);
    this.attachSword(hand, s.x);
  }

  // Katana in the right fist. The grip is solved from the hand's own joints (bone-local, so it
  // holds for every clip): the handle runs through the fist along the pinky -> index knuckle
  // line, the blade leaves on the index/thumb side and the edge faces the knuckles.
  attachSword(hand, handScale) {
    const loc = (n) => {
      const b = this.model.getObjectByName(n);
      return b ? hand.worldToLocal(b.getWorldPosition(new THREE.Vector3())).multiplyScalar(handScale) : null;
    };
    // knuckle joints hang off metacarpals that just follow the wrist, so any pose will do
    this.model.updateMatrixWorld(true);
    const index = loc('Index2R'), pinky = loc('Pinky2R'), middle = loc('Middle2R');
    if (!index || !pinky || !middle) { console.warn('Right hand finger bones not found'); return; }
    const blade = index.clone().sub(pinky).normalize();
    const knuckles = middle.clone().normalize();
    // tilt the blade a little toward the knuckles (a hammer grip holds it at an angle)
    blade.addScaledVector(knuckles, SWORD_GRIP.tilt).normalize();
    const edge = knuckles.clone().addScaledVector(blade, -knuckles.dot(blade)).normalize();
    const side = new THREE.Vector3().crossVectors(blade, edge);
    // palm normal: the side of the hand the thumb sits on
    const palm = side.clone();
    const thumb = loc('Thumb2R');
    if (thumb && thumb.dot(palm) < 0) palm.negate();
    this.sword = templates.sword.clone(true);
    this.sword.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, blade, edge));
    // fist centre: part way from the wrist to the knuckles, between index and pinky, toward the palm
    this.sword.position.copy(middle).multiplyScalar(SWORD_GRIP.along)
      .addScaledVector(blade, SWORD_GRIP.lateral).addScaledVector(palm, SWORD_GRIP.palm)
      .divideScalar(handScale);
    this.sword.scale.setScalar(1 / handScale);
    this.sword.visible = false;
    hand.add(this.sword);
    // grenade held in the fist while winding up a throw
    this.handGrenade = templates.grenade.clone(true);
    this.handGrenade.position.copy(middle).multiplyScalar(0.75).addScaledVector(palm, 0.035).divideScalar(handScale);
    this.handGrenade.scale.setScalar(1 / handScale);
    this.handGrenade.visible = false;
    hand.add(this.handGrenade);
  }

  // Hide the gun / katana and put a grenade in the hand (throwing), or put them back
  setThrowProps(throwing, holding = throwing) {
    this.propsHidden = throwing;
    if (this.gun) this.gun.visible = !throwing && !!this.weapon;
    if (this.sword) this.sword.visible = !throwing && !!this.swordOn;
    if (this.handGrenade) this.handGrenade.visible = holding;
  }

  showSword(on) {
    this.swordOn = on;
    if (this.sword) this.sword.visible = on && !this.propsHidden;
  }

  // Procedural overhand throw on the right arm (no throw clip in the animation sets), applied
  // over whatever the mixer posed this frame (the mixer rewrites the bones every update, so
  // nothing accumulates). w: blend weight, phase: 0 = wound back with the hand behind the head,
  // 1 = followed through forward and down. Each bone is swung (world space) so it points
  // along the key direction, upper arm first, then the forearm.
  applyThrowPose(w, phase) {
    if (w <= 0) return;
    if (this.armBones === undefined) {
      const bone = (n) => this.model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) ?? this.model.getObjectByName(n);
      const b = { upperR: bone('UpperArm.R'), lowerR: bone('LowerArm.R'), wristR: bone('Wrist.R'), upperL: bone('UpperArm.L') };
      this.armBones = Object.values(b).every(Boolean) ? b : null;
      if (!this.armBones) console.warn('Arm bones not found: no throw pose');
    }
    const b = this.armBones;
    if (!b) return;
    this.root.updateMatrixWorld(true);
    const fwd = this.facing();
    const right = _tpA.setFromMatrixPosition(b.upperR.matrixWorld).sub(_tpB.setFromMatrixPosition(b.upperL.matrixWorld)).setY(0).normalize();
    const key = (out, [f, u, r]) => out.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(_up, u).addScaledVector(right, r).normalize();
    const dir = (keys, out) => {
      const t = Math.min(phase, 0.9999) * (keys.length - 1), i = Math.floor(t);
      return key(out, keys[i]).lerp(key(_tpC, keys[i + 1]), t - i).normalize();
    };
    swingBone(b.upperR, b.lowerR, dir(THROW_POSE.upper, _tpD), w);
    swingBone(b.lowerR, b.wristR, dir(THROW_POSE.fore, _tpD), w);
  }

  // Show one firearm (or none with null)
  setWeapon(name) {
    if (!this.gun) return;
    for (const [n, w] of Object.entries(this.weapons)) w.visible = n === name;
    this.gun.visible = !!name && !this.propsHidden;
    this.weapon = this.weapons[name] ?? null;
  }

  // Ease the pistol toward the grip that matches the current animation's source rig,
  // plus the procedural kick-back after a shot
  updateGrip(dt) {
    if (!this.gun) return;
    const name = this.current?.getClip().name ?? '';
    const g = name.includes('|') ? this.grips.native : this.grips.ual; // pack clips are "CharacterArmature|X"
    const k = Math.min(1, 16 * dt);
    this.gun.quaternion.slerp(g.quat, k);
    this.gripPos.lerp(g.pos, k);
    this.recoil *= Math.max(0, 1 - 25 * dt);
    this.gun.position.set(0, 0, -this.recoil * this.gun.scale.x).applyQuaternion(this.gun.quaternion).add(this.gripPos);
  }

  get pos() { return this.root.position; }

  facing() {
    const a = this.root.rotation.y;
    return new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
  }

  faceTowards(dir, dt, rate = 14) {
    if (dir.lengthSq() < 1e-6) return;
    const target = Math.atan2(dir.x, dir.z);
    let d = target - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += dt === 0 ? d : d * Math.min(1, rate * dt);
  }

  play(name, { once = false, fade = 0.12, speed = 1, from = 0 } = {}) {
    const a = this.actions[name];
    if (!a) return 0;
    if (this.current === a && !once) return a.getClip().duration / speed;
    a.reset();
    a.time = from;
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    a.timeScale = speed;
    a.setEffectiveWeight(1);
    a.fadeIn(fade).play();
    if (this.current && this.current !== a) this.current.fadeOut(fade);
    this.current = a;
    return (a.getClip().duration - from) / speed;
  }

  // Is the current (base) action this clip, and how far into it are we?
  playing(name) { return this.current === this.actions[name]; }

  // Additive aim-pitch layer: k in [-1, 1] (-1 = straight down, 1 = straight up)
  setAimPitch(k, dt) {
    if (!this.aimUp) {
      this.aimUp = this.actions.Aim_Up_Add?.play();
      this.aimDown = this.actions.Aim_Down_Add?.play();
      this.aimK = 0;
      if (!this.aimUp) return;
    }
    this.aimK += (k - this.aimK) * Math.min(1, 14 * dt);
    this.aimUp.setEffectiveWeight(Math.max(0, this.aimK));
    this.aimDown.setEffectiveWeight(Math.max(0, -this.aimK));
  }

  setState(state, dur = 0) {
    this.state = state;
    this.stateTime = 0;
    this.stateDur = dur;
  }

  startAttack(key) {
    const atk = ATTACKS[key];
    this.attack = atk;
    this.hitDone = false;
    this.setState('attack', this.play(atk.anim, { once: true, speed: atk.speed, fade: 0.06 }));
  }

  // `at`: where a bullet landed (damage number + sparks go there), `crit`: headshot
  takeHit(amount, fromPos, knock, { at = null, crit = false } = {}) {
    if (this.dead) return false;
    if (this.isPlayer && DEBUG.god) return false;
    if (!this.isPlayer) amount = DEBUG.oneShot ? this.hp : Math.max(1, Math.round(amount * DEBUG.damageMult));
    this.hp = Math.max(0, this.hp - amount);
    this.flash = 0.15;
    if (this.isPlayer) this.iframe = 0.7;
    const dir = this.pos.clone().sub(fromPos).setY(0).normalize();
    this.knock.copy(dir).multiplyScalar(knock);
    const head = at ?? this.pos.clone().setY(this.pos.y + 1.5);
    damageNumber(head, amount, this.isPlayer, crit);
    burst(at ?? head.clone().setY(this.pos.y + 1.2), crit ? 0xff4040 : this.isPlayer ? 0xff3030 : 0xffd040, crit ? 16 : 10, crit ? 5 : 4);
    if (this.hp <= 0) {
      this.die();
      return true;
    }
    this.faceTowards(dir.clone().negate(), 0);
    const anim = Math.random() < 0.5 ? 'HitRecieve' : 'HitRecieve_2';
    this.setState('hit', this.play(anim, { once: true, speed: 1.3, fade: 0.05 }));
    return false;
  }

  die() {
    this.dead = true;
    this.setState('dead', 99);
    if (this.aimUp) this.setAimPitch(0, 1);
    this.play('Death', { once: true, fade: 0.08 });
  }

  // Resolve an attack's hit frame against a list of targets
  resolveHit(targets) {
    const atk = this.attack;
    const fwd = this.facing();
    let hitAny = false;
    for (const t of targets) {
      if (t.dead || t === this || t.invulnerable || t.iframe > 0) continue;
      // strikes only reach targets roughly on the same level (not up to a rooftop / down a stairwell)
      if (Math.abs(t.pos.y - this.pos.y) > MAX_HIT_HEIGHT_DIFF) continue;
      const to = t.pos.clone().sub(this.pos).setY(0);
      const dist = to.length();
      if (dist > atk.range + t.radius) continue;
      if (dist > 0.3 && to.normalize().dot(fwd) < atk.arc) continue;
      t.takeHit(atk.damage + Math.round(Math.random() * 3), this.pos, atk.knock);
      hitAny = true;
    }
    return hitAny;
  }

  updateCommon(dt) {
    this.mixer.update(dt);
    this.updateGrip(dt);
    this.stateTime += dt;
    // knockback decay
    if (this.knock.lengthSq() > 0.001) {
      this.pos.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(Math.max(0, 1 - 8 * dt));
    }
    // jump / gravity / ground (sidewalks, planter, car roofs... from the map colliders)
    const ground = map.groundAt(this.pos, this.radius * 0.5, this.pos.y + STEP);
    if (this.airborne) {
      this.vy -= PHYS.gravity * dt;
      this.pos.y += this.vy * dt;
      if (this.vy <= 0 && this.pos.y <= ground) {
        this.pos.y = ground;
        this.vy = 0;
        this.airborne = false;
        this.landed = true; // consumed by the owner's animation logic
        this.squash = -0.08; // landing squash (Jump_Land adds its own knee bend)
        burst(this.pos.clone().setY(ground + 0.05), 0x9a93a8, 6, 2); // landing dust
      }
    } else if (this.pos.y - ground > STEP) {
      this.airborne = true; // walked off an edge: fall
      this.vy = 0;
    } else this.pos.y = ground;
    // squash & stretch for jump take-off / landing
    if (this.squash) {
      this.squash *= Math.max(0, 1 - 12 * dt);
      if (Math.abs(this.squash) < 0.002) this.squash = 0;
      const s = this.baseScale;
      this.model.scale.set(s * (1 - this.squash * 0.5), s * (1 + this.squash), s * (1 - this.squash * 0.5));
    }
    // hit flash
    if (this.flash > 0) this.flash -= dt;
    if (this.iframe > 0) this.iframe -= dt;
    const f = this.flash > 0 ? 1 : 0;
    for (const m of this.materials) if (m.emissive) m.emissive.setRGB(f, f * 0.2, f * 0.2);
  }

  dispose() {
    this.toggleHitboxDebug(false);
    scene.remove(this.root);
    this.mixer.stopAllAction();
    this.materials.forEach((m) => m.dispose());
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// Bindings use KeyboardEvent.code (physical key position), so the layout
// doesn't matter: on AZERTY the "KeyW" slot is the Z key, "KeyA" is Q, etc.
const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  punch: ['Mouse0', 'KeyJ'],
  kick: ['KeyK'],
  alt: ['Mouse2'], // right click: kick with fists, aim/zoom with the pistol
  roll: ['ShiftLeft', 'ShiftRight'], // tap = roll, hold = sprint
  crouch: ['ControlLeft', 'ControlRight'], // hold
  jump: ['Space'],
  swap: ['KeyQ'],
  hands: ['Digit1'],
  sword: ['Digit2'],
  pistol: ['Digit3'],
  uzi: ['Digit4'],
  reload: ['KeyR'],
  grenade: ['KeyG', 'Mouse1'], // hold: wind up + aim arc, release: throw
};
const keys = new Set();
const pressed = new Set(); // one-shot presses this frame
const released = new Set(); // one-shot releases this frame
const held = (action) => BINDINGS[action].some((c) => keys.has(c));
const hit = (action) => BINDINGS[action].some((c) => pressed.has(c));
const letGo = (action) => BINDINGS[action].some((c) => released.has(c)) && !held(action);

addEventListener('keydown', (e) => {
  if (!e.code) return;
  if (e.target.closest?.('.lil-gui') && !isLocked()) return; // typing in a debug panel field
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (e.code === 'F4') { e.preventDefault(); setHitboxDebug(!showHitboxes); } // debug: show hitboxes
});
addEventListener('keyup', (e) => { keys.delete(e.code); released.add(e.code); });
addEventListener('blur', () => keys.clear());
addEventListener('contextmenu', (e) => e.preventDefault());

// Mouse look (pointer lock)
const MOUSE_SENS = 0.0022;
const cam = { yaw: map.playerYaw, pitch: -0.25, dist: 1.5, curDist: 1.5, aim: 0 };
const isLocked = () => document.pointerLockElement === renderer.domElement;
function lockPointer() {
  const p = renderer.domElement.requestPointerLock?.();
  if (p && p.catch) p.catch(() => {});
}
addEventListener('mousedown', (e) => {
  if (!isLocked()) return;
  if (e.button === 1) e.preventDefault(); // middle click: no autoscroll
  pressed.add('Mouse' + e.button);
  keys.add('Mouse' + e.button);
});
addEventListener('mouseup', (e) => keys.delete('Mouse' + e.button));
addEventListener('mousemove', (e) => {
  if (!isLocked()) return;
  const sens = MOUSE_SENS * (1 - 0.4 * cam.aim); // finer look while aiming
  cam.yaw -= e.movementX * sens;
  const fp = firstPerson();
  cam.pitch = THREE.MathUtils.clamp(cam.pitch - e.movementY * sens, fp ? FP.pitchMin : TP_PITCH.min, fp ? FP.pitchMax : TP_PITCH.max);
});
// Mouse wheel cycles fight mode (fists -> pistol -> uzi). Throttled so one trackpad
// swipe or a fast wheel spin doesn't skip through them.
let wheelSwap = 0;
let lastWheelSwap = 0;
addEventListener('wheel', (e) => {
  if (!isLocked()) return;
  const now = performance.now();
  if (Math.abs(e.deltaY) < 1 || now - lastWheelSwap < 250) return;
  lastWheelSwap = now;
  wheelSwap += Math.sign(e.deltaY);
}, { passive: true });
renderer.domElement.addEventListener('click', () => {
  if (running && !paused && !isLocked()) lockPointer();
});

// Show the actual key labels for the user's layout (e.g. ZQSD on AZERTY)
async function localizeKeyLabels() {
  const map = await navigator.keyboard?.getLayoutMap?.().catch(() => null);
  const label = (code) => (map?.get(code) ?? code.replace(/^Key/, '')).toUpperCase();
  document.querySelectorAll('[data-keys]').forEach((el) => {
    el.textContent = el.dataset.keys.split(',').map(label).join('');
  });
  document.querySelectorAll('[data-key]').forEach((el) => {
    el.textContent = label(el.dataset.key);
  });
}
localizeKeyLabels();

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let player = null;
let enemies = [];
let wave = 0;
let kills = 0;
let running = false;
let paused = false;
let spawnQueue = 0;
let spawnTimer = 0;
let waveDelay = 0;
// first-person view is only used in game (menus / game over keep the orbiting third-person camera)
const firstPerson = () => FP.enabled && running && !!player?.headBone;

const hpFill = document.getElementById('hp-fill');
const waveEl = document.getElementById('wave');
const killsEl = document.getElementById('kills');
const leftEl = document.getElementById('left');
const banner = document.getElementById('banner');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');

function showBanner(text, ms = 1600) {
  banner.textContent = text;
  banner.classList.add('show');
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => banner.classList.remove('show'), ms);
}

function resetGame() {
  enemies.forEach((e) => { e.dispose(); e.bar?.remove(); });
  enemies = [];
  if (player) player.dispose();
  player = new Fighter(PLAYER_MODEL, { hp: 100, isPlayer: true });
  player.pos.set(...map.playerSpawn);
  player.play('Idle');
  player.comboStep = 0;
  player.comboWindow = 0;
  player.queued = null;
  player.invulnerable = false;
  player.ammo = Object.fromEntries(GUNS.map((g) => [g, WEAPONS[g].magSize]));
  player.reloadT = 0;
  player.fireCd = 0;
  player.aimT = 0;
  player.shootAnimT = 0;
  player.crouched = false;
  player.shiftT = 0;
  player.grenades = GRENADE.start;
  player.grenadeCd = 0;
  player.throw = null;
  clearGrenades();
  updateGrenadeHud();
  setMode('hands', false);
  wheelSwap = 0;
  wave = 0;
  kills = 0;
  spawnQueue = 0;
  waveDelay = 0.5;
  cam.yaw = map.playerYaw;
  cam.pitch = -0.25;
  running = true;
  paused = false;
}

function nextWave() {
  wave++;
  spawnQueue = 2 + wave;
  spawnTimer = 0;
  showBanner(`WAVE ${wave}`);
  if (wave > 1) {
    player.hp = Math.min(player.maxHp, player.hp + 25);
    player.grenades = Math.min(GRENADE.max, player.grenades + GRENADE.perWave);
    updateGrenadeHud();
  }
}

function spawnEnemy() {
  const model = ENEMY_MODELS[Math.floor(Math.random() * ENEMY_MODELS.length)];
  const e = new Fighter(model, { hp: 40 + wave * 8 });
  // spawn in an alley / the arcade, preferably out of the player's reach
  const far = map.spawns.filter((s) => Math.hypot(s[0] - player.pos.x, s[2] - player.pos.z) > 10);
  const pool = far.length ? far : map.spawns;
  const s = pool[Math.floor(Math.random() * pool.length)];
  e.pos.set(s[0] + (Math.random() - 0.5) * 1.5, s[1], s[2] + (Math.random() - 0.5) * 1.5);
  e.faceTowards(player.pos.clone().sub(e.pos).setY(0), 0);
  e.speed = 2.6 + Math.random() * 0.8 + wave * 0.12;
  e.cooldown = 1 + Math.random();
  e.deadTime = 0;
  e.play('Idle');
  const bar = document.createElement('div');
  bar.className = 'ehp';
  bar.innerHTML = '<div></div>';
  labelsEl.appendChild(bar);
  e.bar = bar;
  burst(e.pos.clone().setY(0.5), 0xb080ff, 20, 5);
  enemies.push(e);
}

// ---------------------------------------------------------------------------
// Fight mode (hands / gun) + shooting
// ---------------------------------------------------------------------------
let mode = 'hands'; // 'hands' or a WEAPONS key
const weapon = () => WEAPONS[mode]; // current firearm, undefined with fists
const modeEl = document.getElementById('mode');
function updateModeHud() {
  if (!modeEl || !player) return;
  const w = weapon();
  modeEl.classList.toggle('gun', !!w);
  modeEl.style.borderColor = w ? '#' + w.color.toString(16).padStart(6, '0') : '';
  if (!w) modeEl.innerHTML = `<b>${MELEE_NAMES[mode]}</b>`;
  else if (player.reloadT > 0) modeEl.innerHTML = `<b>${w.name}</b> reloading…`;
  else modeEl.innerHTML = `<b>${w.name}</b> ${player.ammo[mode]} / ${w.magSize}`;
}
function setMode(m, announce = true) {
  mode = m;
  player?.setWeapon(WEAPONS[m] ? m : null);
  player?.showSword(m === 'sword');
  if (player) { player.queued = null; player.aimT = 0; player.shootAnimT = 0; player.reloadT = 0; }
  if (announce) burst(player.pos.clone().setY(1.2), WEAPONS[m]?.color ?? (m === 'sword' ? 0xd8e4ff : 0xffd040), 6, 2);
  updateModeHud();
}

function startReload() {
  const p = player, w = weapon();
  if (!w || p.reloadT > 0 || p.ammo[mode] === w.magSize) return;
  p.reloadT = w.reloadTime;
  updateModeHud();
}

const grenadeEl = document.getElementById('grenades');
function updateGrenadeHud() {
  if (!grenadeEl || !player) return;
  grenadeEl.innerHTML = `<b>GRENADES</b> ${DEBUG.infiniteAmmo ? '∞' : player.grenades}`;
  grenadeEl.classList.toggle('empty', !DEBUG.infiniteAmmo && player.grenades <= 0);
}

// Grenade throw (any weapon): wind (arm back, arc preview while held) -> swing (released part
// way through) -> recover (arm blends back into the animation), then the gun / katana return
function startThrow(p) {
  p.throw = { phase: 'wind', t: 0, w: 0, p: 0, released: false };
  p.queued = null;
  if (p.reloadT > 0) { p.reloadT = 0; updateModeHud(); } // the gun hand is busy
  p.setThrowProps(true);
}
function endThrow(p) {
  p.throw = null;
  p.setThrowProps(false);
  showThrowPreview(false);
}
function updateThrow(p, dt, fwd) {
  p.grenadeCd -= dt;
  if (!p.throw && hit('grenade') && p.state === 'move' && p.grenadeCd <= 0) {
    if (p.grenades > 0 || DEBUG.infiniteAmmo) startThrow(p);
    else showBanner('NO GRENADES', 700);
  }
  const th = p.throw;
  if (!th) return;
  // knocked down / rolled / died before letting go: keep the grenade
  if (!th.released && (p.dead || p.state === 'hit' || p.state === 'roll')) { endThrow(p); return; }
  th.t += dt;
  p.faceTowards(fwd, dt, 20);
  if (th.phase === 'wind') {
    th.w = Math.min(1, th.t / GRENADE.windup);
    th.p = 0;
    updateThrowPreview(p);
    if (!held('grenade') && th.t >= GRENADE.windup) { th.phase = 'swing'; th.t = 0; }
  } else if (th.phase === 'swing') {
    th.w = 1;
    const k = Math.min(1, th.t / GRENADE.swing);
    th.p = k * k * (3 - 2 * k);
    if (!th.released && k >= GRENADE.releaseAt) {
      th.released = true;
      const pos = new THREE.Vector3(), vel = new THREE.Vector3();
      throwStart(p, pos, vel);
      spawnGrenade(pos, vel);
      if (!DEBUG.infiniteAmmo) p.grenades--;
      p.grenadeCd = GRENADE.cooldown;
      p.setThrowProps(true, false); // left the hand
      showThrowPreview(false);
      updateGrenadeHud();
    }
    if (k >= 1) { th.phase = 'recover'; th.t = 0; }
  } else {
    th.p = 1;
    th.w = Math.max(0, 1 - th.t / GRENADE.recover);
    if (th.t >= GRENADE.recover) endThrow(p);
  }
}

const _ray = new THREE.Ray();
const _hitPt = new THREE.Vector3();
// Crosshair hit marker: white X on a hit, bigger red X on a headshot
const hitMarkerEl = document.getElementById('hitmarker');
function hitMarker(crit) {
  hitMarkerEl.className = '';
  void hitMarkerEl.offsetWidth; // restart the CSS animation
  hitMarkerEl.className = crit ? 'show crit' : 'show';
}
// Fire along the crosshair: ray from the camera through screen centre
function shoot() {
  const p = player, w = weapon();
  _ray.origin.copy(camera.position);
  camera.getWorldDirection(_ray.direction);
  // hip fire is inaccurate; aiming (right click) tightens it (dead on with the pistol)
  const spread = THREE.MathUtils.lerp(w.hipSpread, w.aimSpread, cam.aim) + (p.airborne ? w.hipSpread : 0);
  if (spread > 0) {
    _ray.direction.x += (Math.random() - 0.5) * 2 * spread;
    _ray.direction.y += (Math.random() - 0.5) * 2 * spread;
    _ray.direction.z += (Math.random() - 0.5) * 2 * spread;
    _ray.direction.normalize();
  }

  // nearest enemy hitbox (capsules on the animated skeleton), ignoring anything behind the player
  let target = null, targetBox = null, bestD = w.range + cam.curDist;
  const minD = cam.curDist * 0.8;
  for (const e of enemies) {
    if (e.dead) continue;
    // cheap reject: the whole body fits in a ~1.3 m sphere around the hips
    _hitPt.copy(e.pos).y += 0.9;
    if (_ray.distanceSqToPoint(_hitPt) > 1.3 * 1.3) continue;
    const h = e.raycastHitboxes(_ray, minD, bestD);
    if (h) { bestD = h.d; target = e; targetBox = h.box; }
  }
  // walls, cars, crates and the ground stop bullets
  const wallD = map.raycast(_ray, w.range + cam.curDist);
  if (wallD < bestD) { bestD = wallD; target = null; }
  const end = _ray.at(bestD, new THREE.Vector3());

  // turn the body toward the shot
  p.faceTowards(end.clone().sub(p.pos).setY(0), 0);
  p.root.updateMatrixWorld(true);
  const muzzle = p.weapon.userData.muzzle.getWorldPosition(new THREE.Vector3());

  spawnTracer(muzzle, end);
  flashMesh.position.copy(muzzle);
  flashLight.position.copy(muzzle);
  flashMesh.visible = true;
  flashT = 0.05;
  shake = Math.max(shake, w.shake);
  p.recoil = w.recoil;

  if (target) {
    const crit = targetBox.part === 'head';
    const dmg = Math.max(1, Math.round((w.damage + Math.random() * w.damageRand) * HIT_MULT[targetBox.part]));
    target.takeHit(dmg, p.pos, w.knock * (crit ? 1.5 : 1), { at: end, crit });
    hitMarker(crit);
    burst(end, crit ? 0xff6060 : 0xffe0a0, 6, 3);
    hitStop = Math.max(hitStop, w.hitStop);
  } else {
    burst(end, 0xaaaaaa, 4, 2);
  }

  if (!DEBUG.infiniteAmmo) p.ammo[mode]--;
  p.fireCd = w.fireInterval;
  p.aimT = GUN_AIM_HOLD;
  if (p.ammo[mode] <= 0) startReload();
  updateModeHud();
}

// ---------------------------------------------------------------------------
// Player logic
// ---------------------------------------------------------------------------
function camForward() {
  return new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
}

// Soft aim assist: nearest enemy in reach, favouring the one under the crosshair
function aimTarget(fwd, maxDist) {
  let best = null, bs = -Infinity;
  for (const e of enemies) {
    if (e.dead) continue;
    const to = e.pos.clone().sub(player.pos).setY(0);
    const d = to.length();
    if (d > maxDist) continue;
    const dot = d > 0.01 ? to.normalize().dot(fwd) : 1;
    if (dot < 0.5 && d > 1.6) continue; // outside the aim cone unless very close
    const score = dot * 2 - d;
    if (score > bs) { bs = score; best = e; }
  }
  return best;
}

// Pitch (radians) from the player's chest to what the crosshair is on
const _aimDir = new THREE.Vector3();
const _aimRay = new THREE.Ray();
function aimPitch() {
  camera.getWorldDirection(_aimDir);
  _aimRay.set(camera.position, _aimDir);
  const d = map.raycast(_aimRay, 25); // what the crosshair is on (walls, floor)
  const x = camera.position.x + _aimDir.x * d - player.pos.x;
  const z = camera.position.z + _aimDir.z * d - player.pos.z;
  const y = camera.position.y + _aimDir.y * d - (player.pos.y + (player.crouched ? 1.0 : 1.4));
  return Math.atan2(y, Math.max(1.5, Math.hypot(x, z)));
}

// Jump_Start -> Jump_Loop while airborne, a short Jump_Land after touching down.
// sfx picks the arm variant: '_Gun' (two-handed pistol aim), '_Sword' (katana carry) or ''.
// Returns true when it drives the base animation.
function jumpAnim(p, sfx) {
  const c = p.current?.getClip();
  const phase = (n) => c?.name.startsWith(n);
  if (p.airborne) {
    if (phase('Jump_Start') && p.current.time < c.duration - 0.15) {
      // swap arm variant mid-take-off without restarting it
      if (c.name !== 'Jump_Start' + sfx) p.play('Jump_Start' + sfx, { once: true, from: p.current.time, speed: JUMP_ANIM.startSpeed, fade: 0.1 });
    } else p.play('Jump_Loop' + sfx, { fade: 0.25 });
    return true;
  }
  if (p.landT > 0) {
    if (!phase('Jump_Land')) p.play('Jump_Land' + sfx, { once: true, from: JUMP_ANIM.landFrom, speed: JUMP_ANIM.landSpeed, fade: 0.05 });
    else if (c.name !== 'Jump_Land' + sfx) p.play('Jump_Land' + sfx, { once: true, from: p.current.time, speed: JUMP_ANIM.landSpeed, fade: 0.1 });
    return true;
  }
  return false;
}

function updatePlayer(dt) {
  const p = player;
  p.updateCommon(dt);
  if (p.dead) { if (p.throw) endThrow(p); return; }
  const fp = firstPerson();

  // Camera-relative movement
  const fwd = camForward();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const f = (held('forward') ? 1 : 0) - (held('back') ? 1 : 0);
  const s = (held('right') ? 1 : 0) - (held('left') ? 1 : 0);
  const input = fwd.clone().multiplyScalar(f).addScaledVector(right, s);
  if (input.lengthSq() > 0) input.normalize();

  // Fight mode switching: mouse wheel / Q cycle fists -> katana -> pistol -> uzi, 1..4 select
  const step = wheelSwap || (hit('swap') ? 1 : 0);
  const pick = MODES.find((m) => hit(m) && m !== mode);
  if (p.throw) { /* hands are busy: no weapon swap mid-throw */ }
  else if (step) setMode(MODES[(MODES.indexOf(mode) + step + MODES.length * 8) % MODES.length]);
  else if (pick) setMode(pick);
  wheelSwap = 0;
  updateThrow(p, dt, fwd);
  const throwing = !!p.throw;

  const w = weapon();
  const gunMode = !!w;
  p.fireCd -= dt;
  p.aimT -= dt;
  p.shootAnimT -= dt;
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) { p.reloadT = 0; p.ammo[mode] = w.magSize; updateModeHud(); }
  }
  if (gunMode && hit('reload') && !throwing) startReload();

  // Right click: aim down the sights with the pistol (hold), kick with fists
  p.aiming = gunMode && held('alt') && p.state !== 'roll';
  if (p.aiming) p.aimT = Math.max(p.aimT, 0.15);

  if (!gunMode && hit('punch') && !throwing) p.queued = 'punch';
  if ((hit('kick') || (!gunMode && hit('alt'))) && !throwing) p.queued = 'kick';
  // Shift: a quick tap (released before MOVE.rollTap) rolls, holding it sprints
  if (hit('roll')) p.shiftT = 0;
  if (held('roll')) p.shiftT = (p.shiftT || 0) + dt;
  if (letGo('roll') && (p.shiftT || 0) < MOVE.rollTap) p.queued = 'roll';
  const sprintHeld = held('roll') && p.shiftT >= MOVE.rollTap;
  // Hold Ctrl to crouch (standing moves like roll / attacks / jump stand up while they last)
  p.crouched = held('crouch') && !p.airborne && p.state !== 'roll' && p.state !== 'attack';
  p.comboWindow -= dt;

  // Jump (works in both modes, you can steer and shoot mid-air)
  if (hit('jump') && p.state === 'move' && !p.airborne) {
    p.crouched = false;
    p.vy = PHYS.jumpSpeed;
    p.airborne = true;
    p.pos.y += 0.001;
    p.squash = 0.1; // take-off stretch
    p.landT = 0;
    const gunAim = gunMode && (held('punch') || p.aimT > 0);
    p.play(gunAim ? 'Jump_Start_Gun' : mode === 'sword' ? 'Jump_Start_Sword' : 'Jump_Start', { once: true, from: JUMP_ANIM.startFrom, speed: JUMP_ANIM.startSpeed, fade: 0.06 });
  }
  if (p.landed) {
    p.landed = false;
    if (p.state === 'move') p.landT = input.lengthSq() > 0 ? JUMP_ANIM.landHoldMoving : JUMP_ANIM.landHold;
  }
  p.landT = Math.max(0, (p.landT || 0) - dt);

  const canAct = !p.airborne && (p.state === 'move' || (p.state === 'attack' && p.stateTime > p.stateDur * 0.6) || (p.state === 'hit' && p.stateTime > p.stateDur * 0.7));

  if (canAct && p.queued) {
    const q = p.queued;
    p.queued = null;
    p.crouched = false; // rolls and attacks are standing moves
    if (q === 'roll') {
      const dir = input.lengthSq() > 0 ? input.clone() : fwd.clone();
      p.faceTowards(dir, 0);
      p.rollDir = dir;
      p.invulnerable = true;
      p.setState('roll', p.play('Roll', { once: true, speed: 1.7, fade: 0.05 }));
    } else {
      // Attack where the camera looks, snapping to an enemy in the aim cone
      const target = aimTarget(fwd, 3.2);
      p.faceTowards(target ? target.pos.clone().sub(p.pos) : fwd, 0);
      if (q === 'kick') {
        p.startAttack('kick');
        p.comboStep = 0;
      } else if (mode === 'sword') {
        // quick cut, then the wide sweep as the finisher; the longer sweep gets more time to chain
        p.comboStep = p.comboWindow > 0 ? (p.comboStep + 1) % 2 : 0;
        p.startAttack(p.comboStep === 0 ? 'swordSlash' : 'swordSweep');
        p.comboWindow = p.comboStep === 0 ? 1.0 : 0.3;
      } else {
        p.comboStep = p.comboWindow > 0 ? (p.comboStep + 1) % 2 : 0;
        p.startAttack(p.comboStep === 0 ? 'punchR' : 'punchL');
        p.comboWindow = 0.9;
      }
    }
  }

  switch (p.state) {
    case 'move': {
      const moving = input.lengthSq() > 0;
      // first person: the body always turns with the view (no strafing clips, legs just run)
      if (fp) p.faceTowards(fwd, dt, 30);
      if (moving) p.landT = Math.min(p.landT, JUMP_ANIM.landHoldMoving);
      // blend out of the landing a bit slower so the knee bend doesn't pop
      const fade = p.current?.getClip().name.startsWith('Jump_Land') ? 0.2 : 0.12;
      if (gunMode) {
        const trigger = held('punch') && !throwing;
        // sprinting lowers the gun; pulling the trigger / aiming cancels the sprint
        const sprint = sprintHeld && moving && !trigger && !p.aiming;
        if (sprint) { p.aimT = 0; p.crouched = false; }
        // Gun lowered: raise it first so the first bullet leaves from a pointed barrel
        if (trigger && p.aimT <= 0) { p.aimT = GUN_AIM_HOLD; p.fireCd = Math.max(p.fireCd, 0.12); }
        if (trigger && p.fireCd <= 0) {
          if (p.ammo[mode] > 0 && p.reloadT <= 0) {
            shoot();
            if (w.shootAnim && !moving && !p.airborne && !p.crouched) {
              // Pistol_Shoot's recoil kick, sped up to fit the fire interval
              p.play('Pistol_Shoot', { once: true, speed: 2.4, fade: 0.04 });
              p.shootAnimT = w.fireInterval + 0.05;
              p.landT = 0;
            }
          } else if (p.ammo[mode] <= 0) startReload();
        }
        const aiming = trigger || p.aimT > 0;
        const reloading = p.reloadT > 0;
        const gunUp = aiming && !reloading;
        if (aiming) p.faceTowards(fwd, dt, 20);
        if (moving) {
          let speed = sprint ? MOVE.sprint : p.aiming ? AIM.moveSpeed : aiming ? 4.2 : MOVE.run;
          if (p.crouched) speed = Math.min(speed, MOVE.crouch);
          p.pos.addScaledVector(input, speed * dt);
          if (!aiming && !fp) p.faceTowards(input, dt);
        }
        // raise / lower the arms toward the crosshair (additive aim offsets)
        p.setAimPitch(gunUp ? aimPitch() / (Math.PI / 2) : 0, dt);
        if (jumpAnim(p, gunUp ? '_Gun' : '')) break;
        if (p.crouched) p.play(moving ? (gunUp ? 'Crouch_Fwd_Aim' : 'Crouch_Fwd_Loop') : gunUp ? 'Crouch_Idle_Aim' : 'Crouch_Idle_Loop', { fade: 0.2 });
        else if (reloading && !moving) {
          // pick up the reload where it is, e.g. after stopping mid-reload
          const d = p.actions.Pistol_Reload.getClip().duration;
          if (!p.playing('Pistol_Reload'))
            p.play('Pistol_Reload', { once: true, speed: d / w.reloadTime, from: d * (1 - p.reloadT / w.reloadTime), fade: 0.15 });
        } else if (moving) p.play(sprint ? 'Sprint_Loop' : gunUp ? 'Run_Shoot' : 'Run', { fade });
        else if (p.shootAnimT <= 0) p.play(aiming ? 'Pistol_Idle_Loop' : 'Idle_Gun', { fade });
        break;
      }
      p.setAimPitch(0, dt);
      const sprint = sprintHeld && moving;
      if (sprint) p.crouched = false;
      if (moving) {
        p.pos.addScaledVector(input, (p.crouched ? MOVE.crouch : sprint ? MOVE.sprint : MOVE.run) * dt);
        if (!fp) p.faceTowards(input, dt);
      }
      // with the katana: the carry variants keep the blade low and forward
      const sw = mode === 'sword' ? '_Sword' : '';
      if (!jumpAnim(p, sw)) {
        if (p.crouched) p.play((moving ? 'Crouch_Fwd_Loop' : 'Crouch_Idle_Loop') + sw, { fade: 0.2 });
        else if (!moving) p.play(sw ? 'Idle_Sword' : 'Idle', { fade });
        else p.play((sprint ? 'Sprint_Loop' : 'Run') + sw, { fade });
      }
      break;
    }
    case 'attack': {
      const atk = p.attack;
      if (p.stateTime < p.stateDur * atk.hitAt) p.pos.addScaledVector(p.facing(), atk.lunge * dt);
      if (!p.hitDone && p.stateTime >= p.stateDur * atk.hitAt) {
        p.hitDone = true;
        if (p.resolveHit(enemies)) {
          hitStop = atk.hitStop ?? (atk === ATTACKS.kick ? 0.09 : 0.05);
          shake = atk.shake ?? (atk === ATTACKS.kick ? 0.35 : 0.18);
        }
      }
      if (p.stateTime >= p.stateDur) p.setState('move');
      break;
    }
    case 'roll': {
      const t = p.stateTime / p.stateDur;
      p.pos.addScaledVector(p.rollDir, (t < 0.75 ? 9 : 3) * dt);
      if (t > 0.8) p.invulnerable = false;
      if (p.stateTime >= p.stateDur) { p.invulnerable = false; p.setState('move'); }
      break;
    }
    case 'hit':
      if (p.stateTime >= p.stateDur) p.setState('move');
      break;
  }
  if (p.state !== 'move') p.setAimPitch(0, dt);
  // grenade throw arm, over whatever the mixer played (a roll / hit cancels it in updateThrow)
  if (p.throw) p.applyThrowPose(p.throw.w, p.throw.p);
}

// ---------------------------------------------------------------------------
// Enemy AI
// ---------------------------------------------------------------------------
function updateEnemy(e, dt) {
  e.updateCommon(dt);
  if (e.dead) {
    e.deadTime += dt;
    if (e.deadTime > 2.2) e.model.position.y -= dt * 0.8; // sink into floor
    return;
  }
  e.cooldown -= dt;
  const toPlayer = player.pos.clone().sub(e.pos).setY(0);
  const dist = toPlayer.length();

  switch (e.state) {
    case 'move': {
      if (DEBUG.freezeAI) { e.play('Idle'); break; }
      if (player.dead) { e.play('Wave'); break; }
      // separation from other enemies
      const sep = new THREE.Vector3();
      for (const o of enemies) {
        if (o === e || o.dead) continue;
        const d = e.pos.clone().sub(o.pos).setY(0);
        const l = d.length();
        if (l < 1.2 && l > 0.001) sep.addScaledVector(d.normalize(), (1.2 - l) * 3);
      }
      e.faceTowards(toPlayer, dt, 8);
      // Only 2 enemies may engage at once; the rest circle at a distance
      const attackers = enemies.filter((o) => !o.dead && o !== e && (o.state === 'attack' || o.engaged)).length;
      e.engaged = attackers < 2 && (e.engaged || dist < 3);
      const wantDist = e.engaged ? 1.4 : 3.2;
      if (!e.engaged && dist < 4) {
        e.strafeDir ??= Math.random() < 0.5 ? 1 : -1;
        const dirTo = toPlayer.clone().normalize();
        const tangent = new THREE.Vector3(-dirTo.z, 0, dirTo.x).multiplyScalar(e.strafeDir * 1.4);
        const radial = dirTo.multiplyScalar((dist - wantDist) * 2);
        e.pos.addScaledVector(tangent.add(radial).add(sep), dt);
        e.play('Walk');
      } else if (dist > wantDist) {
        const move = toPlayer.clone().normalize().multiplyScalar(e.speed * DEBUG.enemySpeed).add(sep);
        e.pos.addScaledVector(move, dt);
        e.play('Run');
      } else {
        e.pos.addScaledVector(sep, dt);
        e.play('Idle');
        if (e.cooldown <= 0 && Math.abs(player.pos.y - e.pos.y) <= MAX_HIT_HEIGHT_DIFF) {
          e.startAttack(Math.random() < 0.7 ? 'enemyPunch' : 'enemyKick');
          e.cooldown = 1.6 + Math.random() * 1.4 - Math.min(0.8, wave * 0.08);
        }
      }
      break;
    }
    case 'attack': {
      if (!e.hitDone && e.stateTime >= e.stateDur * e.attack.hitAt) {
        e.hitDone = true;
        if (e.resolveHit([player])) shake = 0.25;
      } else if (!e.hitDone) {
        e.faceTowards(toPlayer, dt, 4); // track a little during wind-up
      }
      if (e.stateTime >= e.stateDur) e.setState('move');
      break;
    }
    case 'hit':
      if (e.stateTime >= e.stateDur) e.setState('move');
      break;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const timer = new THREE.Timer();
const camTarget = new THREE.Vector3(...map.playerSpawn);
const _camPivot = new THREE.Vector3();
const _camRay = new THREE.Ray();

function tick() {
  requestAnimationFrame(tick);
  perf.begin();
  renderFrame++;
  timer.update();
  const realDt = timer.getDelta();
  let dt = Math.min(realDt, 0.05) * DEBUG.timeScale;
  renderer.info.reset(); // autoReset is off: count every pass of the frame (shadows, AO, main)
  lighting.update(dt, realDt * 1000); // GI bake steps + auto exposure (real time)
  if (!booted) updateBootStatus();

  if (hitStop > 0) { hitStop -= dt; dt *= 0.05; }
  if (paused) dt = 0;

  if (running && player && !paused) {
    updatePlayer(dt);
    for (const e of enemies) {
      const wasDead = e.dead;
      updateEnemy(e, dt);
      if (!wasDead && e.dead) {} // handled below
    }
    updateGrenades(dt);

    // count kills / cleanup
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.dead && !e.counted) {
        e.counted = true;
        kills++;
        e.bar.remove();
        burst(e.pos.clone().setY(1), 0xffffff, 18, 6);
      }
      if (e.dead && e.deadTime > 3.5) {
        e.dispose();
        enemies.splice(i, 1);
      }
    }

    // resolve player/enemy overlap
    for (const e of enemies) {
      if (e.dead) continue;
      const d = e.pos.clone().sub(player.pos).setY(0);
      const l = d.length();
      const min = e.radius + player.radius;
      if (l < min && l > 0.001 && player.state !== 'roll') {
        d.normalize().multiplyScalar((min - l) * 0.5);
        e.pos.add(d);
        player.pos.sub(d);
      }
    }
    // keep everyone out of walls, cars, crates...
    map.collide(player.pos, player.radius);
    for (const e of enemies) map.collide(e.pos, e.radius);

    // waves
    const alive = enemies.filter((e) => !e.dead).length;
    if (DEBUG.noWaves) { /* waves paused from the debug panel */ }
    else if (spawnQueue > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0) { spawnEnemy(); spawnQueue--; spawnTimer = 0.7; }
    } else if (alive === 0 && !player.dead) {
      waveDelay -= dt;
      if (waveDelay <= 0) { nextWave(); waveDelay = 2.5; }
    }

    // game over
    if (player.dead && !player.overShown) {
      player.overShown = true;
      setTimeout(() => {
        document.getElementById('title').textContent = 'KNOCKED OUT';
        document.getElementById('subtitle').textContent = `You reached wave ${wave} with ${kills} kills.`;
        startBtn.textContent = 'Play again';
        overlay.classList.remove('hidden');
        running = false;
        document.exitPointerLock?.();
      }, 2000);
    }

    // HUD
    hpFill.style.width = (player.hp / player.maxHp) * 100 + '%';
    waveEl.textContent = wave;
    killsEl.textContent = kills;
    leftEl.textContent = alive + spawnQueue;
  }

  // enemies keep animating on the game-over screen
  if (!running && player) {
    player.mixer.update(dt);
    enemies.forEach((e) => e.mixer.update(dt));
  }

  // Third-person over-the-shoulder camera + shake
  if (player) {
    const fp = firstPerson();
    if (!running) cam.yaw += dt * 0.15; // slow orbit behind menus
    if (!fp) cam.pitch = THREE.MathUtils.clamp(cam.pitch, TP_PITCH.min, TP_PITCH.max);
    camTarget.lerp(player.pos, 1 - Math.exp(-TP_FOLLOW * (dt || 0.016)));
    // ease in/out of pistol aim zoom
    const aimGoal = running && player.aiming ? 1 : 0;
    cam.aim += (aimGoal - cam.aim) * Math.min(1, AIM.speed * (dt || 0.016));
    cam.curDist = fp ? 0 : THREE.MathUtils.lerp(cam.dist, AIM.dist, cam.aim);
    const fov = THREE.MathUtils.lerp(fp ? FP.fov : VIEW.fov, AIM.fov, cam.aim);
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    crosshair.classList.toggle('aim', cam.aim > 0.5);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    // camera dips with the crouch
    cam.crouch = (cam.crouch || 0) + ((running && player.crouched && !player.dead ? 1 : 0) - (cam.crouch || 0)) * Math.min(1, 8 * (dt || 0.016));
    if (fp) updateFirstPersonCamera(dt);
    else updateThirdPersonCamera(dt);
    if (DEBUG.noShake) shake = 0;
    if (shake > 0) {
      shake = Math.max(0, shake - dt);
      const s = shake * (fp ? 0.15 : 0.4); // right at the eyes the same jolt reads much stronger
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
    }
  }

  updateParticles(dt);
  updateShotFx(dt);
  updateBlasts(dt);

  // enemy HP bars
  for (const e of enemies) {
    if (e.dead || !e.bar) continue;
    const s = toScreen(e.pos.clone().setY(2.1));
    e.bar.style.display = s.visible ? '' : 'none';
    e.bar.style.left = s.x + 'px';
    e.bar.style.top = s.y + 'px';
    e.bar.firstChild.style.width = (e.hp / e.maxHp) * 100 + '%';
  }

  pressed.clear();
  released.clear();
  if (showHitboxes) {
    for (const f of [player, ...enemies]) f?.root.updateMatrixWorld(true);
    for (const f of [player, ...enemies]) f?.updateHitboxDebug();
  }
  // first person: shrink the head away for the main view (restored for the sun shadow pass)
  headHidden = firstPerson();
  if (headHidden) {
    scene.updateMatrixWorld(); // hideHead re-skins from the head's parent: bring the pose up to date
    hideHead(true);
  }
  lighting.render();
  if (headHidden) hideHead(false);
  headHidden = false;
  perf.end();
}

// First person: eyes = head bone (+ offset up / forward), lightly smoothed so running bob and
// hit reactions come through without jitter
const _eye = new THREE.Vector3();
function updateFirstPersonCamera(dt) {
  const p = player;
  p.root.updateMatrixWorld(true);
  p.headBone.getWorldPosition(_eye);
  _eye.y += FP.eyeUp;
  _eye.addScaledVector(camForward(), FP.eyeFwd);
  if (!cam.fpActive) cam.eye = _eye.clone();
  else cam.eye.lerp(_eye, 1 - Math.exp(-FP.smooth * (dt || 0.016)));
  cam.fpActive = true;
  cam.fit = undefined; // third-person collision restarts from scratch when switching back
  camera.position.copy(cam.eye);
}

// Head hiding: scale the head bone to ~0 (skinned verts + anything parented to it collapse).
// The mixer rewrites the pose every frame, the scale is restored right after rendering. The render
// passes don't update matrices / skeletons themselves (see Lighting.render and
// updateSkeletonOncePerFrame), so the head subtree and the player's bone texture are redone here.
let headHidden = false;
const _headScale = new THREE.Vector3();
function hideHead(on) {
  const b = player.headBone;
  if (on) { _headScale.copy(b.scale); b.scale.multiplyScalar(1e-3); }
  else b.scale.copy(_headScale);
  b.updateMatrixWorld(true);
  forceSkeletonUpdate(player);
}
{
  const before = lighting.sun.onBeforeShadow, after = lighting.sun.onAfterShadow;
  lighting.sun.onBeforeShadow = () => { before?.(); if (headHidden) hideHead(false); };
  lighting.sun.onAfterShadow = () => { after?.(); if (headHidden) hideHead(true); };
}

function updateThirdPersonCamera(dt) {
  cam.fpActive = false;
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  _camPivot.set(camTarget.x, CAM_PIVOT_Y - MOVE.crouchCamDrop * cam.crouch + camTarget.y, camTarget.z);
  camera.position
    .copy(_camPivot)
    .addScaledVector(back, cam.curDist)
    .addScaledVector(side, THREE.MathUtils.lerp(CAM_SHOULDER, AIM.shoulder, cam.aim));
  // keep the camera above the player's floor (not world y=0, so it follows into the subway / pits)
  camera.position.y = Math.max(camTarget.y + 0.3, camera.position.y);
  // camera collision: pull in in front of walls (instantly), ease back out
  _camRay.origin.copy(_camPivot);
  _camRay.direction.subVectors(camera.position, _camPivot);
  const full = _camRay.direction.length();
  _camRay.direction.divideScalar(full);
  const fit = Math.min(full, map.raycast(_camRay, full + CAM_MARGIN, 0.5) - CAM_MARGIN);
  cam.fit = cam.fit === undefined || fit < cam.fit ? fit : THREE.MathUtils.lerp(cam.fit, fit, 1 - Math.exp(-6 * (dt || 0.016)));
  camera.position.copy(_camPivot).addScaledVector(_camRay.direction, Math.max(0.2, cam.fit));
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  lighting.resize();
});

// ---------------------------------------------------------------------------
// Boot: load the characters while the GI bakes, start when both are done
// ---------------------------------------------------------------------------
let assetsReady = false;
let assetsFailed = false;
let booted = false;
function updateBootStatus() {
  if (assetsFailed) return;
  if (assetsReady && lighting.ready) {
    booted = true;
    startBtn.disabled = false;
    startBtn.textContent = 'Fight!';
    return;
  }
  startBtn.disabled = true;
  startBtn.textContent = lighting.ready ? 'Loading…' : `Baking lighting ${Math.round(lighting.state.progress * 100)}%`;
}
startBtn.disabled = true;
loadAssets()
  .then(() => {
    assetsReady = true;
    updateBootStatus();
    // idle preview character behind the menu
    player = new Fighter(PLAYER_MODEL, { hp: 100, isPlayer: true });
    player.pos.set(...map.playerSpawn);
    player.play('Idle');
  })
  .catch((err) => {
    console.error(err);
    assetsFailed = true;
    startBtn.textContent = 'Failed to load models';
  });

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const crosshair = document.getElementById('crosshair');

startBtn.addEventListener('click', () => {
  overlay.classList.add('hidden');
  if (paused) paused = false;
  else resetGame();
  keys.clear();
  lockPointer();
});

// Leaving pointer lock (Esc) pauses the game
document.addEventListener('pointerlockchange', () => {
  const locked = isLocked();
  crosshair.classList.toggle('show', locked);
  // with the debug panel open, freeing the mouse (to use the panel) keeps the game running
  if (!locked && running && !player.dead && !debugGui.open) {
    paused = true;
    keys.clear();
    titleEl.textContent = 'PAUSED';
    subtitleEl.textContent = 'Mouse released.';
    startBtn.textContent = 'Resume';
    overlay.classList.remove('hidden');
  }
});
// Browsers briefly refuse re-locking right after Esc; stay paused if so
document.addEventListener('pointerlockerror', () => {
  if (!running) return;
  paused = true;
  titleEl.textContent = 'PAUSED';
  subtitleEl.textContent = 'Could not capture the mouse, try again.';
  startBtn.textContent = 'Resume';
  overlay.classList.remove('hidden');
});

window.__game = { get player() { return player; }, get enemies() { return enemies; }, get mode() { return mode; }, setMode, cam, camera, FP, lighting, map, resume() { paused = false; overlay.classList.add('hidden'); } };

// Debug panel (F2, or ?debug in the URL)
const debugGui = createDebugGui({
  renderer, scene, camera, lighting, perf, map, cam, params,
  WEAPONS, ATTACKS, MOVE, AIM, VIEW, FP, PHYS, HIT_MULT,
  get player() { return player; },
  get enemies() { return enemies; },
  get wave() { return wave; },
  get mode() { return mode; },
  get running() { return running && !paused; },
  isLocked,
  setHitboxDebug,
  get showHitboxes() { return showHitboxes; },
  spawnEnemy: () => running && player && spawnEnemy(),
  nextWave: () => running && player && (spawnQueue = 0, nextWave()),
  killAll: () => enemies.forEach((e) => !e.dead && e.takeHit(e.hp, player.pos, 4)),
  heal: () => player && (player.hp = player.maxHp),
  refillAmmo: () => { if (player?.ammo) { for (const g of GUNS) player.ammo[g] = WEAPONS[g].magSize; player.reloadT = 0; updateModeHud(); } },
  restart: () => { overlay.classList.add('hidden'); resetGame(); },
});
tick();
