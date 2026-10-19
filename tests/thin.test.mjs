// node tests/thin.test.mjs — проверка поиска тонких мест
import Module from '../vendor/manifold/manifold.js';
import { thinParts } from '../thin-core.js';
const wasm = await Module(); wasm.setup(); const { Manifold } = wasm;
let fail = 0; const ok = (c, msg) => { console.log((c ? 'ok   ' : 'FAIL ') + msg); if (!c) fail++; };
const mesh = (m) => m.getMesh();
// 1) толстый кубик — тонких мест нет
const a = thinParts(mesh(Manifold.cube([30, 30, 30])));
ok(a.spots.length === 0, `кубик 30 мм: тонких мест ${a.spots.length}`);
// 2) кубик с тонкой «антенной» 0,6 мм — одно тонкое место, там где антенна
const ant = Manifold.union([Manifold.cube([30, 30, 30]), Manifold.cube([0.6, 0.6, 15]).translate([15, 15, 30])]);
const b = thinParts(mesh(ant));
ok(b.spots.length >= 1 && b.spots[0].z > 30, `антенна 0,6 мм найдена: ${b.spots.length} место, z=${b.spots[0] && b.spots[0].z.toFixed(1)}`);
// 3) пластина 3 мм — не тонкая; 0,8 мм — тонкая
ok(thinParts(mesh(Manifold.cube([40, 40, 3]))).spots.length === 0, 'пластина 3 мм не тонкая');
ok(thinParts(mesh(Manifold.cube([40, 40, 0.8]))).thinShare > 0.9, 'пластина 0,8 мм — тонкая');
console.log(fail ? `\n${fail} проверок не прошло` : '\nвсё хорошо');
process.exit(fail ? 1 : 0);
