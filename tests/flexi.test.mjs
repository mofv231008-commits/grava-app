// Тесты сборщика шарниров — тот же код, что в фоновом потоке телефона.
// Режим один — «⛓ Цепочка»: разрезы ставит человек (тап по фигурке), каждый сразу проверяется.
// Как в телефоне: масштаб → срез низа → шаг 0 «перепаять» → «✨ Предложить» → тап по точкам (зелёные остаются) → сборка.
// Запуск: node tests/flexi.test.mjs [only=hint,joint,taps,lizard,skeleton,octopus,snake,cat,gecko]
// Итоговые STL — в tests/out/<имя>_chain.stl (не в git). tests/gecko.stl — настоящая модель от бота (геккон с бороздками);
// другие *.stl, если положить в tests/, прогоняются тоже.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Module from '../vendor/manifold/manifold.js';
import {
  parseSTL, writeSTL, loadModel, placeModel, repairModel, analyze, attachGrooves, autoCuts, orderCuts, buildJoints, meshOf, verticalSpan,
  jointBodies, jointOutside, jointAt, placeCut, checkCut, prevCut, tooClose, branchGrooves, limbsOf, SKIN_TOL,
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
// Ящерица с хвостом, сужающимся к кончику (как у настоящих): посередине хвоста сустав помещается, у кончика — нет.
function newt() {
  const ps = [ell([30, 14, 10], [0, 0, 7]), ell([13, 9, 8], [42, 0, 6])];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) ps.push(capsule(5.5, [sx * 18, sy * 8, 4], [sx * 24, sy * 34, 4]));
  ps.push(capsule(8, [-26, 0, 7], [-100, 0, 1.8], 1.8));
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

// Сустав спрятан: ничего не выходит за кожу (цельную модель после починки) и итог не выше неё.
// Плёнки ~0.01 мм на совпадающих гранях — шум булевых операций, их не считаем: учитываются куски толще 0.05 мм.
// skinIn (если дан): у готовой подвижной модели (эублефар) сустав может стоять в её прорези или полости от старого
// сустава — это не наружу; считается только то, что вне кожи и вне skinIn (кожи с заплавленными прорезями,
// сжатой на 0.8 мм), то есть выходит к наружной поверхности.
function skinCheck(parts, skin, skinIn) {
  const U = Manifold.union(parts.map((p) => p.manifold));
  const out0 = U.subtract(skin);
  const out = skinIn ? out0.subtract(skinIn) : out0.translate([0, 0, 0]);
  out0.delete();
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
  ok('ничего не выходит за кожу: объём (все детали − кожа' + (skinIn ? ' − прорези и полости модели' : '') + ') < 1 мм³', real < 1, real.toFixed(3) + ' мм³ (с плёнками ' + total.toFixed(2) + ')');
  const zU = U.boundingBox().max[2], zS = skin.boundingBox().max[2];
  ok('высота итога ≤ высота кожи + 0.05 мм', zU <= zS + 0.05, zU.toFixed(3) + ' / ' + zS.toFixed(3));
  out.delete();
  U.delete();
}

// Ни один сустав не выходит за skinIn (кожа, сжатая внутрь на 0.8 мм, снизу у стола не сжата): тела сустава
// строятся заново по его размерам, объём (петля ∪ кольцо) − skinIn < 1 мм³ (шейку не считаем — она по коже).
function skinInCheck(joints, skinIn) {
  const outs = joints.map((J) => {
    const B = jointBodies(wasm, J.dims, J.P, J.n);
    const o = jointOutside(wasm, B, J.P, J.n, Math.max(J.dims.La + 3, J.dims.Re + J.dims.g + 2), skinIn);
    Object.values(B).forEach((m) => m.delete());
    return o.v;
  });
  const worst = outs.length ? Math.max(...outs) : 0;
  ok('ни один сустав не выходит за skinIn: (петля ∪ кольцо) − skinIn < 1 мм³', worst < SKIN_TOL, worst.toFixed(3) + ' мм³');
}

// Модель как в телефоне: масштаб, срез низа, починка, анализ, бороздки, skinIn.
function prepare(stl, length) {
  const base = loadModel(wasm, parseSTL(stl));
  if (!length) length = Math.max(150, base.length);
  const placed = placeModel(wasm, base.manifold, length, 1);
  const rep = repairModel(wasm, placed);
  placed.delete();
  const model = rep.manifold;
  const mesh = meshOf(model);
  const an = analyze(mesh, model.boundingBox());
  attachGrooves(an, rep);
  an.skinIn = rep.skinIn; // кожа, сжатая на 0.8 мм
  an.inAt = rep.inAt;
  // точки модели (как она построена) → после «масштаб, центр в (0,0), срез низа 1 мм»
  const b0 = base.manifold.boundingBox(), sc = length / base.length;
  const T = (x, y, z = 0) => [(x - (b0.min[0] + b0.max[0]) / 2) * sc, (y - (b0.min[1] + b0.max[1]) / 2) * sc, (z - b0.min[2]) * sc - 1];
  const free = () => [model, rep.skinIn, base.manifold].forEach((m) => m.delete());
  return { base, length, rep, model, mesh, an, T, free };
}

/* Как человек: «✨ Предложить», тап по каждой точке, где сустав помещается, — разрез ставится и проверяется
   (placeCut → checkCut вместе с разрезом ближе к телу на той же цепочке, как на экране). Красные (не прошли проверку
   или ближе 2 мм к соседнему) он убирает. Остальное — в сборку. */
function acceptSuggestions(M, opts) {
  const { an, model, mesh } = M;
  const found = autoCuts(an, opts);
  const kept = [], red = [];
  let same = true;
  for (const q of orderCuts(found.cuts, an.skeleton)) {
    const c = placeCut(an, opts, q.P[0], q.P[1], q.br, false);
    if (!c || Math.hypot(c.P[0] - q.P[0], c.P[1] - q.P[1]) > 1e-6) same = false;
    if (!c) continue;
    const onPath = (P) => an.branches[c.br].pts.some((p) => Math.hypot(p[0] - P[0], p[1] - P[1]) < 1.5);
    const v = c.fit ? checkCut(wasm, model, mesh, an, c, opts, prevCut(kept, c, onPath)) : { ok: false, code: 'thin' };
    if (!v.ok) { red.push(v.code); continue; }
    if (kept.some((o) => tooClose(o, c))) { red.push('near'); continue; }
    kept.push(Object.assign(c, { id: kept.length + 1 }));
  }
  return { found, cuts: orderCuts(kept, an.skeleton), red, same };
}

function run(name, stl, expect) {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const t0 = performance.now();
  const M = prepare(stl, arg('len') ? +arg('len') : expect.length);
  const { base, length, rep, model, mesh, an, T } = M;
  const tRep = performance.now();
  const { found, cuts, red, same } = acceptSuggestions(M, opts);
  const tChk = performance.now();
  const res = buildJoints(wasm, model, mesh, an, cuts, opts);
  const t1 = performance.now();

  const chains = new Set(cuts.map((c) => c.chain)).size;
  console.log(`\n${name} — длина ${length.toFixed(0)} мм, ветвей ${chains}, разрезов ${cuts.length}, звеньев ${res.joints.length}, деталей ${res.parts.length}, ${Math.round(t1 - t0)} мс (починка ${Math.round(tRep - t0)}, проверка разрезов ${Math.round(tChk - tRep)}, сборка ${Math.round(t1 - tChk)})`);
  console.log('  ' + res.summary + (found.small ? ' · «сделай крупнее»' : '') + ` · предложено ${found.cuts.length} + тонко ${found.thin.length}` +
    (red.length ? ` · красных после тапа: ${red.length} (${red.join(', ')})` : ''));
  res.notes.forEach((x) => console.log('   ' + (x.level === 'error' ? '✖ ' : '⚠ ') + x.text));

  ok('после починки — одна деталь', rep.parts === 1, rep.parts);
  ok('«✨ Предложить»: точки есть', found.cuts.length + found.thin.length > 0, found.cuts.length + ' + ' + found.thin.length);
  ok('тап по точке-предложению ставит разрез ровно в неё', same);
  ok('зелёных разрезов из предложенных — не меньше 80 %', cuts.length >= 0.8 * found.cuts.length, cuts.length + ' из ' + found.cuts.length);
  if (expect.small != null) {
    ok(expect.small ? 'подсказка «Сделай фигурку крупнее» — суставы помещаются не везде' : 'подсказки «сделай крупнее» нет — суставы помещаются',
      found.small === expect.small, found.small);
  }
  if (expect.noLinks) {
    // кости тоньше любого сустава: на лапах звеньев нет, все места отмечены серым; режется только тело
    ok('на тонких костях звеньев нет (только позвоночник)', cuts.every((c) => c.spine), cuts.filter((c) => !c.spine).length);
    ok('тонкие места — серые точки-предложения', found.thin.length >= expect.noLinks, found.thin.length);
  }
  if (expect.classify) expect.classify(cuts, an, length / base.length, rep, found);
  const errors = res.notes.filter((x) => x.level === 'error');
  const warns = res.notes.filter((x) => x.level === 'warn');
  ok('ни одной красной ошибки', errors.length === 0, errors.map((x) => x.text));
  ok('все звенья держат: сдвиг на 1 мм в 6 сторон задевает соседа', res.joints.every((J) => J.hold), res.joints.length + ' звеньев');
  ok('соседи не пересекаются (и не слиплись: зазор ≥ 0.9·g)', res.joints.every((J) => J.gap >= 0.9 * opts.g),
    'зазоры: ' + res.joints.map((J) => J.gap.toFixed(2)).join(' '));
  let maxI = 0;
  for (let i = 0; i < res.parts.length; i++) {
    for (let j = i + 1; j < res.parts.length; j++) maxI = Math.max(maxI, inter(res.parts[i].manifold, res.parts[j].manifold));
  }
  ok('никакие две детали не пересекаются', maxI < 1e-6, maxI);
  ok('поворот на ±α свободен', !warns.some((x) => /упирается/.test(x.text)), warns.filter((x) => /упирается/.test(x.text)).map((x) => x.text));
  ok('нет висящих деталей', !warns.some((x) => /висит/.test(x.text)), warns.map((x) => x.text));
  skinCheck(res.parts, model, rep.skinIn);
  skinInCheck(res.joints, rep.skinIn);
  if (expect.after) expect.after(res, an, T);
  if (expect.snap) expect.snap(M, opts);
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
  M.free();
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
  // хвост — звенья позвоночника позади задних лап (первое звено каждой лапы — у тела: разрезы идут в порядке сборки)
  const rear = perChain(cuts.filter((c) => !c.spine)).map((x) => x.first).filter((c) => c.P[0] < cx).map((c) => c.P[0]);
  const hip = rear.length ? Math.min(...rear) : cx - 30 * s;
  const tail = cuts.filter((c) => c.spine && c.P[0] < hip - 3);
  ok('на каждой из 4 лап ≥ 1 звено', Object.keys(legs).length === 4 && Object.values(legs).every((n) => n >= 1), legs);
  ok(`на хвосте ≥ ${minTail} звен${minTail === 1 ? 'о' : 'а'}`, tail.length >= minTail, tail.map((c) => c.P[0].toFixed(1)));
  ok('позвоночник режет и тело', cuts.some((c) => c.spine && Math.abs(c.P[0] - cx) < 25 * s), cuts.filter((c) => c.spine).map((c) => c.P[0].toFixed(1)));
};
const arms = (min) => (cuts) => {
  const list = perChain(cuts).map((x) => x.n);
  ok(`8 щупалец, на каждом ≥ ${min} звена`, list.length === 8 && list.every((n) => n >= min), list);
};
const snakeCheck = (cuts) => ok('у змеи ≥ 8 звеньев', cuts.length >= 8, cuts.length);



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

// Размер печати. Суставы теперь с минимумами в мм (стойка ⌀ ≥ 3.2, стенка ушка ≥ 2.0, перекладины ≥ 2.4) —
// на тонких лапах и хвостах маленькой фигурки им негде поместиться, приложение тогда просит сделать крупнее.
// Полные цепочки проверяем на том размере, где сустав помещается (от 18 см, как и советует подсказка).
const MODELS = {
  // щупальца сужаются к кончику: даже при 250 мм сустав влезает на первые ~3 звена каждого
  // время — с проверкой каждого разреза (как на экране после тапа) и сборкой
  octopus: () => ({ m: octopus(), expect: { classify: arms(3), length: 250, small: false, maxMs: 90000 } }),
  cat: () => ({ m: cat(), expect: { classify: catCheck, after: catLegs, length: 250, small: false, maxMs: 75000 } }),
  snake: () => ({ m: snake().m, expect: { classify: snakeCheck, length: 180, maxMs: 60000 } }),
  lizard: () => ({ m: lizard(), expect: { classify: animal(3), length: 180, small: false, maxMs: 60000 } }),
  // кости скелета (полуширина ~2 мм) тоньше любого спрятанного сустава: на них звеньев нет, 4 лапы — серым
  skeleton: () => ({ m: skeleton(), expect: { noLinks: 4, small: true, maxMs: 30000 } }),
};

// Отдельно сустав «ушко в петле»: брусок W×H, длина 60, верх скруглён (r = H/4), один разрез посередине.
// Всё меряется здесь, по готовым деталям, а не по отчёту сборщика.
function roundedBar(W, H) {
  const r = H / 4, L = 60;
  const base = own(Manifold.cube([L, W, H - r]), (m) => m.translate([-L / 2, -W / 2, 0]));
  const rod = (y) => own(own(Manifold.cylinder(L, r, r, 32), (m) => m.rotate([0, 90, 0])), (m) => m.translate([-L / 2, y, H - r]));
  const a = rod(-W / 2 + r), b = rod(W / 2 - r);
  const bar = Manifold.hull([base, a, b]);
  [base, a, b].forEach((m) => m.delete());
  return bar;
}
// Луч по сетке детали вдоль оси ax (0 — x, 1 — y, 2 — z) через точку p: отрезки, где луч внутри детали.
function rayIn(m, ax, p) {
  const mesh = meshOf(m), v = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
  const [b, c] = [0, 1, 2].filter((k) => k !== ax);
  const pb = p[b] + 1.3e-5, pc = p[c] + 2.7e-5; // мимо рёбер
  const ts = [];
  for (let t = 0; t < tv.length; t += 3) {
    const A = tv[t] * np, Bi = tv[t + 1] * np, C = tv[t + 2] * np;
    const ab = v[A + b], ac = v[A + c], bb = v[Bi + b], bc = v[Bi + c], cb = v[C + b], cc = v[C + c];
    const den = (bc - cc) * (ab - cb) + (cb - bb) * (ac - cc);
    if (Math.abs(den) < 1e-14) continue;
    const l1 = ((bc - cc) * (pb - cb) + (cb - bb) * (pc - cc)) / den;
    const l2 = ((cc - ac) * (pb - cb) + (ab - cb) * (pc - cc)) / den;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    ts.push(l1 * v[A + ax] + l2 * v[Bi + ax] + l3 * v[C + ax]);
  }
  ts.sort((x, y) => x - y);
  const iv = [];
  for (let i = 0; i + 1 < ts.length; i += 2) iv.push([ts[i], ts[i + 1]]);
  return iv;
}
const lenAt = (iv, x) => { const s = iv.find(([a, b]) => a <= x && x <= b); return s ? s[1] - s[0] : 0; };
const firstAfter = (iv, x) => { const s = iv.find(([a]) => a > x); return s ? s[1] - s[0] : 0; };

function jointBar(W, H) {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const bar = roundedBar(W, H);
  const mesh = meshOf(bar);
  const an = analyze(mesh, bar.boundingBox());
  const res = buildJoints(wasm, bar, mesh, an, [{ id: 1, P: [0, 0], n: [1, 0], w: W / 2, chain: 0 }], opts);
  console.log(`\nсустав в бруске ${W}×${H} мм — ${res.summary}`);
  const comps = (m) => { const cs = m.decompose(); const n = cs.length; cs.forEach((c) => c.delete()); return n; };
  ok('деталей ровно 2, обе цельные', res.parts.length === 2 && res.parts.every((p) => comps(p.manifold) === 1), res.parts.length);
  const child = (res.parts.find((p) => p.joint === 0) || {}).manifold, parent = (res.parts.find((p) => p.joint === -1) || {}).manifold;
  const J = res.joints[0];
  if (child && parent && J) {
    const hit = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((v) => {
      const m = child.translate(v);
      const x = inter(m, parent);
      m.delete();
      return x;
    });
    ok('сдвиг ребёнка на 1 мм в любую из 6 сторон задевает родителя', hit.every((x) => x > 0.01), hit.map((x) => x.toFixed(1)).join(' '));
    const turn = [-20, 20].map((a) => { const m = child.rotate([0, 0, a]); const x = inter(m, parent); m.delete(); return x; });
    ok('поворот на ±20° свободен (пересечение ≤ 0.5 мм³)', turn.every((x) => x <= 0.5), turn.map((x) => x.toFixed(3)).join(' / '));
    const gap = child.minGap(parent, 1);
    ok('минимальный зазор ≥ 0.4 мм', gap >= 0.4, gap.toFixed(3));
    // толщины — по готовой сетке, на высоте ушка (середина кольца)
    const d = J.dims, ze = d.z0 + (d.ez0 + d.ez1) / 2;
    const stand = Math.min(lenAt(rayIn(child, 0, [0, 0, ze]), 0), lenAt(rayIn(child, 1, [0, 0, ze]), 0));
    ok('стойка петли ⌀ ≥ 3.2 мм (срез на высоте ушка)', stand >= 3.2 - 0.05, stand.toFixed(2) + ' мм');
    const wall = Math.min(firstAfter(rayIn(parent, 0, [0, 0, ze]), 0.1), firstAfter(rayIn(parent, 1, [0, 0, ze]), 0.1),
      firstAfter(rayIn(parent, 1, [0, 0, ze]).map(([a, b]) => [-b, -a]).reverse(), 0.1));
    ok('стенка ушка ≥ 2.0 мм (вперёд и по бокам от стойки)', wall >= 2.0 - 0.05, wall.toFixed(2) + ' мм');
    // перекладины: материал ребёнка под ушком и над ним, в проёме петли перед стойкой
    const xa = (d.dp / 2 + d.g + d.Re) / 2;
    const zr = rayIn(child, 2, [xa, 0, 0]);
    const below = lenAt(zr, d.z0 + 0.3), above = firstAfter(zr, d.z0 + d.ez1);
    ok('перекладины ≥ 2.4 мм (под ушком и над ним)', Math.min(below, above) >= 2.4 - 0.05, below.toFixed(2) + ' / ' + above.toFixed(2) + ' мм');
  }
  ok('ни одной ошибки', !res.notes.some((x) => x.level === 'error'), res.notes.map((x) => x.text));
  skinCheck(res.parts, bar);
  // тот же брусок как в телефоне — после починки, со сжатой кожей: петля стоит на столе и снизу не «вылезает»
  const rep = repairModel(wasm, bar);
  const mesh2 = meshOf(rep.manifold);
  const an2 = analyze(mesh2, rep.manifold.boundingBox());
  an2.skinIn = rep.skinIn;
  an2.inAt = rep.inAt;
  const d2 = jointAt(an2, opts, W / 2, [0, 0], [1, 0]);
  const B2 = jointBodies(wasm, d2, [0, 0], [1, 0]);
  const o2 = jointOutside(wasm, B2, [0, 0], [1, 0], Math.max(d2.La + 3, d2.Re + d2.g + 2), rep.skinIn, d2);
  Object.values(B2).forEach((m) => m.delete());
  ok('(петля ∪ кольцо) − skinIn < 1 мм³ (кожа у стола снизу не сжата), низ сустава на столе', o2.v < SKIN_TOL && d2.z0 < 0.3,
    o2.v.toFixed(3) + ' мм³, низ ' + d2.z0.toFixed(2) + ' мм');
  const v2 = checkCut(wasm, rep.manifold, mesh2, an2, { id: 1, P: [0, 0], n: [1, 0], w: W / 2, chain: 0 }, opts);
  ok('сустав зелёный (проверка разреза как на экране)', v2.ok, v2);
  [rep.manifold, rep.skinIn].forEach((m) => m.delete());
  res.parts.forEach((p) => p.manifold.delete());
  bar.delete();
}

// Сустав по размерам помещается, но вылезает из сжатой кожи: брусок 16×11 с глубоким пазом сбоку (4 мм шириной —
// шире, чем заплавляется; до 2.8 мм от оси) позади разреза — кольцо ушка выходит в паз.
// Причина — «сустав вылезает наружу сбоку на N мм³».
function outsideReason() {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const bar = roundedBar(16, 11);
  const slot = own(Manifold.cube([4, 8, 30]), (m) => m.translate([-6, 2.8, -5]));
  const m = bar.subtract(slot);
  [bar, slot].forEach((x) => x.delete());
  const rep = repairModel(wasm, m);
  m.delete();
  const mesh = meshOf(rep.manifold);
  const an = analyze(mesh, rep.manifold.boundingBox());
  an.skinIn = rep.skinIn;
  an.inAt = rep.inAt;
  const v = checkCut(wasm, rep.manifold, mesh, an, { id: 1, P: [0, 0], n: [1, 0], w: 8, chain: 0 }, opts);
  console.log('\nсустав у паза в бруске 16×11 мм');
  ok('красный: «сустав вылезает наружу сбоку на N мм³» (N ≥ 1)', !v.ok && v.code === 'outside' && /^сустав вылезает наружу сбоку на \d+\.\d мм³$/.test(v.why) &&
    +v.why.match(/на (\d+\.\d)/)[1] >= 1, v);
  [rep.manifold, rep.skinIn].forEach((x) => x.delete());
}

// Причина «тонко» — с числами: высота и/или ширина, сколько есть и сколько нужно.
const THIN_RE = /^тут тонко: (высота \d+\.\d мм, нужно от \d+\.\d|ширина \d+\.\d мм, нужно от \d+\.\d)(; ширина \d+\.\d мм, нужно от \d+\.\d)? — сделай фигурку крупнее или сдвинь ближе к телу$/;

/* Разрезы рукой на ящерице с сужающимся хвостом (220 мм): без разрезов собирать нечего; тап посередине хвоста —
   зелёный разрез и STL из 2 деталей (держит в 6 сторон, поворот ±α свободен); тап у тонкого кончика — красный
   с причиной; мимо фигурки — ничего; разрез ближе 2 мм к соседнему (по кружкам суставов) — «слишком близко». */
function taps() {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const m = newt();
  const stl = writeSTL([meshOf(m)]);
  m.delete();
  fs.writeFileSync(path.join(OUT, 'newt.stl'), Buffer.from(stl));
  const M = prepare(stl, 220);
  const { an, model, mesh, T } = M;
  console.log('\nразрезы рукой — ящерица с сужающимся хвостом, 220 мм');
  const empty = buildJoints(wasm, model, mesh, an, [], opts);
  ok('без разрезов — одна деталь, суставов нет (экран держит «Собрать STL» неактивной)', empty.parts.length === 1 && empty.joints.length === 0, empty.parts.length);
  empty.parts.forEach((p) => p.manifold.delete());

  // середина хвоста (в модели хвост — от x = −26 до −100)
  const mid = T(-60, 0);
  const c = placeCut(an, opts, mid[0], mid[1] + 2); // палец чуть мимо оси — разрез всё равно на скелете
  ok('тап по середине хвоста — разрез на позвоночнике, поперёк хвоста', c && c.spine && Math.abs(c.P[1]) < 1 && Math.abs(c.n[0]) > 0.95,
    c && { P: c.P.map((v) => +v.toFixed(1)), n: c.n.map((v) => +v.toFixed(2)) });
  const t0 = performance.now();
  const v = checkCut(wasm, model, mesh, an, c, opts);
  const tc = performance.now() - t0;
  ok('…он зелёный: сустав помещается, держит, поворачивается, ничего не отрезал', c.fit && v.ok, v);
  ok('проверка одного разреза быстрее 3 с', tc < 3000, Math.round(tc) + ' мс');
  const res = buildJoints(wasm, model, mesh, an, [Object.assign(c, { id: 1 })], opts);
  const J = res.joints[0];
  ok('STL из 2 деталей, ошибок нет', res.parts.length === 2 && !res.notes.some((x) => x.level === 'error'), res.notes.map((x) => x.text));
  ok('сустав держит: сдвиг на 1 мм в 6 сторон задевает соседа', !!(J && J.hold));
  ok('поворот на ±α свободен', !!J && J.turn <= 0.5, J && J.turn.toFixed(3));
  ok('зазор ≥ 0.9·g', !!J && J.gap >= 0.9 * opts.g, J && J.gap.toFixed(3));
  const file = writeSTL(res.parts.map((p) => meshOf(p.manifold)));
  ok('STL читается заново', parseSTL(file).length / 9 === new DataView(file).getUint32(80, true));
  res.parts.forEach((p) => p.manifold.delete());

  // кончик хвоста — тонко
  const tip = T(-97, 0);
  const ct = placeCut(an, opts, tip[0], tip[1]);
  const vt = ct && (ct.fit ? checkCut(wasm, model, mesh, an, ct, opts) : { ok: false, why: ct.why });
  ok('тап по тонкому кончику хвоста — красный: «тут тонко: высота … мм, нужно от … — сделай фигурку крупнее…»', !!ct && !vt.ok && THIN_RE.test(vt.why), vt);

  ok('тап мимо фигурки — разреза нет', placeCut(an, opts, mid[0], mid[1] + 60) === null);

  const c2 = placeCut(an, opts, c.P[0] - 6, c.P[1]);
  ok('разрез в 6 мм от соседнего — слишком близко (кружки ближе 2 мм)', !!c2 && tooClose(c, c2));
  const c3 = placeCut(an, opts, c.P[0] + c.Rh + 12, c.P[1], 0, false); // кружок соседа (ближе к телу) крупнее, Rh ≤ 8.6
  ok('между кружками ≥ 2 мм — не слишком близко', !!c3 && !tooClose(c, c3), c3 && (Math.hypot(c3.P[0] - c.P[0], c3.P[1] - c.P[1]) - c.Rh - c3.Rh).toFixed(1) + ' мм между кружками');
  M.free();
}

/* Размер 15 см (как в телефоне по умолчанию): ящерица, эублефар от бота и скелет. Человек тапает по шее, по телу
   и по хвосту, красный разрез двигает (здесь — шаг 2 мм вдоль позвоночника, с притягиванием к бороздкам):
   шея — от морды до передних лап, тело — ±12 мм от ядра, хвост — за задними лапами, два разреза не ближе 2 мм
   между кружками. Найденные зелёные собираются вместе — ошибок нет. expect: { neck, body, tail } — что должно
   найтись (tail — сколько звеньев на хвосте); где не находится — красная причина с числами. */
function atSize(name, stl, length, expect) {
  const opts = { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 };
  const M = prepare(stl, length);
  const { an, model, mesh } = M;
  autoCuts(an, opts); // an.legS — где лапы выходят из тела
  const sp = an.branches[0], L = sp.cum[sp.cum.length - 1];
  const legS = an.legS || [];
  // шея — от морды до передних лап, тело — между передними и задними, хвост — за задними (лапы — где они выходят
  // из тела, по позвоночнику; у эублефара самое широкое место — голова, поэтому не от «ядра»)
  const sCore = sp.cum[sp.core || 0];
  const two = legS.length >= 2 && Math.max(...legS) - Math.min(...legS) > 15;
  const neckEnd = two ? Math.min(...legS) - 3 : sCore - 12;
  const hip = two ? Math.max(...legS) + 3 : sCore + 12;
  const bodyA = two ? Math.min(...legS) + 3 : sCore - 12, bodyB = two ? Math.max(...legS) - 3 : sCore + 12;
  const kept = [];
  const reds = [];
  const onPath = () => true;
  // первый зелёный разрез в [a, b] (шаг st мм), не ближе 2 мм к уже найденным
  const findGreen = (a, b, st = 2) => {
    for (let s = a; s <= b; s += st) {
      const k = sp.cum.findIndex((x) => x >= s);
      if (k < 0) break;
      const c = placeCut(an, opts, sp.pts[k][0], sp.pts[k][1], 0, true);
      if (!c || kept.some((o) => tooClose(o, c))) continue;
      const v = c.fit ? checkCut(wasm, model, mesh, an, c, opts, prevCut(kept, c, onPath)) : { ok: false, why: c.why };
      if (v.ok) return Object.assign(c, { id: kept.length + 1 });
      reds.push({ s: +s.toFixed(0), why: v.why });
    }
    return null;
  };
  console.log(`\n${name} на ${length / 10} см — шея до ${neckEnd.toFixed(0)} мм от морды, тело ${bodyA.toFixed(0)}…${bodyB.toFixed(0)}, хвост от ${hip.toFixed(0)} (позвоночник ${L.toFixed(0)} мм)`);
  const neck = findGreen(0.08 * L, neckEnd);
  if (neck) kept.push(neck);
  const body = findGreen(bodyA, bodyB);
  if (body) kept.push(body);
  const tail = [];
  for (let i = 0; i < 2; i++) {
    const t = findGreen(tail.length ? tail[tail.length - 1].s + 1 : hip, L, 1);
    if (!t) break;
    tail.push(t);
    kept.push(t);
  }
  const at = (c) => c ? 's = ' + c.s.toFixed(0) + ' мм' : 'нет';
  const lastRed = (a, b) => { const r = reds.filter((x) => x.s >= a && x.s <= b).pop(); return r ? '«' + r.why + '»' : ''; };
  if (expect.neck != null) ok(expect.neck ? 'шея — зелёный разрез' : 'шея — красная, с причиной в цифрах', expect.neck ? !!neck : !neck && THIN_RE.test(lastRed(0, neckEnd).slice(1, -1)), neck ? at(neck) : lastRed(0, neckEnd));
  if (expect.body != null) ok(expect.body ? 'тело — зелёный разрез' : 'тело — красное, с причиной в цифрах', expect.body ? !!body : !body && THIN_RE.test(lastRed(bodyA, bodyB).slice(1, -1)), body ? at(body) : lastRed(bodyA, bodyB));
  if (expect.tail != null) {
    ok(`на хвосте зелёных разрезов ≥ ${expect.tail}` + (expect.tailWhy ? ' (дальше — красная причина в цифрах)' : ''), tail.length >= expect.tail &&
      (!expect.tailWhy || THIN_RE.test(lastRed(hip, L).slice(1, -1))), tail.map(at).join(', ') + (tail.length < 2 ? ' · ' + lastRed(hip, L) : ''));
  }
  if (kept.length) {
    const res = buildJoints(wasm, model, mesh, an, orderCuts(kept, an.skeleton), opts);
    ok(`все найденные зелёные (${kept.length}) собираются вместе: ошибок нет, держат, деталей ${kept.length + 1}`,
      !res.notes.some((x) => x.level === 'error') && res.joints.every((J) => J.hold) && res.parts.length === kept.length + 1,
      res.notes.map((x) => x.text));
    skinInCheck(res.joints, M.rep.skinIn);
    res.parts.forEach((p) => p.manifold.delete());
  }
  M.free();
}

// Бороздка (у геккона от бота — прорези между сегментами) ближе 3 мм притягивает разрез, дальше — нет.
const snapCheck = (M, opts) => {
  const { an } = M;
  const L = limbsOf(an);
  let hit = null;
  an.branches.forEach((br, bi) => {
    if (hit || L.from[bi] < 0) return;
    const gs = branchGrooves(an, br).filter((j) => j >= L.from[bi]);
    for (const j of gs) {
      const s = br.cum[j] + 2;
      if (s < br.cum[br.cum.length - 1] - 1 && gs.every((k) => k === j || Math.abs(br.cum[k] - s) > 3.5)) { hit = { bi, j, gs, s }; break; }
    }
  });
  ok('у модели есть бороздки', !!hit);
  if (!hit) return;
  const br = an.branches[hit.bi];
  const at = (s) => br.cum.findIndex((c) => c >= s);
  const k = at(hit.s), p = br.pts[k];
  const c = placeCut(an, opts, p[0], p[1], hit.bi);
  ok('тап в 2 мм от бороздки — разрез притянулся к ней', !!c && c.groove && Math.abs(c.s - br.cum[hit.j]) < 1e-6, c && (c.s - br.cum[hit.j]).toFixed(2));
  const c0 = placeCut(an, opts, p[0], p[1], hit.bi, false);
  ok('без притягивания — там, куда тапнули', !!c0 && !c0.groove && Math.abs(c0.s - br.cum[k]) < 1e-6);
  let kf = -1;
  for (let i = L.from[hit.bi]; i < br.cum.length && kf < 0; i++) if (hit.gs.every((j) => Math.abs(br.cum[j] - br.cum[i]) > 3.3)) kf = i;
  if (kf >= 0) {
    const cf = placeCut(an, opts, br.pts[kf][0], br.pts[kf][1], hit.bi);
    ok('дальше 3 мм от бороздок — не притягивает', !!cf && !cf.groove && Math.abs(cf.s - br.cum[kf]) < 1e-6);
  }
};

// Кот на 163 мм (как построен): лапы и хвост r = 5 мм тоньше сустава — подсказка «сделай крупнее».
function hintAt(name, m, length) {
  const stl = writeSTL([meshOf(m)]);
  const base = loadModel(wasm, parseSTL(stl));
  const placed = placeModel(wasm, base.manifold, length, 1);
  const rep = repairModel(wasm, placed);
  placed.delete();
  const mesh = meshOf(rep.manifold);
  const an = analyze(mesh, rep.manifold.boundingBox());
  attachGrooves(an, rep);
  an.skinIn = rep.skinIn;
  an.inAt = rep.inAt;
  const found = autoCuts(an, { g: 0.45, alphaSeg: 20, k: 1.2, kBody: 0.5 });
  console.log(`\n${name} на ${length} мм — расстановка: ${found.cuts.length} разрезов`);
  ok('подсказка «На таком размере суставы помещаются не везде. Сделай фигурку крупнее — от 18 см»', found.small === true, found.small);
  [rep.manifold, rep.skinIn, base.manifold].forEach((x) => x.delete());
}

const T0 = performance.now();
if (!ONLY || ONLY.includes('hint')) { const m = cat(); hintAt('кот', m, 163); m.delete(); }
if (!ONLY || ONLY.includes('joint')) { jointBar(13, 10.5); jointBar(16, 11); outsideReason(); }
if (!ONLY || ONLY.includes('taps')) taps();
if (!ONLY || ONLY.includes('size')) {
  const stlOf = (mk) => { const m = mk(); const b = writeSTL([meshOf(m)]); m.delete(); return b; };
  const gk = fs.readFileSync(path.join(HERE, 'gecko.stl'));
  const gecko = gk.buffer.slice(gk.byteOffset, gk.byteOffset + gk.byteLength);
  atSize('ящерица', stlOf(lizard), 150, { neck: true, body: true, tail: 2 });
  // эублефар от бота — уже порезан прорезями на сегменты; хвост на 15 см ниже 9.3 мм (столько нужно суставу
  // с минимумами) почти везде — одно звено; на 18 см — два
  atSize('эублефар', gecko, 150, { neck: true, body: true, tail: 1, tailWhy: true });
  atSize('эублефар', gecko, 180, { neck: true, body: true, tail: 2 });
  // скелет: тело на 15 см высотой ~8.8 мм (нужно от 9.3), шея и хвост — стержни ~3 мм (нужно от 10.6 в ширину)
  atSize('скелет', stlOf(skeleton), 150, { neck: false, body: false });
  atSize('скелет', stlOf(skeleton), 180, { neck: false, body: true });
}
for (const [name, mk] of Object.entries(MODELS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const { m, expect } = mk();
  const stl = writeSTL([meshOf(m)]);
  m.delete();
  fs.writeFileSync(path.join(OUT, name + '.stl'), Buffer.from(stl));
  run(name, stl, expect);
}
// настоящие модели от бота из tests/: геккон — со своими проверками, остальные — общими
// Этот эублефар — уже подвижная модель: тело порезано прорезями на сегменты 13–17 мм, а внутри — полости
// под старые суставы. Новый сустав (≈ 18 мм вдоль тела, со стенкой 0.8 мм) между ними не помещается —
// звеньев нет, приложение показывает «Сделай фигурку крупнее». Проверяем, что ничего не вылезло и подсказка есть.
const REAL = { gecko: { length: 150, small: true, snap: snapCheck, maxMs: 45000 } };
for (const f of fs.readdirSync(HERE).filter((x) => /\.stl$/i.test(x))) {
  const name = f.replace(/\.stl$/i, '');
  if (ONLY && !ONLY.includes(name) && !ONLY.includes(f)) continue;
  const stl = fs.readFileSync(path.join(HERE, f));
  const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  run(name, buf, REAL[name] || { maxMs: 60000 });
}
console.log(`\n${failed ? '✘ провалено проверок: ' + failed : '✔ все проверки прошли'} · ${Math.round(performance.now() - T0)} мс · STL — в tests/out/`);
process.exitCode = failed ? 1 : 0;
