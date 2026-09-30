// Lighting pipeline, ported from threejs-probe-gi (src/main.js there):
//   - probe-volume GI baked at runtime on the GPU (gi.js), spread over frames
//   - analytic sky dome, captured by the probes
//   - hand-rolled cascaded sun shadows, sun applied in the shader (sun.js) - no three.js lights
//   - half-res SSAO applied to indirect light (ao.js)
//   - auto exposure from the probe irradiance at the eye
//
// Layers: 0 = static world (baked into the probes), 1 = dynamic (characters, props: receive GI +
// cast sun shadows, never baked), 3 = FX (particles, tracers: no GI, no shadows).
import * as THREE from 'three';
import { ProbeGI } from './gi.js';
import { SunShadows } from './sun.js';
import { SSAO } from './ao.js';

export const LAYERS = { STATIC: 0, DYNAMIC: 1, FX: 3 };

// cascades: [radius m, resolution] near -> far, re-rendered every frame around the camera
export const PRESETS = {
  low: { ao: 6, fine: 2.5, coarse: [8, 4, 8], bounces: 2, cascades: [[8, 1024], [30, 1024]], staticRes: 2048, dpr: 1 },
  medium: { ao: 8, fine: 2.0, coarse: [6, 4, 6], bounces: 2, cascades: [[7, 2048], [22, 2048], [60, 2048]], staticRes: 2048, dpr: 1.5 },
  high: { ao: 12, fine: 1.5, coarse: [5, 3, 5], bounces: 3, cascades: [[6, 2048], [20, 2048], [55, 2048]], staticRes: 4096, dpr: 2 },
};

export class Lighting {
  constructor(renderer, scene, camera, { quality = 'medium', shadow, fog, timeOfDay = 0.3, sunIntensity = 3.4, moonIntensity = 0.45, nightExposure = 1.8, exposure = 0.65 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.Q = PRESETS[quality] ?? PRESETS.medium;
    this.night = 0;
    this.cfg = {
      timeOfDay, sunIntensity, moonIntensity, nightExposure, exposure, bounces: this.Q.bounces,
      aeStrength: 0.55, aeMin: 0.6, aeMax: 6, aeSpeed: 2.5, aeInterval: 8,
    };
    this.state = { enabled: true, firstBakeDone: false, progress: 0, bakeMs: 0, refLum: null, targetExposure: 1, exposure: 1, frames: 0 };
    camera.layers.enable(LAYERS.DYNAMIC);
    camera.layers.enable(LAYERS.FX);

    this.gi = new ProbeGI(renderer, scene);
    this._makeSky();

    this.sun = new SunShadows(renderer, scene, {
      near: this.Q.cascades.map(([radius, res]) => ({ radius, res })),
      stat: { radius: shadow?.radius ?? 50, res: this.Q.staticRes, center: shadow?.center ?? [0, 0, 0] },
    });
    this.sun.onBeforeShadow = () => (this.sky.visible = false);
    this.sun.onAfterShadow = () => (this.sky.visible = true);

    this.ao = new SSAO(renderer, scene, { samples: this.Q.ao });
    this.ao.onBeforeDepth = () => (this.sky.visible = false);
    this.ao.onAfterDepth = () => (this.sky.visible = true);

    scene.fog = new THREE.Fog(0x9fb4d0, fog?.near ?? 60, fog?.far ?? 320);
    this._bakeIt = null;
    this._perFrame = 16;
  }

  _makeSky() {
    const u = (this.skyUniforms = {
      sunDir: { value: new THREE.Vector3() },
      sunCol: { value: new THREE.Color() },
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      night: { value: 0 },
      giCapture: this.gi.uniforms.giCapture,
    });
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(500, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: u,
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 sunDir, sunCol, zenith, horizon;
          uniform float giCapture, night;
          varying vec3 vDir;
          float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.45)) : mix(horizon, horizon * 0.35, pow(min(-h * 4.0, 1.0), 0.6));
            float sd = max(dot(d, sunDir), 0.0);
            col += sunCol * (pow(sd, 6.0) * 0.25 + pow(sd, 64.0) * 0.6);
            if (giCapture < 0.5) {
              col += sunCol * smoothstep(0.9994, 0.9997, sd) * 60.0;
              // stars (display only: too small to matter for the probes)
              if (night > 0.0 && h > 0.0) {
                vec3 p = d * 220.0, c = floor(p);
                float r = hash3(c);
                if (r > 0.985) {
                  vec3 o = vec3(hash3(c + 7.1), hash3(c + 3.7), hash3(c + 1.3)) * 0.6 + 0.2;
                  float s = smoothstep(0.12, 0.0, length(fract(p) - o));
                  float tw = 0.6 + 0.4 * hash3(c + 11.0);
                  col += vec3(0.85, 0.9, 1.0) * s * tw * (r - 0.985) * 260.0 * night * smoothstep(0.0, 0.25, h);
                }
              }
            }
            // probe capture: alpha carries the hit distance (sky = far)
            gl_FragColor = vec4(col, giCapture > 0.5 ? 40.0 : 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  /** Inject GI + sun + SSAO into a MeshStandardMaterial / MeshPhysicalMaterial. */
  patch(mat, opts) {
    this.gi.patchMaterial(mat, opts);
    const giHook = mat.onBeforeCompile;
    const sun = this.sun, ao = this.ao;
    mat.onBeforeCompile = (sh, r) => { giHook(sh, r); sun.inject(sh); ao.inject(sh); };
    mat.needsUpdate = true;
    return mat;
  }

  /**
   * Prepare a dynamic object (character, weapon...): patch its lit materials and move it to the
   * dynamic layer so it receives GI and casts sun shadows without being baked into the probes.
   */
  addDynamic(root, { layer = LAYERS.DYNAMIC, specular = true } = {}) {
    root.traverse((o) => {
      o.layers.set(layer);
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if ((m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) && !m.userData.giPatched) {
          this.patch(m, { specular });
          m.userData.giPatched = true;
        }
      }
    });
    return root;
  }

  /** Mark an unlit effect object (particles, tracers...) as FX: visible, but no GI / shadows. */
  addFx(obj) {
    obj.traverse((o) => o.layers.set(LAYERS.FX));
    return obj;
  }

  /**
   * Static world: merged vertex-colored geometry (+ aEmissive), optional PBR-textured groups
   * (world.textured + world.materials: albedo / normal / ORM maps, tile size in metres) and its
   * probe volumes. Async: the textures are loaded before the bake so the probes capture them.
   */
  async setWorld(world) {
    const mat = this.patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }), { emissiveAttr: true });
    this.staticMesh = new THREE.Mesh(world.geometry, mat);
    this.staticMesh.frustumCulled = false;
    this.scene.add(this.staticMesh);
    if (world.textured?.length) await this._addTextured(world.textured, world.materials);
    for (const [name, min, max, spacing] of world.volumes(this.Q)) this.gi.addVolume(name, min, max, spacing);
    this.gi.build(world.solids);
    this.refPoint = new THREE.Vector3(...(world.refPoint ?? [0, 1.6, 0]));
    this.meter = this.gi.createMeter();
    this.setTimeOfDay(this.cfg.timeOfDay);
  }

  async _addTextured(groups, materials) {
    const loader = new THREE.TextureLoader();
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const cache = new Map();
    const tex = (url, size, srgb) => {
      if (!cache.has(url)) {
        cache.set(url, loader.loadAsync(url).then((t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(1 / size, 1 / size); // the Builder's UVs are world-space metres
          t.anisotropy = aniso;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          return t;
        }));
      }
      return cache.get(url);
    };
    const meshes = await Promise.all(groups.map(async ({ mat, geometry }) => {
      const d = materials[mat];
      const base = `${import.meta.env.BASE_URL}textures/${d.path}/`;
      const [map, normalMap, orm] = await Promise.all([
        tex(base + 'albedo.jpg', d.size, true), tex(base + 'normal.jpg', d.size), tex(base + 'orm.jpg', d.size),
      ]);
      const m = this.patch(new THREE.MeshStandardMaterial({
        map, normalMap, aoMap: orm, roughnessMap: orm, // ORM: R = AO, G = roughness, B = metalness (unused)
        vertexColors: true, // per-box tint
        roughness: d.roughness ?? 1, metalness: 0, aoMapIntensity: d.ao ?? 1,
        normalScale: new THREE.Vector2(d.normalScale ?? 1, d.normalScale ?? 1),
      }), { emissiveAttr: true, specular: true });
      const mesh = new THREE.Mesh(geometry, m);
      mesh.frustumCulled = false;
      return mesh;
    }));
    this.texturedMeshes = meshes;
    for (const m of meshes) this.scene.add(m);
  }

  /** Sun arc for t in [0, 1] (sunrise -> sunset): direction, color, intensity and sky colors. */
  _day(t) {
    const S = THREE.MathUtils.smoothstep;
    const el = Math.sin(t * Math.PI) * THREE.MathUtils.degToRad(58) + THREE.MathUtils.degToRad(3);
    const az = t * Math.PI;
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el)).normalize();
    const hi = S(Math.sin(el), 0.0, 0.5);
    return {
      dir,
      col: new THREE.Color(1.0, 0.45, 0.2).lerp(new THREE.Color(1.0, 0.93, 0.85), hi),
      intensity: this.cfg.sunIntensity * S(Math.sin(el), 0.0, 0.12),
      zenith: new THREE.Color(0.08, 0.2, 0.6).lerp(new THREE.Color(0.18, 0.4, 0.95), hi).multiplyScalar(1.4),
      horizon: new THREE.Color(0.9, 0.5, 0.3).lerp(new THREE.Color(0.62, 0.72, 0.9), hi),
    };
  }

  /**
   * t in [0, 2): 0..1 = day (sunrise -> sunset), 1..2 = night (dusk -> moon arc -> dawn).
   * Only one shadow-casting light exists, so at night it becomes the moon; the switch happens
   * during twilight while both are faded out, so there is no visible jump.
   */
  setTimeOfDay(t) {
    t = ((t % 2) + 2) % 2;
    this.cfg.timeOfDay = t;
    const S = THREE.MathUtils.smoothstep;
    const u = this.skyUniforms;
    let light, night;
    if (t <= 1) {
      light = this._day(t);
      night = 0;
    } else {
      const s = t - 1; // 0 = dusk, 1 = dawn
      const edge = this._day(s < 0.5 ? 1 : 0); // sky / sun state at sunset or sunrise
      // twilight: 0 at the day edges, 1 in full night
      night = S(s, 0.0, 0.1) * (1 - S(s, 0.9, 1.0));
      const sunFade = s < 0.5 ? 1 - S(s, 0.0, 0.04) : S(s, 0.96, 1.0);
      const moonFade = S(s, 0.04, 0.12) * (1 - S(s, 0.88, 0.96));
      const el = Math.sin(s * Math.PI) * THREE.MathUtils.degToRad(50) + THREE.MathUtils.degToRad(4);
      const az = s * Math.PI + 0.35; // rises where the sun did, slightly offset
      const moonDir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -Math.sin(az) * Math.cos(el)).normalize();
      const moonCol = new THREE.Color(0.62, 0.72, 1.0);
      light = sunFade > 0
        ? { dir: edge.dir, col: edge.col, intensity: edge.intensity * sunFade }
        : { dir: moonDir, col: moonCol, intensity: this.cfg.moonIntensity * moonFade };
      light.zenith = edge.zenith.clone().lerp(new THREE.Color(0.004, 0.008, 0.026), night);
      light.horizon = edge.horizon.clone().lerp(new THREE.Color(0.02, 0.03, 0.06), night);
      // sky glow/disc: the moon is small and cold, the sun keeps its own color at twilight
      light.skyCol = sunFade > 0 ? edge.col.clone().multiplyScalar(sunFade) : moonCol.clone().multiplyScalar(0.12 * moonFade);
    }
    this.night = night;
    this.sun.setSun(light.dir, light.col, light.intensity);
    u.sunDir.value.copy(light.dir);
    u.sunCol.value.copy(light.skyCol ?? light.col);
    u.zenith.value.copy(light.zenith);
    u.horizon.value.copy(light.horizon);
    u.night.value = night;
    this.scene.fog.color.copy(u.horizon.value);
  }

  /** (Re-)bake the probes; the previous result stays on screen until the new one is complete. */
  startBake() {
    this.sun.update(this.camera); // every cascade must exist before probes sample them
    this._bakeIt = this.gi.bake(this.cfg.bounces);
    this._bakeStart = performance.now();
  }

  get ready() { return this.state.firstBakeDone; }
  get baking() { return !!this._bakeIt; }

  _runBake(dtMs) {
    if (!this._bakeIt) return;
    const st = this.state;
    // adapt probes/frame: at boot aim ~20 fps, at runtime keep the game fluid
    const target = st.firstBakeDone ? 30 : 60;
    this._perFrame = dtMs < target ? Math.min(this._perFrame * 1.2 + 1, 3000) : Math.max(this._perFrame * 0.7, st.firstBakeDone ? 2 : 8);
    if (st.firstBakeDone) this._perFrame = Math.min(this._perFrame, 64);
    const fog = this.scene.fog;
    this.scene.fog = null;
    let res;
    for (let i = 0; i < this._perFrame; i++) {
      res = this._bakeIt.next();
      if (res.done) break;
    }
    this.scene.fog = fog;
    if (res.done) {
      this._bakeIt = null;
      st.bakeMs = performance.now() - this._bakeStart;
      st.progress = 1;
      st.refLum = null; // re-measure the outdoor reference with the new GI
      if (!st.firstBakeDone) console.info(`GI: ${this.gi.count} probes, ${this.cfg.bounces} bounces baked in ${(st.bakeMs / 1000).toFixed(1)} s`);
      st.firstBakeDone = true;
      return;
    }
    const v = res.value;
    st.progress = (v.bounce + (v.index + 1) / v.total) / v.bounces;
  }

  /** Call once per frame (real, unscaled time). */
  update(dt, dtMs) {
    this._runBake(dtMs);
    const st = this.state, cfg = this.cfg;
    if (!st.firstBakeDone) return;
    this.gi.applyDisplayState(st.enabled);
    if (st.frames++ % cfg.aeInterval === 0) {
      const needRef = st.refLum == null;
      this.meter.measure(needRef ? this.refPoint : this.camera.position).then((lum) => {
        if (lum == null) return;
        if (needRef) { st.refLum = lum; return; }
        if (st.refLum == null) return;
        st.targetExposure = Math.pow(st.refLum / Math.max(lum, 1e-4), cfg.aeStrength);
      });
      this.gi.applyDisplayState(st.enabled);
    }
    const te = st.enabled ? THREE.MathUtils.clamp(st.targetExposure, cfg.aeMin, cfg.aeMax) : 1;
    st.exposure = THREE.MathUtils.damp(st.exposure, te, cfg.aeSpeed, dt);
    this.renderer.toneMappingExposure = st.exposure * cfg.exposure * THREE.MathUtils.lerp(1, cfg.nightExposure, this.night);
  }

  render() {
    if (!this.state.firstBakeDone) return;
    this.gi.applyDisplayState(this.state.enabled);
    // world matrices once for every pass (cascades, AO depth, main) instead of once per pass
    const scene = this.scene, auto = scene.matrixWorldAutoUpdate;
    scene.updateMatrixWorld();
    scene.matrixWorldAutoUpdate = false;
    try {
      this.sun.update(this.camera);
      this.ao.render(this.camera);
      this.renderer.render(scene, this.camera);
    } finally {
      scene.matrixWorldAutoUpdate = auto;
    }
  }

  resize() {
    this.ao.resize();
  }
}
