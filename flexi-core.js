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

/* ---------- Размеры сустава ---------- */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Минимальный радиус кулака: проём кольца должен быть уже кулака.
export function rMin(alphaDeg, wn, g) {
  const a = alphaDeg * DEG;
  return (0.6 + (wn + g) * Math.cos(a) + g * Math.sin(a)) / (1 - Math.sin(a));
}

/* Сустав звена. opts: { g — зазор, alphaSeg — поворот на звено, ° }.
   w — полуширина ветви в месте разреза, ztop — верх модели рядом. Все размеры в мм, alpha — в градусах. */
export function jointDims(opts, w, ztop) {
  const g = opts.g;
  const alpha = opts.alphaSeg;
  const H = clamp(ztop, 6, 16);
  const c = Math.min(1.5, H / 4);
  const gc = 1.42 * g;
  const wn = clamp(0.3 * w, 1.2, 2.0);
  const t = 1.6;
  const R = Math.max(rMin(alpha, wn, g), Math.min(w - g - t - 0.6, 6));
  const Rh = R + g + t;
  return {
    g, w, R, wn, H, c, gc, t, Rh, b: R - c + gc, alpha,
    Rs: Math.max(Rh + g + 0.5, w + 2),
  };
}

/* ---------- Автопоиск разрезов ---------- */

/* Каждая ветвь — цепочка звеньев. opts: + k (длина звена 0.8–1.6).
   Разрез: { P:[x,y], n:[nx,ny], w, chain, dist }. Не больше 40 на модель. */
export function autoCuts(an, opts) {
  const limit = 40;
  const g = opts.g;
  const at = (br, d) => {
    const { cum } = br;
    let k = 0;
    while (k < cum.length - 1 && cum[k] < d) k++;
    return k;
  };
  const maxDt = (br, from, to) => {
    let m = 0;
    for (let k = 0; k < br.cum.length; k++) if (br.cum[k] >= from && br.cum[k] <= to) m = Math.max(m, br.dt[k]);
    return m;
  };
  const dirAt = (br, k) => {
    const a = br.pts[at(br, br.cum[k] - 3)], b = br.pts[at(br, br.cum[k] + 3)];
    const nx = b[0] - a[0], ny = b[1] - a[1];
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  };
  const mk = (br, k, w, chain) => {
    const P = br.pts[k].slice();
    const d = jointDims(opts, w, ztopAt(an, P[0], P[1]));
    // направление — на точку скелета, где при сборке будет проба ребёнка: на изогнутой лапе шейка смотрит в неё
    const ahead = d.Rh + g + 1.5;
    let n = dirAt(br, k);
    if (br.cum[br.cum.length - 1] - br.cum[k] > ahead) {
      const q = br.pts[at(br, br.cum[k] + ahead)];
      const l = Math.hypot(q[0] - P[0], q[1] - P[1]);
      if (l > ahead * 0.5) n = [(q[0] - P[0]) / l, (q[1] - P[1]) / l];
    }
    return { P, n, w, chain, dist: br.cum[k], Rh: d.Rh };
  };
  // проба ребёнка (как при сборке) должна попасть в силуэт, иначе сустав не встанет
  const inside = (x, y) => {
    const { x0, y0, step, W, H } = an.grid;
    const px = Math.floor((x - x0) / step), py = Math.floor((y - y0) / step);
    return px >= 0 && py >= 0 && px < W && py < H && an.heights[py * W + px] > 0;
  };
  const probeOk = (c) => inside(c.P[0] + c.n[0] * (c.Rh + g + 1.5), c.P[1] + c.n[1] * (c.Rh + g + 1.5));

  // кандидаты по ветвям
  const lists = [];
  let chainNo = 0;
  for (const br of an.branches) {
    if (br.ex < 0) continue; // отросток внутри тела
    const last = br.cum.length - 1;
    const total = br.cum[last];
    const i = at(br, br.cum[br.ex] + 1);
    const chain = chainNo++;
    // первый разрез — на выходе из тела
    const first = mk(br, i, maxDt(br, br.cum[i], br.cum[i] + 4), chain);
    if (total - br.cum[i] < first.Rh + g + 4 || !probeOk(first)) continue;
    const list = [first];

    // дальше звенья с шагом max(2·Rh + 2, k·2·w), пока до конца больше Rh + g + 4
    const wAt = (k) => maxDt(br, br.cum[k] - 2, br.cum[k] + 2);
    const linkStep = (k) => {
      const d = jointDims(opts, wAt(k), ztopAt(an, br.pts[k][0], br.pts[k][1]));
      return Math.max(2 * d.Rh + 2, (opts.k || 1.2) * 2 * wAt(k));
    };
    let cur = i, curRh = first.Rh;
    for (;;) {
      const stepMm = linkStep(cur);
      let target = br.cum[cur] + stepMm;
      let j = -1, c = null;
      // соседние звенья не ближе Rh_i + Rh_j + 2
      for (let tries = 0; tries < 6; tries++) {
        j = at(br, target);
        if (j <= cur) break;
        c = mk(br, j, wAt(j), chain);
        // по прямой, а не по пиксельному пути скелета (он зигзагом и длиннее)
        const gap = Math.hypot(br.pts[j][0] - br.pts[cur][0], br.pts[j][1] - br.pts[cur][1]) - (curRh + c.Rh + 2);
        if (gap >= 0) break;
        target += -gap + 0.5;
        c = null;
      }
      if (!c || j <= cur) break;
      if (total - br.cum[j] < c.Rh + g + 4 || !probeOk(c)) break;
      list.push(c);
      cur = j;
      curRh = c.Rh;
    }
    lists.push(list);
  }

  // по кругу: сначала первые разрезы всех ветвей, потом вторые… — лимит делится честно
  const cuts = [];
  const close = (c) => cuts.some((o) => Math.hypot(o.P[0] - c.P[0], o.P[1] - c.P[1]) < o.Rh + c.Rh + 1.5);
  for (let round = 0; cuts.length < limit; round++) {
    let any = false;
    for (const list of lists) {
      if (round >= list.length || cuts.length >= limit) continue;
      any = true;
      const c = list[round];
      if (round > 0 && !cuts.includes(list[round - 1])) { list.length = round; continue; } // цепочка оборвалась
      if (close(c)) { if (round === 0) list.length = 0; else list.length = round; continue; } // дубль от развилки
      cuts.push(c);
    }
    if (!any) break;
  }
  // номера ветвей подряд (дубли от развилок выпали)
  const renum = new Map();
  return cuts.map(({ Rh, ...c }) => {
    if (!renum.has(c.chain)) renum.set(c.chain, renum.size);
    return Object.assign(c, { chain: renum.get(c.chain) });
  });
}

// Порядок сборки: по расстоянию от ядра вдоль скелета (ближние к телу — первыми).
export function orderCuts(cuts, skeleton) {
  const key = (c) => {
    let best = Infinity, d = 0;
    for (const s of skeleton) {
      const dd = (s.x - c.P[0]) ** 2 + (s.y - c.P[1]) ** 2;
      if (dd < best) { best = dd; d = s.dist; }
    }
    return d + Math.sqrt(best);
  };
  return cuts.map((c) => ({ c, k: key(c) })).sort((a, b) => a.k - b.k).map((x) => x.c);
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
const MIN_VOL = 20;

/* Тела сустава в мировых координатах. Строим в локальных: ось — вертикаль через начало, +X = n. */
export function jointBodies(wasm, d, P, n) {
  const { Manifold, CrossSection } = wasm;
  const { R, H, c, gc, b, g, wn, Rh, Rs } = d;
  const tmp = [];
  const T = (m) => { tmp.push(m); return m; };
  const rev = (pts) => {
    const cs = new CrossSection([pts]);
    const m = Manifold.revolve(cs, SEG);
    cs.delete();
    return m;
  };
  const tall = (r) => T(T(Manifold.cylinder(250, r, r, SEG)).translate([0, 0, -50]));

  const knuckle = rev([[0, 0], [R - c, 0], [R, c], [R, H - c], [R - c, H], [0, H]]);
  const socket = T(rev([[0, -1], [b - 1, -1], [R + g, c + g - gc], [R + g, H - c - g + gc], [b - 1, H + 1], [0, H + 1]]));
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

function bigParts(m) {
  const all = m.decompose();
  const keep = [];
  all.forEach((p) => { if (p.volume() >= MIN_VOL) keep.push(p); else p.delete(); });
  return keep;
}

const unionAll = (wasm, list) => (list.length === 1 ? list[0].translate([0, 0, 0]) : wasm.Manifold.union(list));

/* ---------- Сборка суставов ---------- */

/* cuts: [{ id, P, n, w, chain }] — в порядке сборки (orderCuts). opts — как в jointDims.
   Возвращает { parts:[{manifold, joint}], joints:[…], notes:[{id, level:'error'|'warn', text}], redIds, summary }.
   Manifold-ы деталей вызывающий удаляет сам. */
export function buildJoints(wasm, model, mesh, an, cuts, opts, onProgress) {
  const pieces = [{ m: model.translate([0, 0, 0]), joint: -1 }];
  const joints = [];
  const notes = [];
  const red = new Set();
  const num = {};
  cuts.forEach((c, i) => { num[c.id] = i + 1; });
  const say = (id, level, text) => {
    notes.push({ id, level, text });
    if (id != null) red.add(id);
  };
  const g = opts.g;

  cuts.forEach((cut, k) => {
    if (onProgress) onProgress('cut', k + 1, cuts.length);
    const P = cut.P, n = cut.n;
    const d = jointDims(opts, cut.w, ztopAt(an, P[0], P[1]));

    // 1. соседи
    const near = joints.find((J) => Math.hypot(J.P[0] - P[0], J.P[1] - P[1]) < J.Rh + d.Rh + 1.5);
    if (near) {
      say(cut.id, 'warn', 'Слишком близко к звену ' + num[near.id] + ' — пропущено');
      return;
    }
    // 2. проба ребёнка
    const qc = [P[0] + n[0] * (d.Rh + g + 1.5), P[1] + n[1] * (d.Rh + g + 1.5)];
    const span = verticalSpan(mesh, qc[0], qc[1]);
    if (!span) {
      say(cut.id, 'warn', 'Ветвь слишком короткая для звена — пропущено');
      return;
    }
    const qz = (span.zb + span.zt) / 2;
    // 3. деталь
    const pi = pieces.findIndex((p) => probe(wasm, p.m, qc[0], qc[1], qz));
    if (pi < 0) {
      say(cut.id, 'warn', 'Ветвь слишком короткая для звена — пропущено');
      return;
    }
    const piece = pieces[pi];
    const B = jointBodies(wasm, d, P, n);
    const made = [];
    const drop = () => made.forEach((m) => { try { m.delete(); } catch (e) { /* уже */ } });
    try {
      // 4. отделяем лапу
      const a1 = piece.m.subtract(B.innerC); made.push(a1);
      const a2 = a1.subtract(B.notch); made.push(a2);
      const comps = bigParts(a2); made.push(...comps);
      const ci = comps.findIndex((m) => probe(wasm, m, qc[0], qc[1], qz));
      const others = comps.filter((_, i) => i !== ci);
      if (ci < 0 || others.length === 0) throw new FlexiError('no_split', 'Разрез не отделил лапу — сдвинь дальше от тела');
      if (others.length > 1) throw new FlexiError('two_parents', 'Сустав отрезал кусок тела — сдвинь разрез');

      // 5. ребёнок: лапа без зоны сустава + кулак + шейка
      const c1 = comps[ci].subtract(B.clearC); made.push(c1);
      const c2 = c1.add(B.knuckle); made.push(c2);
      const c3 = c2.add(B.neck); made.push(c3);
      const cParts = bigParts(c3); made.push(...cParts);
      const ki = cParts.findIndex((m) => probe(wasm, m, P[0], P[1], d.H / 2));
      if (ki < 0 || cParts.length > 1) throw new FlexiError('child_split', 'Лапа развалилась у сустава — сдвинь разрез');
      const child = cParts[ki].translate([0, 0, 0]);

      // 6. родитель: тело без проёма + кольцо
      const p1 = others[0].subtract(B.fan); made.push(p1);
      const parentM = p1.add(B.housing);

      // 7. соседние детали — освобождаем место под сустав
      const changed = [];
      for (let qi = 0; qi < pieces.length; qi++) {
        if (qi === pi) continue;
        const bb = pieces[qi].m.boundingBox();
        const dx = Math.max(bb.min[0] - P[0], 0, P[0] - bb.max[0]);
        const dy = Math.max(bb.min[1] - P[1], 0, P[1] - bb.max[1]);
        if (Math.hypot(dx, dy) > d.Rh + g) continue;
        const q1 = pieces[qi].m.subtract(B.clearC); made.push(q1);
        const q2 = q1.subtract(B.fan); made.push(q2);
        const qs = bigParts(q2); made.push(...qs);
        if (qs.length !== 1) {
          child.delete();
          parentM.delete();
          changed.forEach((x) => x.m.delete());
          throw new FlexiError('neighbour', 'Сустав разрезал соседнюю деталь — сдвинь разрез');
        }
        changed.push({ qi, m: qs[0].translate([0, 0, 0]) });
      }

      // 8. всё получилось — заменяем детали
      changed.forEach(({ qi, m }) => { pieces[qi].m.delete(); pieces[qi].m = m; });
      const jointIdx = joints.length;
      joints.push({
        id: cut.id, P: P.slice(), n: n.slice(), Rh: d.Rh, R: d.R, alpha: d.alpha, H: d.H,
        parent: piece.joint, chain: cut.chain == null ? -1 : cut.chain,
      });
      piece.m.delete();
      pieces.splice(pi, 1, { m: parentM, joint: piece.joint }, { m: child, joint: jointIdx });
    } catch (err) {
      const text = err instanceof FlexiError ? err.message : 'не получилось — ' + ((err && err.message) || err);
      say(cut.id, 'error', 'Звено ' + num[cut.id] + ': ' + text.charAt(0).toLowerCase() + text.slice(1));
    } finally {
      drop();
      Object.values(B).forEach((m) => m.delete());
    }
  });

  // 5. автопроверка
  if (onProgress) onProgress('check', 0, joints.length);
  const parts = pieces.map((p) => ({ manifold: p.m, joint: p.joint }));
  const partOf = (j) => parts.find((p) => p.joint === j);
  const inter = (a, b) => { const x = a.intersect(b); const v = x.volume(); x.delete(); return v; };
  let holdBad = 0;
  joints.forEach((J, j) => {
    if (onProgress) onProgress('check', j + 1, joints.length);
    const child = partOf(j).manifold, parent = partOf(J.parent).manifold;
    const N = num[J.id];
    // держит во все 6 сторон
    const free = [];
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].forEach((v, i) => {
      const m = child.translate(v);
      if (inter(m, parent) <= 0.05) free.push(['+X', '−X', '+Y', '−Y', '+Z', '−Z'][i]);
      m.delete();
    });
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
    const ok = comps.length === 1;
    comps.forEach((c) => c.delete());
    const vol = m.volume();
    if (!ok || vol < MIN_VOL) say(null, 'error', 'Деталь ' + (i + 1) + ' развалилась на куски');
    if (m.boundingBox().min[2] > 0.05) notes.push({ id: null, level: 'warn', text: 'Деталь ' + (i + 1) + ' висит над столом' });
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
