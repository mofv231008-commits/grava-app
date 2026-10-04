/* Грава — фоновый поток сборщика шарниров (manifold-3d, WebAssembly). */
import Module from './vendor/manifold/manifold.js?v=1';
import {
  parseSTL, writeSTL, loadModel, placeModel, analyze, autoCuts, orderCuts, buildJoints, layoutPlates, meshOf, FlexiError,
} from './flexi-core.js?v=2';

let wasmPromise = null;
let base = null;   // фигурка после ориентации (без масштаба)
let model = null;  // после масштаба и среза низа
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
      if (model) model.delete();
      model = placeModel(wasm, base, msg.length, msg.cut);
      if (model.isEmpty()) throw new FlexiError('empty');
      mesh = meshOf(model);
      const bb = model.boundingBox();
      an = analyze(mesh, bb);
      // скелет для экрана: x, y, dt, родитель, расстояние от ядра
      const skeleton = new Float32Array(an.skeleton.length * 5);
      an.skeleton.forEach((s, k) => {
        skeleton.set([s.x, s.y, s.dt, s.parent, s.dist], k * 5);
      });
      const heights = an.heights.slice();
      self.postMessage({
        type: 'prepared', id: msg.id, grid: an.grid, heights, skeleton, zMax: an.zMax,
        core: an.core, bbox: { min: bb.min, max: bb.max }, length: msg.length,
      }, [heights.buffer, skeleton.buffer]);
    } else if (msg.type === 'auto') {
      if (!an) throw new FlexiError('no_model');
      self.postMessage({ type: 'cuts', id: msg.id, cuts: autoCuts(an, msg.opts) });
    } else if (msg.type === 'build') {
      if (!model) throw new FlexiError('no_model');
      const opts = msg.opts;
      const cuts = orderCuts(msg.cuts, an.skeleton);
      const res = buildJoints(wasm, model, mesh, an, cuts, opts, (phase, k, n, link) => {
        self.postMessage({ type: 'progress', id: msg.id, phase, k, n, link: !!link, links: cuts.filter((c) => c.link).length });
      });
      const meshes = res.parts.map((p) => meshOf(p.manifold));
      const transfer = [];
      const parts = meshes.map((m, i) => {
        const vert = m.numProp === 3 ? m.vertProperties.slice() : strip(m);
        const tri = m.triVerts.slice();
        transfer.push(vert.buffer, tri.buffer);
        return { vert, tri, joint: res.parts[i].joint, volume: res.parts[i].manifold.volume() };
      });

      let stl = null;
      let plates = null;
      if (opts.mode === 'kit') {
        // раскладка на столы: каждый стол — свой STL
        const lay = layoutPlates(res.parts.map((p) => p.manifold.boundingBox()), opts.plate);
        lay.tooBig.forEach((i) => {
          res.notes.push({ id: null, level: 'error', text: 'Деталь ' + (i + 1) + ' больше стола — уменьши длину фигурки' });
        });
        plates = lay.plates.map((items) => {
          const ms = items.map((it) => res.parts[it.index].manifold.translate([it.dx, it.dy, 0]));
          const file = writeSTL(ms.map(meshOf));
          ms.forEach((m) => m.delete());
          transfer.push(file);
          return { items, stl: file };
        });
      } else {
        stl = writeSTL(meshes);
        transfer.push(stl);
      }
      res.parts.forEach((p) => p.manifold.delete());

      // цепочки звеньев: «Хвост: 9 звеньев, гнётся до ±135°»
      const chains = {};
      res.joints.forEach((J) => {
        if (J.chain < 0) return;
        const c = chains[J.chain] || (chains[J.chain] = { count: 0, bend: 0 });
        c.count++;
        c.bend += J.alpha;
      });
      self.postMessage({
        type: 'built', id: msg.id, parts, joints: res.joints, notes: res.notes, redIds: res.redIds,
        summary: res.summary, num: res.num, order: cuts.map((c) => c.id), stl, plates,
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
