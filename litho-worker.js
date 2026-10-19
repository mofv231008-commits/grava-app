/* Грава — фоновый поток литофании и барельефа: пока считается сетка, ползунки не замирают.
   Сообщение: { seq, luma, w, h, opts } → { seq, ok, stl, tris, size, grid, light, ms } (stl и light — передаются, не копируются). */
import { makeLitho, backlitPreview } from './litho-core.js?v=1';

self.onmessage = (e) => {
  const { seq, luma, w, h, opts } = e.data;
  try {
    const t0 = performance.now();
    const r = makeLitho(luma, w, h, opts);
    const light = opts.mode === 'litho' ? backlitPreview(r.hf) : null;
    const ms = Math.round(performance.now() - t0);
    const out = { seq, ok: true, stl: r.stl, tris: r.tris, size: r.size, grid: r.grid, light, ms };
    self.postMessage(out, light ? [r.stl, light.buffer] : [r.stl]);
  } catch (err) {
    self.postMessage({ seq, ok: false, error: String((err && err.message) || err) });
  }
};
