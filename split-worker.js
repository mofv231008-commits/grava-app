/* Грава — фоновый поток «Разделить на части» (manifold-3d, WebAssembly; режет split-core.js).
   Сообщения:
   { type: 'load', seq, buffer } → { dims } — модель из STL (как у сборщика шарниров: parseSTL + loadModel);
   { type: 'split', seq, size, bed } → { fits, parts, pins, cuts, tooBig, dims, plates } — самая длинная сторона = size мм;
     у каждой детали: pos — как лежит на своём столе, apos — где она в целой модели (для превью и «Разнести»), idx — треугольники;
   { type: 'plate', seq, i } → { stl } — стол i одним бинарным STL;
   { type: 'free' } — освободить память. Все Manifold удаляем сами (delete), иначе WASM течёт. */
import Module from './vendor/manifold/manifold.js?v=1';
import { parseSTL, loadModel } from './flexi-core.js?v=13';
import { splitModel } from './split-core.js?v=1';

let wasmPromise = null;
let base = null; // модель после ориентации, без масштаба
let last = null; // последний результат splitModel — из него собираем столы при сохранении

function getWasm() {
  if (!wasmPromise) {
    wasmPromise = Module({ locateFile: (f) => new URL('./vendor/manifold/' + f + '?v=1', import.meta.url).href })
      .then((w) => { w.setup(); return w; });
  }
  return wasmPromise;
}

function freeLast() {
  if (!last) return;
  last.plates.forEach((items) => items.forEach((it) => it.m.delete()));
  last = null;
}

const dimsOf = (m) => {
  const bb = m.boundingBox();
  return [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
};

// Деталь для превью: вершины на столе и в целой модели (обратное преобразование прогона исходной модели).
function itemView(it, id) {
  const g = it.m.getMesh();
  const np = g.numProp;
  const nv = g.vertProperties.length / np;
  const pos = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) pos[v * 3 + k] = g.vertProperties[v * np + k];
  const idx = new Uint32Array(g.triVerts);
  let apos = null;
  if (!it.pin) {
    // runTransform: 3×4 по столбцам — исходная модель → как деталь лежит сейчас (x' = R·x + t). Нам нужно обратно.
    let run = -1;
    for (let r = 0; r < g.runOriginalID.length; r++) if (g.runOriginalID[r] === id) { run = r; break; }
    const T = run >= 0 ? g.runTransform.slice(run * 12, run * 12 + 12) : null;
    if (T && T.every(Number.isFinite)) {
      apos = new Float32Array(nv * 3);
      for (let v = 0; v < nv; v++) {
        const x = pos[v * 3] - T[9], y = pos[v * 3 + 1] - T[10], z = pos[v * 3 + 2] - T[11];
        // R ортогональна (только повороты): обратная — транспонированная
        apos[v * 3] = T[0] * x + T[1] * y + T[2] * z;
        apos[v * 3 + 1] = T[3] * x + T[4] * y + T[5] * z;
        apos[v * 3 + 2] = T[6] * x + T[7] * y + T[8] * z;
      }
    }
  }
  return { pin: !!it.pin, tooBig: !!it.tooBig, w: it.w, d: it.d, h: it.h, pos, apos, idx };
}

function writeSTL(g) {
  const np = g.numProp, v = g.vertProperties, tv = g.triVerts;
  const n = tv.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = 'Grava split: parts with pin holes';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    [a, b, c].forEach((p, k) => {
      dv.setFloat32(o + 12 + k * 12, v[p], true);
      dv.setFloat32(o + 16 + k * 12, v[p + 1], true);
      dv.setFloat32(o + 20 + k * 12, v[p + 2], true);
    });
    o += 50;
  }
  return buf;
}

async function handle(d) {
  const wasm = await getWasm();
  if (d.type === 'load') {
    freeLast();
    if (base) base.delete();
    base = loadModel(wasm, parseSTL(d.buffer)).manifold;
    return { dims: dimsOf(base) };
  }
  if (d.type === 'split') {
    if (!base) throw new Error('no_model');
    freeLast();
    const dims0 = dimsOf(base);
    const k = d.size / Math.max(dims0[0], dims0[1], dims0[2]);
    const scaled = base.scale(k);
    const bb = scaled.boundingBox();
    const placed = scaled.translate([-bb.min[0], -bb.min[1], -bb.min[2]]); // стоит на столе
    scaled.delete();
    const model = placed.asOriginal(); // свой номер — по нему найдём, где деталь была в целой модели
    placed.delete();
    const id = model.originalID();
    const dims = dimsOf(model);
    const r = splitModel(wasm, model, { bed: d.bed });
    if (r.fits) { // делить не нужно — для превью отдаём модель целиком
      const whole = itemView({ m: model, pin: true }, id); // pin: true — она и так в своих координатах, без обратного преобразования
      whole.pin = false;
      model.delete();
      return { reply: { fits: true, dims, whole }, transfer: [whole.pos.buffer, whole.idx.buffer].concat(whole.apos ? [whole.apos.buffer] : []) };
    }
    model.delete();
    last = r;
    const plates = r.plates.map((items) => items.map((it) => itemView(it, id)));
    const transfer = [];
    plates.forEach((items) => items.forEach((it) => { transfer.push(it.pos.buffer, it.idx.buffer); if (it.apos) transfer.push(it.apos.buffer); }));
    return { reply: { fits: false, parts: r.parts, pins: r.pins, cuts: r.cuts, tooBig: r.tooBig || 0, dims, plates }, transfer };
  }
  if (d.type === 'plate') {
    if (!last || !last.plates[d.i]) throw new Error('no_plate');
    const items = last.plates[d.i];
    const u = wasm.Manifold.union(items.map((it) => it.m));
    const stl = writeSTL(u.getMesh());
    u.delete();
    return { reply: { stl }, transfer: [stl] };
  }
  if (d.type === 'free') {
    freeLast();
    return {};
  }
  throw new Error('bad_type');
}

// По одному сообщению за раз: деление — долгое, а следующее ждёт результата предыдущего.
let chain = Promise.resolve();
self.onmessage = (e) => {
  const d = e.data;
  chain = chain.then(async () => {
    try {
      const r = await handle(d);
      const reply = Object.assign({ seq: d.seq, ok: true }, r.reply || r);
      delete reply.transfer;
      self.postMessage(reply, r.transfer || []);
    } catch (err) {
      self.postMessage({ seq: d.seq, ok: false, error: (err && (err.code || err.message)) || String(err) });
    }
  });
};
