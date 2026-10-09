/* Грава — фоновый поток сборщика шарниров «⛓ Цепочка» (manifold-3d, WebAssembly). */
import Module from './vendor/manifold/manifold.js?v=1';
import {
  parseSTL, writeSTL, loadModel, placeModel, repairModel, analyze, attachGrooves, autoCuts, orderCuts, buildJoints, meshOf, FlexiError,
  limbsOf, placeCut, checkCut,
} from './flexi-core.js?v=10';

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

// Проверки разрезов — в очереди: пока считается одна, человек мог сдвинуть или убрать разрез —
// тогда старая проверка не нужна (latest[key] — последняя версия разреза, о которой знает поток).
const checks = [];
const latest = {};
let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  setTimeout(async () => {
    const msg = checks.shift();
    try {
      if (!msg) return;
      if (!model || !an || (latest[msg.key] != null && latest[msg.key] > msg.ver)) {
        self.postMessage({ type: 'checked', id: msg.id, stale: true });
        return;
      }
      const wasm = await getWasm();
      const r = checkCut(wasm, model, mesh, an, msg.cut, msg.opts, msg.prev || null);
      self.postMessage({ type: 'checked', id: msg.id, ok: r.ok, code: r.code, why: r.why });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, op: 'check', code: (err && err.code) || 'failed', text: String((err && err.message) || err) });
    } finally {
      pumping = false;
      if (checks.length) pump();
    }
  }, 0);
}
const dropChecks = () => {
  checks.splice(0).forEach((m) => self.postMessage({ type: 'checked', id: m.id, stale: true }));
};

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.key != null && msg.ver != null) latest[msg.key] = Math.max(latest[msg.key] || 0, msg.ver);
  if (msg.type === 'check') { checks.push(msg); pump(); return; }
  if (msg.type === 'drop') return; // разрез убрали — его проверки в очереди устарели
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
      dropChecks();
      if (model) { model.delete(); model = null; }
      if (an && an.skinIn) { an.skinIn.delete(); an.skinIn = null; }
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
      an.skinIn = rep.skinIn; // кожа, сжатая на 0.8 мм: суставы должны лежать в ней целиком
      an.inAt = rep.inAt;
      // скелет для экрана: x, y, dt, родитель, расстояние от ядра
      const skeleton = new Float32Array(an.skeleton.length * 5);
      an.skeleton.forEach((s, k) => {
        skeleton.set([s.x, s.y, s.dt, s.parent, s.dist], k * 5);
      });
      const heights = an.heights.slice();
      // ветви, по которым можно резать: экран тянет разрез вдоль них
      const L = limbsOf(an);
      const branches = [];
      an.branches.forEach((br, i) => {
        if (L.from[i] < 0) return;
        const pts = new Float32Array(br.pts.length * 2);
        br.pts.forEach((q, k) => { pts[k * 2] = q[0]; pts[k * 2 + 1] = q[1]; });
        branches.push({ i, from: L.from[i], pts, spine: L.spine && i === 0 });
      });
      self.postMessage({
        type: 'prepared', id: msg.id, grid: an.grid, heights, skeleton, zMax: an.zMax, branches, legs: L.legs,
        core: an.core, bbox: { min: bb.min, max: bb.max }, length: msg.length, parts: rep.parts,
      }, [heights.buffer, skeleton.buffer, ...branches.map((b) => b.pts.buffer)]);
    } else if (msg.type === 'auto') {
      // предложения для «✨ Предложить»: где сустав помещается (fit) и где он нужен, но тонко
      if (!an) throw new FlexiError('no_model');
      const r = autoCuts(an, msg.opts);
      const sugg = r.cuts.map((c) => ({ P: c.P, br: c.br, fit: true })).concat(r.thin.map((c) => ({ P: c.P, br: c.br, fit: false })));
      self.postMessage({ type: 'sugg', id: msg.id, sugg, legs: r.legs, small: r.small });
    } else if (msg.type === 'place') {
      if (!an) throw new FlexiError('no_model');
      const c = placeCut(an, msg.opts, msg.x, msg.y, msg.br == null ? null : msg.br, msg.snap !== false);
      self.postMessage({ type: 'placed', id: msg.id, cut: c });
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
