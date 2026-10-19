// node tests/litho.test.mjs — литофания и барельеф: сетка замкнутая, размеры и толщины верные
import assert from 'assert';
import { makeLitho, LITHO_DEFAULTS } from '../litho-core.js';

// проверка: каждое ребро встречается ровно 2 раза в противоположных направлениях, объём > 0
function check(stl) {
  const dv = new DataView(stl), n = dv.getUint32(80, true);
  assert.strictEqual(stl.byteLength, 84 + n * 50, 'размер файла');
  const ids = new Map(), edges = new Map(); let vol = 0;
  const vid = (x, y, z) => { const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4); if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12, p = [];
    for (let k = 0; k < 3; k++) p.push([dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]);
    const [a, b, c] = p;
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    const v = p.map((q) => vid(...q));
    for (let k = 0; k < 3; k++) { const key = v[k] + '>' + v[(k + 1) % 3]; edges.set(key, (edges.get(key) || 0) + 1); }
  }
  for (const [key, c] of edges) {
    assert.strictEqual(c, 1, 'ребро дважды в одну сторону: ' + key);
    const [a, b] = key.split('>');
    assert.ok(edges.has(b + '>' + a), 'дыра у ребра ' + key);
  }
  assert.ok(vol > 0, 'объём положительный (нормали наружу)');
  return { n, vol };
}

// картинка 40×30: градиент слева направо, сверху тёмная полоса
const w = 40, h = 30, L = new Float32Array(w * h);
for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) L[j * w + i] = j < 5 ? 0 : i / (w - 1);

for (const opts of [
  { mode: 'litho' },
  { mode: 'litho', frame: 0 },
  { mode: 'litho', curve: 120 },
  { mode: 'relief', blur: 1 },
  { mode: 'relief', lightUp: true },
]) {
  const r = makeLitho(L, w, h, { ...opts, width: 80, maxCells: 5000 });
  const { n, vol } = check(r.stl);
  assert.ok(Math.abs(r.size[0] - 80) < 1e-6 && Math.abs(r.size[1] - 60) < 1e-6, 'ширина 80, высота по пропорциям');
  console.log('ok', JSON.stringify(opts), n, 'треугольников', Math.round(vol), 'мм³');
}

// толщины литофании: светлое — minT, тёмное — maxT, рамка — maxT + 0.5
{
  const r = makeLitho(L, w, h, { mode: 'litho', width: 80, maxCells: 5000 });
  const { T, gx, gy } = r.hf, d = LITHO_DEFAULTS;
  const mid = Math.floor(gy / 2);
  assert.ok(T[mid * gx + gx - 5] < d.minT + 0.3, 'светлое место тонкое');
  assert.ok(T[mid * gx + 4] > d.maxT - 0.3, 'тёмное место толстое');
  assert.ok(Math.abs(T[0] - (d.maxT + 0.5)) < 1e-6, 'рамка');
}
// размер файла: 100 мм картинки не больше 8 МБ
{
  const big = new Float32Array(600 * 800).fill(0.5);
  const r = makeLitho(big, 600, 800, { width: 100 });
  assert.ok(r.stl.byteLength < 8e6, 'файл меньше 8 МБ: ' + r.stl.byteLength);
  console.log('ok размер', (r.stl.byteLength / 1e6).toFixed(1), 'МБ, сетка', r.grid.join('×'), 'шаг', r.step.toFixed(2), 'мм');
}
console.log('litho: все проверки прошли');
