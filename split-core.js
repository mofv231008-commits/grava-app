/* split-core.js — делим большую модель на части под стол принтера, со штырями-соединителями.
   Работает с Manifold (manifold-3d, тот же WASM, что у сборщика шарниров). Размеры в мм.

   Как:
   1. Пока какая-то часть не влезает на стол (с запасом), режем её поперёк самой длинной стороны.
      Место разреза ищем ближе к середине, там, где в срез помещается хотя бы один штырь.
   2. В каждый срез — отверстия под штыри (с обеих сторон), сами штыри печатаются отдельно.
   3. Части не поворачиваем (модель уже стоит как печатать) и раскладываем по столам.
*/

export const SPLIT_DEFAULTS = {
  bed: [250, 250, 250],  // стол принтера X × Y × высота, мм (Anycubic Kobra 3 — 250 × 250 × 260)
  margin: 6,             // запас от края стола, мм
  pinD: 4,               // диаметр штыря, мм
  pinL: 12,              // длина штыря, мм (по половине в каждую часть)
  clear: 0.2,            // зазор в отверстии на сторону, мм (отверстие = pinD + 2·clear)
  wall: 2.5,             // стенка от отверстия до края среза, мм
  maxPins: 3,            // штырей на один срез, не больше
  gap: 8,                // расстояние между деталями на столе, мм
};

// влезает ли часть как стоит (высота — по Z, по столу можно повернуть на 90°)
const fits = (d, bed, m) => {
  const a = [d[0], d[1]].sort((p, q) => p - q), b = [bed[0] - 2 * m, bed[1] - 2 * m].sort((p, q) => p - q);
  return a[0] <= b[0] && a[1] <= b[1] && d[2] <= bed[2] - m;
};
// по какой оси резать: где превышение сильнее всего
const worstAxis = (d, bed, m) => {
  const xy = Math.max(bed[0], bed[1]) - 2 * m, z = bed[2] - m;
  const r = [d[0] / xy, d[1] / xy, d[2] / z];
  return r.indexOf(Math.max(...r));
};
const dimsOf = (bb) => [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];

// поворот, после которого ось ax смотрит вверх (Z)
const toZ = (ax) => (ax === 0 ? [0, -90, 0] : ax === 1 ? [90, 0, 0] : [0, 0, 0]);
const fromZ = (ax) => (ax === 0 ? [0, 90, 0] : ax === 1 ? [-90, 0, 0] : [0, 0, 0]);

// точки под штыри в срезе: в каждом отдельном пятне среза (у изогнутой змеи их бывает несколько) —
// внутри, отступив r + wall от края; в большом пятне до maxPins, как можно дальше друг от друга
function pinSpots(wasm, cs, o) {
  const r = o.pinD / 2 + o.clear;
  const out = [];
  for (const island of cs.decompose()) {
    const inner = island.offset(-(r + o.wall), 'Round');
    island.delete();
    const area = inner.area();
    if (area <= 0.5) { inner.delete(); continue; }
    const polys = inner.toPolygons();
    const bb = inner.bounds();
    inner.delete();
    const inside = (x, y) => { // чётность пересечений по всем контурам
      let c = false;
      for (const poly of polys) for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a], [xj, yj] = poly[b];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const cand = [];
    const step = Math.max(0.5, Math.min(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) / 12);
    for (let x = bb.min[0]; x <= bb.max[0] + 1e-9; x += step) for (let y = bb.min[1]; y <= bb.max[1] + 1e-9; y += step) if (inside(x, y)) cand.push([x, y]);
    if (!cand.length) continue;
    // первый — ближе к центру пятна, дальше — самые далёкие от уже выбранных
    const cx = cand.reduce((t, p) => t + p[0], 0) / cand.length, cy = cand.reduce((t, p) => t + p[1], 0) / cand.length;
    cand.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    const want = Math.max(1, Math.min(o.maxPins, Math.floor(area / 400) + 1)); // ~ один штырь на 20×20 мм свободной площади
    const pick = [cand[0]];
    while (pick.length < want) {
      let best = null, bd = 0;
      for (const p of cand) { const d = Math.min(...pick.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))); if (d > bd) { bd = d; best = p; } }
      if (!best || bd < o.pinD * 3) break;
      pick.push(best);
    }
    out.push(...pick);
  }
  return out;
}

// Разрезать часть поперёк оси ax. Возвращает две части и число штырей, или null, если не вышло.
function cutPart(wasm, part, ax, o) {
  const { Manifold } = wasm;
  const rot = part.rotate(toZ(ax)); // ось разреза — вверх
  const bb = rot.boundingBox();
  const z0 = bb.min[2], z1 = bb.max[2], H = z1 - z0;
  // ищем место разреза: ближе к середине, без «щепок» (крошечных пятен среза) и со штырём в каждом пятне
  let best = null, bestScore = -Infinity;
  for (const f of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
    const z = z0 + H * f;
    const cs = rot.slice(z);
    if (cs.isEmpty()) { cs.delete(); continue; }
    const islands = cs.decompose();
    const areas = islands.map((x) => { const a = x.area(); x.delete(); return a; });
    const spots = pinSpots(wasm, cs, o);
    const area = cs.area();
    cs.delete();
    const slivers = areas.filter((a) => a < Math.max(30, (o.pinD + 2 * o.wall) ** 2)).length;
    const score = (spots.length ? 100 : 0) - slivers * 40 - Math.abs(f - 0.5) * 60 - (areas.length - 1) * 5;
    if (score > bestScore) { bestScore = score; best = { z, spots, area }; }
    if (spots.length && !slivers && areas.length === 1) break; // идеальный разрез — дальше не ищем
  }
  if (!best) { rot.delete(); return null; }
  const [upper, lower] = rot.splitByPlane([0, 0, 1], best.z);
  rot.delete();
  // отверстия под штыри: цилиндры через срез, по pinL/2 + 0,5 в каждую сторону
  const r = o.pinD / 2 + o.clear, h = o.pinL / 2 + 0.5;
  let a = upper, b = lower;
  if (best.spots.length) {
    const holes = Manifold.union(best.spots.map(([x, y]) => Manifold.cylinder(2 * h, r, r, 32).translate([x, y, best.z - h])));
    const a2 = a.subtract(holes), b2 = b.subtract(holes);
    a.delete(); b.delete(); holes.delete();
    a = a2; b = b2;
  }
  // назад в исходную ориентацию
  const A = a.rotate(fromZ(ax)), B = b.rotate(fromZ(ax));
  a.delete(); b.delete();
  // у каждой части запоминаем срез: нормаль наружу (в исходных координатах)
  const n = [0, 0, 0]; n[ax] = 1;
  return { up: A, down: B, pins: best.spots.length, normalUp: n.map((v) => -v), normalDown: n, area: best.area };
}

// Разобрать на отдельные куски и собрать обратно группами: куски с пересекающимися габаритами — в одну группу
function groupPieces(wasm, m) {
  const { Manifold } = wasm;
  const pieces = m.decompose().filter((x) => { if (x.volume() > 1) return true; x.delete(); return false; });
  if (pieces.length <= 1) return pieces.length ? pieces : [m.translate([0, 0, 0])];
  const bb = pieces.map((x) => x.boundingBox());
  const par = pieces.map((_, i) => i);
  const find = (a) => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  const hit = (a, b) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) if (hit(bb[i], bb[j])) par[find(i)] = find(j);
  const by = new Map();
  pieces.forEach((x, i) => { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(x); });
  return [...by.values()].map((list) => { if (list.length === 1) return list[0]; const u = Manifold.union(list); list.forEach((x) => x.delete()); return u; });
}

// Главная функция. model — Manifold в мм, стоит на столе. Возвращает { parts, plates, pins, cuts } или { fits: true }.
export function splitModel(wasm, model, opts = {}) {
  const o = { ...SPLIT_DEFAULTS, ...opts };
  const { Manifold } = wasm;
  if (fits(dimsOf(model.boundingBox()), o.bed, o.margin)) return { fits: true, parts: [], plates: [], pins: 0, cuts: 0 };
  let queue = [{ m: model.translate([0, 0, 0]), faces: [] }];
  const done = [];
  let pins = 0, cuts = 0, guard = 0;
  while (queue.length) {
    const p = queue.pop();
    // часть из нескольких отдельных кусков (например, изгиб змеи после разреза) — разбираем на группы:
    // куски, чьи габариты пересекаются (глаз в голове, звенья цепочки), остаются вместе
    const groups = groupPieces(wasm, p.m);
    if (groups.length > 1) {
      p.m.delete();
      for (const g of groups) queue.push({ m: g, faces: p.faces });
      continue;
    }
    groups[0].delete();
    const d = dimsOf(p.m.boundingBox());
    if (fits(d, o.bed, o.margin) || guard > 40) { done.push(p); continue; }
    guard++;
    const ax = worstAxis(d, o.bed, o.margin);
    let c = cutPart(wasm, p.m, ax, o);
    // не вышло по худшей оси — пробуем другие; совсем никак — оставляем часть как есть (её покажем как «не влезает»)
    for (const ax2 of [0, 1, 2]) if (!c && ax2 !== ax) c = cutPart(wasm, p.m, ax2, o);
    if (!c) { p.tooBig = true; done.push(p); continue; }
    p.m.delete();
    cuts++; pins += c.pins;
    queue.push({ m: c.up, faces: [...p.faces, { n: c.normalUp, area: c.area }] });
    queue.push({ m: c.down, faces: [...p.faces, { n: c.normalDown, area: c.area }] });
  }
  // части не поворачиваем: модель уже стоит как печатать. У верхней части после горизонтального разреза
  // срез оказывается внизу — она встаёт на него. Длинную часть поворачиваем на 90° по столу, если так влезает.
  const W0 = o.bed[0] - 2 * o.margin;
  const parts = done.map((p, i) => {
    let m = p.m, bb = m.boundingBox();
    if (bb.max[0] - bb.min[0] > W0 && bb.max[1] - bb.min[1] <= W0) { const r = m.rotate([0, 0, 90]); m.delete(); m = r; bb = m.boundingBox(); }
    const flat = m.translate([-bb.min[0], -bb.min[1], -bb.min[2]]);
    m.delete();
    const b2 = flat.boundingBox();
    return { id: i + 1, m: flat, w: b2.max[0], d: b2.max[1], h: b2.max[2], tooBig: !!p.tooBig };
  });
  // штыри: цилиндры d × L стоя, с фаской 0,5 мм сверху и снизу, чтобы легко входили
  const pinParts = [];
  for (let k = 0; k < pins; k++) {
    const core = Manifold.cylinder(o.pinL - 1, o.pinD / 2, o.pinD / 2, 32).translate([0, 0, 0.5]);
    const bot = Manifold.cylinder(0.5, o.pinD / 2 - 0.4, o.pinD / 2, 32);
    const top = Manifold.cylinder(0.5, o.pinD / 2, o.pinD / 2 - 0.4, 32).translate([0, 0, o.pinL - 0.5]);
    const pin = Manifold.union([core, bot, top]);
    core.delete(); bot.delete(); top.delete();
    pinParts.push({ id: 'pin' + (k + 1), m: pin.translate([o.pinD / 2, o.pinD / 2, 0]), w: o.pinD, d: o.pinD, h: o.pinL, pin: true });
    pin.delete();
  }
  // раскладка по столам полками: слева направо, потом новая полка; не влезло — новый стол
  const W = o.bed[0] - 2 * o.margin, D = o.bed[1] - 2 * o.margin;
  const items = [...parts.sort((a, b) => b.d - a.d), ...pinParts];
  const plates = [];
  let cur = null;
  const newPlate = () => { cur = { items: [], x: 0, y: 0, row: 0 }; plates.push(cur); };
  newPlate();
  for (const it of items) {
    if (cur.x + it.w > W) { cur.x = 0; cur.y += cur.row + o.gap; cur.row = 0; }
    if (cur.y + it.d > D) { newPlate(); }
    const placed = it.m.translate([o.margin + cur.x, o.margin + cur.y, 0]);
    it.m.delete();
    cur.items.push({ ...it, m: placed });
    cur.x += it.w + o.gap; cur.row = Math.max(cur.row, it.d);
  }
  return { fits: false, parts: parts.length, pins, cuts, tooBig: parts.filter((p) => p.tooBig).length, plates: plates.map((p) => p.items) };
}
