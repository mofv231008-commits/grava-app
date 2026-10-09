/* Грава — сборщик шарниров «⛓ Цепочка»: фигурка печатается сразу подвижной (print-in-place).
   Позвоночник и лапы режутся на звенья; сустав спрятан внутри: ушко заднего звена в петле переднего.
   Чистые функции без DOM: их используют flexi-worker.js, экран (jointDims/orderCuts) и tests/flexi.test.mjs.
   wasm — инициализированный manifold-3d (Module() + setup()). */

/* ---------- STL ---------- */

// Возвращает «суп» треугольников: Float32Array по 9 чисел на треугольник.
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  if (bytes.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) {
      const pos = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) {
        const o = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) pos[t * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return pos;
    }
  }
  // ASCII
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  if (!vals.length || vals.length % 9) throw new FlexiError('bad_stl');
  return new Float32Array(vals);
}

export function writeSTL(meshes) {
  let n = 0;
  meshes.forEach((m) => { n += m.triVerts.length / 3; });
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  // в заголовке STL — предупреждение (ASCII, 80 байт): суставы рассчитаны на этот размер
  const head = 'Grava flexi: DO NOT SCALE in slicer - joints sized for this print';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  meshes.forEach((m) => {
    const v = m.vertProperties;
    const np = m.numProp || 3;
    const tv = m.triVerts;
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
  });
  return buf;
}

export class FlexiError extends Error {
  constructor(code, text) {
    super(text || code);
    this.code = code;
  }
}

/* ---------- Модель: меш → Manifold, ориентация ---------- */

// Собираем Manifold из STL и кладём фигурку плашмя: самый маленький габарит — по Z.
export function loadModel(wasm, soup) {
  const { Manifold, Mesh } = wasm;
  const nv = soup.length / 3;
  const triVerts = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) triVerts[i] = i;
  const mesh = new Mesh({ numProp: 3, vertProperties: soup, triVerts });
  mesh.merge(); // STL — «суп» треугольников, склеиваем общие вершины
  let m;
  try {
    m = new Manifold(mesh);
  } catch (e) {
    throw new FlexiError('holes');
  }
  if (m.status() !== 'NoError' || m.isEmpty()) {
    m.delete();
    throw new FlexiError('holes');
  }
  const bb = m.boundingBox();
  const size = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
  let rot = null;
  if (size[0] < size[1] && size[0] < size[2]) rot = [0, 90, 0];       // X → Z
  else if (size[1] < size[0] && size[1] < size[2]) rot = [90, 0, 0];  // Y → Z
  if (rot) {
    const r = m.rotate(rot);
    m.delete();
    m = r;
  }
  const b2 = m.boundingBox();
  return { manifold: m, length: Math.max(b2.max[0] - b2.min[0], b2.max[1] - b2.min[1]) };
}

// Масштаб по длине, центр в (0,0), на стол, срезать низ на cut мм.
export function placeModel(wasm, base, length, cut) {
  const bb = base.boundingBox();
  const s = length / Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const a = base.translate([-cx, -cy, -bb.min[2]]);
  const b = a.scale(s);
  a.delete();
  if (!(cut > 0)) return b;
  const c = b.trimByPlane([0, 0, 1], cut);
  b.delete();
  const d = c.translate([0, 0, -cut]);
  c.delete();
  return d;
}

/* ---------- Вид сверху: растр, карта расстояний, скелет ---------- */

const INF = 1e20;
const MIN_VOL = 20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// Точное евклидово расстояние (Felzenszwalb) до ближайшего пикселя, где feature=1. Возвращает квадраты, в пикселях².
export function edt(feature, W, H) {
  const N = Math.max(W, H);
  const f = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1);
  const out = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = feature[i] ? 0 : INF;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = out[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = out[row + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) out[row + x] = d[x];
  }
  return out;
}

function getMeshArrays(m) {
  const mesh = m.getMesh();
  return { vertProperties: mesh.vertProperties, triVerts: mesh.triVerts, numProp: mesh.numProp };
}

// Растр силуэта + карта высот (макс. z) — треугольники в проекции XY.
function rasterize(mesh, grid) {
  const { x0, y0, step, W, H } = grid;
  const v = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
  const mask = new Uint8Array(W * H);
  const top = new Float32Array(W * H).fill(-INF);
  const bot = new Float32Array(W * H).fill(INF); // низ меша — для сустава на приподнятом брюхе
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ax = (v[a] - x0) / step - 0.5, ay = (v[a + 1] - y0) / step - 0.5, az = v[a + 2];
    const bx = (v[b] - x0) / step - 0.5, by = (v[b + 1] - y0) / step - 0.5, bz = v[b + 2];
    const cx = (v[c] - x0) / step - 0.5, cy = (v[c + 1] - y0) / step - 0.5, cz = v[c + 2];
    // центр треугольника — всегда в маску (мелкие треугольники не теряются)
    const mx = Math.round((ax + bx + cx) / 3), my = Math.round((ay + by + cy) / 3);
    if (mx >= 0 && my >= 0 && mx < W && my < H) {
      const i = my * W + mx;
      mask[i] = 1;
      const zz = (az + bz + cz) / 3;
      if (zz > top[i]) top[i] = zz;
      if (zz < bot[i]) bot[i] = zz;
    }
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.floor(Math.max(ay, by, cy)));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const i = py * W + px;
        mask[i] = 1;
        const zz = l1 * az + l2 * bz + l3 * cz;
        if (zz > top[i]) top[i] = zz;
        if (zz < bot[i]) bot[i] = zz;
      }
    }
  }
  return { mask, top, bot };
}

// Залить дыры внутри силуэта: всё, до чего нельзя дойти от края по фону.
function fillHoles(mask, W, H) {
  const seen = new Uint8Array(W * H);
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0;
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  for (let i = 0; i < W * H; i++) if (!seen[i]) mask[i] = 1;
}

function component(mask, W, H, start) {
  const out = new Uint8Array(W * H);
  if (!mask[start]) return out;
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0;
  out[start] = 1;
  q[qt++] = start;
  while (qh < qt) {
    const i = q[qh++];
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (mask[j] && !out[j]) { out[j] = 1; q[qt++] = j; }
      }
    }
  }
  return out;
}

// Zhang–Suen thinning.
function thin(mask, W, H) {
  const img = Uint8Array.from(mask);
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!img[i]) continue;
          const p2 = img[i - W], p3 = img[i - W + 1], p4 = img[i + 1], p5 = img[i + W + 1];
          const p6 = img[i + W], p7 = img[i + W - 1], p8 = img[i - 1], p9 = img[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      if (del.length) changed = true;
      for (const i of del) img[i] = 0;
    }
  }
  return img;
}


/* ---------- Шаг 0: перепаять модель ---------- */

// Воксели по чётности пересечений вертикальных лучей (как карта высот, только в объёме).
export function voxelize(mesh, v, pad = 3) {
  const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vp.length; i += np) {
    for (let k = 0; k < 3; k++) { if (vp[i + k] < mn[k]) mn[k] = vp[i + k]; if (vp[i + k] > mx[k]) mx[k] = vp[i + k]; }
  }
  const x0 = mn[0] - pad * v, y0 = mn[1] - pad * v, z0 = mn[2] - pad * v;
  const nx = Math.ceil((mx[0] - mn[0]) / v) + 2 * pad, ny = Math.ceil((mx[1] - mn[1]) / v) + 2 * pad, nz = Math.ceil((mx[2] - mn[2]) / v) + 2 * pad;
  const cols = new Array(nx * ny);
  const jx = 1.234e-4 * v, jy = 2.345e-4 * v; // сдвиг лучей с узлов сетки, чтобы не попадать ровно в рёбра
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ax = vp[a], ay = vp[a + 1], bx = vp[b], by = vp[b + 1], cx = vp[c], cy = vp[c + 1];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-14) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0 - jx) / v - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0 - jx) / v - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0 - jy) / v - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0 - jy) / v - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * v + jy;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * v + jx;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * vp[a + 2] + l2 * vp[b + 2] + l3 * vp[c + 2];
        const k = j * nx + i;
        (cols[k] || (cols[k] = [])).push(z);
      }
    }
  }
  const occ = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < cols.length; k++) {
    const zs = cols[k];
    if (!zs || zs.length < 2) continue;
    zs.sort((p, q) => p - q);
    for (let h = 0; h + 1 < zs.length; h += 2) {
      const ka = Math.max(0, Math.ceil((zs[h] - z0) / v - 0.5)), kb = Math.min(nz - 1, Math.floor((zs[h + 1] - z0) / v - 0.5));
      for (let z = ka; z <= kb; z++) occ[(z * ny) * nx + k] = 1;
    }
  }
  return { nx, ny, nz, x0, y0, z0, v, occ };
}

function morph6(src, nx, ny, nz, grow) {
  const out = Uint8Array.from(src);
  const sxy = nx * ny;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = z * sxy + y * nx + x;
        const want = grow ? 0 : 1; // dilate: пустой с заполненным соседом → 1; erode: заполненный с пустым соседом → 0
        if (src[i] !== want) continue;
        const n = (x > 0 ? src[i - 1] : 0) !== want || (x < nx - 1 ? src[i + 1] : 0) !== want ||
          (y > 0 ? src[i - nx] : 0) !== want || (y < ny - 1 ? src[i + nx] : 0) !== want ||
          (z > 0 ? src[i - sxy] : 0) !== want || (z < nz - 1 ? src[i + sxy] : 0) !== want;
        if (n) out[i] = grow ? 1 : 0;
      }
    }
  }
  return out;
}

function fillCavities3(occ, nx, ny, nz) {
  const sxy = nx * ny, N = occ.length;
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  const push = (i) => { if (!occ[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) push(z * sxy + y * nx + x);
  }
  while (qh < qt) {
    const i = q[qh++];
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / sxy) | 0;
    if (x > 0) push(i - 1);
    if (x < nx - 1) push(i + 1);
    if (y > 0) push(i - nx);
    if (y < ny - 1) push(i + nx);
    if (z > 0) push(i - sxy);
    if (z < nz - 1) push(i + sxy);
  }
  const out = Uint8Array.from(occ);
  for (let i = 0; i < N; i++) if (!seen[i]) out[i] = 1;
  return out;
}

// Точное расстояние (в вокселях) до ближайшего voxel с feature=1, по трём осям.
function edt3(feature, nx, ny, nz) {
  const N = Math.max(nx, ny, nz);
  const f = new Float64Array(N), d = new Float64Array(N), vv = new Int32Array(N), z = new Float64Array(N + 1);
  const out = new Float32Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = feature[i] ? 0 : INF;
  const sxy = nx * ny;
  const pass = (len, stride, starts) => {
    for (const base of starts) {
      for (let k = 0; k < len; k++) f[k] = out[base + k * stride];
      edt1d(f, len, d, vv, z);
      for (let k = 0; k < len; k++) out[base + k * stride] = d[k];
    }
  };
  const gen = function* (a, b, sa, sb) { for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) yield i * sa + j * sb; };
  pass(nx, 1, gen(nz, ny, sxy, nx));
  pass(ny, nx, gen(nz, nx, sxy, 1));
  pass(nz, sxy, gen(ny, nx, nx, 1));
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i]);
  return out;
}

/* Перепаять: воксели → закрытие на 1 воксель → заливка полостей → знаковое расстояние → levelSet.
   Возвращает { manifold, parts, grid, filled, skinIn, inAt } — filled: заполненные воксели после закрытия и заливки
   (по ним ищутся бороздки); skinIn — кожа, сжатая на 0.8 мм (см. ниже), inAt — её поле расстояний. */
export function repairModel(wasm, model, v = 0.3, onStage) {
  const { Manifold } = wasm;
  const stage = (name) => { if (onStage) onStage(name); };
  // большая фигурка — воксель крупнее, чтобы сетка не превышала ~8 млн (память и время на телефоне)
  const bb = model.boundingBox();
  const box = (bb.max[0] - bb.min[0] + 2) * (bb.max[1] - bb.min[1] + 2) * (bb.max[2] - bb.min[2] + 2);
  v = Math.max(v, Math.cbrt(box / 8e6));
  const RC = 1.2; // заплавить прорези и полости уже 2·RC — только для skinIn (сетке нужен запас RC по краям)
  const g = voxelize(getMeshArrays(model), v, 4 + Math.ceil(RC / v));
  stage('voxels');
  const { nx, ny, nz, occ } = g;
  const closed = morph6(morph6(occ, nx, ny, nz, true), nx, ny, nz, false);
  const filled = fillCavities3(closed, nx, ny, nz);
  stage('closed');

  const empty = new Uint8Array(filled.length);
  for (let i = 0; i < filled.length; i++) empty[i] = filled[i] ? 0 : 1;
  const dIn = edt3(empty, nx, ny, nz), dOut = edt3(filled, nx, ny, nz);
  const sdf = new Float32Array(filled.length);
  for (let i = 0; i < sdf.length; i++) sdf[i] = (filled[i] ? dIn[i] - 0.5 : 0.5 - dOut[i]) * v; // плюс — внутри
  stage('sdf');

  const sxy = nx * ny;
  const sample = (p) => {
    const fx = (p[0] - g.x0) / v - 0.5, fy = (p[1] - g.y0) / v - 0.5, fz = (p[2] - g.z0) / v - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) return -v * 3;
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const i = iz * sxy + iy * nx + ix;
    const c00 = sdf[i] * (1 - tx) + sdf[i + 1] * tx, c10 = sdf[i + nx] * (1 - tx) + sdf[i + nx + 1] * tx;
    const c01 = sdf[i + sxy] * (1 - tx) + sdf[i + sxy + 1] * tx, c11 = sdf[i + sxy + nx] * (1 - tx) + sdf[i + sxy + nx + 1] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  const bounds = {
    min: [g.x0 + v, g.y0 + v, g.z0 + v],
    max: [g.x0 + (nx - 1) * v, g.y0 + (ny - 1) * v, g.z0 + (nz - 1) * v],
  };
  const dense = Manifold.levelSet(sample, bounds, v, 0);
  stage('levelset');
  // skinIn — кожа, сжатая внутрь на 0.8 мм: петля и кольцо сустава должны лежать в ней целиком (стенка ≥ 0.8 мм).
  // 1. Прорези и полости уже 2·RC заплавлены: у готовой подвижной модели (эублефар от бота — прорези между
  //    сегментами и полости под старые суставы) сустав в прорези виден, как в зазоре, но наружу не торчит.
  // 2. Снизу, от стола, не сжимаем — петля стоит на столе: под каждой колонкой, где тело касается стола (слой kb —
  //    первый, чей центр выше z = 0), кожа продлена вниз на 2 мм ниже нуля; после сжатия всё ниже z = 0 отрезается.
  //    Так кожа сжимается только с боков и сверху (и снизу там, где брюхо приподнято над столом).
  const IN = 0.8;
  // закрытие радиусом RC (расширить на RC, сузить на RC) и заливка полостей, которые после этого стали замкнутыми
  const rc = RC / v;
  const dil = new Uint8Array(filled.length);
  for (let i = 0; i < dil.length; i++) dil[i] = filled[i] || dOut[i] <= rc ? 1 : 0;
  const dD = edt3(Uint8Array.from(dil, (x) => 1 - x), nx, ny, nz);
  const shut = new Uint8Array(filled.length);
  for (let i = 0; i < shut.length; i++) shut[i] = filled[i] || (dil[i] && dD[i] > rc) ? 1 : 0;
  const solid = fillCavities3(shut, nx, ny, nz);
  const emptyS = Uint8Array.from(solid, (x) => 1 - x);
  const kb = Math.floor(-g.z0 / v - 0.5) + 1;
  const extra = Math.max(0, Math.ceil(2 / v) - kb); // сколько слоёв добавить снизу, чтобы под нулём было ≥ 2 мм
  const nzE = nz + extra, zE = g.z0 - extra * v;
  const emptyExt = new Uint8Array(sxy * nzE).fill(1);
  emptyExt.set(emptyS, extra * sxy);
  if (kb >= 0 && kb < nz) {
    const top = (kb + extra) * sxy;
    for (let k = 0; k < kb + extra; k++) {
      for (let i = 0; i < sxy; i++) if (!emptyExt[top + i]) emptyExt[k * sxy + i] = 0;
    }
  }
  const dInExt = edt3(emptyExt, nx, ny, nzE);
  // снаружи хватает «−полвокселя»: уровень 0.8 мм лежит глубоко внутри, наружные значения его не трогают
  const sdfIn = new Float32Array(emptyExt.length);
  for (let i = 0; i < sdfIn.length; i++) sdfIn[i] = emptyExt[i] ? -0.5 * v : (dInExt[i] - 0.5) * v;
  const sampleIn = (p) => {
    const fx = (p[0] - g.x0) / v - 0.5, fy = (p[1] - g.y0) / v - 0.5, fz = (p[2] - zE) / v - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nzE - 1) return -v * 3;
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const i = iz * sxy + iy * nx + ix;
    const c00 = sdfIn[i] * (1 - tx) + sdfIn[i + 1] * tx, c10 = sdfIn[i + nx] * (1 - tx) + sdfIn[i + nx + 1] * tx;
    const c01 = sdfIn[i + sxy] * (1 - tx) + sdfIn[i + sxy + 1] * tx, c11 = sdfIn[i + sxy + nx] * (1 - tx) + sdfIn[i + sxy + nx + 1] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  // для проверки «внутри» хватает шага 0.5 мм (вдвое быстрее и легче, чем 0.3); ниже стола — отрезать
  const inRaw = Manifold.levelSet(sampleIn, { min: [g.x0 + v, g.y0 + v, zE + v / 2], max: bounds.max }, Math.max(v, 0.5), IN);
  const skinIn = inRaw.trimByPlane([0, 0, 1], 0);
  inRaw.delete();
  stage('skinIn');
  // levelSet даёт ~0.7 млн треугольников — упрощаем с допуском 0.1 мм (в 4–5 раз меньше, STL < 12 МБ)
  // крупная фигурка — допуск побольше, чтобы итоговый STL остался < 12 МБ
  let raw = dense.simplify(0.1);
  for (const tol of [0.13, 0.17, 0.22, 0.3]) {
    if (raw.numTri() <= 160000) break;
    raw.delete();
    raw = dense.simplify(tol);
  }
  dense.delete();
  // simplify поднимает допуск булевых операций до tol — вернём точный, иначе на совпадающих гранях
  // петли, ушка и кожи остаются плёнки толщиной с допуск
  const exact = raw.setTolerance(1e-5);
  raw.delete();
  raw = exact;
  stage('simplify');
  // самая большая компонента; мелочь < 20 мм³ — в мусор
  const comps = raw.decompose();
  raw.delete();
  comps.sort((a, b) => b.volume() - a.volume());
  const big = comps.filter((c) => c.volume() >= MIN_VOL);
  const manifold = comps[0];
  comps.slice(1).forEach((c) => c.delete());
  // inAt(x, y, z) ≥ 0 — точка внутри skinIn (по тому же полю расстояний, без булевых операций; ниже стола — снаружи)
  const inAt = (x, y, z) => (z < 0 ? -1 : sampleIn([x, y, z]) - IN);
  return { manifold, parts: big.length, grid: g, filled, skinIn, inAt };
}

/* ---------- Анализ вида сверху ---------- */

// Силуэт, карта расстояний, «тело», скелет и его ветви. Разрезы считает autoCuts().
export function analyze(mesh, bbox) {
  const margin = 3;
  let step = 0.5;
  const spanX = bbox.max[0] - bbox.min[0] + margin * 2, spanY = bbox.max[1] - bbox.min[1] + margin * 2;
  if (Math.max(spanX, spanY) / step > 700) step = Math.max(spanX, spanY) / 700;
  const W = Math.ceil(spanX / step), H = Math.ceil(spanY / step);
  const grid = { x0: bbox.min[0] - margin, y0: bbox.min[1] - margin, step, W, H };
  const N = W * H;

  const { mask, top, bot } = rasterize(mesh, grid);
  fillHoles(mask, W, H);

  const bg = new Uint8Array(N);
  for (let i = 0; i < N; i++) bg[i] = mask[i] ? 0 : 1;
  const d2 = edt(bg, W, H);
  const dt = new Float32Array(N);
  let core = -1, coreW = 0;
  for (let i = 0; i < N; i++) {
    dt[i] = mask[i] ? Math.sqrt(d2[i]) * step : 0;
    if (dt[i] > coreW) { coreW = dt[i]; core = i; }
  }
  if (core < 0) throw new FlexiError('empty');

  // «тело»: морфологическое открытие радиусом rb
  const rb = Math.max(2, 0.55 * coreW);
  const eroded = new Uint8Array(N);
  for (let i = 0; i < N; i++) eroded[i] = dt[i] > rb ? 1 : 0;
  const de = edt(eroded, W, H);
  const rbPx2 = (rb / step) * (rb / step);
  const opened = new Uint8Array(N);
  for (let i = 0; i < N; i++) opened[i] = mask[i] && de[i] <= rbPx2 ? 1 : 0;
  const body = component(opened, W, H, core);
  const db = edt(body, W, H);
  const bodyD = new Uint8Array(N);
  const onePx2 = (1 / step) * (1 / step);
  for (let i = 0; i < N; i++) bodyD[i] = db[i] <= onePx2 ? 1 : 0;

  // скелет и дерево BFS от ядра
  const skel = thin(mask, W, H);
  const cx = core % W, cy = (core / W) | 0;
  let root = -1, best = Infinity;
  for (let i = 0; i < N; i++) {
    if (!skel[i]) continue;
    const dd = (i % W - cx) ** 2 + (((i / W) | 0) - cy) ** 2;
    if (dd < best) { best = dd; root = i; }
  }
  const parent = new Int32Array(N).fill(-2);
  const dist = new Float32Array(N);
  const hasChild = new Uint8Array(N);
  const order = [];
  if (root >= 0) {
    parent[root] = -1;
    const q = [root];
    for (let qh = 0; qh < q.length; qh++) {
      const i = q[qh];
      order.push(i);
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (skel[j] && parent[j] === -2) {
            parent[j] = i;
            dist[j] = dist[i] + Math.hypot(dx, dy) * step;
            hasChild[i] = 1;
            q.push(j);
          }
        }
      }
    }
  }

  const P = (i) => [grid.x0 + (i % W + 0.5) * step, grid.y0 + (((i / W) | 0) + 0.5) * step];
  const index = new Map();
  order.forEach((i, k) => index.set(i, k));
  const skeleton = order.map((i) => {
    const [x, y] = P(i);
    return { x, y, dt: dt[i], parent: parent[i] >= 0 ? index.get(parent[i]) : -1, dist: dist[i] };
  });

  // ветви: путь от ядра до каждого листа
  const branches = order.filter((i) => !hasChild[i]).map((leaf) => {
    const path = [];
    for (let i = leaf; i >= 0; i = parent[i]) path.push(i);
    path.reverse();
    const pts = path.map(P);
    const cum = new Float64Array(path.length);
    for (let k = 1; k < path.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    let ex = -1;
    for (let k = 0; k < path.length; k++) if (!bodyD[path[k]]) { ex = k; break; }
    return { pts, cum, dt: Float32Array.from(path, (i) => dt[i]), ex, path };
  }).sort((a, b) => b.cum[b.cum.length - 1] - a.cum[a.cum.length - 1]);

  // позвоночник: самый длинный путь по скелету — от кончика морды через ядро до кончика хвоста.
  // A — самая длинная ветвь от ядра (обычно хвост), B — ветвь на противоположной стороне (голова): длина от
  // развилки, умноженная на квадрат «противоположности» направлений (лапа сбоку проигрывает короткой голове).
  // Путь B (задом наперёд) + A.
  if (branches.length) {
    const A = branches[0];
    const lenOf = (b) => b.cum[b.cum.length - 1];
    const c0 = P(root);
    const dirOf = (b) => { const e = b.pts[b.pts.length - 1]; const l = Math.hypot(e[0] - c0[0], e[1] - c0[1]) || 1; return [(e[0] - c0[0]) / l, (e[1] - c0[1]) / l]; };
    const dA = dirOf(A);
    let best = null, bestScore = 0, bestC = 0;
    for (const B of branches.slice(1)) {
      let c = 0;
      while (c < A.path.length && c < B.path.length && A.path[c] === B.path[c]) c++;
      const dB = dirOf(B);
      const opp = Math.max(0, -(dA[0] * dB[0] + dA[1] * dB[1]));
      const score = (lenOf(B) - B.cum[c - 1]) * opp * opp;
      if (score > bestScore) { bestScore = score; best = B; bestC = c; }
    }
    const path = best ? best.path.slice(bestC - 1).reverse().concat(A.path.slice(bestC)) : A.path.slice();
    const pts = path.map(P);
    const cum = new Float64Array(path.length);
    for (let k = 1; k < path.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    const inBody = Uint8Array.from(path, (i) => bodyD[i]);
    let ex = -1;
    for (let k = 0; k < path.length; k++) if (inBody[k]) { ex = k; break; } // первая точка тела со стороны морды
    // позвоночник нужен вытянутому телу (кот, ящерица); у круглого (осьминог) хребта нет — каждая ветвь сама по себе
    let bodyLen = 0, bodyW = 0;
    for (let k = 1; k < path.length; k++) if (inBody[k] && inBody[k - 1]) bodyLen += cum[k] - cum[k - 1];
    for (let k = 0; k < path.length; k++) if (inBody[k]) bodyW = Math.max(bodyW, dt[path[k]]);
    if (bodyLen >= 1.6 * 2 * bodyW) {
      branches[0] = {
        pts, cum, dt: Float32Array.from(path, (i) => dt[i]), ex, path, inBody, spine: true,
        core: Math.max(0, path.indexOf(root)),
      };
    }
  }
  branches.forEach((b) => { delete b.path; });

  // картинка высот для экрана: 0 — фон, 40…255 — высота
  let zMax = 0;
  for (let i = 0; i < N; i++) if (mask[i] && top[i] > zMax) zMax = top[i];
  const heights = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const z = top[i] > -INF ? top[i] : 0;
    heights[i] = 40 + Math.round(215 * Math.max(0, Math.min(1, z / (zMax || 1))));
  }

  return { grid, heights, top, bot, zMax, skeleton, branches, core: P(core), coreW, rb, mesh };
}

// Верх меша в радиусе r мм от точки (по карте высот).
export function ztopAt(an, x, y, r = 3) {
  const { x0, y0, step, W, H } = an.grid;
  const cx = (x - x0) / step - 0.5, cy = (y - y0) / step - 0.5, rp = r / step;
  let z = 0;
  for (let py = Math.max(0, Math.floor(cy - rp)); py <= Math.min(H - 1, Math.ceil(cy + rp)); py++) {
    for (let px = Math.max(0, Math.floor(cx - rp)); px <= Math.min(W - 1, Math.ceil(cx + rp)); px++) {
      if ((px - cx) ** 2 + (py - cy) ** 2 > rp * rp) continue;
      const t = an.top[py * W + px];
      if (t > z) z = t;
    }
  }
  return z;
}

/* ---------- Размеры сустава ---------- */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* Сустав «ушко в петле» (как у flexi happy lizard). opts: { g — зазор, alphaSeg — поворот на звено, ° }.
   У заднего звена (родителя) посередине высоты вперёд торчит плоское ушко — горизонтальное кольцо с дыркой;
   у переднего (ребёнка) — петля: стойка сквозь дырку ушка, сверху и снизу перекладины уходят в тело ребёнка.
   w — полуширина тела в точке разреза, Hs — высота тела на оси, z0 — низ сустава (стол или низ кожи + 0.8),
   Hfree — сколько высоты над z0 есть до верха кожи. Размеры — в мм ГОТОВОЙ фигурки, с минимумами, чтобы
   стойки и стенки печатались прочными при любом масштабе (S — толщина тела: min(2w, Hs, Hfree) — по свободной
   высоте над следом петли, чтобы у перехода тела в хвост сустав был по хвосту, а не по толстому телу):
     dp — диаметр стойки 3.2…4.4, ta — перекладины по высоте 2.4…3.2, bw = dp — их ширина,
     be — стенка кольца ушка 2.0…2.8, te — ушко по высоте 2.4…3.2.
   fits — сустав помещается: Lt + 0.8 ≤ Hfree и Re + g + 0.8 ≤ w (иначе звена здесь нет).
   Rh — «радиус» для расстановки: (La + Re + 2)/2, сумма двух соседних — шаг La + Re + 2. */
export function jointDims(opts, w, Hs, wOut = w, z0 = 0, Hfree = Hs) {
  const g = opts.g;
  const alpha = opts.alphaSeg;
  const S = Math.min(2 * w, Hs, Hfree);
  const dp = clamp(0.30 * S, 3.2, 4.4);   // диаметр стойки петли
  const ta = clamp(0.22 * S, 2.4, 3.2);   // толщина перекладин по высоте
  const bw = dp;                          // ширина перекладин и передней стойки
  const be = clamp(0.20 * S, 2.0, 2.8);   // стенка кольца ушка
  const te = clamp(0.22 * S, 2.4, 3.2);   // толщина ушка по высоте
  const ai = be + 2 * g + 0.6;            // длина проёма петли (вдоль n)
  const hi = te + 2 * g + 0.4;            // высота проёма петли
  const Lt = 2 * ta + hi;                 // высота петли
  const La = dp / 2 + ai + ta;            // вылет петли вперёд
  const Re = dp / 2 + g + be;             // наружный радиус ушка
  const ez0 = ta + g, ez1 = ez0 + te;     // ушко по высоте (от низа петли)
  const Rh = (La + Re + 2) / 2;
  return {
    g, w, Hs, z0, Hfree, dp, ta, bw, be, te, ai, hi, Lt, La, Re, ez0, ez1, Rh, alpha, H: Lt,
    fits: Lt + 0.8 <= Hfree && Re + g + 0.8 <= w,
    // V-вырез — всю ширину тела (не дальше w + 6: у ядра прорезал бы суставы соседей)
    Rs: Math.max(Re + g + 0.5, w + 2, Math.min(wOut + 1.5, w + 6)),
  };
}

// Низ и верх кожи в точке (карты высот вида сверху, шаг 0.5 мм); вне силуэта — null.
function spanAt(an, x, y) {
  const { x0, y0, step, W, H } = an.grid;
  const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
  if (px < 0 || py < 0 || px >= W || py >= H) return null;
  const i = py * W + px, zt = an.top[i], zb = an.bot ? an.bot[i] : 0;
  return zt > -INF && zb < INF ? { zb, zt } : null;
}

// Щель разреза: полоса |x| < GAP мм вокруг линии разреза (вдоль n). Сустав проходит сквозь зазор V-выреза и виден
// в нём по устройству; бороздка модели (прорезь снизу и сверху), к которой притянут разрез, — это и есть зазор.
// Поэтому низ и верх кожи и проверка skinIn считаются без этой полосы.
export const GAP = 1.5;

// Высота по мешу на оси сустава (обход всех треугольников — дорого, поэтому запоминается по точке).
function axisSpan(an, x, y) {
  if (!an.vsCache) an.vsCache = new Map();
  const key = Math.round(x * 1000) + ',' + Math.round(y * 1000);
  let v = an.vsCache.get(key);
  if (v === undefined) {
    v = verticalSpan(an.mesh, x, y);
    an.vsCache.set(key, v);
  }
  return v;
}

// Низ сустава и запас по высоте — по следу петли сверху (стойка, перекладины, передняя стойка): на столе — с низа
// кожи; если брюхо приподнято (шея, грудь эллипсоида) — на 0.8 мм выше самого высокого низа, чтобы снизу осталась
// стенка. Hfree — до самого низкого верха над петлёй.
// n и d0 (прикидочные размеры) задают след; без них — только ось.
function footSpan(an, P, n, d0) {
  // низ и верх сустава — это петля: стойка на оси и перекладины до передней стойки (кольцо и шейка — посередине
  // высоты, их держит проверка по skinIn)
  const pts = [[0, 0]];
  if (n && d0) {
    // весь след петли сеткой 0.5 мм: стойка, перекладины, передняя стойка (низ кожи под хвостом, отходящим от
    // стола, растёт неровно — по нескольким точкам можно не заметить, где он выше)
    const hw = d0.bw / 2, front = d0.La + 2;
    for (let x = -d0.dp / 2; x <= front + 1e-6; x += 0.5) {
      for (let y = -hw; y <= hw + 1e-6; y += Math.max(0.5, hw / 3)) if (x >= 0 || Math.hypot(x, y) <= d0.dp / 2) pts.push([x, y]);
    }
  }
  const t = n ? [-n[1], n[0]] : [0, 0];
  let zbMax = -INF, ztMin = INF, Hs = 0;
  const foot = [];
  for (const [x, y] of pts) {
    const q = n ? [P[0] + n[0] * x + t[0] * y, P[1] + n[1] * x + t[1] * y] : P;
    const sp = (x === 0 && y === 0 && an.mesh && axisSpan(an, q[0], q[1])) || spanAt(an, q[0], q[1]);
    // ось вне фигурки — сустава нет; точка следа за кончиком — пропускаем (высоту считаем по остальным, а что
    // сустав торчит за кончик, ловит проба ребёнка при проверке: «слишком близко к кончику»)
    if (!sp && x === 0 && y === 0) return { Hs: 0, zb: 0, zt: 0, foot: [] };
    if (!sp) continue;
    if (x === 0 && y === 0) Hs = sp.zt - sp.zb;
    // щель разреза (|x| < GAP) не считается: там сустав виден в зазоре по устройству, а бороздка модели
    // (прорезь снизу и сверху) — это и есть зазор
    if (n && d0 && Math.abs(x) < GAP) continue;
    zbMax = Math.max(zbMax, sp.zb);
    ztMin = Math.min(ztMin, sp.zt);
    foot.push([q[0], q[1], sp.zb, sp.zt]);
  }
  if (zbMax === -INF) return { Hs: 0, zb: 0, zt: 0, foot: [] };
  return { Hs, zb: zbMax, zt: ztMin, foot };
}

/* Размеры сустава в точке по следу петли (без щели разреза).
   С полем skinIn (сжатая кожа модели с заплавленными прорезями): в каждой точке следа — где сжатая кожа
   начинается снизу и где кончается сверху; низ петли z0 — не ниже самого высокого «начала» (на столе — это
   стол, у приподнятого брюха — над ним с запасом 0.8 мм, на наклонном — выше), но и не ниже настоящего низа
   кожи там, где он у стола (≤ 0.3 мм: после вокселей низ на 0.05–0.15 мм выше нуля, петля не должна торчать
   под ним). Верх петли — не выше самого низкого «конца». Бороздка модели (прорезь снизу или сверху у разреза)
   заплавлена в skinIn — сустав в ней виден, как в зазоре, и не поднимается из-за неё.
   Без поля (бруски в тестах) — по низу и верху кожи: на столе — с низа кожи, приподнято больше 0.3 мм — +0.8. */
function footDims(an, opts, w, P, n, wOut = w) {
  const ax = footSpan(an, P);
  const sp = footSpan(an, P, n, jointDims(opts, w, ax.Hs));
  if (!an.inAt || !n || !sp.foot.length) {
    const z0 = sp.zb > 0.3 ? sp.zb + 0.8 : Math.max(0, sp.zb);
    return jointDims(opts, w, sp.Hs, wOut, z0, sp.zt - z0);
  }
  let z0 = 0, top = INF;
  const IN = (x, y, z) => an.inAt(x, y, z) >= 0.02;
  for (const [x, y, zb, zt] of sp.foot) {
    // снизу вверх шагом 0.2, потом уточнить до 0.025 мм
    let lo = 0;
    while (lo < zt && !IN(x, y, lo + 0.05)) lo += 0.2;
    // сжатой кожи над точкой нет вовсе (край тела, кончик) — это не про высоту: сустав там вылезает вбок,
    // это ловит проверка skinIn
    if (lo >= zt) continue;
    if (lo > 0) for (let st = 0.1; st > 0.02; st /= 2) if (IN(x, y, lo - st + 0.05)) lo -= st;
    if (zb <= 0.3) lo = Math.max(lo, zb);
    // сверху вниз так же
    let hi = zt + 1;
    while (hi > lo && !IN(x, y, hi)) hi -= 0.2;
    if (hi > lo) for (let st = 0.1; st > 0.02; st /= 2) if (IN(x, y, hi + st)) hi += st;
    if (lo > z0) z0 = lo;
    if (hi < top) top = hi;
  }
  if (top === INF) return jointDims(opts, w, sp.Hs, wOut, 0, 0); // сжатой кожи под следом нет — не помещается
  // Hfree — с запасом 0.8 сверху, как в правиле Lt + 0.8 ≤ Hfree: верх петли не выше top
  return jointDims(opts, w, sp.Hs, wOut, z0, top + 0.8 - z0);
}

// Размеры сустава в точке P: высота и низ на оси (по мешу), V-вырез — до края силуэта поперёк ветви.
export function jointAt(an, opts, w, P, n) {
  let wOut = w;
  if (n) {
    const { x0, y0, step, W, H: GH } = an.grid;
    const inside = (x, y) => {
      const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
      return px >= 0 && py >= 0 && px < W && py < GH && an.heights[py * W + px] > 0;
    };
    const bt = (opts.alphaSeg / 2) * DEG;
    for (const sg of [1, -1]) {
      for (const db of [-bt, 0, bt]) {
        const a = Math.atan2(n[1], n[0]) + sg * Math.PI / 2 + db;
        let r = 0;
        while (r < 60 && inside(P[0] + Math.cos(a) * (r + step), P[1] + Math.sin(a) * (r + step))) r += step;
        if (r > wOut) wOut = r;
      }
    }
  }
  return footDims(an, opts, w, P, n, wOut);
}

// Размеры сустава по точке без V-выреза (для расстановки).
function dimsHere(an, opts, w, P, n) {
  return footDims(an, opts, w, P, n);
}

/* ---------- Бороздки ---------- */

// Столбцы вокселей после починки: fc — сколько заполненных вокселей над каждой клеткой (площадь сечений).
export function attachGrooves(an, rep) {
  const g = rep.grid, { nx, ny, nz } = g, sxy = nx * ny;
  const fc = new Float32Array(sxy);
  for (let z = 0; z < nz; z++) {
    const o = z * sxy;
    for (let i = 0; i < sxy; i++) if (rep.filled[o + i]) fc[i]++;
  }
  an.cols = { fc, x0: g.x0, y0: g.y0, v: g.v, nx, ny };
  an.branches.forEach((br) => { delete br.grooves; });
}


const GROOVE_DIP = 0.2; // сечение в бороздке на 30 % меньше, чем в 1–2 мм по сторонам
const brAt = (br, d) => {
  const { cum } = br;
  let k = 0;
  while (k < cum.length - 1 && cum[k] < d) k++;
  return k;
};
const brDir = (br, k) => {
  const a = br.pts[brAt(br, br.cum[k] - 3)], b = br.pts[brAt(br, br.cum[k] + 3)];
  const nx = b[0] - a[0], ny = b[1] - a[1];
  const l = Math.hypot(nx, ny) || 1;
  return [nx / l, ny / l];
};
const brMaxDt = (br, from, to) => {
  let m = 0;
  for (let k = 0; k < br.cum.length; k++) if (br.cum[k] >= from && br.cum[k] <= to) m = Math.max(m, br.dt[k]);
  return m;
};

/* Бороздки ветви — индексы точек пути. Бороздка — узкий провал площади сечения поперёк ветви:
   срез толщиной 0.3 мм, профиль вдоль пути с шагом 0.15 мм; в бороздке сечение заметно меньше,
   чем в 0.9–1.8 мм по обе стороны (плавное сужение — шея, кончик хвоста — так не проваливается). */
export function branchGrooves(an, br) {
  if (br.grooves) return br.grooves;
  const out = [];
  br.grooves = out;
  const C = an.cols;
  if (!C) return out;
  const look = (x, y) => {
    const ix = Math.floor((x - C.x0) / C.v), iy = Math.floor((y - C.y0) / C.v);
    return ix < 0 || iy < 0 || ix >= C.nx || iy >= C.ny ? -1 : iy * C.nx + ix;
  };
  const { pts, cum } = br;
  const len = cum[cum.length - 1];
  const STEP = 0.15;
  const m = Math.floor(len / STEP) + 1;
  const area = new Float32Array(m), kOf = new Int32Array(m);
  let k = 0;
  for (let i = 0; i < m; i++) {
    const sv = i * STEP;
    while (k < cum.length - 2 && cum[k + 1] < sv) k++;
    const k1 = Math.min(k + 1, cum.length - 1);
    const t = cum[k1] > cum[k] ? clamp((sv - cum[k]) / (cum[k1] - cum[k]), 0, 1) : 0;
    const P = [pts[k][0] + (pts[k1][0] - pts[k][0]) * t, pts[k][1] + (pts[k1][1] - pts[k][1]) * t];
    const kn = t < 0.5 ? k : k1;
    kOf[i] = kn;
    const d = brDir(br, kn), w = Math.max(br.dt[k], br.dt[k1]) + 1;
    let f = 0;
    for (let a = -0.15; a <= 0.16; a += 0.15) {
      for (let l = -w; l <= w; l += 0.15) {
        const j = look(P[0] + d[0] * a - d[1] * l, P[1] + d[1] * a + d[0] * l);
        if (j >= 0) f += C.fc[j];
      }
    }
    area[i] = f;
  }
  const s0 = Math.round(0.9 / STEP), s1 = Math.round(1.8 / STEP), R = Math.round(2.5 / STEP);
  const dip = new Float32Array(m);
  for (let i = s1; i < m - s1; i++) {
    let lo = 0, hi = 0;
    for (let j = s0; j <= s1; j++) { lo = Math.max(lo, area[i - j]); hi = Math.max(hi, area[i + j]); }
    const sh = Math.min(lo, hi); // провал должен быть с обеих сторон
    dip[i] = sh > 0 ? 1 - area[i] / sh : 0;
  }
  // пики не ближе 2.5 мм друг к другу
  for (let i = 0; i < m; i++) {
    if (dip[i] < GROOVE_DIP) continue;
    let peak = true;
    for (let j = Math.max(0, i - R); j <= Math.min(m - 1, i + R) && peak; j++) {
      if (j !== i && (dip[j] > dip[i] || (dip[j] === dip[i] && j < i))) peak = false;
    }
    if (peak && out[out.length - 1] !== kOf[i]) out.push(kOf[i]);
  }
  return out;
}

/* ---------- Автопоиск разрезов ---------- */

// Полуширина в точке разреза: радиус самого большого круга вокруг P внутри силуэта (минимум в ±0.5 мм пути —
// в бороздке ветвь уже, и кольцо должно поместиться именно там).
const brMinDt = (br, k) => {
  let m = Infinity;
  for (let j = k; j >= 0 && br.cum[k] - br.cum[j] <= 0.5; j--) m = Math.min(m, br.dt[j]);
  for (let j = k + 1; j < br.cum.length && br.cum[j] - br.cum[k] <= 0.5; j++) m = Math.min(m, br.dt[j]);
  return m;
};

// Разрез в точке k ветви: направление — на точку, где при сборке будет проба ребёнка
// (на изогнутой лапе шейка смотрит в неё). w — полуширина в точке разреза.
export function cutAt(an, opts, bi, k, w) {
  const br = an.branches[bi];
  if (w == null) w = brMinDt(br, k);
  const P = br.pts[k].slice();
  const d = dimsHere(an, opts, w, P);
  const ahead = d.Rh + opts.g + 1.5;
  let n = brDir(br, k);
  if (br.cum[br.cum.length - 1] - br.cum[k] > ahead) {
    const q = br.pts[brAt(br, br.cum[k] + ahead)];
    const l = Math.hypot(q[0] - P[0], q[1] - P[1]);
    if (l > ahead * 0.5) {
      // но не дальше 10° от оси ветви: косой V-вырез на толстом хвосте отрезает боковую щепку
      const a0 = Math.atan2(n[1], n[0]);
      let da = Math.atan2(q[1] - P[1], q[0] - P[0]) - a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const a = a0 + clamp(da, -10 * DEG, 10 * DEG);
      n = [Math.cos(a), Math.sin(a)];
    }
  }
  // помещается ли — по всему следу сустава (низ и верх кожи под ним, поле skinIn)
  const df = dimsHere(an, opts, w, P, n);
  return { P, n, w, br: bi, s: br.cum[k], Rh: df.Rh, fit: df.fits && footprintOk(an, P, n, df) };
}

// Сустав целиком внутри skinIn — быстрая проверка для расстановки: петля (стойка, перекладины, передняя стойка)
// и кольцо ушка обходятся сеткой 0.6 мм, каждая точка — по полю расстояний skinIn (an.inAt). Шейку ушка не
// проверяем — она срастается с телом родителя и обрезается по коже. Снаружи SKIN_TOL мм³ и больше — не помещается.
// Точная проверка — булевой операцией (jointOutside).
function footprintOk(an, P, n, d) {
  if (!an.inAt) return true;
  const h = 0.6, cell = h * h * h;
  const { dp, ta, bw, hi, La, Lt, Re, ez0, ez1, g, z0 } = d;
  const t = [-n[1], n[0]];
  // по высоте — сетка 0.6 мм и ещё низ и верх петли, перекладин и ушка (тонкая полоска у грани иначе проскакивает
  // между слоями сетки)
  const zs = [0.05, ta - 0.05, ta + hi + 0.05, ez0 + 0.05, ez1 - 0.05, Lt - 0.05];
  for (let z = h / 2; z < Lt; z += h) zs.push(z);
  let out = 0;
  for (let x = -Re + h / 2; x < La + 2; x += h) {
    for (let y = -Re + h / 2; y < Re; y += h) {
      const r = Math.hypot(x, y);
      for (const z of zs) {
        const inLoop = r <= dp / 2 || (Math.abs(y) <= bw / 2 && ((x >= 0 && x <= La && (z <= ta || z >= ta + hi)) || (x >= La - ta && x <= La + 2)));
        const inEye = z >= ez0 && z <= ez1 && r <= Re && r >= dp / 2 + g;
        if ((!inLoop && !inEye) || Math.abs(x) < GAP) continue;
        if (an.inAt(P[0] + n[0] * x + t[0] * y, P[1] + n[1] * x + t[1] * y, z0 + z) < 0) {
          out += cell;
          if (out >= SKIN_TOL) return false;
        }
      }
    }
  }
  return true;
}

// Проба ребёнка (как при сборке) должна попасть в силуэт, иначе сустав не встанет.
function probeInside(an, c, g) {
  const x = c.P[0] + c.n[0] * (c.Rh + g + 1.5), y = c.P[1] + c.n[1] * (c.Rh + g + 1.5);
  const { x0, y0, step, W, H } = an.grid;
  const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
  return px >= 0 && py >= 0 && px < W && py < H && an.heights[py * W + px] > 0;
}

// Деталь «на столе», если её низ не выше HANG: после вокселей низ, стоявший на столе, оказывается на 0.05–0.15 мм
// выше нуля; выше первого слоя (0.2 мм) — звено висит, без поддержек его не напечатать.
const HANG = 0.2;

// Кусок ветви между s0 и s1 касается стола: где-то под осью низ кожи не выше HANG (как проверяет сборщик).
function touchesTable(an, br, s0, s1) {
  const { x0, y0, step, W, H } = an.grid;
  for (let k = 0; k < br.pts.length; k++) {
    if (br.cum[k] < s0 || br.cum[k] > s1) continue;
    const px = Math.floor((br.pts[k][0] - x0) / step), py = Math.floor((br.pts[k][1] - y0) / step);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = px + dx, Y = py + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H && an.bot[Y * W + X] <= HANG) return true;
      }
    }
  }
  return false;
}

// До конца ветви должно остаться больше Rh + g + 4.
const roomLeft = (an, c, g) => {
  const br = an.branches[c.br];
  return br.cum[br.cum.length - 1] - c.s > c.Rh + g + 4;
};
// Соседние суставы: кольца не ближе 0.2 мм — жёсткий предел сборщика (ближе — ошибка «слишком близко»).
export const sepMin = (Ra, Rb) => Ra + Rb + 0.2;
// На экране и в предложениях запас больше: между кружками суставов (радиус Rh) — не меньше CLEAR мм.
export const CLEAR = 2;
export const tooClose = (a, b) => Math.hypot(a.P[0] - b.P[0], a.P[1] - b.P[1]) < a.Rh + b.Rh + CLEAR;
const farEnough = (a, b) => !tooClose(a, b);

// Короткие причины для красного разреза (экран показывает их как есть).
export const THIN_TAIL = 'сделай фигурку крупнее или сдвинь ближе к телу';
export const NEAR_WHY = 'слишком близко к соседнему разрезу';
// Допуск «сустав − skinIn»: воксели 0.3 мм дают шум по краям.
export const SKIN_TOL = 1;
const mm = (x) => (Math.round(x * 10) / 10).toFixed(1);
// «тут тонко: высота 7.8 мм, нужно от 9.3 — …» (не прошло Lt + 0.8 ≤ Hs или Re + g + 0.8 ≤ w; ширина — полная, 2w)
export function thinWhy(d) {
  const parts = [];
  if (!(d.Lt + 0.8 <= d.Hfree)) parts.push('высота ' + mm(Math.max(0, d.Hfree)) + ' мм, нужно от ' + mm(d.Lt + 0.8));
  if (!(d.Re + d.g + 0.8 <= d.w)) parts.push('ширина ' + mm(2 * d.w) + ' мм, нужно от ' + mm(2 * (d.Re + d.g + 0.8)));
  return 'тут тонко: ' + (parts.join('; ') || 'сустав не помещается') + ' — ' + THIN_TAIL;
}
// «сустав вылезает наружу сверху на 3.2 мм³»
export const outsideWhy = (v, where) => 'сустав вылезает наружу ' + where + ' на ' + mm(v) + ' мм³';
const WHY = {
  thin: 'тут тонко — ' + THIN_TAIL, outside: 'сустав вылезает наружу', weak: 'звено не держит — сдвинь разрез', near: NEAR_WHY,
  short: 'тут слишком близко к кончику — сдвинь ближе к телу',
  no_split: 'разрез не отделил кусок — сдвинь дальше от тела',
  child_split: 'звено развалилось у сустава — сдвинь разрез',
  two_parents: 'сустав отрезал кусок тела — сдвинь разрез',
  neighbour: 'сустав задевает соседнюю деталь — сдвинь разрез',
  hang: 'звено висит над столом — без поддержек не напечатать, сдвинь разрез',
  stiff: 'звено упирается раньше, чем повернётся до конца — сдвинь разрез',
};
export const whyOf = (code) => WHY[code] || 'тут не режется — сдвинь разрез';

/* Звенья: лапы и позвоночник. opts: + k (длина звена 0.8–1.6), kBody (звенья тела 0.4–1.0, по умолчанию 0.5).
   1. Лапы: разрез у основания каждой лапы (на выходе из тела) и дальше по лапе, если она толстая.
   2. Позвоночник (an.branches[0], от морды до кончика хвоста) — по всей длине, включая тело: от шеи с шагом
      max(La + Re + 2, k·2·w), внутри тела k = kBody. Разрез не ближе Rh + 3 мм к месту,
      где лапа выходит из тела (вдоль позвоночника) — лапа остаётся на своём звене (грудном, тазовом).
   Везде: разрез ближе Rh + 2 к бороздке переезжает в неё; звено ставится, только если сустав прячется внутри
   (jointDims → fits), иначе место попадает в thin; между кружками соседних суставов — не меньше CLEAR мм.
   Это предложения для кнопки «✨ Предложить» — сами разрезы ставит человек.
   Возвращает { cuts, thin, legs, small } (small — суставы помещаются не везде). Разрез: { P, n, w, Rh, chain, dist, auto, br, s, root, spine }, не больше 40.
   thin: [{ P, br }, …] — места, где сустав нужен, но не помещается. */
export function autoCuts(an, opts) {
  const limit = 40;
  const g = opts.g;
  const thin = [];
  const tooThin = (c) => {
    if (c.fit) return false;
    if (!thin.some((p) => Math.hypot(p.P[0] - c.P[0], p.P[1] - c.P[1]) < 3)) thin.push({ P: c.P.slice(), br: c.br });
    return true;
  };

  let reserved = [];
  const blocked = (c) => reserved.some((o) => !farEnough(o, c));
  let avoid = () => false; // для позвоночника: корни лап
  // ближайшая к c бороздка в окне Rh + 2, которая не ближе нужного к предыдущему разрезу
  const snap = (bi, c, prev, o) => {
    const br = an.branches[bi];
    const cand = branchGrooves(an, br)
      // на позвоночнике — не дальше 3 мм: тело короткое, между лапами каждый миллиметр на счету
      .filter((k) => Math.abs(br.cum[k] - c.s) < (br.spine ? Math.min(3, c.Rh + 2) : c.Rh + 2))
      .sort((a, b) => Math.abs(br.cum[a] - c.s) - Math.abs(br.cum[b] - c.s));
    for (const k of cand) {
      const q = cutAt(an, o, bi, k);
      if (prev && (br.cum[k] <= prev.s || !farEnough(q, prev))) continue;
      if (blocked(q) || avoid(q) || !q.fit) continue;
      if (!roomLeft(an, q, g) || !probeInside(an, q, g)) continue;
      return Object.assign(q, { groove: true });
    }
    return c;
  };

  // следующее звено цепочки после cur (или первое — с позиции target): шаг, соседи, бороздки, «помещается»
  const next = (bi, cur, target, o, slide = 6) => {
    const br = an.branches[bi];
    let c = null;
    for (let tries = 0; tries < 40; tries++) {
      const j = brAt(br, target);
      if (cur && br.cum[j] <= cur.s) break;
      const q = cutAt(an, o, bi, j);
      const gap = cur ? Math.hypot(q.P[0] - cur.P[0], q.P[1] - cur.P[1]) - (cur.Rh + q.Rh + CLEAR) : 0;
      if (gap >= 0 && !blocked(q) && !avoid(q)) { c = q; break; }
      if (j >= br.cum.length - 1) break;
      target += gap < 0 ? -gap + 0.5 : 1;
    }
    if (!c) return null;
    c = snap(bi, c, cur, o);
    if (!roomLeft(an, c, g) || !probeInside(an, c, g)) return null;
    // звено между cur и c и всё, что дальше c, должны касаться стола (у самого разреза низ звена вырезан
    // каналом петли — он уходит назад до ~3.2 мм, там не считается)
    const onTable = (q) => (!cur || touchesTable(an, br, cur.s, q.s - 4)) && touchesTable(an, br, q.s + 2, Infinity);
    if (!c.fit || !onTable(c)) {
      // тонкое место (бороздка, перехват) — поищем утолщение дальше: на лапе до 6 мм (дальше она только тоньше),
      // на позвоночнике до 30 мм (за тонким основанием хвоста бывает место); звено над столом — удлиним до 12 мм
      let alt = null;
      const far = c.fit ? Math.max(slide, 12) : slide;
      for (let dd = 1; dd <= far && !alt; dd++) {
        const q = cutAt(an, o, bi, brAt(br, c.s + dd));
        if (q.s > c.s && q.fit && onTable(q) && (!cur || farEnough(q, cur)) && !blocked(q) && !avoid(q) &&
          roomLeft(an, q, g) && probeInside(an, q, g)) alt = q;
      }
      if (!alt) { if (!c.fit) tooThin(c); return null; }
      c = alt;
    }
    return c;
  };
  const stepFrom = (bi, cur, o, k) => {
    const br = an.branches[bi];
    const kc = brAt(br, cur.s);
    const wc = brMaxDt(br, cur.s - 2, cur.s + 2);
    const dc = dimsHere(an, o, wc, br.pts[kc]);
    return cur.s + Math.max(dc.La + dc.Re + 2 + CLEAR, k * 2 * wc);
  };

  // 1. лапы (и прочие ветви, выходящие из тела не по позвоночнику)
  const spine = an.branches[0];
  const onSpine = (p) => spine && spine.spine && spine.pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.5);
  const legLists = new Map();
  const legExits = [];
  an.branches.forEach((br, bi) => {
    if ((bi === 0 && br.spine) || br.ex < 0 || onSpine(br.pts[br.ex])) return;
    legExits.push(br.pts[br.ex]);
    const list = [];
    let c = null;
    for (let d = 1; d <= 15 && !c; d += 1) {
      const i = brAt(br, br.cum[br.ex] + d);
      const q = cutAt(an, opts, bi, i);
      if (!blocked(q)) c = snap(bi, q, null, opts);
      if (i >= br.cum.length - 1) break;
    }
    if (c && roomLeft(an, c, g) && probeInside(an, c, g) && !tooThin(c) && touchesTable(an, br, c.s + 2, Infinity)) {
      c.root = true;
      list.push(c);
      for (;;) {
        const q = next(bi, list[list.length - 1], stepFrom(bi, list[list.length - 1], opts, opts.k || 1.2), opts);
        if (!q) break;
        list.push(q);
      }
    }
    legLists.set(bi, list);
  });

  // 2. позвоночник: от шеи до кончика хвоста, тело тоже
  let spineList = [];
  if (spine && spine.spine) {
    const br = spine, bi = 0;
    const oS = opts;
    const L = br.cum[br.cum.length - 1];
    // где лапы выходят из тела: разрез у основания (или выход ветви), спроецированный на позвоночник
    const legS = [];
    for (const list of legLists.values()) if (list.length) legExits.push(list[0].P);
    for (const p of legExits) {
      let kb = 0, bd = Infinity;
      br.pts.forEach((q, k) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; kb = k; } });
      if (!legS.some((x) => Math.abs(x - br.cum[kb]) < 2)) legS.push(br.cum[kb]);
    }
    reserved = [...legLists.values()].flat();
    an.legS = legS; // где лапы выходят из тела — для подсказки «сделай крупнее»
    avoid = (c) => legS.some((x) => Math.abs(c.s - x) < c.Rh + 3);
    // шея: голова — первый заметный максимум ширины от морды (наибольший в ±8 мм и не уже 60 % самого широкого),
    // тело — самое широкое место дальше; шея — самое узкое между ними
    let gmax = 0;
    for (let k = 0; k < br.pts.length; k++) gmax = Math.max(gmax, br.dt[k]);
    let kh = 0;
    for (let k = 0; k < br.pts.length && br.cum[k] < 0.5 * L; k++) {
      if (br.dt[k] < 0.6 * gmax) continue;
      let top = true;
      for (let j = 0; j < br.pts.length && top; j++) if (Math.abs(br.cum[j] - br.cum[k]) <= 8 && br.dt[j] > br.dt[k]) top = false;
      if (top) { kh = k; break; }
    }
    let kb2 = -1;
    for (let k = 0; k < br.pts.length; k++) if (br.cum[k] > br.cum[kh] + 5 && br.cum[k] <= 0.75 * L && (kb2 < 0 || br.dt[k] > br.dt[kb2])) kb2 = k;
    let kn = -1;
    for (let k = kh + 1; k < kb2; k++) if (kn < 0 || br.dt[k] < br.dt[kn]) kn = k;
    if (kn >= 0 && br.dt[kn] > 0.85 * Math.min(br.dt[kh], br.dt[kb2])) kn = -1;
    // первое звено — от шеи к хвосту, первое место, где сустав помещается и лапы не мешают
    const s0 = kn >= 0 ? br.cum[kn] : Math.min(10, 0.1 * L);
    let c = null;
    for (let sv = Math.max(0, s0 - 2); sv < L && !c; sv += 0.5) {
      const q = cutAt(an, oS, bi, brAt(br, sv));
      if (!q.fit || avoid(q) || blocked(q) || !roomLeft(an, q, g) || !probeInside(an, q, g)) continue;
      if (!touchesTable(an, br, 0, q.s - 4) || !touchesTable(an, br, q.s + 2, Infinity)) continue; // голова или хвост над столом
      const sn = snap(bi, q, null, oS);
      c = sn.fit && !avoid(sn) ? sn : q;
    }
    while (c && br.cum[brAt(br, c.s)] < L) {
      spineList.push(c);
      const kc = brAt(br, c.s);
      const q = next(bi, c, stepFrom(bi, c, oS, br.inBody[kc] ? (opts.kBody || 0.5) : (opts.k || 1.2)), oS, 30);
      c = q;
    }
    spineList.forEach((x) => { x.spine = true; });
  }

  // ветви одной развилки дают одни и те же разрезы: первая остаётся, у остальных совпадения отрезаются
  const lists = [];
  const taken = [];
  const close = (c) => taken.some((o) => !farEnough(o, c));
  let chainNo = 0;
  for (const list of [spineList, ...legLists.values()]) {
    const cut = list.findIndex(close);
    if (cut >= 0) list.length = cut;
    if (!list.length) continue;
    const chain = chainNo++;
    list.forEach((c) => { c.chain = chain; c.dist = c.s; c.auto = true; taken.push(c); });
    lists.push(list);
  }

  // по кругу: сначала первые разрезы всех цепочек, потом вторые… — лимит делится честно
  const cuts = [];
  for (let round = 0; cuts.length < limit; round++) {
    let any = false;
    for (const list of lists) {
      if (round >= list.length || cuts.length >= limit) continue;
      any = true;
      cuts.push(list[round]);
    }
    if (!any) break;
  }
  // сколько лап (ветвей, выходящих из тела не по позвоночнику; пальцы одной лапы — одна) и есть ли на них суставы
  const legs = [];
  an.branches.forEach((br, bi) => {
    if ((bi === 0 && br.spine) || br.ex < 0 || onSpine(br.pts[br.ex])) return;
    const e = br.pts[br.ex];
    let leg = legs.find((q) => Math.hypot(q.e[0] - e[0], q.e[1] - e[1]) < 6);
    if (!leg) legs.push(leg = { e, joints: 0 });
    leg.joints += cuts.filter((c) => c.br === bi).length;
  });
  // мелко: на хвосте (позвоночник за задними лапами) меньше 3 звеньев или на какой-то лапе нет сустава
  let small = legs.some((l) => !l.joints);
  if (spine && spine.spine && an.legS && an.legS.length) {
    const hip = Math.max(...an.legS), L = spine.cum[spine.cum.length - 1];
    const tail = cuts.filter((c) => c.spine && c.s > hip).length;
    if (L - hip > 25 && tail < 3) small = true;
  }
  return { cuts, thin, legs: legs.length, small };
}

/* ---------- Разрезы рукой ---------- */

/* Где можно резать: позвоночник целиком (если он есть) и лапы — от 3 мм внутри тела до кончика.
   from[bi] — первая точка ветви, где можно резать (−1 — нельзя: обрывки скелета внутри тела, концы позвоночника),
   chain[bi] — цепочка (позвоночник — 0, лапы — дальше; пальцы одной лапы — одна цепочка), legs — сколько лап. */
export function limbsOf(an) {
  if (an.limbs) return an.limbs;
  const B = an.branches, spine = B[0] && B[0].spine ? B[0] : null;
  const onSpine = (p) => spine && spine.pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.5);
  const from = new Int32Array(B.length).fill(-1), chain = new Int32Array(B.length).fill(-1);
  const exits = [];
  B.forEach((br, bi) => {
    if (bi === 0 && spine) { from[0] = 0; chain[0] = 0; return; }
    if (br.ex < 0 || onSpine(br.pts[br.ex])) return;
    const e = br.pts[br.ex];
    let li = exits.findIndex((q) => Math.hypot(q[0] - e[0], q[1] - e[1]) < 6);
    if (li < 0) { li = exits.length; exits.push(e); }
    chain[bi] = (spine ? 1 : 0) + li;
    from[bi] = brAt(br, br.cum[br.ex] - 3);
  });
  an.limbs = { from, chain, legs: exits.length, spine: !!spine };
  return an.limbs;
}

/* Разрез там, куда тапнули: ближайшая точка скелета на позвоночнике или лапе, поперёк ветви.
   bi — резать только по этой ветви (перетаскивание вдоль позвоночника), иначе — по ближайшей.
   snap — притянуть к ближайшей бороздке, если она не дальше 3 мм вдоль ветви.
   Тап мимо фигурки (дальше полутора полуширин от скелета) — null.
   Возвращает { P, n, w, br, s, Rh, fit, why, spine, chain, groove }: fit — сустав помещается по размерам
   (иначе why — «тут тонко: высота … нужно от …»); сжатая кожа и всё остальное — checkCut. */
export function placeCut(an, opts, x, y, bi = null, snap = true) {
  const L = limbsOf(an);
  let best = null;
  // ближе — лучше; на общем участке нескольких ветвей (лапа до развилки пальцев) — позвоночник, потом самая длинная
  const better = (b, d, rest) => {
    if (!best || d < best.d - 1e-9) return true;
    if (d > best.d + 1e-9) return false;
    const sp = L.spine && b === 0, bsp = L.spine && best.b === 0;
    return sp !== bsp ? sp : rest > best.rest;
  };
  const list = bi != null ? [bi] : an.branches.map((_, i) => i);
  for (const b of list) {
    const br = an.branches[b], k0 = L.from[b];
    if (!br || k0 < 0) continue;
    const end = br.cum[br.cum.length - 1];
    for (let k = k0; k < br.pts.length; k++) {
      const d = (br.pts[k][0] - x) ** 2 + (br.pts[k][1] - y) ** 2;
      if (better(b, d, end - br.cum[k])) best = { b, k, d, rest: end - br.cum[k] };
    }
  }
  if (!best) return null;
  const br = an.branches[best.b];
  if (bi == null && Math.sqrt(best.d) > Math.max(4, 1.5 * br.dt[best.k])) return null;
  let k = best.k, groove = false;
  if (snap) {
    let gk = -1;
    for (const j of branchGrooves(an, br)) {
      if (j < L.from[best.b] || Math.abs(br.cum[j] - br.cum[best.k]) > 3) continue;
      if (gk < 0 || Math.abs(br.cum[j] - br.cum[best.k]) < Math.abs(br.cum[gk] - br.cum[best.k])) gk = j;
    }
    if (gk >= 0) { k = gk; groove = true; }
  }
  const c = cutAt(an, opts, best.b, k);
  const spine = L.spine && best.b === 0;
  // fit — по размерам (высота и ширина); вылезает ли сустав из сжатой кожи — точно, в checkCut
  const d = jointAt(an, opts, c.w, c.P, c.n);
  return {
    P: c.P, n: c.n, w: c.w, br: best.b, s: c.s, Rh: d.Rh, fit: d.fits, why: d.fits ? '' : thinWhy(d),
    spine, chain: L.chain[best.b], root: false, groove,
  };
}

// Разрез ближе к телу на той же цепочке (позвоночник — ближе к морде, лапа — ближе к телу); onPath(P) — лежит ли
// точка на ветви разреза c (пальцы одной лапы — разные ветви с общим началом).
export function prevCut(cuts, c, onPath) {
  let best = null;
  for (const o of cuts) {
    if (o === c || o.chain !== c.chain || !(o.Rh > 0) || !(o.s < c.s) || (best && o.s <= best.s)) continue;
    if (o.br !== c.br && !onPath(o.P)) continue;
    best = o;
  }
  return best;
}

/* Полная проверка одного разреза — те же правила, что при сборке (сустав внутри тела с запасом от кожи,
   держит в 6 сторон, поворачивается на ±α, ничего не отрезал, звено не висит над столом). { ok, code, why }.
   prev — разрез ближе к телу на той же цепочке: модель сначала делится его V-вырезом, чтобы звено между ними
   было как при сборке (без него середина щупальца, оторванная от стола, не видна). */
export function checkCut(wasm, model, mesh, an, cut, opts, prev = null) {
  const d = jointAt(an, opts, cut.w, cut.P, cut.n);
  if (!d.fits) return { ok: false, code: 'thin', why: thinWhy(d) };
  return buildJoints(wasm, model, mesh, an, [Object.assign({}, cut, { id: 1 })], opts, null, prev ? Object.assign({}, prev, { id: 0 }) : true);
}

// Порядок сборки: сначала лапы (основания, потом дальние звенья), потом позвоночник от головы к хвосту.
export function orderCuts(cuts, skeleton) {
  const key = (c) => {
    let best = Infinity, d = 0;
    for (const s of skeleton) {
      const dd = (s.x - c.P[0]) ** 2 + (s.y - c.P[1]) ** 2;
      if (dd < best) { best = dd; d = s.dist; }
    }
    return d + Math.sqrt(best);
  };
  const rank = (c) => (c.spine ? 2e6 + (c.s || 0) : (c.root ? 0 : 1e6) + key(c));
  return cuts.map((c) => ({ c, k: rank(c) })).sort((a, b) => a.k - b.k).map((x) => x.c);
}

/* ---------- Геометрия ---------- */

export function verticalSpan(mesh, x, y) {
  const v = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
  let zb = Infinity, zt = -Infinity;
  for (let t = 0; t < tv.length; t += 3) {
    const a = tv[t] * np, b = tv[t + 1] * np, c = tv[t + 2] * np;
    const ax = v[a], ay = v[a + 1], bx = v[b], by = v[b + 1], cx = v[c], cy = v[c + 1];
    if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx)) continue;
    if ((y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const z = l1 * v[a + 2] + l2 * v[b + 2] + l3 * v[c + 2];
    if (z < zb) zb = z;
    if (z > zt) zt = z;
  }
  return zb <= zt ? { zb, zt } : null;
}

const SEG = 48;

/* Тела сустава «ушко в петле» в мировых координатах. Строим в локальных: ось — вертикаль через начало,
   +X = n (вперёд, к ребёнку), z = 0 — низ сустава (d.z0). Потом поворот к n и сдвиг в P.
   Ребёнку: loop — стойка ⌀ dp на оси, перекладины снизу и сверху (ta по высоте, bw поперёк), передняя стойка
   уходит в тело ребёнка на 2 мм. Родителю: ring — плоское кольцо (стенка be) вокруг стойки на высоте ez0…ez1;
   eyeNeck — его шейка назад, к телу родителя (обрезается по коже и по телу родителя — только как страховка).
   Очистки: fan — канал петли в родителе (±(α + 3°)), eyeClear — место ушка в ребёнке. notch — V-вырез.
   Петля и кольцо по коже НЕ обрезаются: сустав ставится только туда, где он целиком внутри (см. buildJoints). */
export function jointBodies(wasm, d, P, n, skin) {
  const { Manifold } = wasm;
  const { dp, ta, bw, g, La, Lt, hi, Re, ez0, ez1, Rs, z0 } = d;
  const tmp = [];
  const T = (m) => { tmp.push(m); return m; };
  const box = (x0, x1, hy, za, zb) => T(T(Manifold.cube([x1 - x0, 2 * hy, zb - za])).translate([x0, -hy, za]));
  const cyl = (r, za, zb) => T(T(Manifold.cylinder(zb - za, r, r, SEG)).translate([0, 0, za]));
  const tall = (r) => cyl(r, -50, 200);

  // петля ребёнка: стойка, перекладины снизу и сверху, передняя стойка
  const loop = Manifold.union([cyl(dp / 2, 0, Lt), box(0, La, bw / 2, 0, ta), box(0, La, bw / 2, ta + hi, Lt), box(La - ta, La + 2, bw / 2, 0, Lt)]);
  // ушко родителя
  const ring = cyl(Re, ez0, ez1).subtract(cyl(dp / 2 + g, ez0 - 1, ez1 + 1));
  const eyeNeck = box(-(Rs + 1), -(dp / 2 + g), Re, ez0, ez1).translate([0, 0, 0]);
  // канал петли в родителе: петля поворачивается на ±α, с запасом 3°
  const fb = box(-(dp / 2 + g), La + g, bw / 2 + g, -1, Lt + g);
  const fa = (d.alpha + 3);
  const fan = Manifold.hull([T(fb.rotate([0, 0, -fa])), T(fb.rotate([0, 0, fa]))]);
  // место ушка в ребёнке: ушко круглое вокруг оси — поворот его не задевает
  const eyeClear = cyl(Re + g, ez0 - g, ez1 + g).translate([0, 0, 0]);

  // V-вырез: родитель оставляет |φ| ≥ 90°+β, ребёнок |φ| ≤ 90°−β, каждый отступает на g/2
  const beta = (d.alpha / 2) * DEG;
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const zone = tall(Rs);
  const keepChild = T(T(zone.trimByPlane([cb, -sb, 0], g / 2)).trimByPlane([cb, sb, 0], g / 2));
  const keepParent = T(T(zone.trimByPlane([-cb, -sb, 0], g / 2)).trimByPlane([-cb, sb, 0], g / 2));
  const notch = T(zone.subtract(keepParent)).subtract(keepChild);

  const deg = Math.atan2(n[1], n[0]) / DEG;
  const place = (m, lift = true) => {
    const r = m.rotate([0, 0, deg]);
    const t = r.translate([P[0], P[1], lift ? z0 : 0]);
    r.delete();
    m.delete();
    return t;
  };
  const out = {
    loop: place(loop), ring: place(ring), eyeNeck: place(eyeNeck), fan: place(fan),
    eyeClear: place(eyeClear), notch: place(notch, false),
  };
  tmp.forEach((m) => m.delete());
  if (skin) {
    // страховка: шейка ушка уходит назад на Rs + 1 — по коже (сзади тело может сужаться)
    const L = Rs + 2;
    const cube = Manifold.cube([2 * L, 2 * L, 2000]);
    const bx = cube.translate([P[0] - L, P[1] - L, -1000]);
    cube.delete();
    const local = skin.intersect(bx);
    bx.delete();
    const m = out.eyeNeck.intersect(local);
    out.eyeNeck.delete();
    out.eyeNeck = m;
    local.delete();
  }
  return out;
}

/* Объём сустава (петля ∪ кольцо; шейку не считаем — она обрезается по коже) вне skinIn — кожи, сжатой внутрь
   на 0.8 мм, без щели разреза (|x| < GAP вдоль n). { v, where }: where — где вылезает больше всего («сверху» —
   выше верхней перекладины снизу, «снизу» — ниже верха нижней, иначе «сбоку»); считается, только если d передан
   и v ≥ SKIN_TOL. */
export function jointOutside(wasm, B, P, n, L, skinIn, d) {
  const { Manifold } = wasm;
  const cube = Manifold.cube([2 * L, 2 * L, 2000]);
  const bx = cube.translate([P[0] - L, P[1] - L, -1000]);
  cube.delete();
  const local = skinIn.intersect(bx);
  bx.delete();
  const slab0 = Manifold.cube([2 * GAP, 4 * L, 4000]);
  const slab1 = slab0.translate([-GAP, -2 * L, -2000]);
  const slab2 = slab1.rotate([0, 0, Math.atan2(n[1], n[0]) / DEG]);
  const slab = slab2.translate([P[0], P[1], 0]);
  [slab0, slab1, slab2].forEach((m) => m.delete());
  const j0 = B.loop.add(B.ring);
  const j = j0.subtract(slab);
  const o = j.subtract(local);
  [j0, slab].forEach((m) => m.delete());
  const v = Math.max(0, o.volume());
  let where = 'сбоку';
  if (d && v >= SKIN_TOL) {
    const up = o.trimByPlane([0, 0, 1], d.z0 + d.Lt - d.ta), dn = o.trimByPlane([0, 0, -1], -(d.z0 + d.ta));
    const vu = up.volume(), vd = dn.volume(), vs = v - vu - vd;
    where = vu >= vs && vu >= vd ? 'сверху' : vd > vs ? 'снизу' : 'сбоку';
    up.delete();
    dn.delete();
  }
  [local, j, o].forEach((m) => m.delete());
  return { v, where };
}

function probe(wasm, m, x, y, z) {
  const c = wasm.Manifold.cube([0.2, 0.2, 0.2], true);
  const t = c.translate([x, y, z]);
  c.delete();
  const i = m.intersect(t);
  t.delete();
  const v = i.volume();
  i.delete();
  return v > 0;
}

function bigCount(m) {
  const all = m.decompose();
  const n = all.filter((p) => p.volume() >= MIN_VOL).length;
  all.forEach((p) => p.delete());
  return n;
}

// Без крошек: куски < 20 мм³ выбрасываются. Внутренние пустоты (отрицательный объём) остаются — кольцо может
// замкнуть с телом карман щели, и заливать его нельзя: он вне кожи.
function solidParts(wasm, m) {
  const all = m.decompose();
  if (all.length === 1) { all[0].delete(); return m.translate([0, 0, 0]); }
  const keep = all.filter((p) => { const v = p.volume(); return v >= MIN_VOL || v < 0; });
  const out = keep.length ? wasm.Manifold.compose(keep) : m.translate([0, 0, 0]);
  all.forEach((p) => p.delete());
  return out;
}

function bigParts(m) {
  const all = m.decompose();
  const keep = [];
  all.forEach((p) => { if (p.volume() >= MIN_VOL) keep.push(p); else p.delete(); });
  return keep;
}

const unionAll = (wasm, list) => (list.length === 1 ? list[0].translate([0, 0, 0]) : wasm.Manifold.union(list));

/* ---------- Сборка суставов ---------- */

/* cuts: [{ id, P, n, w, chain, br?, s?, spine? }] — в порядке сборки (orderCuts). opts — как в jointDims.
   Разрезы ставит человек; разрез, который не режется, ничего не меняет и даёт красную ошибку с короткой причиной
   (notes[].why) — ничего не сдвигается и не пропускается молча.
   Возвращает { parts:[{manifold, joint}], joints:[…], notes:[{id, level:'error'|'warn', text, why}], redIds, summary, num }.
   Manifold-ы деталей вызывающий удаляет сам.
   checkOnly — проверить один разрез на целой модели: { ok, code, why }, детали удаляются здесь; если это разрез
   (соседний, ближе к телу), модель сначала делится его V-вырезом. */
export function buildJoints(wasm, model, mesh, an, cuts, opts, onProgress, checkOnly = false) {
  const skin = model; // цельная модель после починки и среза низа — её не режем, только обрезаем по ней сустав
  const pieces = [{ m: model.translate([0, 0, 0]), joint: -1, n: Math.max(1, bigCount(model)) }];
  const joints = [];
  const notes = [];
  const red = new Set();
  const num = {};
  const say = (id, level, text, why) => {
    notes.push({ id, level, text, why: why || text });
    if (id != null) red.add(id);
  };
  const g = opts.g;
  const fail = (code, text) => { throw new FlexiError(code, text || whyOf(code)); };
  const dimsOf = (c) => jointAt(an, opts, c.w, c.P, c.n);
  const inter = (a, b) => { const x = a.intersect(b); const v = x.volume(); x.delete(); return v; };
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // свободные направления: сдвиг ребёнка на 1 мм не задевает родителя
  const freeDirs = (child, parent) => DIRS.map((v, i) => {
    const m = child.translate(v);
    const free = inter(m, parent) <= 0.05;
    m.delete();
    return free ? ['+X', '−X', '+Y', '−Y', '+Z', '−Z'][i] : null;
  }).filter(Boolean);

  // Один разрез. Удачно — детали заменены; иначе FlexiError, детали не тронуты.
  const attempt = (cut) => {
    const P = cut.P, n = cut.n;
    const d = dimsOf(cut);
    if (!d.fits) fail('thin', thinWhy(d));

    // 1. соседи
    const near = joints.find((J) => Math.hypot(J.P[0] - P[0], J.P[1] - P[1]) < sepMin(J.Rh, d.Rh, g) - 0.01);
    if (near) fail('near');
    // 2. проба ребёнка
    // за кольцом, на ветви; если точка попала в прорезь бороздки — чуть дальше или на другой высоте
    let qc = null, qz = 0, pi = -1;
    for (const ahead of [1.5, 2.5, 3.5, 1]) {
      const q = [P[0] + n[0] * (d.Rh + g + ahead), P[1] + n[1] * (d.Rh + g + ahead)];
      const span = verticalSpan(mesh, q[0], q[1]);
      if (!span) continue;
      for (const f of [0.5, 0.3, 0.7]) {
        const z = span.zb + (span.zt - span.zb) * f;
        const i = pieces.findIndex((p) => probe(wasm, p.m, q[0], q[1], z));
        if (i >= 0) { qc = q; qz = z; pi = i; break; }
      }
      if (pi >= 0) break;
    }
    // 3. деталь
    if (pi < 0) fail('short');
    const piece = pieces[pi];
    const B = jointBodies(wasm, d, P, n, skin);
    const made = [];
    const keep = (m) => { made.push(m); return m; };
    let outIn = 0;
    try {
      // 3½. сустав целиком внутри тела: петля и кольцо — в коже, сжатой на 0.8 мм (шейка обрезана по коже)
      if (an.skinIn) {
        const o = jointOutside(wasm, B, P, n, Math.max(d.La + 3, d.Re + d.g + 2), an.skinIn, d);
        outIn = o.v;
        if (o.v >= SKIN_TOL) fail('outside', outsideWhy(o.v, o.where));
      }
      // 4. отделяем лапу V-вырезом вокруг оси
      const a2 = keep(piece.m.subtract(B.notch));
      const comps = bigParts(a2); made.push(...comps);
      const ci = comps.findIndex((m) => probe(wasm, m, qc[0], qc[1], qz));
      const others = comps.filter((_, i) => i !== ci);
      if (ci < 0 || others.length === 0) fail('no_split');
      // «отрезал кусок» проверяем ниже, после кольца: оно может снова пришить щепку у сустава к телу

      // 5. ребёнок: лапа без места под ушко + петля
      const c1 = keep(comps[ci].subtract(B.eyeClear));
      const c2 = keep(c1.add(B.loop));
      const cParts = bigParts(c2); made.push(...cParts);
      // щупаем переднюю стойку петли (она сращена с телом ребёнка)
      const fx = d.La - d.ta / 2;
      const ki = cParts.findIndex((m) => probe(wasm, m, P[0] + n[0] * fx, P[1] + n[1] * fx, d.z0 + d.Lt / 2));
      if (ki < 0 || cParts.length > 1) fail('child_split');

      // 6. родитель: тело без канала петли (до ушка!) + ушко (крошки от канала — в мусор)
      const p0 = keep(unionAll(wasm, others));
      const p1 = keep(p0.subtract(B.fan));
      const pParts = bigParts(p1); made.push(...pParts);
      if (!pParts.length) fail('two_parents');
      const p2 = keep(unionAll(wasm, pParts));

      // 7. соседние детали — освобождаем место под сустав
      const changed = [];
      for (let qi = 0; qi < pieces.length; qi++) {
        if (qi === pi) continue;
        const bb = pieces[qi].m.boundingBox();
        const dx = Math.max(bb.min[0] - P[0], 0, P[0] - bb.max[0]);
        const dy = Math.max(bb.min[1] - P[1], 0, P[1] - bb.max[1]);
        if (Math.hypot(dx, dy) > d.Rh + g) continue;
        const q1 = keep(pieces[qi].m.subtract(B.eyeClear));
        const q2 = keep(q1.subtract(B.fan));
        const qs = bigParts(q2); made.push(...qs);
        if (qs.length > pieces[qi].n || !qs.length) fail('neighbour');
        changed.push({ qi, m: keep(unionAll(wasm, qs)) });
      }

      // 8. ушко: кольцо + шейка, обрезанная по телу родителя (дальше назад, за прошлый сустав, ей нельзя)
      const neck = keep(B.eyeNeck.intersect(p2));
      const eye = keep(B.ring.add(neck));
      const parentM = keep(solidParts(wasm, keep(p2.add(eye))));
      // «отрезал кусок» — только если у родителя кусков стало больше, чем было у детали до разреза
      const pn = bigCount(parentM);
      if (pn > piece.n && pParts.length > piece.n) fail('two_parents');
      if (pn > piece.n) fail('weak'); // ушко отвалилось
      // звено, которое не касается стола, без поддержек не напечатать (кончик щупальца в воздухе)
      if (cParts[ki].boundingBox().min[2] > HANG) fail('hang');
      // и родитель не должен оторваться от стола (средний кусок щупальца)
      if (parentM.boundingBox().min[2] > HANG && piece.m.boundingBox().min[2] <= HANG) fail('hang');
      // держит в 6 сторон — быстро и по месту: петля против ушка (держат они — держит и деталь целиком)
      if (freeDirs(B.loop, eye).length) fail('weak');
      // и поворачивается на ±α: щель модели рядом с суставом может оставить родителю щепку перед P
      const L = d.Rs + 1;
      const cube = keep(wasm.Manifold.cube([2 * L, 2 * L, 2000]));
      const box = keep(cube.translate([P[0] - L, P[1] - L, -1000]));
      const cl = keep(cParts[ki].intersect(box)), pl = keep(parentM.intersect(box));
      for (const sg of [-1, 1]) {
        const r1 = keep(cl.translate([-P[0], -P[1], 0]));
        const r2 = keep(r1.rotate([0, 0, sg * d.alpha]));
        const r3 = keep(r2.translate([P[0], P[1], 0]));
        if (inter(r3, pl) > 0.5) fail('stiff');
      }

      // 9. всё получилось — заменяем детали
      const child = cParts[ki].translate([0, 0, 0]);
      made.splice(made.indexOf(parentM), 1);
      changed.forEach(({ qi, m }) => { made.splice(made.indexOf(m), 1); pieces[qi].m.delete(); pieces[qi].m = m; });
      const jointIdx = joints.length;
      joints.push({
        id: cut.id, P: P.slice(), n: n.slice(), Rh: d.Rh, dp: d.dp, Re: d.Re, alpha: d.alpha, H: d.H, outIn,
        dims: Object.assign({}, d), // все размеры сустава — для проверок и экрана
        zEye: d.z0 + (d.ez0 + d.ez1) / 2,
        parent: piece.joint, chain: cut.chain == null ? -1 : cut.chain, spine: !!cut.spine, s: cut.s,
      });
      piece.m.delete();
      pieces.splice(pi, 1, { m: parentM, joint: piece.joint, n: pn }, { m: child, joint: jointIdx, n: 1 });
      // разрез позвоночника делит тело, на котором уже держатся лапы: кольцо лапы могло уйти в новую половину —
      // тогда её родитель теперь новое звено (щупаем кольцо ушка позади оси)
      for (let ji = 0; ji < jointIdx; ji++) {
        const J = joints[ji];
        if (J.parent !== piece.joint) continue;
        const rr = (J.dp / 2 + g + J.Re) / 2;
        const Q = [J.P[0] - J.n[0] * rr, J.P[1] - J.n[1] * rr];
        if (probe(wasm, child, Q[0], Q[1], J.zEye)) J.parent = jointIdx;
      }
    } finally {
      made.forEach((m) => { try { m.delete(); } catch (e) { /* уже */ } });
      Object.values(B).forEach((m) => m.delete());
    }
  };

  // проверка с соседом ближе к телу: модель — уже на две части по его V-вырезу
  if (checkOnly && checkOnly.P) {
    const pb = jointBodies(wasm, dimsOf(checkOnly), checkOnly.P, checkOnly.n);
    const cutM = model.subtract(pb.notch);
    Object.values(pb).forEach((m) => m.delete());
    const halves = bigParts(cutM);
    cutM.delete();
    if (halves.length > 1) {
      pieces.forEach((p) => p.m.delete());
      pieces.splice(0, pieces.length, ...halves.map((m) => ({ m, joint: -1, n: 1 })));
    } else halves.forEach((m) => m.delete());
  }
  let first = null; // checkOnly: первая неудача
  cuts.forEach((cut, k) => {
    if (onProgress) onProgress('cut', k + 1, cuts.length);
    try {
      attempt(cut);
    } catch (e) {
      const code = e instanceof FlexiError ? e.code : 'failed';
      const why = e instanceof FlexiError ? e.message : 'не получилось — ' + ((e && e.message) || e);
      if (!first) first = { code, why };
      say(cut.id, 'error', 'Разрез #{' + cut.id + '}: ' + why, why);
    }
  });
  if (checkOnly) {
    pieces.forEach((p) => p.m.delete());
    return first ? { ok: false, code: first.code, why: first.why } : { ok: true, code: '', why: '' };
  }
  // номера — по порядку сборки (как на экране)
  let no = 0;
  cuts.forEach((c) => { num[c.id] = ++no; });
  notes.forEach((x) => { x.text = x.text.replace(/#\{([^}]+)\}/g, (_, id) => num[id] || '?'); });

  // 5. автопроверка
  if (onProgress) onProgress('check', 0, joints.length);
  const parts = pieces.map((p) => ({ manifold: p.m, joint: p.joint, n: p.n }));
  const partOf = (j) => parts.find((p) => p.joint === j);
  let holdBad = 0;
  joints.forEach((J, j) => {
    if (onProgress) onProgress('check', j + 1, joints.length);
    const child = partOf(j).manifold, parent = partOf(J.parent).manifold;
    const N = num[J.id];
    // держит во все 6 сторон
    const free = freeDirs(child, parent);
    J.hold = free.length === 0;
    if (!J.hold) {
      holdBad++;
      say(J.id, 'error', 'Разрез ' + N + ': звено не держит (свободно: ' + free.join(', ') + ')', 'звено не держит — сдвинь разрез');
    }
    // не слипся
    const touch = inter(child, parent);
    const gap = child.minGap(parent, 2 * g);
    J.gap = gap;
    if (touch > 1e-6 || gap < 0.9 * g) say(J.id, 'error', 'Разрез ' + N + ': звено слиплось (зазор ' + gap.toFixed(2) + ' мм)', 'звено слиплось с соседом — сдвинь разрез');
    // поворот
    let worst = 0;
    for (const s of [-1, 1]) {
      const a = child.translate([-J.P[0], -J.P[1], 0]);
      const b = a.rotate([0, 0, s * J.alpha]);
      const r = b.translate([J.P[0], J.P[1], 0]);
      worst = Math.max(worst, inter(r, parent));
      [a, b, r].forEach((m) => m.delete());
    }
    J.turn = worst;
    if (worst > 0.5) notes.push({ id: J.id, level: 'warn', text: 'Разрез ' + N + ': звено упирается раньше ±' + Math.round(J.alpha) + '°' });
  });
  parts.forEach((p, i) => {
    const m = p.manifold;
    const comps = m.decompose();
    const ok = comps.filter((c) => c.volume() > 0).length <= p.n; // пустоты внутри — не куски
    comps.forEach((c) => c.delete());
    const vol = m.volume();
    if (!ok || vol < MIN_VOL) say(null, 'error', 'Деталь ' + (i + 1) + ' развалилась на куски');
    if (m.boundingBox().min[2] > HANG) notes.push({ id: null, level: 'warn', text: 'Деталь ' + (i + 1) + ' висит над столом' });
  });

  const errors = notes.filter((x) => x.level === 'error');
  const summary = errors.length
    ? errors.length + ' ' + plural(errors.length, 'проблема', 'проблемы', 'проблем')
    : '✅ ' + joints.length + ' ' + plural(joints.length, 'звено', 'звена', 'звеньев') + ', все держат';
  return { parts, joints, notes, redIds: Array.from(red), summary, num };
}

function plural(n, one, few, many) {
  const n100 = Math.abs(n) % 100, n10 = n100 % 10;
  if (n100 > 10 && n100 < 20) return many;
  if (n10 > 1 && n10 < 5) return few;
  if (n10 === 1) return one;
  return many;
}

export function meshOf(m) {
  return getMeshArrays(m);
}
