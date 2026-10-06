/* Грава — сборщик шарниров «⛓ Цепочка»: фигурка печатается сразу подвижной (print-in-place).
   Каждая ветвь режется на цепочку звеньев; сустав — отдельная добавленная деталь: «кулак» в «кольце».
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
  const head = 'Grava flexi (print-in-place)';
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
      }
    }
  }
  return { mask, top };
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
   Возвращает { manifold, parts, grid, filled } — filled: заполненные воксели после закрытия и заливки (по ним ищутся бороздки). */
export function repairModel(wasm, model, v = 0.3, onStage) {
  const { Manifold } = wasm;
  const stage = (name) => { if (onStage) onStage(name); };
  // большая фигурка — воксель крупнее, чтобы сетка не превышала ~8 млн (память и время на телефоне)
  const bb = model.boundingBox();
  const box = (bb.max[0] - bb.min[0] + 2) * (bb.max[1] - bb.min[1] + 2) * (bb.max[2] - bb.min[2] + 2);
  v = Math.max(v, Math.cbrt(box / 8e6));
  const g = voxelize(getMeshArrays(model), v);
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
  // кулака, кольца и кожи остаются плёнки толщиной с допуск
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
  return { manifold, parts: big.length, grid: g, filled };
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

  const { mask, top } = rasterize(mesh, grid);
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
    return { pts, cum, dt: Float32Array.from(path, (i) => dt[i]), ex };
  }).sort((a, b) => b.cum[b.cum.length - 1] - a.cum[a.cum.length - 1]);

  // картинка высот для экрана: 0 — фон, 40…255 — высота
  let zMax = 0;
  for (let i = 0; i < N; i++) if (mask[i] && top[i] > zMax) zMax = top[i];
  const heights = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const z = top[i] > -INF ? top[i] : 0;
    heights[i] = 40 + Math.round(215 * Math.max(0, Math.min(1, z / (zMax || 1))));
  }

  return { grid, heights, top, zMax, skeleton, branches, core: P(core), coreW, rb };
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

// Низкий верх кожи в кольце r0…r1 вокруг точки: 15-й процентиль карты высот (щель в бороздке — 0).
export function zlowAt(an, x, y, r0, r1) {
  const { x0, y0, step, W, H } = an.grid;
  const cx = (x - x0) / step - 0.5, cy = (y - y0) / step - 0.5, a = r0 / step, b = r1 / step;
  const zs = [];
  for (let py = Math.max(0, Math.floor(cy - b)); py <= Math.min(H - 1, Math.ceil(cy + b)); py++) {
    for (let px = Math.max(0, Math.floor(cx - b)); px <= Math.min(W - 1, Math.ceil(cx + b)); px++) {
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 > b * b || d2 < a * a) continue;
      const t = an.top[py * W + px];
      zs.push(t > 0 ? t : 0);
    }
  }
  if (!zs.length) return 0;
  zs.sort((p, q) => p - q);
  return zs[Math.floor(zs.length * 0.15)];
}

/* ---------- Размеры сустава ---------- */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Минимальный радиус кулака: проём кольца должен быть уже кулака.
export function rMin(alphaDeg, wn, g) {
  const a = alphaDeg * DEG;
  return (0.6 + (wn + g) * Math.cos(a) + g * Math.sin(a)) / (1 - Math.sin(a));
}

/* Сустав звена. opts: { g — зазор, alphaSeg — поворот на звено, ° }.
   w — полуширина ветви в месте разреза, ztop — верх кожи над суставом, zlip — низкий верх кожи над губой кольца
   (см. jointAt). Кулак и кольцо — на всю высоту фигурки H (сверху не остаётся ямы), лишнее срезается по коже.
   Верхняя губа кольца (над фаской кулака) — на высоте Hl, ниже кожи: на круглой спине обрезка её не съест.
   Выше Hl кулак продолжается столбиком радиуса R − c до самого верха. Все размеры в мм, alpha — в градусах. */
export function jointDims(opts, w, ztop, zlip = ztop, wOut = w) {
  const g = opts.g;
  const alpha = opts.alphaSeg;
  const H = Math.max(6, ztop);
  const c = Math.min(1.5, H / 4);
  const Hl = clamp(zlip - 1.2, 2 * c + 1.5, H);
  const gc = 1.42 * g;
  const t = 1.6;
  // шейка 0.3·w (1.2…2 мм); в тесном месте — тоньше, чтобы кулак и кольцо поместились внутри: Rh ≤ w − 0.4
  let wn = clamp(0.3 * w, 1.2, 2.0);
  while (wn > 1.2 && rMin(alpha, wn, g) + g + t > w - 0.4) wn = Math.max(1.2, wn - 0.1);
  const R = Math.max(rMin(alpha, wn, g), Math.min(w - g - t - 0.6, 6));
  const Rh = R + g + t;
  return {
    g, w, R, wn, H, Hl, c, gc, t, Rh, b: R - c + gc, alpha,
    // не дальше w + 6: широкий вырез у ядра прорезал бы кольца соседних суставов
    Rs: Math.max(Rh + g + 0.5, w + 2, Math.min(wOut + 1.5, w + 6)),
  };
}

// Размеры сустава в точке P: H — максимальная высота кожи в круге Rh + g (+0.3 мм на шаг карты высот),
// губа кольца — под кожей над кольцом R − c … R + g. V-вырез — до края силуэта поперёк ветви (n — направление
// разреза): в бороздке ветвь уже, а рядом шире; недорезанный бок упрётся при повороте.
export function jointAt(an, opts, w, P, n) {
  const d0 = jointDims(opts, w, 0);
  const H = ztopAt(an, P[0], P[1], d0.Rh + opts.g) + 0.3;
  let wOut = w;
  if (n) {
    const { x0, y0, step, W, H: GH } = an.grid;
    const inside = (x, y) => {
      const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
      return px >= 0 && py >= 0 && px < W && py < GH && an.heights[py * W + px] > 0;
    };
    const b = (opts.alphaSeg / 2) * DEG;
    for (const sg of [1, -1]) {
      for (const db of [-b, 0, b]) {
        const a = Math.atan2(n[1], n[0]) + sg * Math.PI / 2 + db;
        let r = 0;
        while (r < 60 && inside(P[0] + Math.cos(a) * (r + step), P[1] + Math.sin(a) * (r + step))) r += step;
        if (r > wOut) wOut = r;
      }
    }
  }
  return jointDims(opts, w, H, zlowAt(an, P[0], P[1], d0.R - d0.c, d0.R + opts.g), wOut);
}

// Сустав прячется внутри фигурки, только если кольцо уже ветви: Rh ≤ w − 0.4.
export const jointFits = (Rh, w) => Rh <= w - 0.4;

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
  const d = jointDims(opts, w, ztopAt(an, P[0], P[1]));
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
  return { P, n, w, br: bi, s: br.cum[k], Rh: d.Rh };
}

// Проба ребёнка (как при сборке) должна попасть в силуэт, иначе сустав не встанет.
function probeInside(an, c, g) {
  const x = c.P[0] + c.n[0] * (c.Rh + g + 1.5), y = c.P[1] + c.n[1] * (c.Rh + g + 1.5);
  const { x0, y0, step, W, H } = an.grid;
  const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
  return px >= 0 && py >= 0 && px < W && py < H && an.heights[py * W + px] > 0;
}

// До конца ветви должно остаться больше Rh + g + 4.
const roomLeft = (an, c, g) => {
  const br = an.branches[c.br];
  return br.cum[br.cum.length - 1] - c.s > c.Rh + g + 4;
};
// Соседние суставы: кольца не ближе 0.2 мм. Если кольцо заходит в зону зазора (Rh + g) соседа, сборщик
// срезает с его переднего края тонкую шапочку — зазор между деталями всё равно остаётся g (проверяется в конце).
export const sepMin = (Ra, Rb) => Ra + Rb + 0.2;
const farEnough = (a, b, g) => Math.hypot(a.P[0] - b.P[0], a.P[1] - b.P[1]) >= sepMin(a.Rh, b.Rh, g);

/* Каждая ветвь — цепочка звеньев. opts: + k (длина звена 0.8–1.6).
   Разрезы ложатся в бороздки модели (если есть): разрез ближе Rh + 2 к бороздке переезжает в неё.
   На самой длинной ветви (хребет) бороздки режутся и внутри тела.
   Звено ставится, только если сустав прячется внутри ветви (Rh ≤ w − 0.4); дальше ветвь остаётся цельной
   с соседним звеном, а место попадает в thin — серые точки на экране.
   Возвращает { cuts, thin }. Разрез: { P:[x,y], n:[nx,ny], w, chain, dist, auto, br, s, root }, не больше 40.
   thin: [[x, y], …]. */
export function autoCuts(an, opts) {
  const limit = 40;
  const g = opts.g;
  const thin = [];
  const tooThin = (c) => {
    if (jointFits(c.Rh, c.w)) return false;
    if (!thin.some((p) => Math.hypot(p[0] - c.P[0], p[1] - c.P[1]) < 3)) thin.push(c.P.slice());
    return true;
  };

  // ближайшая к d бороздка в окне Rh + 2, которая не ближе нужного к предыдущему разрезу
  let reserved = [];
  const blocked = (c) => reserved.some((o) => !farEnough(o, c, g));
  const snap = (bi, c, prev) => {
    const br = an.branches[bi];
    const cand = branchGrooves(an, br)
      .filter((k) => Math.abs(br.cum[k] - c.s) < c.Rh + 2)
      .sort((a, b) => Math.abs(br.cum[a] - c.s) - Math.abs(br.cum[b] - c.s));
    for (const k of cand) {
      const q = cutAt(an, opts, bi, k);
      if (prev && (br.cum[k] <= prev.s || !farEnough(q, prev, g))) continue;
      if (blocked(q) || !jointFits(q.Rh, q.w)) continue;
      if (!roomLeft(an, q, g) || !probeInside(an, q, g)) continue;
      return Object.assign(q, { groove: true });
    }
    return c;
  };

  const chainOf = (bi) => {
    const br = an.branches[bi];
    const list = [];
    // хребет: бороздки внутри тела — тоже звенья; если бороздка прорезана почти насквозь и сустав в ней
    // не держит, сборщик сдвинет его — поэтому в кандидатах и середины между соседними бороздками
    if (bi === 0) {
      const gr = branchGrooves(an, br);
      const cand = [];
      gr.forEach((k, i) => {
        cand.push(k);
        if (i + 1 < gr.length) cand.push(brAt(br, (br.cum[k] + br.cum[gr[i + 1]]) / 2));
      });
      for (const k of cand) {
        if (k >= br.ex) break;
        const c = cutAt(an, opts, bi, k);
        if (br.cum[k] < c.Rh + g + 4) continue; // родителю (голове) нужно место
        const prev = list[list.length - 1];
        if ((prev && !farEnough(c, prev, g)) || blocked(c) || !jointFits(c.Rh, c.w)) continue;
        if (!roomLeft(an, c, g) || !probeInside(an, c, g)) continue;
        list.push(Object.assign(c, { groove: true, root: true }));
      }
    }
    // первый разрез — на выходе из тела (занято хребтом — чуть дальше по ветви)
    if (!list.length) {
      let first = null;
      for (let d = 1; d <= 15 && !first; d += 1) {
        const i = brAt(br, br.cum[br.ex] + d);
        const q = cutAt(an, opts, bi, i);
        if (!blocked(q)) first = snap(bi, q, null);
        if (i >= br.cum.length - 1) break;
      }
      if (!first || !roomLeft(an, first, g) || !probeInside(an, first, g)) return list;
      if (tooThin(first)) return list;
      first.root = true;
      list.push(first);
    }

    // дальше звенья с шагом max(2·Rh + 2, k·2·w), пока до конца больше Rh + g + 4
    for (;;) {
      const cur = list[list.length - 1];
      const kc = brAt(br, cur.s);
      const wc = brMaxDt(br, cur.s - 2, cur.s + 2);
      const dc = jointDims(opts, wc, ztopAt(an, br.pts[kc][0], br.pts[kc][1]));
      let target = cur.s + Math.max(2 * dc.Rh + 2, (opts.k || 1.2) * 2 * wc);
      let c = null;
      // соседние звенья не ближе sepMin — по прямой, а не по пиксельному пути скелета
      for (let tries = 0; tries < 12; tries++) {
        const j = brAt(br, target);
        if (br.cum[j] <= cur.s) break;
        const q = cutAt(an, opts, bi, j);
        const gap = Math.hypot(q.P[0] - cur.P[0], q.P[1] - cur.P[1]) - sepMin(cur.Rh, q.Rh, g);
        if (gap >= 0 && !blocked(q)) { c = q; break; }
        if (j >= br.cum.length - 1) break;
        target += gap < 0 ? -gap + 0.5 : 1;
      }
      if (!c) break;
      c = snap(bi, c, cur);
      if (!roomLeft(an, c, g) || !probeInside(an, c, g)) break;
      if (!jointFits(c.Rh, c.w)) {
        // тонкое место (бороздка, перехват) — поищем утолщение чуть дальше, до 6 мм
        let alt = null;
        for (let dd = 1; dd <= 6 && !alt; dd++) {
          const q = cutAt(an, opts, bi, brAt(br, c.s + dd));
          if (q.s > c.s && jointFits(q.Rh, q.w) && farEnough(q, cur, g) && !blocked(q) && roomLeft(an, q, g) && probeInside(an, q, g)) alt = q;
        }
        if (!alt) { tooThin(c); break; }
        c = alt;
      }
      list.push(c);
    }
    return list;
  };

  // сначала хребет (его разрезы привязаны к бороздкам и сдвигаться не могут), потом остальные ветви в обход него;
  // ветвь, которая выходит из тела по хребту, — развилка на его конце: её покрывает хребет
  const raw = new Map();
  const spine = an.branches[0];
  if (spine && spine.ex >= 0) {
    raw.set(0, chainOf(0));
    reserved = raw.get(0).slice();
  }
  const onSpine = (p) => spine && spine.ex >= 0 && spine.pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1.5);
  an.branches.forEach((br, bi) => {
    if (bi > 0 && br.ex >= 0 && !onSpine(br.pts[br.ex])) raw.set(bi, chainOf(bi));
  });
  // ветви одной развилки дают одни и те же разрезы: первая (длинная) остаётся, у остальных совпадения отрезаются
  const lists = [];
  const taken = [];
  const close = (c) => taken.some((o) => !farEnough(o, c, g));
  let chainNo = 0;
  for (const bi of [...raw.keys()].sort((a, b) => a - b)) {
    const list = raw.get(bi);
    const cut = list.findIndex(close);
    if (cut >= 0) list.length = cut;
    if (!list.length) continue;
    const chain = chainNo++;
    list.forEach((c) => { c.chain = chain; c.dist = c.s; c.auto = true; taken.push(c); });
    lists.push(list);
  }

  // по кругу: сначала первые разрезы всех ветвей, потом вторые… — лимит делится честно
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
  return { cuts: cuts.map(({ Rh, ...c }) => c), thin };
}

// Порядок сборки: сначала разрезы у тела (основания лап, хвоста, шеи), потом дальние звенья;
// внутри — по расстоянию от ядра вдоль скелета.
export function orderCuts(cuts, skeleton) {
  const key = (c) => {
    let best = Infinity, d = 0;
    for (const s of skeleton) {
      const dd = (s.x - c.P[0]) ** 2 + (s.y - c.P[1]) ** 2;
      if (dd < best) { best = dd; d = s.dist; }
    }
    return d + Math.sqrt(best);
  };
  return cuts.map((c) => ({ c, k: (c.root ? 0 : 1e6) + key(c) })).sort((a, b) => a.k - b.k).map((x) => x.c);
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

/* Тела сустава в мировых координатах. Строим в локальных: ось — вертикаль через начало, +X = n.
   skin — цельная модель: кулак, шейка и кольцо обрезаются по ней, снаружи остаются только щели. */
export function jointBodies(wasm, d, P, n, skin) {
  const { Manifold, CrossSection } = wasm;
  const { R, H, Hl, c, gc, b, g, wn, Rh, Rs } = d;
  const tmp = [];
  const T = (m) => { tmp.push(m); return m; };
  const rev = (pts) => {
    const cs = new CrossSection([pts]);
    const m = Manifold.revolve(cs, SEG);
    cs.delete();
    return m;
  };
  const tall = (r) => T(T(Manifold.cylinder(250, r, r, SEG)).translate([0, 0, -50]));

  // кулак: фаски снизу и на высоте Hl, выше — столбик R − c до верха; гнездо повторяет его с зазором g
  const stepUp = H - Hl > 0.05;
  const knuckle = rev(stepUp
    ? [[0, 0], [R - c, 0], [R, c], [R, Hl - c], [R - c, Hl], [R - c, H], [0, H]]
    : [[0, 0], [R - c, 0], [R, c], [R, H - c], [R - c, H], [0, H]]);
  const socket = T(rev(stepUp
    ? [[0, -1], [b - 1, -1], [R + g, c + g - gc], [R + g, Hl - c - g + gc], [R - c + g, Hl - g + gc], [R - c + g, H + 1], [0, H + 1]]
    : [[0, -1], [b - 1, -1], [R + g, c + g - gc], [R + g, H - c - g + gc], [b - 1, H + 1], [0, H + 1]]));
  const box = T(T(Manifold.cube([Rh + g + 5, 2 * (wn + g), H + 2])).translate([0, -(wn + g), -1]));
  const fan = Manifold.hull([T(box.rotate([0, 0, -d.alpha])), T(box.rotate([0, 0, d.alpha]))]);
  const housing = T(T(Manifold.cylinder(H, Rh, Rh, SEG)).subtract(socket)).subtract(fan);
  const neck = T(Manifold.cube([Rh + g + 2, 2 * wn, H])).translate([0, -wn, 0]);
  const clearC = tall(Rh + g).translate([0, 0, 0]);
  const innerC = tall(Rh - 0.2).translate([0, 0, 0]);

  // V-вырез: родитель оставляет |φ| ≥ 90°+β, ребёнок |φ| ≤ 90°−β, каждый отступает на g/2
  const beta = (d.alpha / 2) * DEG;
  const cb = Math.cos(beta), sb = Math.sin(beta);
  const zone = tall(Rs);
  const keepChild = T(T(zone.trimByPlane([cb, -sb, 0], g / 2)).trimByPlane([cb, sb, 0], g / 2));
  const keepParent = T(T(zone.trimByPlane([-cb, -sb, 0], g / 2)).trimByPlane([-cb, sb, 0], g / 2));
  const notch = T(zone.subtract(keepParent)).subtract(keepChild);

  const deg = Math.atan2(n[1], n[0]) / DEG;
  const place = (m) => {
    const r = m.rotate([0, 0, deg]);
    const t = r.translate([P[0], P[1], 0]);
    r.delete();
    m.delete();
    return t;
  };
  const out = {
    knuckle: place(knuckle), housing: place(housing), neck: place(neck), fan: place(fan),
    clearC: place(clearC), innerC: place(innerC), notch: place(notch),
  };
  tmp.forEach((m) => m.delete());
  if (skin) {
    // кусок кожи вокруг сустава (так пересечения считаются по маленькому мешу)
    const L = Rh + g + 3;
    const cube = Manifold.cube([2 * L, 2 * L, 2000]);
    const box = cube.translate([P[0] - L, P[1] - L, -1000]);
    cube.delete();
    const local = skin.intersect(box);
    box.delete();
    for (const k of ['knuckle', 'neck', 'housing']) {
      const m = out[k].intersect(local);
      out[k].delete();
      out[k] = m;
    }
    local.delete();
  }
  return out;
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

/* cuts: [{ id, P, n, w, chain, auto?, br?, s? }] — в порядке сборки (orderCuts). opts — как в jointDims.
   Автоматический разрез, который не режется, сдвигается вдоль ветви на ±1…±5 мм; не вышло — тихо пропускается
   (соседние звенья сливаются) и попадает в skipped. Красные ошибки — только для разрезов, поставленных рукой.
   Возвращает { parts:[{manifold, joint}], joints:[…], notes:[{id, level:'error'|'warn', text}], redIds, skipped, skipWhy, moved, summary }.
   moved — { id: {P, n, w, s} } для сдвинутых разрезов. Manifold-ы деталей вызывающий удаляет сам. */
export function buildJoints(wasm, model, mesh, an, cuts, opts, onProgress) {
  const skin = model; // цельная модель после починки и среза низа — её не режем, только обрезаем по ней сустав
  const pieces = [{ m: model.translate([0, 0, 0]), joint: -1, n: Math.max(1, bigCount(model)) }];
  const joints = [];
  const notes = [];
  const red = new Set();
  const skipped = [];
  const skipWhy = {}; // id → 'thin' (после обрезки по коже не держит) | 'cut' (не режется)
  const moved = {};
  const num = {};
  const say = (id, level, text) => {
    notes.push({ id, level, text });
    if (id != null) red.add(id);
  };
  const g = opts.g;
  const fail = (code, text) => { throw new FlexiError(code, text); };
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

    // 1. соседи
    const near = joints.find((J) => Math.hypot(J.P[0] - P[0], J.P[1] - P[1]) < sepMin(J.Rh, d.Rh, g) - 0.01);
    if (near) fail('near', 'Слишком близко к звену #{' + near.id + '} — пропущено');
    // 2. проба ребёнка
    const qc = [P[0] + n[0] * (d.Rh + g + 1.5), P[1] + n[1] * (d.Rh + g + 1.5)];
    const span = verticalSpan(mesh, qc[0], qc[1]);
    if (!span) fail('short', 'Ветвь слишком короткая для звена — пропущено');
    const qz = (span.zb + span.zt) / 2;
    // 3. деталь
    const pi = pieces.findIndex((p) => probe(wasm, p.m, qc[0], qc[1], qz));
    if (pi < 0) fail('short', 'Ветвь слишком короткая для звена — пропущено');
    const piece = pieces[pi];
    const B = jointBodies(wasm, d, P, n, skin);
    const made = [];
    const keep = (m) => { made.push(m); return m; };
    try {
      // 4. отделяем лапу
      const a1 = keep(piece.m.subtract(B.innerC));
      const a2 = keep(a1.subtract(B.notch));
      const comps = bigParts(a2); made.push(...comps);
      const ci = comps.findIndex((m) => probe(wasm, m, qc[0], qc[1], qz));
      const others = comps.filter((_, i) => i !== ci);
      if (ci < 0 || others.length === 0) fail('no_split', 'Разрез не отделил лапу — сдвинь дальше от тела');
      // «отрезал кусок» проверяем ниже, после кольца: оно может снова пришить щепку у сустава к телу

      // 5. ребёнок: лапа без зоны сустава + кулак + шейка
      const c1 = keep(comps[ci].subtract(B.clearC));
      const c2 = keep(c1.add(B.knuckle));
      const c3 = keep(c2.add(B.neck));
      const cParts = bigParts(c3); made.push(...cParts);
      // кулак обрезан по коже: в бороздке над P кожа ниже H — щупаем середину кожи в точке P
      const sp0 = verticalSpan(mesh, P[0], P[1]);
      const kz = sp0 ? (sp0.zb + Math.min(sp0.zt, d.H)) / 2 : d.H / 2;
      const ki = cParts.findIndex((m) => probe(wasm, m, P[0], P[1], kz));
      if (ki < 0 || cParts.length > 1) fail('child_split', 'Лапа развалилась у сустава — сдвинь разрез');

      // 6. родитель: тело без проёма + кольцо (крошки от проёма — в мусор)
      const p0 = keep(unionAll(wasm, others));
      const p1 = keep(p0.subtract(B.fan));
      const pParts = bigParts(p1); made.push(...pParts);
      if (!pParts.length) fail('two_parents', 'Сустав отрезал кусок тела — сдвинь разрез');
      const p2 = keep(unionAll(wasm, pParts));

      // 7. соседние детали — освобождаем место под сустав
      const changed = [];
      for (let qi = 0; qi < pieces.length; qi++) {
        if (qi === pi) continue;
        const bb = pieces[qi].m.boundingBox();
        const dx = Math.max(bb.min[0] - P[0], 0, P[0] - bb.max[0]);
        const dy = Math.max(bb.min[1] - P[1], 0, P[1] - bb.max[1]);
        if (Math.hypot(dx, dy) > d.Rh + g) continue;
        const q1 = keep(pieces[qi].m.subtract(B.clearC));
        const q2 = keep(q1.subtract(B.fan));
        const qs = bigParts(q2); made.push(...qs);
        if (qs.length > pieces[qi].n || !qs.length) fail('neighbour', 'Сустав разрезал соседнюю деталь — сдвинь разрез');
        changed.push({ qi, m: unionAll(wasm, qs) });
      }

      // 8. кольцо может замкнуть с телом пустоту (кусок V-выреза) — внутренние пустоты и крошки убираем
      const parentM = keep(solidParts(wasm, keep(p2.add(B.housing))));
      // «отрезал кусок» — только если у родителя кусков стало больше, чем было у детали до разреза
      const pn = bigCount(parentM);
      if (pn > piece.n && pParts.length > piece.n) fail('two_parents', 'Сустав отрезал кусок тела — сдвинь разрез');
      if (pn > piece.n) fail('weak', 'Кольцо сустава отвалилось — тут тонко');
      // обрезка по коже могла срезать губу кольца (низкий круглый хвост): автоматическое звено обязано держать
      if (cut.auto) {
        // звено, которое не касается стола, без поддержек не напечатать (кончик щупальца в воздухе)
        if (cParts[ki].boundingBox().min[2] > 0.05) fail('hang', 'Звено висит над столом');
        // быстро и по месту: кулак с шейкой против кольца (держат они — держит и деталь целиком)
        const kn = keep(B.knuckle.add(B.neck));
        if (freeDirs(kn, B.housing).length) fail('weak', 'Звено не держит — тут тонко');
        // и поворачивается на ±α: щель модели рядом с суставом может оставить родителю щепку перед P
        const L = d.Rs + 1;
        const cube = keep(wasm.Manifold.cube([2 * L, 2 * L, 2000]));
        const box = keep(cube.translate([P[0] - L, P[1] - L, -1000]));
        const cl = keep(cParts[ki].intersect(box)), pl = keep(parentM.intersect(box));
        for (const sg of [-1, 1]) {
          const r1 = keep(cl.translate([-P[0], -P[1], 0]));
          const r2 = keep(r1.rotate([0, 0, sg * d.alpha]));
          const r3 = keep(r2.translate([P[0], P[1], 0]));
          if (inter(r3, pl) > 0.5) fail('stiff', 'Звено упирается раньше ±' + Math.round(d.alpha) + '°');
        }
      }

      // 9. всё получилось — заменяем детали
      const child = cParts[ki].translate([0, 0, 0]);
      made.splice(made.indexOf(parentM), 1);
      changed.forEach(({ qi, m }) => { pieces[qi].m.delete(); pieces[qi].m = m; });
      const jointIdx = joints.length;
      joints.push({
        id: cut.id, P: P.slice(), n: n.slice(), Rh: d.Rh, R: d.R, alpha: d.alpha, H: d.H,
        parent: piece.joint, chain: cut.chain == null ? -1 : cut.chain,
      });
      piece.m.delete();
      pieces.splice(pi, 1, { m: parentM, joint: piece.joint, n: pn }, { m: child, joint: jointIdx, n: 1 });
    } finally {
      made.forEach((m) => { try { m.delete(); } catch (e) { /* уже */ } });
      Object.values(B).forEach((m) => m.delete());
    }
  };

  // Сдвиг автоматического разреза вдоль его ветви на delta мм (null — некуда).
  const shifted = (cut, delta, k) => {
    const br = cut.br != null && an.branches[cut.br];
    if (!br || cut.s == null) return null;
    const k0 = brAt(br, cut.s);
    if (Math.hypot(br.pts[k0][0] - cut.P[0], br.pts[k0][1] - cut.P[1]) > 1.5) return null; // ветви уже другие
    const s = cut.s + delta;
    if (s < 0 || s > br.cum[br.cum.length - 1]) return null;
    const c = Object.assign(cutAt(an, opts, cut.br, brAt(br, s)), { id: cut.id, chain: cut.chain, auto: true, root: cut.root });
    if (Math.abs(c.s - cut.s - delta) > 0.8) return null; // эта точка уже была
    if (br.cum[br.cum.length - 1] - c.s <= c.Rh + g + 4 || !jointFits(c.Rh, c.w)) return null;
    // соседи — уже построенные звенья (следующие разрезы проверят себя сами, у них свои сдвиги)
    if (joints.some((J) => Math.hypot(J.P[0] - c.P[0], J.P[1] - c.P[1]) < sepMin(J.Rh, c.Rh, g))) return null;
    delete c.Rh;
    return c;
  };

  cuts.forEach((cut, k) => {
    if (onProgress) onProgress('cut', k + 1, cuts.length);
    let err = null;
    try { attempt(cut); return; } catch (e) { err = e; }
    if (cut.auto) {
      // сдвиги ±1…±5 мм, потом промежуточные ±1.5…±4.5 (у бороздок с прорезями удачное место бывает узким)
      for (const step of [1, 2, 3, 4, 5, 1.5, 2.5, 3.5, 4.5]) {
        for (const sg of [1, -1]) {
          const c = shifted(cut, sg * step, k);
          if (!c) continue;
          try {
            attempt(c);
            Object.assign(cut, { P: c.P, n: c.n, w: c.w, s: c.s });
            moved[cut.id] = { P: c.P, n: c.n, w: c.w, s: c.s };
            joints[joints.length - 1].P = c.P.slice();
            return;
          } catch (e) { /* следующий сдвиг */ }
        }
      }
      skipped.push(cut.id);
      skipWhy[cut.id] = err.code === 'weak' ? 'thin' : 'cut';
      return;
    }
    if (err.code === 'near' || err.code === 'short') { say(cut.id, 'warn', err.message); return; }
    const text = err instanceof FlexiError ? err.message : 'не получилось — ' + ((err && err.message) || err);
    say(cut.id, 'error', 'Звено #{' + cut.id + '}: ' + text.charAt(0).toLowerCase() + text.slice(1));
  });
  // номера — без пропущенных (экран их уберёт)
  let no = 0;
  cuts.forEach((c) => { num[c.id] = skipped.includes(c.id) ? 0 : ++no; });
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
      say(J.id, 'error', 'Звено ' + N + ' не держит (свободно: ' + free.join(', ') + ')');
    }
    // не слипся
    const touch = inter(child, parent);
    const gap = child.minGap(parent, 2 * g);
    J.gap = gap;
    if (touch > 1e-6 || gap < 0.9 * g) say(J.id, 'error', 'Звено ' + N + ' слиплось (зазор ' + gap.toFixed(2) + ' мм)');
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
    if (worst > 0.5) notes.push({ id: J.id, level: 'warn', text: 'Звено ' + N + ' упирается раньше ±' + Math.round(J.alpha) + '°' });
  });
  parts.forEach((p, i) => {
    const m = p.manifold;
    const comps = m.decompose();
    const ok = comps.filter((c) => c.volume() > 0).length <= p.n; // пустоты внутри — не куски
    comps.forEach((c) => c.delete());
    const vol = m.volume();
    if (!ok || vol < MIN_VOL) say(null, 'error', 'Деталь ' + (i + 1) + ' развалилась на куски');
    if (m.boundingBox().min[2] > 0.05) notes.push({ id: null, level: 'warn', text: 'Деталь ' + (i + 1) + ' висит над столом' });
  });

  const errors = notes.filter((x) => x.level === 'error');
  const summary = errors.length
    ? errors.length + ' ' + plural(errors.length, 'проблема', 'проблемы', 'проблем')
    : '✅ ' + joints.length + ' ' + plural(joints.length, 'звено', 'звена', 'звеньев') + ', все держат';
  return { parts, joints, notes, redIds: Array.from(red), skipped, skipWhy, moved, summary, num };
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
