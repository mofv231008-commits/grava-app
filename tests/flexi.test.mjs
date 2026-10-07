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
  parseSTL, writeSTL, loadModel, placeModel, repairModel, analyze, attachGrooves, autoCuts, orderCuts, buildJoints, meshOf, verticalSpan,
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
// Кот лёжа: тело, голова, 4 лапы и хвост
function cat() {
  const ps = [ell([40, 14, 11], [0, 0, 10]), ell([13, 12, 11], [50, 0, 10])];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) ps.push(capsule(5, [sx * 25, sy * 10, 5], [sx * 30, sy * 32, 5]));
  ps.push(capsule(5, [-40, 0, 6], [-95, 0, 5]));
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
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
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
    // кости тоньше любого сустава: на лапах звеньев нет, все места отмечены серым; режется только тело
    ok('на тонких костях звеньев нет (только позвоночник)', cuts.every((c) => c.spine), cuts.filter((c) => !c.spine).length);
    ok('тонкие места отмечены (серые точки)', found.thin.length >= expect.noLinks, found.thin.length);
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
    // decompose на почти пустой плёнке роняет manifold — раскладываем только когда есть что считать
    const total = out.volume();
    let real = Math.max(0, total);
    if (total >= 1) {
      real = 0;
      out.decompose().forEach((c) => {
        const v = c.volume();
        if (v > 0 && (2 * v) / c.surfaceArea() > 0.05) real += v;
        c.delete();
      });
    }
    ok('ничего не выходит за кожу: (все детали − кожа) < 1 мм³', real < 1, real.toFixed(3) + ' мм³ (с плёнками ' + out.volume().toFixed(2) + ')');
    const zU = U.boundingBox().max[2], zS = model.boundingBox().max[2];
    ok('высота не больше кожи + 0.05 мм', zU <= zS + 0.05, zU.toFixed(3) + ' / ' + zS.toFixed(3));
    out.delete();
    U.delete();
  }
  // точки модели (как она построена) → после «масштаб, центр в (0,0), срез низа 1 мм»
  const b0 = base.manifold.boundingBox(), sc = length / base.length;
  const T = (x, y, z) => [(x - (b0.min[0] + b0.max[0]) / 2) * sc, (y - (b0.min[1] + b0.max[1]) / 2) * sc, (z - b0.min[2]) * sc - 1];
  if (expect.after) expect.after(res, an, T);
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
// Лапы — цепочки не позвоночника (сбоку от оси тела), хвост — звенья позвоночника позади тела.
const animal = (minTail) => (cuts, an, s) => {
  const [cx] = an.core;
  const legs = {};
  perChain(cuts.filter((c) => !c.spine)).forEach(({ first: c, n }) => {
    if (Math.abs(c.P[1]) > 9 * s && Math.abs(c.P[1]) > Math.abs(c.P[0] - cx) * 0.35) {
      const side = (c.P[0] > cx ? 'перед' : 'зад') + (c.P[1] > 0 ? '-левая' : '-правая');
      legs[side] = (legs[side] || 0) + n;
    }
  });
  // хвост — звенья позвоночника позади задних лап
  const rear = cuts.filter((c) => !c.spine && c.root && c.P[0] < cx).map((c) => c.P[0]);
  const hip = rear.length ? Math.min(...rear) : cx - 30 * s;
  const tail = cuts.filter((c) => c.spine && c.P[0] < hip - 3);
  ok('на каждой из 4 лап ≥ 1 звено', Object.keys(legs).length === 4 && Object.values(legs).every((n) => n >= 1), legs);
  ok(`на хвосте ≥ ${minTail} звен${minTail === 1 ? 'о' : 'а'}`, tail.length >= minTail, tail.map((c) => c.P[0].toFixed(1)));
  ok('позвоночник режет и тело', cuts.some((c) => c.spine && Math.abs(c.P[0] - cx) < 25 * s), cuts.filter((c) => c.spine).map((c) => c.P[0].toFixed(1)));
};
const arms = (cuts) => {
  const list = perChain(cuts).map((x) => x.n);
  ok('8 щупалец, на каждом ≥ 4 звена', list.length === 8 && list.every((n) => n >= 4), list);
};
const snakeCheck = (cuts) => ok('у змеи ≥ 8 звеньев', cuts.length >= 8, cuts.length);

// Лапы по анализу: ветвь, выходящая из тела не по позвоночнику; корень — точка позвоночника напротив выхода,
// середина — 5 мм за выходом, кончик — 2 мм до конца ветви (z — середина кожи в точке).
function legsFromAnalysis(an, mesh) {
  const sp = an.branches[0];
  const zAt = (p) => { const v = verticalSpan(mesh, p[0], p[1]); return v ? [p[0], p[1], (v.zb + v.zt) / 2] : null; };
  const legs = [];
  an.branches.slice(1).forEach((br) => {
    if (br.ex < 0) return;
    const ex = br.pts[br.ex];
    if (sp.pts.some((q) => Math.hypot(q[0] - ex[0], q[1] - ex[1]) < 1.5)) return;
    if (legs.some((l) => Math.hypot(l.ex[0] - ex[0], l.ex[1] - ex[1]) < 6)) return;
    let kb = 0, bd = Infinity;
    sp.pts.forEach((q, k) => { const d = (q[0] - ex[0]) ** 2 + (q[1] - ex[1]) ** 2; if (d < bd) { bd = d; kb = k; } });
    const at = (s) => { let k = 0; while (k < br.cum.length - 1 && br.cum[k] < s) k++; return br.pts[k]; };
    const root = zAt(sp.pts[kb]), mid = zAt(at(br.cum[br.ex] + 5)), tip = zAt(at(br.cum[br.cum.length - 1] - 2));
    if (root && mid && tip) legs.push({ name: `(${ex[0].toFixed(0)},${ex[1].toFixed(0)})`, ex, root, mid, tip });
  });
  return legs;
}

// Эублефар лежит вдоль Y: голова −Y, хвост +Y. Шея и спина — до задних лап, дальше хвост.
// Лапы тонкие — сустав в них не прячется, звеньев там может не быть.
const gecko = (cuts, an) => {
  const spine = cuts.filter((c) => Math.abs(c.P[0]) <= 9);
  const exits = an.branches.filter((br) => br.ex >= 0).map((br) => br.pts[br.ex]).filter((p) => Math.abs(p[0]) > 9 && p[1] > 0);
  const hip = exits.length ? Math.max(...exits.map((p) => p[1])) : 0;
  const back = spine.filter((c) => c.P[1] <= hip), tail = spine.filter((c) => c.P[1] > hip);
  ok('на теле (шея и спина) ≥ 3 звена', back.length >= 3, back.map((c) => c.P[1].toFixed(1)));
  ok('на хвосте ≥ 2 звена', tail.length >= 2, tail.map((c) => c.P[1].toFixed(1)));
};

// Деталь, в которой лежит точка (кубик 0.2 мм).
const partAt = (parts, x, y, z) => parts.findIndex((p) => {
  const c = Manifold.cube([0.2, 0.2, 0.2], true);
  const t = c.translate([x, y, z]);
  const v = inter(p.manifold, t);
  c.delete(); t.delete();
  return v > 0;
});
// Лапа на своём звене позвоночника: основание (тело над выходом лапы) — звено позвоночника, а не голова (корень);
// лапа — либо в той же детали, либо цепочкой звеньев, первое из которых держится именно на этом звене.
// Передние — на одном («грудном»), задние — на другом («тазовом»).
function legsOnLinks(res, legs, T = (x, y, z) => [x, y, z]) {
  // деталь-родитель: та, ребёнком которой не является эта деталь, — по суставу, на котором она держится
  const parentPart = (pi) => {
    const j = res.parts[pi].joint;
    return j < 0 ? -1 : res.parts.findIndex((p) => p.joint === res.joints[j].parent);
  };
  // часть лапы → вверх по цепочке, пока не выйдем из лапы на деталь тела
  const rootOf = (pi, body) => {
    for (let k = 0; k < 20 && pi >= 0 && pi !== body; k++) pi = parentPart(pi);
    return pi;
  };
  const where = legs.map(({ name, root, mid, tip }) => ({ name, body: partAt(res.parts, ...T(...root)), mid: partAt(res.parts, ...T(...mid)), tip: partAt(res.parts, ...T(...tip)) }));
  const whole = where.every((x) => x.body >= 0 && res.parts[x.body].joint >= 0 && x.mid >= 0 && x.tip >= 0 &&
    rootOf(x.mid, x.body) === x.body && rootOf(x.tip, x.body) === x.body);
  ok('лапы держатся на звеньях позвоночника (не на голове)', whole, where.map((x) => `${x.name}: тело ${x.body}, лапа ${x.mid}/${x.tip}`).join(', '));
  return where;
}
const catCheck = (cuts) => {
  const X = (c) => c.P[0] - 18.5; // назад в координаты модели
  const spine = cuts.filter((c) => c.spine);
  const between = spine.filter((c) => X(c) > -40 && X(c) < 40);
  ok('≥ 5 звеньев на позвоночнике между головой и хвостом (включая тело)', spine.filter((c) => X(c) > -95 && X(c) < 40).length >= 5,
    spine.map((c) => X(c).toFixed(1)).join(' '));
  ok('позвоночник режет и тело (≥ 3 звена внутри тела)', between.length >= 3, between.map((c) => X(c).toFixed(1)).join(' '));
};
const catLegs = (res, an, T) => {
  const legs = [];
  for (const sx of [1, -1]) for (const sy of [1, -1]) legs.push({ name: (sx > 0 ? 'перед' : 'зад') + (sy > 0 ? '-лев' : '-прав'), root: [sx * 25, sy * 6, 9], mid: [sx * 27.5, sy * 21, 4], tip: [sx * 29.5, sy * 30, 4] });
  const w = legsOnLinks(res, legs, T);
  ok('передние на одном звене, задние на другом', w[0].body === w[1].body && w[2].body === w[3].body && w[0].body !== w[2].body, w.map((x) => x.body));
};

const MODELS = {
  // у осьминога щупальца тонкие: при 189 мм спрятанный сустав влезает только у основания — проверяем на 250 мм
  octopus: () => ({ m: octopus(), expect: { classify: arms, length: 250, maxMs: 45000 } }),
  cat: () => ({ m: cat(), expect: { classify: catCheck, after: catLegs, maxMs: 45000 } }),
  snake: () => ({ m: snake().m, expect: { classify: snakeCheck, maxMs: 30000 } }),
  lizard: () => ({ m: lizard(), expect: { classify: animal(3), maxMs: 30000 } }),
  // кости скелета (полуширина ~2 мм) тоньше любого спрятанного сустава: на них звеньев нет, 4 лапы и хвост — серым
  skeleton: () => ({ m: skeleton(), expect: { noLinks: 5, maxMs: 30000 } }),
};

// Отдельно сустав «ушко в петле»: брусок W×H (длина 60), один разрез посередине.
function jointBar(W, H) {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const bar = own(Manifold.cube([60, W, H]), (m) => m.translate([-30, -W / 2, 0]));
  const mesh = meshOf(bar);
  const an = analyze(mesh, bar.boundingBox());
  const res = buildJoints(wasm, bar, mesh, an, [{ id: 1, P: [0, 0], n: [1, 0], w: W / 2, chain: 0 }], opts);
  console.log(`\nсустав в бруске ${W}×${H} мм — ${res.summary}`);
  const J = res.joints[0] || {};
  ok('2 детали, обе цельные', res.parts.length === 2 && res.parts.every((p) => { const cs = p.manifold.decompose(); const n = cs.length; cs.forEach((c) => c.delete()); return n === 1; }));
  ok('сдвиг ребёнка на 1 мм в любую из 6 сторон задевает родителя', J.hold === true);
  ok('поворот ±20° свободен', J.turn != null && J.turn <= 0.5 && J.alpha === 20, J.turn);
  ok('минимальный зазор ≥ 0.4 мм', J.gap >= 0.4, J.gap && J.gap.toFixed(3));
  ok('ни одной ошибки', !res.notes.some((x) => x.level === 'error'), res.notes.map((x) => x.text));
  res.parts.forEach((p) => p.manifold.delete());
  bar.delete();
}

const T0 = performance.now();
if (!ONLY || ONLY.includes('joint')) { jointBar(16, 11); jointBar(10, 8); }
for (const [name, mk] of Object.entries(MODELS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const { m, expect } = mk();
  const stl = writeSTL([meshOf(m)]);
  m.delete();
  fs.writeFileSync(path.join(OUT, name + '.stl'), Buffer.from(stl));
  run(name, stl, expect);
}
// настоящие модели от бота из tests/: геккон — со своими проверками, остальные — общими
// у эублефара лапы тонкие (звеньев на них нет), но каждая — целиком на своём звене позвоночника
const geckoLegs = (res, an) => legsOnLinks(res, legsFromAnalysis(an, an.mesh));
const REAL = { gecko: { length: 150, classify: gecko, after: geckoLegs, maxMs: 45000 } };
for (const f of fs.readdirSync(HERE).filter((x) => /\.stl$/i.test(x))) {
  const name = f.replace(/\.stl$/i, '');
  if (ONLY && !ONLY.includes(name) && !ONLY.includes(f)) continue;
  const stl = fs.readFileSync(path.join(HERE, f));
  const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  run(name, buf, REAL[name] || { maxMs: 60000 });
}
console.log(`\n${failed ? '✘ провалено проверок: ' + failed : '✔ все проверки прошли'} · ${Math.round(performance.now() - T0)} мс · STL — в tests/out/`);
process.exitCode = failed ? 1 : 0;
