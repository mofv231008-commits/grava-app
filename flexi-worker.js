/* Грава — фоновый поток сборщика шарниров «⛓ Цепочка» (manifold-3d, WebAssembly). */
import Module from './vendor/manifold/manifold.js?v=1';
import {
  parseSTL, writeSTL, loadModel, placeModel, repairModel, analyze, attachGrooves, autoCuts, orderCuts, buildJoints, meshOf, FlexiError,
} from './flexi-core.js?v=5';

let wasmPromise = null;
let base = null;   // фигурка после ориентации (без масштаба)
let model = null;  // после масштаба, среза низа и починки — это и есть «кожа» (skin): её не режем, по ней обрезается сустав
let mesh = null;
let an = null;     // анализ вида сверху

function getWasm() {
  if (!wasmPromise) {
    wasmPromise = Module({ locateFile: (f) => new URL('./vendor/manifold/' + f + '?v=1', import.meta.url).href })
      .then((w) => { w.setup(); return w; });
  }
  return wasmPromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    const wasm = await getWasm();
    if (msg.type === 'load') {
      if (base) base.delete();
      if (model) { model.delete(); model = null; }
      const soup = parseSTL(msg.buffer);
      const r = loadModel(wasm, soup);
      base = r.manifold;
      self.postMessage({ type: 'loaded', id: msg.id, length: r.length, tris: soup.length / 9 });
    } else if (msg.type === 'prepare') {
      if (!base) throw new FlexiError('no_model');
      if (model) { model.delete(); model = null; }
      const placed = placeModel(wasm, base, msg.length, msg.cut);
      if (placed.isEmpty()) { placed.delete(); throw new FlexiError('empty'); }
      // шаг 0: перепаять — щели и самопересечения заплавляются, лишние куски выбрасываются
      self.postMessage({ type: 'progress', id: msg.id, phase: 'repair' });
      const rep = repairModel(wasm, placed);
      placed.delete();
      model = rep.manifold;
      if (model.isEmpty()) throw new FlexiError('empty');
      self.postMessage({ type: 'progress', id: msg.id, phase: 'analyze' });
      mesh = meshOf(model);
      const bb = model.boundingBox();
      an = analyze(mesh, bb);
      attachGrooves(an, rep);
      // скелет для экрана: x, y, dt, родитель, расстояние от ядра
      const skeleton = new Float32Array(an.skeleton.length * 5);
      an.skeleton.forEach((s, k) => {
        skeleton.set([s.x, s.y, s.dt, s.parent, s.dist], k * 5);
      });
      const heights = an.heights.slice();
      self.postMessage({
        type: 'prepared', id: msg.id, grid: an.grid, heights, skeleton, zMax: an.zMax,
        core: an.core, bbox: { min: bb.min, max: bb.max }, length: msg.length, parts: rep.parts,
      }, [heights.buffer, skeleton.buffer]);
    } else if (msg.type === 'auto') {
      if (!an) throw new FlexiError('no_model');
      const r = autoCuts(an, msg.opts);
      self.postMessage({ type: 'cuts', id: msg.id, cuts: r.cuts, thin: r.thin });
    } else if (msg.type === 'build') {
      if (!model) throw new FlexiError('no_model');
      const opts = msg.opts;
      const cuts = orderCuts(msg.cuts, an.skeleton);
      const res = buildJoints(wasm, model, mesh, an, cuts, opts, (phase, k, n) => {
        self.postMessage({ type: 'progress', id: msg.id, phase, k, n });
      });
      const meshes = res.parts.map((p) => meshOf(p.manifold));
      const transfer = [];
      const parts = meshes.map((m, i) => {
        const vert = m.numProp === 3 ? m.vertProperties.slice() : strip(m);
        const tri = m.triVerts.slice();
        transfer.push(vert.buffer, tri.buffer);
        return { vert, tri, joint: res.parts[i].joint, volume: res.parts[i].manifold.volume() };
      });

      const stl = writeSTL(meshes);
      transfer.push(stl);
      res.parts.forEach((p) => p.manifold.delete());

      // ветви-цепочки: сколько звеньев и насколько гнётся (звенья · α)
      const chains = {};
      res.joints.forEach((J) => {
        if (J.chain < 0) return;
        const c = chains[J.chain] || (chains[J.chain] = { count: 0, bend: 0 });
        c.count++;
        c.bend += J.alpha;
      });
      self.postMessage({
        type: 'built', id: msg.id, parts, joints: res.joints, notes: res.notes, redIds: res.redIds,
        skipped: res.skipped, skipWhy: res.skipWhy, moved: res.moved,
        summary: res.summary, num: res.num, order: cuts.map((c) => c.id), stl,
        chains: Object.values(chains),
      }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, op: msg.type, code: (err && err.code) || 'failed', text: String((err && err.message) || err) });
  }
};

function strip(m) {
  const n = m.vertProperties.length / m.numProp;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = m.vertProperties[i * m.numProp];
    out[i * 3 + 1] = m.vertProperties[i * m.numProp + 1];
    out[i * 3 + 2] = m.vertProperties[i * m.numProp + 2];
  }
  return out;
}
