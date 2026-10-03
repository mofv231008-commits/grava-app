/* Грава — фоновый поток сборщика шарниров (manifold-3d, WebAssembly). */
import Module from './vendor/manifold/manifold.js?v=1';
import { parseSTL, writeSTL, loadModel, placeModel, analyze, buildJoints, meshOf, FlexiError } from './flexi-core.js?v=1';

let wasmPromise = null;
let base = null;   // фигурка после ориентации (без масштаба)
let model = null;  // после масштаба и среза низа
let mesh = null;

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
      if (model) model.delete();
      model = placeModel(wasm, base, msg.length, msg.cut);
      if (model.isEmpty()) throw new FlexiError('empty');
      mesh = meshOf(model);
      const bb = model.boundingBox();
      const an = analyze(mesh, bb);
      // скелет для экрана: индексы родителей — внутри массива
      const idx = new Map();
      an.skeleton.forEach((s, k) => idx.set(s.i, k));
      const skeleton = new Float32Array(an.skeleton.length * 4);
      an.skeleton.forEach((s, k) => {
        skeleton[k * 4] = s.x;
        skeleton[k * 4 + 1] = s.y;
        skeleton[k * 4 + 2] = s.dt;
        skeleton[k * 4 + 3] = s.parent >= 0 ? idx.get(s.parent) : -1;
      });
      self.postMessage({
        type: 'prepared', id: msg.id, grid: an.grid, heights: an.heights, skeleton, cuts: an.cuts,
        core: an.core, bbox: { min: bb.min, max: bb.max }, length: msg.length,
      }, [an.heights.buffer, skeleton.buffer]);
    } else if (msg.type === 'build') {
      if (!model) throw new FlexiError('no_model');
      const res = buildJoints(wasm, model, mesh, msg.cuts, { g: msg.g, alpha: msg.alpha }, (k, n) => {
        self.postMessage({ type: 'progress', id: msg.id, k, n });
      });
      const meshes = res.parts.map((p) => meshOf(p.manifold));
      const stl = writeSTL(meshes);
      const parts = meshes.map((m, i) => ({
        // копии: буферы уходят в основной поток
        vert: m.numProp === 3 ? m.vertProperties.slice() : strip(m), tri: m.triVerts.slice(), joint: res.parts[i].joint,
      }));
      res.parts.forEach((p) => p.manifold.delete());
      const transfer = [stl];
      parts.forEach((p) => { transfer.push(p.vert.buffer, p.tri.buffer); });
      self.postMessage({ type: 'built', id: msg.id, parts, joints: res.joints, warnings: res.warnings, errors: res.errors, stl }, transfer);
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
