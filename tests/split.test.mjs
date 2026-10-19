// node tests/split.test.mjs — проверка деления большой модели на части
import Module from '../vendor/manifold/manifold.js';
import { splitModel, SPLIT_DEFAULTS } from '../split-core.js';
const wasm = await Module(); wasm.setup(); const { Manifold } = wasm;
let fail = 0; const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };
const bed = SPLIT_DEFAULTS.bed, m = SPLIT_DEFAULTS.margin;
const fitsBed = (it) => Math.min(it.w, it.d) <= Math.min(bed[0], bed[1]) - 2 * m && Math.max(it.w, it.d) <= Math.max(bed[0], bed[1]) - 2 * m && it.h <= bed[2] - m;
// 1) маленькая модель — делить не надо
const small = Manifold.cube([100, 80, 60]);
ok(splitModel(wasm, small).fits === true, 'кубик 100 мм влезает без деления');
// 2) длинный брусок 600 мм — 3 части, со штырями
const bar = Manifold.cube([600, 60, 40]);
const r = splitModel(wasm, bar);
ok(!r.fits && r.parts >= 3, `брусок 600 мм → ${r.parts} части`);
ok(r.pins >= r.cuts, `штырей ${r.pins} на ${r.cuts} разреза`);
const items = r.plates.flat();
ok(items.every((it) => it.pin || fitsBed(it)), 'каждая часть влезает на стол 250×250');
const vol = items.filter((it) => !it.pin).reduce((s, it) => s + it.m.volume(), 0);
ok(vol < 600 * 60 * 40 && vol > 600 * 60 * 40 * 0.98, `объём сохранился (минус отверстия): ${vol.toFixed(0)} из ${600 * 60 * 40}`);
ok(items.every((it) => it.m.status() === 'NoError' && it.m.genus() >= 0), 'все детали — замкнутые тела');
// 3) высокая башня 400 мм — режется поперёк по высоте
const tower = Manifold.cylinder(400, 50, 50, 64);
const t = splitModel(wasm, tower);
ok(!t.fits && t.parts === 2 && t.plates.flat().every((it) => it.pin || fitsBed(it)), `башня 400 мм → ${t.parts} части`);
// 4) изогнутая «змея» (несвязные куски в срезе не теряются)
const seg = [];
for (let i = 0; i < 12; i++) seg.push(Manifold.cylinder(40, 22, 22, 32).rotate([0, 90, 0]).translate([i * 35, 120 * Math.sin(i / 2), 0]));
const snake = Manifold.union(seg); const sv = snake.volume();
const s = splitModel(wasm, snake.translate([0, 0, 22]));
const svol = s.plates.flat().filter((it) => !it.pin).reduce((a, it) => a + it.m.volume(), 0);
ok(svol > sv * 0.97, `змея: объём ${svol.toFixed(0)} из ${sv.toFixed(0)}, частей ${s.parts}`);
console.log(fail ? `\n${fail} проверок не прошло` : '\nвсё хорошо');
process.exit(fail ? 1 : 0);
