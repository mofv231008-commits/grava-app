/* Грава — фоновый поток «Найти тонкие места» (thin-core.js): то, что тоньше 1,2 мм, не напечатается или сломается.
   Сообщение: { seq, buffer, size } — STL и реальный размер модели (мм, по самой длинной стороне).
   Ответ: { seq, ok, k, thinShare, spots: [{ x, y, z, mm3 }], ms } — точки в координатах STL, умноженных на k. */
import { parseSTL } from './flexi-core.js';
import { thinParts } from './thin-core.js?v=1';

self.onmessage = (e) => {
  const { seq, buffer, size } = e.data;
  try {
    const t0 = performance.now();
    const soup = parseSTL(buffer);
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < soup.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (soup[i + k] < mn[k]) mn[k] = soup[i + k];
        if (soup[i + k] > mx[k]) mx[k] = soup[i + k];
      }
    }
    // до реального размера: самая длинная сторона = size мм (в STL от нейросети единицы бывают любые)
    const longest = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
    const k = size > 0 && longest > 0 ? size / longest : 1;
    if (k !== 1) for (let i = 0; i < soup.length; i++) soup[i] *= k;
    const n = soup.length / 3;
    const triVerts = new Uint32Array(n);
    for (let i = 0; i < n; i++) triVerts[i] = i;
    const r = thinParts({ vertProperties: soup, triVerts, numProp: 3 });
    self.postMessage({ seq, ok: true, k, thinShare: r.thinShare, spots: r.spots, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ seq, ok: false, error: String((err && err.message) || err) });
  }
};
