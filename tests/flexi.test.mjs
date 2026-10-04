// Тесты сборщика шарниров — тот же код, что в фоновом потоке телефона.
// Запуск: node tests/flexi.test.mjs [only=lizard,skeleton,octopus,snake] [mode=pip,kit]
// Итоговые STL — в tests/out/ (не в git). Если в tests/ лежат другие *.stl (модели от бота) — прогоняются тоже.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Module from '../vendor/manifold/manifold.js';
import {
  parseSTL, writeSTL, loadModel, placeModel, analyze, autoCuts, orderCuts, buildJoints, layoutPlates, meshOf,
} from '../flexi-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const arg = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').split('=')[1];
const ONLY = arg('only') ? arg('only').split(',') : null;
const MODES = arg('mode') ? arg('mode').split(',') : ['pip', 'kit'];

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

function run(name, stl, mode, expect) {
  const opts = mode === 'kit'
    ? { mode, g: 0.2, snap: 0.35, links: !!expect.kitLinks, k: 1.2, alphaSeg: 15, plate: 220 }
    : { mode, g: 0.45, alpha: 20, links: true, k: 1.2, alphaSeg: 15 };
  const t0 = performance.now();
  const base = loadModel(wasm, parseSTL(stl));
  const length = Math.max(150, base.length);
  const placed = placeModel(wasm, base.manifold, length, 1);
  const mesh = meshOf(placed);
  const an = analyze(mesh, placed.boundingBox());
  const cuts = orderCuts(autoCuts(an, opts).map((c, i) => ({ ...c, id: i + 1 })), an.skeleton);
  const res = buildJoints(wasm, placed, mesh, an, cuts, opts);
  const t1 = performance.now();

  console.log(`\n${name} · ${mode === 'kit' ? '🧩 Сборная' : '🖨 Целиком'} — длина ${length.toFixed(0)} мм, разрезов ${cuts.length}, суставов ${res.joints.length}, деталей ${res.parts.length}, ${Math.round(t1 - t0)} мс`);
  console.log('  ' + res.summary);
  res.notes.forEach((x) => console.log('   ' + (x.level === 'error' ? '✖ ' : '⚠ ') + x.text));

  if (expect.classify) {
    const where = expect.classify(cuts, an, length / base.length);
    if (expect.legs) ok('разрезы у всех 4 лап', where.legs >= 4, where);
    if (expect.tail) ok('хотя бы 1 на хвосте', where.tail >= 1, where.tail);
    if (expect.minPerArm) ok(`на каждом щупальце ≥ ${expect.minPerArm} разрезов`, where.perArm.every((k) => k >= expect.minPerArm), where.perArm);
    if (expect.minLinks) ok(`≥ ${expect.minLinks} звеньев`, where.links >= expect.minLinks, where.links);
  }
  const errors = res.notes.filter((x) => x.level === 'error');
  const warns = res.notes.filter((x) => x.level === 'warn');
  ok('ни одной красной ошибки', errors.length === 0, errors.map((x) => x.text));
  ok('все суставы держат в 6 сторон и не слиплись (зазор ≥ 0.9·g)',
    res.joints.length > 0 && res.joints.every((J) => J.hold && J.gap >= 0.9 * opts.g),
    'зазоры: ' + res.joints.map((J) => J.gap.toFixed(2)).join(' '));
  ok('поворот на ±α свободен', !warns.some((x) => /упирается/.test(x.text)), warns.filter((x) => /упирается/.test(x.text)).map((x) => x.text));
  ok('нет висящих деталей', !warns.some((x) => /висит/.test(x.text)));
  ok('нет пропущенных разрезов', !warns.some((x) => /пропущен/.test(x.text)), warns.filter((x) => /пропущен/.test(x.text)).map((x) => x.text));
  ok('деталей = суставов + 1', res.parts.length === res.joints.length + 1, [res.parts.length, res.joints.length]);
  const vols = res.parts.map((p) => p.manifold.volume());
  ok('нет деталей меньше 20 мм³', vols.every((v) => v >= 20), 'мин. ' + Math.min(...vols).toFixed(0) + ' мм³');
  let maxI = 0;
  for (let i = 0; i < res.parts.length; i++) {
    for (let j = i + 1; j < res.parts.length; j++) maxI = Math.max(maxI, inter(res.parts[i].manifold, res.parts[j].manifold));
  }
  ok('детали не пересекаются', maxI < 1e-6, maxI);
  ok(`сборка быстрее ${expect.maxMs / 1000} с`, t1 - t0 < expect.maxMs, Math.round(t1 - t0) + ' мс');

  const outs = [];
  if (mode === 'kit') {
    const lay = layoutPlates(res.parts.map((p) => p.manifold.boundingBox()), opts.plate);
    ok('все детали меньше стола', lay.tooBig.length === 0, lay.tooBig);
    lay.plates.forEach((plate, pi) => {
      const ms = plate.map((it) => res.parts[it.index].manifold.translate([it.dx, it.dy, 0]));
      let out = false, minGap = Infinity;
      ms.forEach((m) => {
        const b = m.boundingBox();
        if (b.min[0] < -1e-6 || b.min[1] < -1e-6 || b.max[0] > opts.plate + 1e-6 || b.max[1] > opts.plate + 1e-6) out = true;
      });
      for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) minGap = Math.min(minGap, ms[i].minGap(ms[j], 10));
      ok(`стол ${pi + 1}/${lay.plates.length} (${plate.length} дет.): никто не выходит за ${opts.plate}×${opts.plate}`, !out);
      ok(`стол ${pi + 1}: детали не пересекаются, между ними ≥ 5 мм`, ms.length < 2 || minGap >= 5, isFinite(minGap) ? minGap.toFixed(1) + ' мм' : '—');
      outs.push({ file: writeSTL(ms.map(meshOf)), fn: `${name}-kit-plate${pi + 1}of${lay.plates.length}.stl` });
      ms.forEach((m) => m.delete());
    });
    outs.push({ file: writeSTL(res.parts.map((p) => meshOf(p.manifold))), fn: `${name}-kit-assembled.stl` });
  } else {
    outs.push({ file: writeSTL(res.parts.map((p) => meshOf(p.manifold))), fn: `${name}-pip.stl` });
  }
  outs.forEach(({ file, fn }) => {
    fs.writeFileSync(path.join(OUT, fn), Buffer.from(file));
    const back = parseSTL(file);
    ok(`${fn}: открывается заново, < 12 МБ`, back.length / 9 === new DataView(file).getUint32(80, true) && file.byteLength < 12 * 1048576,
      (file.byteLength / 1048576).toFixed(2) + ' МБ');
  });
  res.parts.forEach((p) => p.manifold.delete());
  placed.delete();
  base.manifold.delete();
  return res;
}

// Где разрезы: лапы — сбоку от оси тела, хвост — сзади по оси.
const animal = (cuts, an, s) => {
  const [cx] = an.core;
  const sides = new Set();
  let tail = 0, links = 0;
  cuts.forEach((c) => {
    if (c.link) links++;
    if (Math.abs(c.P[1]) > 9 * s && Math.abs(c.P[1]) > Math.abs(c.P[0] - cx) * 0.35) {
      sides.add((c.P[0] > cx ? 'перед' : 'зад') + (c.P[1] > 0 ? '-левая' : '-правая'));
    } else if (c.P[0] < cx - 10 && Math.abs(c.P[1]) < 9 * s) tail++;
  });
  return { legs: sides.size, tail, links, cuts: cuts.length };
};
// щупальца: каждое — своя цепочка звеньев (chain), первый разрез у головы тоже в ней
const arms = (cuts) => {
  const per = {};
  cuts.forEach((c) => { if (c.chain >= 0) per[c.chain] = (per[c.chain] || 0) + 1; });
  const list = Object.values(per);
  while (list.length < 8) list.push(0);
  return { perArm: list, links: cuts.filter((c) => c.link).length };
};

const MODELS = {
  lizard: () => ({ m: lizard(), expect: { classify: animal, legs: true, tail: true, maxMs: 15000 } }),
  skeleton: () => ({ m: skeleton(), expect: { classify: animal, legs: true, tail: true, maxMs: 15000 } }),
  octopus: () => ({ m: octopus(), expect: { classify: arms, minPerArm: 4, kitLinks: true, maxMs: 30000 } }),
  snake: () => {
    const { m } = snake();
    return { m, expect: { classify: (cuts) => ({ links: cuts.filter((c) => c.chain >= 0).length }), minLinks: 8, kitLinks: true, maxMs: 30000 } }; // звенья цепочки, включая первый сустав у головы
  },
};

// Раскладка на несколько столов и деталь больше стола
{
  console.log('\nраскладка (shelf packing)');
  const box = (w, h) => ({ min: [10, 20, 0], max: [10 + w, 20 + h, 5] });
  const boxes = [box(100, 80), box(90, 70), box(60, 60), box(150, 40), box(50, 50), box(170, 30), box(240, 10)];
  const lay = layoutPlates(boxes, 180);
  ok('деталь больше стола найдена', lay.tooBig.length === 1 && lay.tooBig[0] === 6, lay.tooBig);
  ok('не влезло на один стол — второй стол', lay.plates.length >= 2, lay.plates.length);
  let bad = false;
  lay.plates.forEach((pl) => {
    const rects = pl.map((it) => { const b = boxes[it.index]; return [b.min[0] + it.dx, b.min[1] + it.dy, b.max[0] + it.dx, b.max[1] + it.dy]; });
    rects.forEach((r, i) => {
      if (r[0] < 5 - 1e-9 || r[1] < 5 - 1e-9 || r[2] > 175 + 1e-9 || r[3] > 175 + 1e-9) bad = true;
      rects.forEach((q, j) => { if (j > i && !(r[2] + 6 - 1e-9 <= q[0] || q[2] + 6 - 1e-9 <= r[0] || r[3] + 6 - 1e-9 <= q[1] || q[3] + 6 - 1e-9 <= r[1])) bad = true; });
    });
  });
  ok('поле 5 мм от края, между деталями ≥ 6 мм', !bad);
  ok('все детали, кроме слишком большой, разложены', lay.plates.flat().length === 6);
}

const T0 = performance.now();
for (const [name, mk] of Object.entries(MODELS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const { m, expect } = mk();
  const stl = writeSTL([meshOf(m)]);
  m.delete();
  fs.writeFileSync(path.join(OUT, name + '.stl'), Buffer.from(stl));
  for (const mode of MODES) run(name, stl, mode, expect);
}
// настоящие модели от бота, если положили в tests/
for (const f of fs.readdirSync(HERE).filter((x) => /\.stl$/i.test(x))) {
  if (ONLY && !ONLY.includes(f)) continue;
  const stl = fs.readFileSync(path.join(HERE, f));
  const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
  for (const mode of MODES) run(f.replace(/\.stl$/i, ''), buf, mode, { maxMs: 60000 });
}
console.log(`\n${failed ? '✘ провалено проверок: ' + failed : '✔ все проверки прошли'} · ${Math.round(performance.now() - T0)} мс · STL — в tests/out/`);
process.exitCode = failed ? 1 : 0;
