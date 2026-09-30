import Stats from 'three/examples/jsm/libs/stats.module.js';

// Performance HUD built from stats.js panels: FPS, CPU ms (JS time spent in the
// frame, including issuing GL commands) and GPU ms (measured with
// EXT_disjoint_timer_query_webgl2, when the browser exposes it). F3 toggles it.
export class PerfStats {
  constructor(renderer) {
    this.dom = document.createElement('div');
    this.dom.id = 'perf';
    this.fps = this.addPanel(new Stats.Panel('FPS', '#0ff', '#002'));
    this.cpu = this.addPanel(new Stats.Panel('CPU', '#0f0', '#020'));
    this.gpu = this.addPanel(new Stats.Panel('GPU', '#fa0', '#210'));
    // JS heap in MB (performance.memory is Chromium-only)
    if (performance.memory) this.mem = this.addPanel(new Stats.Panel('MB', '#f08', '#201'));
    document.body.appendChild(this.dom);

    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!this.ext) this.gpu.dom.title = 'GPU timer queries not supported by this browser';
    this.queries = []; // in flight, oldest first
    this.pool = [];
    this.active = null;

    this.frames = 0;
    this.fpsTime = performance.now();
    this.cpuStart = 0;

    addEventListener('keydown', (e) => {
      if (e.code === 'F3') { e.preventDefault(); this.dom.hidden = !this.dom.hidden; }
    });
  }

  addPanel(panel) {
    this.dom.appendChild(panel.dom);
    return panel;
  }

  begin() {
    this.cpuStart = performance.now();
    this.pollGpu();
    if (this.ext && !this.active) {
      const q = this.pool.pop() || this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.active = q;
    }
  }

  end() {
    const now = performance.now();
    this.cpu.update(now - this.cpuStart, 33);
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.queries.push(this.active);
      this.active = null;
    }
    this.frames++;
    if (now >= this.fpsTime + 1000) {
      this.fps.update((this.frames * 1000) / (now - this.fpsTime), 144);
      if (this.mem) {
        const m = performance.memory;
        this.mem.update(m.usedJSHeapSize / 1048576, m.jsHeapSizeLimit / 1048576);
      }
      this.fpsTime = now;
      this.frames = 0;
    }
  }

  // Results arrive a few frames late; read every query that is ready
  pollGpu() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.queries.shift();
      if (!disjoint) this.gpu.update(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, 33);
      this.pool.push(q);
    }
    if (disjoint) { this.pool.push(...this.queries); this.queries.length = 0; } // results unreliable
  }
}
