/* thin-core.js — поиск тонких мест модели (то, что не напечатается или сломается).
   Идея: «открытие» объёма шаром радиуса r. Всё, что тоньше 2r, при открытии исчезает — это и есть тонкие места.
   Объём — воксели (как в flexi-core.voxelize), расстояния — точное евклидово (edt3). */
import { voxelize } from './flexi-core.js';

const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
// расстояние (в вокселях) до ближайшего voxel с feature=1
function edt3(feature, nx, ny, nz) {
  const N = Math.max(nx, ny, nz);
  const f = new Float64Array(N), d = new Float64Array(N), vv = new Int32Array(N), z = new Float64Array(N + 1);
  const out = new Float32Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = feature[i] ? 0 : INF;
  const sxy = nx * ny;
  const pass = (len, stride, count, baseOf) => {
    for (let c = 0; c < count; c++) {
      const base = baseOf(c);
      for (let k = 0; k < len; k++) f[k] = out[base + k * stride];
      edt1d(f, len, d, vv, z);
      for (let k = 0; k < len; k++) out[base + k * stride] = d[k];
    }
  };
  pass(nx, 1, nz * ny, (c) => c * nx);
  pass(ny, nx, nz * nx, (c) => Math.floor(c / nx) * sxy + (c % nx));
  pass(nz, sxy, ny * nx, (c) => c);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

// mesh: { vertProperties, triVerts, numProp } (как у manifold / flexi-core). Размеры в мм.
// minMm — самая тонкая стенка, которая надёжно печатается (2 сопла 0,4 = 0,8; для фигурок берём 1,2).
// maxCells — ограничение памяти: шаг вокселя подбирается сам.
export function thinParts(mesh, { minMm = 1.2, maxCells = 6e6 } = {}) {
  const vp = mesh.vertProperties, np = mesh.numProp;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vp.length; i += np) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], vp[i + k]); mx[k] = Math.max(mx[k], vp[i + k]); }
  const vol = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);
  const v = Math.max(minMm / 4, Math.cbrt(vol / maxCells)); // хотя бы 4 вокселя на минимальную толщину, если хватает памяти
  const g = voxelize(mesh, v, 3);
  const { nx, ny, nz, occ } = g;
  const r = minMm / 2 / v; // радиус «шара» в вокселях
  // 1) эрозия: остаётся то, что дальше r от пустоты
  const empty = new Uint8Array(occ.length); for (let i = 0; i < occ.length; i++) empty[i] = occ[i] ? 0 : 1;
  const dIn = edt3(empty, nx, ny, nz);
  const core = new Uint8Array(occ.length); let coreN = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i] && dIn[i] > r) { core[i] = 1; coreN++; }
  // 2) обратно наращиваем ядро: всё, куда ядро не дотягивается, — тонкое.
  //    Порог 2r, а не r: острые рёбра и углы (до √3·r от ядра) — это не тонкие места, их не помечаем
  const dCore = coreN ? edt3(core, nx, ny, nz) : null;
  const thin = new Uint8Array(occ.length); let thinN = 0, occN = 0;
  for (let i = 0; i < occ.length; i++) {
    if (!occ[i]) continue; occN++;
    if (!dCore || dCore[i] > 2 * r + 0.5) { thin[i] = 1; thinN++; }
  }
  // 3) тонкие воксели → кучки (6-связность), мелкие кучки (шум на поверхности) отбрасываем
  const sxy = nx * ny, seen = new Uint8Array(occ.length), q = new Int32Array(occ.length), spots = [];
  const minVox = Math.max(8, Math.round((minMm / v) ** 3)); // кучка меньше кубика minMm³ — не считаем
  for (let s = 0; s < occ.length; s++) {
    if (!thin[s] || seen[s]) continue;
    let qh = 0, qt = 0, sx = 0, sy = 0, sz = 0, cnt = 0, minZ = Infinity;
    seen[s] = 1; q[qt++] = s;
    while (qh < qt) {
      const i = q[qh++]; const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sxy) | 0;
      sx += x; sy += y; sz += z; cnt++; if (z < minZ) minZ = z;
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, z > 0 ? i - sxy : -1, z < nz - 1 ? i + sxy : -1];
      for (const j of nb) if (j >= 0 && thin[j] && !seen[j]) { seen[j] = 1; q[qt++] = j; }
    }
    if (cnt >= minVox) spots.push({
      x: g.x0 + (sx / cnt + 0.5) * v, y: g.y0 + (sy / cnt + 0.5) * v, z: g.z0 + (sz / cnt + 0.5) * v,
      mm3: cnt * v * v * v,
    });
  }
  spots.sort((a, b) => b.mm3 - a.mm3);
  return { voxel: v, thinShare: occN ? thinN / occN : 0, spots: spots.slice(0, 20), grid: { nx, ny, nz } };
}
