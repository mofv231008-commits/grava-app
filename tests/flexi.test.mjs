// Тесты сборщика шарниров — тот же код, что в фоновом потоке телефона.
// Режим один — «⛓ Цепочка»: каждая ветвь режется на звенья.
// Как в телефоне: масштаб → срез низа → шаг 0 «перепаять» → автопоиск (по бороздкам) → сборка.
// Запуск: node tests/flexi.test.mjs [only=lizard,skeleton,octopus,snake,gecko]
// Итоговые STL — в tests/out/<имя>_chain.stl (не в git). tests/gecko.stl — настоящая модель от бота (геккон с бороздками);
// другие *.stl, если положить в tests/, прогоняются тоже.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Module from '../vendor/manifold/manifold.js';
import {
  parseSTL, writeSTL, loadModel, placeModel, repairModel, analyze, attachGrooves, autoCuts, orderCuts, buildJoints, meshOf,
} from '../flexi-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const arg = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').split('=')[1];
const ONLY = arg('only') ? arg('only').split(',') : null;

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;

/* ---------- модели ---------- */
const own = (m, f) => { const r = f(m); m.delete(); return r; };
const ell = (s, c) => own(own(Manifold.sphere(1, 48), (m) => m.scale(s)), (m) => m.translate(c));
const capsule = (r1, p, q, r2 = r1) => {
  const a = own(Manifold.sphere(r1, 32), (m) => m.translate(p));
  const b = own(Manifold.sphere(r2, 32), (m) => m.translate(q));
  const h = Manifold.hull([a, b]);
  a.delete(); b.delete();
  return h;
};
const finish = (parts) => {
  const u = Manifold.union(parts);
  parts.forEach((p) => p.delete());
  return own(u, (m) => m.trimByPlane([0, 0, 1], 0));
};

function lizard() {
  const ps = [ell([30, 14, 10], [0, 0, 7]), ell([13, 9, 8], [42, 0, 6])];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) ps.push(capsule(5.5, [sx * 18, sy * 8, 4], [sx * 24, sy * 34, 4]));
  ps.push(capsule(5.5, [-26, 0, 5], [-78, 0, 3.5]));
  return finish(ps);
}
function skeleton() {
  const ps = [ell([28, 9, 5], [0, 0, 5]), ell([12, 8, 7], [42, 0, 7]), capsule(1.6, [26, 0, 4], [32, 0, 4])];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    ps.push(capsule(1.5, [sx * 15, sy * 7, 3], [sx * 22, sy * 20, 3]));
    ps.push(capsule(1.5, [sx * 22, sy * 20, 3], [sx * 20, sy * 38, 2.5]));
  }
  ps.push(capsule(1.5, [-27, 0, 3], [-90, 0, 2]));
  return finish(ps);
}
function octopus() {
  const ps = [ell([22, 22, 18], [0, 0, 16])];
  for (let k = 0; k < 8; k++) {
    const th = k * 45 * Math.PI / 180;
    let x = 22 * Math.cos(th), y = 22 * Math.sin(th), dir = th;
    const segL = 80 / 6, turn = (60 * Math.PI / 180) / 6;
    for (let i = 0; i < 6; i++) {
      const r1 = 6 - (3 * i) / 6, r2 = 6 - (3 * (i + 1)) / 6;
      const nx = x + segL * Math.cos(dir), ny = y + segL * Math.sin(dir);
      ps.push(capsule(r1, [x, y, 5], [nx, ny, 5], r2));
      x = nx; y = ny; dir += turn;
    }
  }
  return finish(ps);
}
function snake() {
  // S-образная кривая, r=6, длина ~160 мм, плюс голова-эллипсоид
  const ps = [ell([18, 14, 9], [0, 0, 8])];
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push([-14 - t * 128, 26 * Math.sin(t * 2 * Math.PI), 6]);
  }
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  for (let i = 1; i < pts.length; i++) ps.push(capsule(6, pts[i - 1], pts[i]));
  return { m: finish(ps), L };
}

/* ---------- проверки ---------- */
let failed = 0;
const ok = (name, cond, extra) => {
  const ex = extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + ex);
  if (!cond) failed++;
};
const inter = (a, b) => { const x = a.intersect(b); const v = x.volume(); x.delete(); return v; };

function run(name, stl, expect) {
  const opts = { g: 0.45, alphaSeg: 15, k: 1.2 };
  const t0 = performance.now();
  const base = loadModel(wasm, parseSTL(stl));
  const length = expect.length || Math.max(150, base.length);
  const placed = placeModel(wasm, base.manifold, length, 1);
  const rep = repairModel(wasm, placed);
  placed.delete();
  const model = rep.manifold;
  const tRep = performance.now();
  const mesh = meshOf(model);
  const an = analyze(mesh, model.boundingBox());
  attachGrooves(an, rep);
  const found = autoCuts(an, opts);
  const auto = orderCuts(found.cuts.map((c, i) => ({ ...c, id: i + 1 })), an.skeleton);
  const res = buildJoints(wasm, model, mesh, an, auto, opts);
  const cuts = auto.filter((c) => !res.skipped.includes(c.id)); // пропущенные экран убирает
  const t1 = performance.now();

  const chains = new Set(cuts.map((c) => c.chain)).size;
  console.log(`\n${name} — длина ${length.toFixed(0)} мм, ветвей ${chains}, разрезов ${cuts.length}, звеньев ${res.joints.length}, деталей ${res.parts.length}, ${Math.round(t1 - t0)} мс (починка ${Math.round(tRep - t0)})`);
  console.log('  ' + res.summary + (res.skipped.length ? ` · пропущено автоматических: ${res.skipped.length}` : '') +
    (found.thin.length ? ` · тонко (сустав не прячется): ${found.thin.length} мест` : ''));
  res.notes.forEach((x) => console.log('   ' + (x.level === 'error' ? '✖ ' : '⚠ ') + x.text));

  ok('после починки — одна деталь', rep.parts === 1, rep.parts);
  if (expect.noLinks) {
    // кости тоньше любого сустава: звеньев нет, все места отмечены серым, фигурка — одна цельная деталь
    ok('звеньев нет — сустав не прячется', cuts.length === 0 && res.parts.length === 1, cuts.length);
    ok('тонкие места отмечены (серые точки)', found.thin.length >= expect.noLinks, found.thin.length);
    res.parts.forEach((p) => p.manifold.delete());
    model.delete();
    base.manifold.delete();
    return res;
  }
  if (expect.classify) expect.classify(cuts, an, length / base.length, rep, found);
  const errors = res.notes.filter((x) => x.level === 'error');
  const warns = res.notes.filter((x) => x.level === 'warn');
  ok('ни одной красной ошибки', errors.length === 0, errors.map((x) => x.text));
  ok('все звенья держат: сдвиг на 1 мм в 6 сторон задевает соседа', res.joints.length > 0 && res.joints.every((J) => J.hold));
  ok('соседи не пересекаются (и не слиплись: зазор ≥ 0.9·g)', res.joints.every((J) => J.gap >= 0.9 * opts.g),
    'зазоры: ' + res.joints.map((J) => J.gap.toFixed(2)).join(' '));
  let maxI = 0;
  for (let i = 0; i < res.parts.length; i++) {
    for (let j = i + 1; j < res.parts.length; j++) maxI = Math.max(maxI, inter(res.parts[i].manifold, res.parts[j].manifold));
  }
  ok('никакие две детали не пересекаются', maxI < 1e-6, maxI);
  ok('поворот на ±α свободен', !warns.some((x) => /упирается/.test(x.text)), warns.filter((x) => /упирается/.test(x.text)).map((x) => x.text));
  ok('нет пропущенных разрезов и висящих деталей', !warns.some((x) => /пропущен|висит/.test(x.text)), warns.map((x) => x.text));
  // сустав спрятан: ничего не выходит за кожу (цельную модель после починки). Плёнки ~0.01 мм на совпадающих
  // гранях — шум булевых операций, их не считаем: учитываются куски толще 0.05 мм (печатать такое нечем)
  if (res.parts.length > 1) {
    const U = Manifold.union(res.parts.map((p) => p.manifold));
    const out = U.subtract(model);
    let real = 0;
    out.decompose().forEach((c) => {
      const v = c.volume();
      if (v > 0 && (2 * v) / c.surfaceArea() > 0.05) real += v;
      c.delete();
    });
    ok('ничего не выходит за кожу: (все детали − кожа) < 1 мм³', real < 1, real.toFixed(3) + ' мм³ (с плёнками ' + out.volume().toFixed(2) + ')');
    const zU = U.boundingBox().max[2], zS = model.boundingBox().max[2];
    ok('высота не больше кожи + 0.05 мм', zU <= zS + 0.05, zU.toFixed(3) + ' / ' + zS.toFixed(3));
    out.delete();
    U.delete();
  }
  const vols = res.parts.map((p) => p.manifold.volume());
  ok('нет деталей меньше 20 мм³', vols.every((v) => v >= 20), 'мин. ' + Math.min(...vols).toFixed(0) + ' мм³');
  ok('деталей = звеньев + 1', res.parts.length === res.joints.length + 1, [res.parts.length, res.joints.length]);
  ok(`сборка быстрее ${expect.maxMs / 1000} с`, t1 - t0 < expect.maxMs, Math.round(t1 - t0) + ' мс');

  const file = writeSTL(res.parts.map((p) => meshOf(p.manifold)));
  fs.writeFileSync(path.join(OUT, name + '_chain.stl'), Buffer.from(file));
  const back = parseSTL(file);
  ok('STL открывается заново и меньше 12 МБ', back.length / 9 === new DataView(file).getUint32(80, true) && file.byteLength < 12 * 1048576,
    (file.byteLength / 1048576).toFixed(2) + ' МБ');
  res.parts.forEach((p) => p.manifold.delete());
  model.delete();
  base.manifold.delete();
  return res;
}

// Звенья по ветвям: ветвь = chain. Лапа — первая точка ветви сбоку от оси тела, хвост — сзади по оси.
const perChain = (cuts) => {
  const m = new Map();
  cuts.forEach((c) => {
    if (!m.has(c.chain)) m.set(c.chain, { first: c, n: 0 });
    m.get(c.chain).n++;
  });
  return [...m.values()];
};
const animal = (minTail) => (cuts, an, s) => {
  const [cx] = an.core;
  const legs = {}, tails = [];
  perChain(cuts).forEach(({ first: c, n }) => {
    if (Math.abs(c.P[1]) > 9 * s && Math.abs(c.P[1]) > Math.abs(c.P[0] - cx) * 0.35) {
      const side = (c.P[0] > cx ? 'перед' : 'зад') + (c.P[1] > 0 ? '-левая' : '-правая');
      legs[side] = (legs[side] || 0) + n;
    } else if (c.P[0] < cx - 10 && Math.abs(c.P[1]) < 9 * s) tails.push(n);
  });
  ok('на каждой из 4 лап ≥ 1 звено', Object.keys(legs).length === 4 && Object.values(legs).every((n) => n >= 1), legs);
  ok(`на хвосте ≥ ${minTail} звен${minTail === 1 ? 'о' : 'а'}`, tails.length >= 1 && Math.max(...tails) >= minTail, tails);
};
const arms = (cuts) => {
  const list = perChain(cuts).map((x) => x.n);
  ok('8 щупалец, на каждом ≥ 4 звена', list.length === 8 && list.every((n) => n >= 4), list);
};
const snakeCheck = (cuts) => ok('у змеи ≥ 8 звеньев', cuts.length >= 8, cuts.length);

// Эублефар лежит вдоль Y: голова −Y, хвост +Y. Шея и спина — до задних лап, дальше хвост.
// Лапы тонкие — сустав в них не прячется, звеньев там может не быть.
const gecko = (cuts, an) => {
  const spine = cuts.filter((c) => Math.abs(c.P[0]) <= 9);
  const exits = an.branches.filter((br) => br.ex >= 0).map((br) => br.pts[br.ex]).filter((p) => Math.abs(p[0]) > 9 && p[1] > 0);
  const hip = exits.length ? Math.max(...exits.map((p) => p[1])) : 0;
  const back = spine.filter((c) => c.P[1] <= hip), tail = spine.filter((c) => c.P[1] > hip);
  ok('на шее и спине ≥ 3 звена', back.length >= 3, back.map((c) => c.P[1].toFixed(1)));
  ok('на хвосте ≥ 2 звена', tail.length >= 2, tail.map((c) => c.P[1].toFixed(1)));
};

const MODELS = {
  // у осьминога щупальца тонкие: при 189 мм спрятанный сустав влезает только у основания — проверяем на 250 мм
  octopus: () => ({ m: octopus(), expect: { classify: arms, length: 250, maxMs: 45000 } }),
  snake: () => ({ m: snake().m, expect: { classify: snakeCheck, maxMs: 30000 } }),
  lizard: () => ({ m: lizard(), expect: { classify: animal(3), maxMs: 30000 } }),
  // кости скелета (полуширина ~2 мм) тоньше любого спрятанного сустава: звеньев нет, 4 лапы и хвост — серым
  skeleton: () => ({ m: skeleton(), expect: { noLinks: 5, maxMs: 30000 } }),
};

const T0 = performance.now();
for (const [name, mk] of Object.entries(MODELS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const { m, expect } = mk();
  const stl = writeSTL([meshOf(m)]);
  m.delete();
  fs.writeFileSync(path.join(OUT, name + '.stl'), Buffer.from(stl));
  run(name, stl, expect);
}
// настоящие модели от бота из tests/: геккон — со своими проверками, остальные — общими
const REAL = { gecko: { length: 150, classify: gecko, maxMs: 45000 } };
for (const f of fs.readdirSync(HERE).filter((x) => /\.stl$/i.test(x))) {
  const name = f.replace(/\.stl$/i, '');
  if (ONLY && !ONLY.includes(name) && !ONLY.includes(f)) continue;
  const stl = fs.readFileSync(path.join(HERE, f));
  const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  run(name, buf, REAL[name] || { maxMs: 60000 });
}
console.log(`\n${failed ? '✘ провалено проверок: ' + failed : '✔ все проверки прошли'} · ${Math.round(performance.now() - T0)} мс · STL — в tests/out/`);
process.exitCode = failed ? 1 : 0;
