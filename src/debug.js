// Debug panel (lil-gui): cheats / mechanics tuning, graphics toggles and live stats.
// F2 toggles it (or start with ?debug in the URL). While it is open, freeing the mouse
// (Esc, or opening it mid-game) does not pause, so values can be tweaked live; click the
// game to capture the mouse again. "first person (FPS)" (Game folder, or ?fps in the URL)
// switches the camera to the player's eyes.
import * as THREE from 'three';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

// Flags read by the game loop (main.js)
export const DEBUG = {
  god: false, // player takes no damage
  infiniteAmmo: false,
  oneShot: false, // any hit kills an enemy
  damageMult: 1, // player -> enemy damage
  timeScale: 1, // game time (slow motion < 1)
  freezeAI: false, // enemies stand still and never attack
  enemySpeed: 1,
  noWaves: false, // stop spawning / advancing waves
  noShake: false,
};

export function createDebugGui(ctx) {
  const { renderer, scene, lighting, perf } = ctx;
  const gui = new GUI({ title: 'Debug (F2)', width: 300 });
  gui.domElement.style.zIndex = 20; // above the menu overlay
  let open = ctx.params.has('debug');
  gui.show(open);

  // ---- Stats (read-only, refreshed a few times per second) ----------------------------
  const info = { fps: 0, memory: '', calls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0, probes: 0, bake: '', exposure: 0,
    wave: 0, enemies: '', hp: '', state: '', anim: '', pos: '' };
  const fStats = gui.addFolder('Stats');
  for (const k of Object.keys(info)) fStats.add(info, k).listen().disable();
  let frames = 0, last = performance.now();
  const countFrame = () => { frames++; requestAnimationFrame(countFrame); };
  countFrame();
  setInterval(() => {
    if (!open) return;
    const now = performance.now();
    info.fps = Math.round((frames * 1000) / (now - last));
    frames = 0; last = now;
    const m = performance.memory; // Chromium-only
    info.memory = m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)} / ${(m.totalJSHeapSize / 1048576).toFixed(0)} MB` : 'n/a';
    const r = renderer.info;
    info.calls = r.render.calls;
    info.triangles = r.render.triangles;
    info.geometries = r.memory.geometries;
    info.textures = r.memory.textures;
    info.programs = r.programs?.length ?? 0;
    info.probes = lighting.gi.count ?? 0;
    info.bake = lighting.baking ? `${Math.round(lighting.state.progress * 100)}%` : `done (${(lighting.state.bakeMs / 1000).toFixed(1)} s)`;
    info.exposure = +lighting.state.exposure.toFixed(3);
    info.wave = ctx.wave;
    const alive = ctx.enemies.filter((e) => !e.dead);
    info.enemies = `${alive.length} alive / ${ctx.enemies.length}`;
    const p = ctx.player;
    if (p) {
      info.hp = `${Math.round(p.hp)} / ${p.maxHp}`;
      info.state = `${p.state}${p.airborne ? ' (air)' : ''}${p.crouched ? ' (crouch)' : ''}${p.invulnerable || p.iframe > 0 ? ' (i-frames)' : ''}`;
      info.anim = p.current?.getClip().name.split('|').pop() ?? '';
      info.pos = p.pos.toArray().map((v) => v.toFixed(2)).join(', ');
    }
  }, 250);

  // ---- Cheats / game --------------------------------------------------------------------
  const fGame = gui.addFolder('Game');
  fGame.add(ctx.FP, 'enabled').name('first person (FPS)').listen();
  fGame.add(DEBUG, 'god').name('god mode');
  fGame.add(DEBUG, 'infiniteAmmo').name('infinite ammo');
  fGame.add(DEBUG, 'oneShot').name('one-shot kills');
  fGame.add(DEBUG, 'damageMult', 0, 10, 0.1).name('damage ×');
  fGame.add(DEBUG, 'timeScale', 0.05, 2, 0.05).name('time scale');
  fGame.add(DEBUG, 'freezeAI').name('freeze enemies');
  fGame.add(DEBUG, 'enemySpeed', 0, 3, 0.05).name('enemy speed ×');
  fGame.add(DEBUG, 'noWaves').name('pause waves');
  fGame.add(DEBUG, 'noShake').name('no camera shake');
  const actions = {
    spawn: ctx.spawnEnemy, killAll: ctx.killAll, nextWave: ctx.nextWave,
    heal: ctx.heal, refill: ctx.refillAmmo, restart: ctx.restart,
  };
  fGame.add(actions, 'spawn').name('spawn enemy');
  fGame.add(actions, 'killAll').name('kill all enemies');
  fGame.add(actions, 'nextWave').name('next wave');
  fGame.add(actions, 'heal').name('heal player');
  fGame.add(actions, 'refill').name('refill ammo');
  fGame.add(actions, 'restart').name('restart game');

  // ---- Hitboxes -------------------------------------------------------------------------
  const fHit = gui.addFolder('Hitboxes');
  const hb = { get show() { return ctx.showHitboxes; }, set show(v) { ctx.setHitboxDebug(v); } };
  fHit.add(hb, 'show').name('show (F4)').listen();
  fHit.add(ctx.HIT_MULT, 'head', 0, 10, 0.1).name('head ×');
  fHit.add(ctx.HIT_MULT, 'body', 0, 5, 0.1).name('body ×');
  fHit.add(ctx.HIT_MULT, 'limb', 0, 5, 0.1).name('limb ×');
  fHit.close();

  // ---- Weapons / melee ------------------------------------------------------------------
  const fWeap = gui.addFolder('Weapons');
  for (const w of Object.values(ctx.WEAPONS)) {
    const f = fWeap.addFolder(w.name);
    f.add(w, 'damage', 0, 100, 1);
    f.add(w, 'damageRand', 0, 20, 1).name('damage rand');
    f.add(w, 'fireInterval', 0.02, 1, 0.005).name('fire interval (s)');
    f.add(w, 'magSize', 1, 200, 1).name('mag size');
    f.add(w, 'reloadTime', 0.1, 5, 0.1).name('reload (s)');
    f.add(w, 'range', 1, 200, 1);
    f.add(w, 'hipSpread', 0, 0.3, 0.005).name('hip spread');
    f.add(w, 'aimSpread', 0, 0.3, 0.005).name('aim spread');
    f.add(w, 'knock', 0, 10, 0.1).name('knockback');
    f.add(w, 'recoil', 0, 0.2, 0.005);
    f.add(w, 'shake', 0, 0.5, 0.005);
    f.add(w, 'hitStop', 0, 0.2, 0.005).name('hit stop (s)');
    f.close();
  }
  const fMelee = fWeap.addFolder('Melee');
  for (const [id, a] of Object.entries(ctx.ATTACKS)) {
    fMelee.add(a, 'damage', 0, 100, 1).name(`${id} damage`);
    fMelee.add(a, 'range', 0.5, 5, 0.05).name(`${id} range`);
  }
  fMelee.close();
  fWeap.close();

  // ---- Movement / camera ----------------------------------------------------------------
  const fMove = gui.addFolder('Movement & camera');
  fMove.add(ctx.MOVE, 'run', 0, 20, 0.1).name('run speed');
  fMove.add(ctx.MOVE, 'sprint', 0, 30, 0.1).name('sprint speed');
  fMove.add(ctx.MOVE, 'crouch', 0, 10, 0.1).name('crouch speed');
  fMove.add(ctx.AIM, 'moveSpeed', 0, 10, 0.1).name('aim move speed');
  fMove.add(ctx.PHYS, 'gravity', 1, 60, 0.5);
  fMove.add(ctx.PHYS, 'jumpSpeed', 0, 20, 0.1).name('jump speed');
  fMove.add(ctx.VIEW, 'fov', 30, 110, 1).name('fov');
  fMove.add(ctx.cam, 'dist', 1, 10, 0.1).name('camera distance');
  fMove.add(ctx.AIM, 'fov', 15, 90, 1).name('aim fov');
  fMove.add(ctx.AIM, 'dist', 0.5, 6, 0.05).name('aim distance');
  fMove.add(ctx.FP, 'fov', 40, 120, 1).name('FPS fov');
  fMove.add(ctx.FP, 'eyeUp', -0.2, 0.3, 0.005).name('FPS eye up (m)');
  fMove.add(ctx.FP, 'eyeFwd', -0.2, 0.4, 0.005).name('FPS eye forward (m)');
  fMove.add(ctx.FP, 'smooth', 2, 60, 1).name('FPS eye smoothing');
  fMove.close();

  // ---- Graphics -------------------------------------------------------------------------
  const fGfx = gui.addFolder('Graphics');
  const reload = (key, value) => { ctx.params.set(key, value); if (open) ctx.params.set('debug', ''); location.search = ctx.params.toString(); };
  const gfx = {
    quality: ctx.params.get('quality') ?? 'medium',
    pixelRatio: renderer.getPixelRatio(),
    toneMapping: renderer.toneMapping,
    wireframe: false,
    perf: !perf.dom.hidden,
  };
  const currentQuality = gfx.quality;
  fGfx.add(gfx, 'quality', ['low', 'medium', 'high']).name('quality (reload)').onFinishChange((v) => v !== currentQuality && reload('quality', v));
  fGfx.add(gfx, 'pixelRatio', 0.25, Math.max(2, devicePixelRatio), 0.05).name('pixel ratio').onFinishChange((v) => {
    renderer.setPixelRatio(v);
    renderer.setSize(innerWidth, innerHeight);
    lighting.resize();
  });
  fGfx.add(gfx, 'toneMapping', {
    ACES: THREE.ACESFilmicToneMapping, AgX: THREE.AgXToneMapping, Neutral: THREE.NeutralToneMapping,
    Reinhard: THREE.ReinhardToneMapping, Linear: THREE.LinearToneMapping, None: THREE.NoToneMapping,
  }).name('tone mapping').onChange((v) => { renderer.toneMapping = v; });
  fGfx.add(lighting.cfg, 'exposure', 0.05, 3, 0.01);
  fGfx.add(lighting.cfg, 'aeStrength', 0, 1, 0.01).name('auto exposure');
  fGfx.add(gfx, 'wireframe').onChange((v) => {
    scene.traverse((o) => {
      if (!o.isMesh || o.userData.debugHelper) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if ('wireframe' in m && !m.isShaderMaterial) m.wireframe = v;
    });
  });
  fGfx.add(gfx, 'perf').name('perf HUD (F3)').onChange((v) => { perf.dom.hidden = !v; }).listen();
  addEventListener('keydown', (e) => { if (e.code === 'F3') setTimeout(() => { gfx.perf = !perf.dom.hidden; }); });

  // Sun / sky (changing them needs a GI re-bake to update the bounce light)
  const fSun = fGfx.addFolder('Sun & sky');
  const sun = { autoRebake: true, shadows: true };
  const maybeRebake = () => sun.autoRebake && lighting.startBake();
  fSun.add(lighting.cfg, 'timeOfDay', 0, 2, 0.005).name('time (0-1 day, 1-2 night)').onChange((v) => lighting.setTimeOfDay(v)).onFinishChange(maybeRebake).listen();
  fSun.add(lighting.cfg, 'sunIntensity', 0, 10, 0.05).name('sun intensity').onChange(() => lighting.setTimeOfDay(lighting.cfg.timeOfDay)).onFinishChange(maybeRebake);
  fSun.add(lighting.cfg, 'moonIntensity', 0, 3, 0.01).name('moon intensity').onChange(() => lighting.setTimeOfDay(lighting.cfg.timeOfDay)).onFinishChange(maybeRebake);
  fSun.add(lighting.cfg, 'nightExposure', 0.5, 5, 0.05).name('night exposure');
  fSun.add(sun, 'shadows').name('sun shadows').onChange((v) => lighting.sun.setEnabled(v));
  fSun.add(sun, 'autoRebake').name('auto re-bake GI');

  // Probe GI
  const fGI = fGfx.addFolder('GI (probes)');
  const gi = { showProbes: false, rebake: () => lighting.startBake() };
  let probeMesh = null;
  fGI.add(lighting.state, 'enabled').name('GI enabled');
  fGI.add(lighting.gi.uniforms.giIntensity, 'value', 0, 4, 0.01).name('intensity');
  fGI.add(lighting.gi.uniforms.giBias, 'value', 0, 2, 0.01).name('leak bias');
  fGI.add(lighting.cfg, 'bounces', 1, 6, 1).onFinishChange(() => lighting.startBake());
  fGI.add(gi, 'showProbes').name('show probes').onChange((v) => {
    if (v && !probeMesh) {
      probeMesh = lighting.addFx(lighting.gi.createDebugMesh());
      probeMesh.userData.debugHelper = true;
    }
    if (probeMesh) (v ? scene.add(probeMesh) : scene.remove(probeMesh));
  });
  fGI.add(gi, 'rebake').name('re-bake GI');
  fGI.close();

  // SSAO
  const fAO = fGfx.addFolder('SSAO');
  const ao = lighting.ao;
  const aoState = { enabled: ao.enabled, debugView: false };
  fAO.add(aoState, 'enabled').onChange((v) => ao.setEnabled(v));
  fAO.add(ao.aoMat.uniforms.intensity, 'value', 0, 8, 0.05).name('intensity');
  fAO.add(ao.aoMat.uniforms.radius, 'value', 0.05, 4, 0.05).name('radius (m)');
  fAO.add(ao.aoMat.uniforms.maxPx, 'value', 4, 200, 1).name('max radius (px)');
  fAO.add(ao.uniforms.aoDirect, 'value', 0, 1, 0.01).name('on direct light');
  fAO.add(aoState, 'debugView').name('AO only view').onChange((v) => { ao.uniforms.aoDebug.value = v ? 1 : 0; });
  fAO.close();

  // Fog (kept as an object: the lighting code recolours it; "off" pushes it out of range)
  const fFog = fGfx.addFolder('Fog');
  const fog = { enabled: true, near: scene.fog.near, far: scene.fog.far };
  const applyFog = () => {
    scene.fog.near = fog.enabled ? fog.near : 1e6;
    scene.fog.far = fog.enabled ? Math.max(fog.far, fog.near + 1) : 1e6 + 1;
  };
  fFog.add(fog, 'enabled').onChange(applyFog);
  fFog.add(fog, 'near', 0, 500, 1).onChange(applyFog);
  fFog.add(fog, 'far', 1, 1000, 1).onChange(applyFog);
  fFog.close();
  fGfx.close();

  gui.add({ reset: () => gui.reset() }, 'reset').name('reset all to defaults');

  // ---- Show / hide ----------------------------------------------------------------------
  const setOpen = (v) => {
    open = v;
    gui.show(v);
    // free the mouse so the panel can be used; the game keeps running while it is open
    if (v && ctx.isLocked()) document.exitPointerLock?.();
  };
  addEventListener('keydown', (e) => {
    if (e.code !== 'F2') return;
    e.preventDefault();
    setOpen(!open);
  });

  return { gui, get open() { return open; }, setOpen };
}
