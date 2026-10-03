/* Грава — сборщик шарниров: превращает фигурку в подвижную (print-in-place).
   Чистые функции без DOM: их использует фоновый поток flexi-worker.js и тестовый скрипт.
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

// Анализ вида сверху: силуэт, расстояния, тело, скелет, автоматические разрезы.
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

  // расстояние до края, мм
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
          if (skel[j] && parent[j] === -2) { parent[j] = i; hasChild[i] = 1; q.push(j); }
        }
      }
    }
  }

  const P = (i) => [grid.x0 + (i % W + 0.5) * step, grid.y0 + (((i / W) | 0) + 0.5) * step];
  const skeleton = order.map((i) => {
    const [x, y] = P(i);
    return { i, x, y, dt: dt[i], parent: parent[i] };
  });

  const cuts = autoCuts({ order, parent, hasChild, bodyD, dt, P });

  // картинка высот для экрана: 0 — фон, 1…255 — высота
  let zMax = 0;
  for (let i = 0; i < N; i++) if (mask[i] && top[i] > zMax) zMax = top[i];
  const heights = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const z = top[i] > -INF ? top[i] : 0;
    heights[i] = 40 + Math.round(215 * Math.max(0, Math.min(1, z / (zMax || 1))));
  }

  return {
    grid, heights, skeleton, cuts,
    core: P(core), coreW, rb,
  };
}

function autoCuts({ order, parent, hasChild, bodyD, dt, P }) {
  const leaves = order.filter((i) => !hasChild[i]);
  const paths = leaves.map((leaf) => {
    const path = [];
    for (let i = leaf; i >= 0; i = parent[i]) path.push(i);
    path.reverse();
    const pts = path.map(P);
    const cum = new Float64Array(path.length);
    for (let k = 1; k < path.length; k++) cum[k] = cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    return { path, pts, cum };
  }).sort((a, b) => b.cum[b.cum.length - 1] - a.cum[a.cum.length - 1]);

  const cuts = [];
  const near = (p, r) => cuts.some((c) => Math.hypot(c.P[0] - p[0], c.P[1] - p[1]) < r);
  const at = (br, dist) => {
    const { cum } = br;
    let k = 0;
    while (k < cum.length - 1 && cum[k] < dist) k++;
    return k;
  };
  const maxDt = (br, from, to) => {
    let m = 0;
    for (let k = 0; k < br.path.length; k++) if (br.cum[k] >= from && br.cum[k] <= to) m = Math.max(m, dt[br.path[k]]);
    return m;
  };
  const dirAt = (br, k) => {
    const a = br.pts[at(br, br.cum[k] - 3)], b = br.pts[at(br, br.cum[k] + 3)];
    let nx = b[0] - a[0], ny = b[1] - a[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    return [nx, ny];
  };

  for (const br of paths) {
    if (cuts.length >= 14) break;
    const last = br.path.length - 1;
    const total = br.cum[last];
    let ex = -1;
    for (let k = 0; k < br.path.length; k++) if (!bodyD[br.path[k]]) { ex = k; break; }
    if (ex < 0) continue; // отросток внутри тела
    const i = at(br, br.cum[ex] + 1);
    if (total - br.cum[i] < 8) continue;
    if (near(br.pts[i], 8)) continue; // дубль от развилки
    cuts.push({ P: br.pts[i].slice(), n: dirAt(br, i), w: maxDt(br, br.cum[i], br.cum[i] + 4), dist: br.cum[i] });

    // длинные ветви (хвост, шея): ещё разрезы с шагом
    let cur = i;
    while (cuts.length < 14) {
      const wl = maxDt(br, br.cum[cur] - 2, br.cum[cur] + 2);
      const stepMm = Math.max(3 * wl + 3, 10);
      const target = br.cum[cur] + stepMm;
      if (total - target <= 0.7 * stepMm) break;
      const j = at(br, target);
      if (j <= cur) break;
      if (!near(br.pts[j], 8)) {
        cuts.push({ P: br.pts[j].slice(), n: dirAt(br, j), w: maxDt(br, br.cum[j] - 2, br.cum[j] + 2), dist: br.cum[j] });
      }
      cur = j;
    }
  }
  return cuts;
}

/* ---------- Сустав «кулак в гнезде» ---------- */

// Низ и верх меша на вертикали через (x, y).
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

export function jointSize(w, zb, zt, alphaDeg, cMax = 2) {
  const h = zt - zb;
  const c = Math.min(cMax, h / 4);
  const R = w / Math.cos(alphaDeg * Math.PI / 180) + c + 0.5;
  return { h, c, R, zc: (zb + zt) / 2, hf: h - 2 * c, Rz: R + 2.5 };
}

const SEG = 48;

/* Собрать все суставы. cuts: [{id, P:[x,y], n:[nx,ny], w}] — уже по порядку от ядра.
   opts: { g, alpha }. onProgress(k, N).
   Возвращает { parts:[{manifold, joint}], joints:[{id, P, n, R, parent}], warnings:[{id, text}], errors:[{id, text}] } —
   Manifold-ы деталей вызывающий должен удалить сам. */
export function buildJoints(wasm, model, mesh, cuts, opts, onProgress) {
  const { Manifold, CrossSection } = wasm;
  const g = opts.g, alpha = opts.alpha;
  const e = 1.42 * g;
  const pieces = [{ m: model.translate([0, 0, 0]), joint: -1 }];
  const joints = [];
  const warnings = [];
  const errors = [];
  const big = Manifold.cube([4000, 4000, 4000], true);
  const sizes = [];

  const halfSpace = (P, n, off) => big.trimByPlane([-n[0], -n[1], 0], -(n[0] * P[0] + n[1] * P[1]) - off);
  const probe = (m, x, y, z) => {
    const c = Manifold.cube([0.2, 0.2, 0.2], true);
    const t = c.translate([x, y, z]);
    c.delete();
    const i = m.intersect(t);
    t.delete();
    const vol = i.volume();
    i.delete();
    return vol > 0;
  };
  const revolveProfile = (pts, P) => {
    const cs = new CrossSection([pts]);
    const r = Manifold.revolve(cs, SEG);
    cs.delete();
    const t = r.translate([P[0], P[1], 0]);
    r.delete();
    return t;
  };

  cuts.forEach((cut, k) => {
    if (onProgress) onProgress(k + 1, cuts.length);
    const tmp = [];
    const T = (m) => { tmp.push(m); return m; };
    try {
      const P = cut.P, n = cut.n, w = cut.w;
      const span = verticalSpan(mesh, P[0], P[1]);
      if (!span) throw new FlexiError('outside', 'разрез вне модели');
      const { h, c, R, zc, hf, Rz } = jointSize(w, span.zb, span.zt, alpha);
      sizes.push({ id: cut.id, P, R });
      if (h < 6 || w < 3) warnings.push({ id: cut.id, text: 'тут тонко — увеличь длину фигурки' });

      const z1 = zc - hf / 2, z2 = zc + hf / 2;
      const barrel = T(revolveProfile([[0, z1 - R], [R, z1], [R, z2], [0, z2 + R]], P));
      const socket = T(revolveProfile([[0, z1 - R - e], [R + e, z1], [R + e, z2], [0, z2 + R + e]], P));
      const cyl = T(Manifold.cylinder(250, Rz, Rz, SEG));
      const zone = T(cyl.translate([P[0], P[1], -50]));

      // деталь, которую режем: та, где точка чуть со стороны тела
      const qp = [P[0] - n[0] * (g + 1), P[1] - n[1] * (g + 1)];
      const pi = pieces.findIndex((p) => probe(p.m, qp[0], qp[1], zc));
      if (pi < 0) throw new FlexiError('outside', 'разрез вне модели');
      const piece = pieces[pi];

      const hp0 = T(halfSpace(P, n, 0));
      const cutA = T(T(zone.intersect(hp0)).intersect(socket));
      const zoneHalf = T(zone.intersect(hp0));
      const slab = T(zoneHalf.trimByPlane([n[0], n[1], 0], n[0] * P[0] + n[1] * P[1] - g));
      const rest = T(T(piece.m.subtract(cutA)).subtract(slab));
      const comps = rest.decompose().filter((m) => {
        if (m.volume() < 1) { m.delete(); return false; }
        return true;
      });
      comps.forEach(T);
      const qc = [P[0] + n[0] * (g + 1), P[1] + n[1] * (g + 1)];
      const ci = comps.findIndex((m) => probe(m, qc[0], qc[1], zc));
      if (comps.length < 2) throw new FlexiError('no_split', 'разрез не отделил часть: передвинь или расширь');
      if (ci < 0) throw new FlexiError('no_child', 'разрез не попал в лапу');

      const hp1 = T(halfSpace(P, n, 0.01));
      const ball = T(T(T(piece.m.intersect(zone)).intersect(hp1)).intersect(barrel));
      const child = comps[ci].add(ball);
      const others = comps.filter((_, i) => i !== ci);
      const parentM = others.length === 1 ? others[0].translate([0, 0, 0]) : Manifold.union(others);

      // проверка поворота: лапа на ±α вокруг вертикали через P
      let hits = false;
      for (const s of [-1, 1]) {
        const a = T(child.translate([-P[0], -P[1], 0]));
        const b = T(a.rotate([0, 0, s * alpha]));
        const r = T(b.translate([P[0], P[1], 0]));
        const x = T(r.intersect(parentM));
        if (x.volume() > 1) hits = true;
      }
      if (hits) warnings.push({ id: cut.id, text: 'лапа задевает при повороте' });

      const jointIdx = joints.length;
      joints.push({ id: cut.id, P: P.slice(), n: n.slice(), R, zc, parent: piece.joint });
      piece.m.delete();
      pieces.splice(pi, 1, { m: parentM, joint: piece.joint }, { m: child, joint: jointIdx });
    } catch (err) {
      errors.push({ id: cut.id, text: err instanceof FlexiError ? err.message : 'не получилось: ' + ((err && err.message) || err) });
    } finally {
      tmp.forEach((m) => { try { m.delete(); } catch (x) { /* уже удалён */ } });
    }
  });
  big.delete();

  // суставы слишком близко
  for (let i = 0; i < sizes.length; i++) {
    for (let j = i + 1; j < sizes.length; j++) {
      const a = sizes[i], b = sizes[j];
      if (Math.hypot(a.P[0] - b.P[0], a.P[1] - b.P[1]) < a.R + b.R + 2) {
        warnings.push({ id: b.id, text: 'суставы слишком близко' });
      }
    }
  }
  return { parts: pieces.map((p) => ({ manifold: p.m, joint: p.joint })), joints, warnings, errors };
}

export function meshOf(m) {
  return getMeshArrays(m);
}
