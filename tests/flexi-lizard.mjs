// Тест сборщика шарниров на синтетической ящерице: node tests/flexi-lizard.mjs [папка-для-STL]
import fs from 'fs';
import assert from 'assert';
import Module from '../vendor/manifold/manifold.js';
import { parseSTL, writeSTL, loadModel, placeModel, analyze, buildJoints, meshOf, jointSize, verticalSpan } from '../flexi-core.js';

const wasm = await Module();
wasm.setup();
const { Manifold } = wasm;
const OUT = process.argv[2] || (await import('os')).tmpdir();

// ---- синтетическая ящерица ----
const ell = (s, c) => { const a = Manifold.sphere(1, 48); const b = a.scale(s); a.delete(); const t = b.translate(c); b.delete(); return t; };
const capsule = (r, p, q) => { const a = Manifold.sphere(r, 32).translate(p), b = Manifold.sphere(r, 32).translate(q); const h = Manifold.hull([a, b]); a.delete(); b.delete(); return h; };
const parts = [ell([30, 14, 10], [0, 0, 7]), ell([13, 9, 8], [42, 0, 6])];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(capsule(5.5, [sx * 18, sy * 8, 4], [sx * 24, sy * 34, 4]));
parts.push(capsule(5.5, [-26, 0, 5], [-78, 0, 3.5]));
const u = Manifold.union(parts); parts.forEach((p) => p.delete());
const liz = u.trimByPlane([0, 0, 1], 0); u.delete();
const lizStl = writeSTL([meshOf(liz)]);
fs.writeFileSync(OUT + '/lizard.stl', Buffer.from(lizStl));
liz.delete();
console.log('lizard.stl', (lizStl.byteLength / 1024).toFixed(0), 'KB');

// ---- конвейер, как в телефоне ----
const t0 = performance.now();
const soup = parseSTL(lizStl);
const base = loadModel(wasm, soup);
const length = Math.max(150, base.length);
const model = placeModel(wasm, base.manifold, length, 1);
const mesh = meshOf(model);
const bb = model.boundingBox();
const an = analyze(mesh, bb);
const tA = performance.now();
const cuts = an.cuts.map((c, i) => ({ ...c, id: i + 1 })).sort((a, b) => a.dist - b.dist);
const opts = { g: 0.45, alpha: 25 };
const res = buildJoints(wasm, model, mesh, cuts, opts, (k, n) => {});
const t1 = performance.now();

const s = length / base.length;
console.log('orig length', base.length.toFixed(1), '→', length, 'scale', s.toFixed(3), 'grid', an.grid.W + '×' + an.grid.H, 'step', an.grid.step, 'coreW', an.coreW.toFixed(1));
console.log('cuts:'); cuts.forEach((c) => console.log('  #' + c.id, 'P=(' + c.P.map((x) => x.toFixed(1)) + ')', 'n=(' + c.n.map((x) => x.toFixed(2)) + ')', 'w=' + c.w.toFixed(1), 'dist=' + c.dist.toFixed(0)));
console.log('errors', res.errors, 'warnings', res.warnings);
console.log('parts', res.parts.length, 'analyze ms', (tA - t0).toFixed(0), 'build ms', (t1 - tA).toFixed(0), 'total ms', (t1 - t0).toFixed(0));

// классификация разрезов (в координатах после масштаба)
const legCuts = cuts.filter((c) => Math.abs(c.P[1]) > 12 * s);
const tailCuts = cuts.filter((c) => c.P[0] < 0 && Math.abs(c.P[1]) < 8 * s); // ядро тела — при x≈+15, хвост левее
const otherCuts = cuts.filter((c) => !legCuts.includes(c) && !tailCuts.includes(c));
console.log('legs', legCuts.length, 'tail', tailCuts.length, 'other (head/neck)', otherCuts.map((c) => c.P.map((x) => +x.toFixed(1))));

const ok = (name, cond, extra) => { console.log((cond ? '✔ ' : '✘ ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) process.exitCode = 1; };
ok('4 разреза у лап', legCuts.length === 4, legCuts.length);
ok('1–2 разреза на хвосте', tailCuts.length >= 1 && tailCuts.length <= 2, tailCuts.length);
ok('нет ошибок сборки', res.errors.length === 0, res.errors);
ok('деталей = разрезов + 1', res.parts.length === cuts.length + 1, [res.parts.length, cuts.length]);

// любые две детали не пересекаются
let maxInter = 0;
for (let i = 0; i < res.parts.length; i++) for (let j = i + 1; j < res.parts.length; j++) {
  const x = res.parts[i].manifold.intersect(res.parts[j].manifold); maxInter = Math.max(maxInter, x.volume()); x.delete();
}
ok('детали не пересекаются (объём 0)', maxInter < 1e-6, maxInter);

// замки и поворот
const partOf = (j) => res.parts.find((p) => p.joint === j).manifold;
const inter = (a, b) => { const x = a.intersect(b); const v = x.volume(); x.delete(); return v; };
res.joints.forEach((J, j) => {
  const child = partOf(j), parent = partOf(J.parent);
  const up03 = child.translate([0, 0, 0.3]), up12 = child.translate([0, 0, 1.2]), dn12 = child.translate([0, 0, -1.2]);
  const v03 = inter(up03, parent), vu = inter(up12, parent), vd = inter(dn12, parent);
  [up03, up12, dn12].forEach((m) => m.delete());
  ok(`сустав #${J.id}: +0.3 мм свободно, ±1.2 мм упирается`, v03 < 1e-6 && vu > 0 && vd > 0, { v03: +v03.toFixed(4), up12: +vu.toFixed(2), dn12: +vd.toFixed(2) });
  const isLeg = legCuts.some((c) => c.id === J.id);
  if (isLeg) {
    let worst = 0;
    for (const sgn of [-1, 1]) {
      const a = child.translate([-J.P[0], -J.P[1], 0]), b = a.rotate([0, 0, sgn * opts.alpha]), r = b.translate([J.P[0], J.P[1], 0]);
      worst = Math.max(worst, inter(r, parent)); [a, b, r].forEach((m) => m.delete());
    }
    ok(`лапа #${J.id}: поворот ±${opts.alpha}° не задевает тело`, worst < 1, +worst.toFixed(3));
  }
});

// итоговый STL
const out = writeSTL(res.parts.map((p) => meshOf(p.manifold)));
fs.writeFileSync(OUT + '/lizard-flexi.stl', Buffer.from(out));
const back = parseSTL(out);
ok('STL открывается заново', back.length / 9 === new DataView(out).getUint32(80, true) && back.length > 0, back.length / 9);
ok('STL меньше 12 МБ', out.byteLength < 12 * 1024 * 1024, (out.byteLength / 1048576).toFixed(2) + ' МБ');
ok('сборка быстрее 10 с', t1 - t0 < 10000, Math.round(t1 - t0) + ' мс');
res.parts.forEach((p) => p.manifold.delete());
model.delete(); base.manifold.delete();
