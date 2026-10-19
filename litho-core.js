/* litho-core.js — литофания и барельеф по картинке. Чистые функции без DOM и без библиотек.
   Вход: яркость картинки (Float32Array 0..1, по строкам сверху вниз) и её размер в пикселях.
   Выход: двоичный STL (ArrayBuffer), замкнутая сетка без дыр, низ на z = 0, размеры в мм.

   Литофания: тонкая пластина. Светлое место — тонко, тёмное — толсто. На просвет видна картинка.
   Барельеф: пластина-основа и выпуклая картинка сверху (светлое выше или тёмное выше).
*/

export const LITHO_DEFAULTS = {
  mode: 'litho',      // 'litho' — литофания, 'relief' — барельеф
  width: 100,         // ширина картинки, мм (высота — по пропорциям)
  minT: 0.8,          // литофания: толщина в самом светлом месте, мм
  maxT: 3.0,          // литофания: толщина в самом тёмном месте, мм
  base: 2.0,          // барельеф: толщина основы, мм
  depth: 2.5,         // барельеф: высота рельефа над основой, мм
  lightUp: false,     // барельеф: true — светлое выше, false — тёмное выше
  frame: 3,           // рамка по краю, мм (0 — без рамки)
  frameT: 0,          // толщина рамки, мм (0 — как самое толстое место + 0.5)
  curve: 0,           // литофания: изгиб по дуге, градусы (0 — плоская, до 180)
  stand: false,       // плоская литофания: подставка снизу, чтобы стояла
  gamma: 1.0,         // >1 — светлее середина, <1 — темнее
  contrast: 1.0,      // растяжка контраста вокруг середины
  blur: 0,            // барельеф: сглаживание в пикселях сетки (0–3)
  maxCells: 70000,    // сколько клеток сетки максимум (≈ 2 треугольника на клетку; 70 000 ≈ 7 МБ STL)
};

// Растягиваем яркость на всю шкалу (1-й и 99-й процентиль), контраст и гамма
export function prepareLuma(luma, opts = {}) {
  const o = { ...LITHO_DEFAULTS, ...opts };
  const n = luma.length;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(luma[i] * 255)))]++;
  let acc = 0, lo = 0, hi = 255;
  for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= n * 0.01) { lo = b; break; } }
  acc = 0;
  for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= n * 0.01) { hi = b; break; } }
  const span = Math.max(1, hi - lo) / 255, l0 = lo / 255;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = (luma[i] - l0) / span;
    v = (v - 0.5) * o.contrast + 0.5;
    v = Math.max(0, Math.min(1, v));
    out[i] = Math.pow(v, 1 / o.gamma);
  }
  return out;
}

// Пересэмплирование яркости в сетку gx × gy (билинейно)
export function resample(luma, w, h, gx, gy) {
  const out = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    const y = ((j + 0.5) / gy) * h - 0.5, y0 = Math.max(0, Math.floor(y)), y1 = Math.min(h - 1, y0 + 1), fy = Math.max(0, y - y0);
    for (let i = 0; i < gx; i++) {
      const x = ((i + 0.5) / gx) * w - 0.5, x0 = Math.max(0, Math.floor(x)), x1 = Math.min(w - 1, x0 + 1), fx = Math.max(0, x - x0);
      const a = luma[y0 * w + x0], b = luma[y0 * w + x1], c = luma[y1 * w + x0], d = luma[y1 * w + x1];
      out[j * gx + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

function boxBlur(f, gx, gy, r) {
  if (r <= 0) return f;
  const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) { const ii = i + k; if (ii >= 0 && ii < gx) { s += f[j * gx + ii]; c++; } }
    tmp[j * gx + i] = s / c;
  }
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) { const jj = j + k; if (jj >= 0 && jj < gy) { s += tmp[jj * gx + i]; c++; } }
    out[j * gx + i] = s / c;
  }
  return out;
}

// Размер сетки: шаг не мельче 0.2 мм и не больше maxCells клеток
export function gridFor(w, h, o) {
  const W = o.width, H = o.width * h / w;
  let step = Math.max(0.2, Math.sqrt((W * H) / o.maxCells));
  const gx = Math.max(3, Math.round(W / step)), gy = Math.max(3, Math.round(H / step));
  return { gx, gy, W, H, step: W / gx };
}

// Толщина в каждой точке сетки (мм), с рамкой
export function heightField(luma, w, h, opts = {}) {
  const o = { ...LITHO_DEFAULTS, ...opts };
  const g = gridFor(w, h, o);
  let L = resample(prepareLuma(luma, o), w, h, g.gx, g.gy);
  if (o.mode === 'relief') L = boxBlur(L, g.gx, g.gy, Math.round(o.blur));
  const T = new Float32Array(g.gx * g.gy);
  const top = o.mode === 'relief' ? o.base + o.depth : o.maxT;
  const fT = o.frameT > 0 ? o.frameT : top + 0.5;
  const fc = Math.round(o.frame / g.step);
  for (let j = 0; j < g.gy; j++) for (let i = 0; i < g.gx; i++) {
    const k = j * g.gx + i, v = L[k];
    let t = o.mode === 'relief'
      ? o.base + o.depth * (o.lightUp ? v : 1 - v)
      : o.minT + (o.maxT - o.minT) * (1 - v);
    if (fc > 0 && (i < fc || j < fc || i >= g.gx - fc || j >= g.gy - fc)) t = fT;
    T[k] = t;
  }
  return { T, ...g, frameT: fT };
}

// Сетка → STL. Вершины: верх (по толщине) и низ (плоский или по дуге). Стенки по краю — сетка замкнутая.
export function buildMesh(hf, opts = {}) {
  const o = { ...LITHO_DEFAULTS, ...opts };
  const { T, gx, gy, W, H } = hf;
  const curve = o.mode === 'litho' ? Math.max(0, Math.min(180, o.curve)) * Math.PI / 180 : 0;
  // точка (x — поперёк, y — вдоль картинки сверху вниз, t — толщина) → координаты в мм
  const R = curve > 0 ? W / curve : 0;
  const pos = (i, j, t) => {
    const x = (i / (gx - 1)) * W, y = H - (j / (gy - 1)) * H; // верх картинки — дальний край (y = H)
    if (curve > 0) {
      // дуга вокруг оси Y: картинка на внешней стороне, низ печатается стоя (y — вверх по Z)
      const a = (x / W - 0.5) * curve, r = R + t;
      return [Math.sin(a) * r, -Math.cos(a) * r + R, y];
    }
    return [x, y, t];
  };
  const nTri = (gx - 1) * (gy - 1) * 2 + (gx - 1) * 2 + (gy + 2) * 2 + ((gx - 1) + (gy - 1)) * 4;
  const buf = new ArrayBuffer(84 + nTri * 50), dv = new DataView(buf);
  let tc = 0;
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    const off = 84 + tc * 50; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    [a, b, c].forEach((p, k) => { dv.setFloat32(off + 12 + k * 12, p[0], true); dv.setFloat32(off + 16 + k * 12, p[1], true); dv.setFloat32(off + 20 + k * 12, p[2], true); });
    dv.setUint16(off + 48, 0, true); tc++;
  };
  const up = (i, j) => pos(i, j, T[j * gx + i]);
  const dn = (i, j) => pos(i, j, 0);
  // верх: рельеф по всей сетке, нормаль наружу (в сторону толщины)
  for (let j = 0; j < gy - 1; j++) for (let i = 0; i < gx - 1; i++) {
    tri(up(i, j), up(i, j + 1), up(i + 1, j)); tri(up(i + 1, j), up(i, j + 1), up(i + 1, j + 1));
  }
  // низ гладкий: каждая полоса между столбцами i и i+1 — плоский прямоугольник (и на дуге тоже),
  // поэтому хватает двух треугольников на полосу. У крайних полос все вершины края — веером, чтобы не было щелей со стенками.
  const J = gy - 1;
  for (let i = 0; i < gx - 1; i++) {
    if (i === 0 || i === gx - 2) {
      // веер из угла соседнего столбца: (o, 0) → все вершины края → (o, J)
      const e = i === 0 ? 0 : gx - 1, o2 = i === 0 ? 1 : gx - 2;
      const rev = i === 0; // у левой полосы обход обратный, чтобы нормаль смотрела вниз
      const t3 = (a, b, c) => (rev ? tri(a, c, b) : tri(a, b, c));
      const pivot = dn(o2, 0);
      for (let j = 0; j < J; j++) t3(pivot, dn(e, j), dn(e, j + 1));
      t3(pivot, dn(e, J), dn(o2, J));
    } else {
      tri(dn(i, 0), dn(i + 1, 0), dn(i, J)); tri(dn(i + 1, 0), dn(i + 1, J), dn(i, J));
    }
  }
  // стенки: обход края, четыре стороны
  const wall = (i0, j0, i1, j1) => { tri(dn(i0, j0), dn(i1, j1), up(i0, j0)); tri(dn(i1, j1), up(i1, j1), up(i0, j0)); };
  for (let i = 0; i < gx - 1; i++) { wall(i + 1, 0, i, 0); wall(i, gy - 1, i + 1, gy - 1); }
  for (let j = 0; j < gy - 1; j++) { wall(0, j, 0, j + 1); wall(gx - 1, j + 1, gx - 1, j); }
  dv.setUint32(80, tc, true);
  const head = 'Grava litho';
  for (let k = 0; k < head.length; k++) dv.setUint8(k, head.charCodeAt(k));
  let out = buf.slice(0, 84 + tc * 50);
  new DataView(out).setUint32(80, tc, true);
  // подставка для плоской литофании — отдельная деталь рядом с пластиной (печатается в том же файле)
  if (o.stand && curve === 0) out = appendStand(out, W, hf.frameT);
  return out;
}

// Подставка: брусок 14 × 8 мм с пазом под толщину рамки. Печатается рядом с пластиной;
// после печати пластину вставляют в паз, и она стоит вертикально.
function appendStand(stl, W, fT) {
  const slot = fT + 0.4, L = W, D = 14, Hh = 8; // ширина паза, длина, глубина, высота
  const parts = [];
  const xb = 0, yb = -D - 5;
  const y0 = yb, y1 = yb + (D - slot) / 2, y2 = y1 + slot, y3 = yb + D;
  parts.push([xb, y0, 0, xb + L, y1, Hh]); // передняя стенка
  parts.push([xb, y2, 0, xb + L, y3, Hh]); // задняя стенка
  parts.push([xb, y1 - 0.5, 0, xb + L, y2 + 0.5, 2]);  // дно паза (заходит в стенки — слайсер сольёт)
  const old = new DataView(stl), n0 = old.getUint32(80, true), add = parts.length * 12;
  const buf = new ArrayBuffer(84 + (n0 + add) * 50);
  new Uint8Array(buf).set(new Uint8Array(stl));
  const dv = new DataView(buf); let tc = n0;
  const tri = (a, b, c) => {
    const off = 84 + tc * 50;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(off, nx / l, true); dv.setFloat32(off + 4, ny / l, true); dv.setFloat32(off + 8, nz / l, true);
    [a, b, c].forEach((p, k) => { dv.setFloat32(off + 12 + k * 12, p[0], true); dv.setFloat32(off + 16 + k * 12, p[1], true); dv.setFloat32(off + 20 + k * 12, p[2], true); });
    tc++;
  };
  for (const [x0, y0b, z0, x1, y1b, z1] of parts) {
    const v = (a, b, c) => [a ? x1 : x0, b ? y1b : y0b, c ? z1 : z0];
    const q = (p0, p1, p2, p3) => { tri(p0, p1, p2); tri(p0, p2, p3); };
    q(v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)); q(v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1));
    q(v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)); q(v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0));
    q(v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)); q(v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1));
  }
  dv.setUint32(80, tc, true);
  return buf;
}

// Главная функция: яркость картинки → STL
export function makeLitho(luma, w, h, opts = {}) {
  const o = { ...LITHO_DEFAULTS, ...opts };
  const hf = heightField(luma, w, h, o);
  const stl = buildMesh(hf, o);
  const tris = new DataView(stl).getUint32(80, true);
  let top = 0;
  for (let i = 0; i < hf.T.length; i++) if (hf.T[i] > top) top = hf.T[i];
  return { stl, tris, grid: [hf.gx, hf.gy], step: hf.step, size: [hf.W, hf.H, top], hf };
}

// Как литофания будет выглядеть на просвет (для превью): яркость 0..1 по сетке
export function backlitPreview(hf, k = 1.4) {
  const out = new Float32Array(hf.T.length);
  let mx = 0;
  for (let i = 0; i < out.length; i++) { out[i] = Math.exp(-k * hf.T[i]); if (out[i] > mx) mx = out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= mx || 1;
  return out;
}
