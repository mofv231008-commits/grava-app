/* Грава — фоновый поток конструктора: считает деталь движком OpenSCAD (WebAssembly).
   Основной поток один раз присылает скомпилированный WebAssembly.Module, потом — задания на рендер. */
import OpenSCAD from './vendor/openscad/openscad.js?v=1';

let wasmModule = null;

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    wasmModule = msg.module;
    return;
  }
  if (msg.type !== 'render') return;
  let result;
  try {
    result = await render(msg.code, msg.out);
  } catch (err) {
    result = { rc: -1, data: null, log: ['ERROR: ' + ((err && err.message) || err)] };
  }
  self.postMessage({ type: 'result', id: msg.id, rc: result.rc, data: result.data, log: result.log },
    result.data ? [result.data] : []);
};

// Новый экземпляр на каждый рендер: повторный callMain в одном экземпляре Emscripten не любит.
async function runOnce(code, out, args) {
  const log = [];
  const inst = await OpenSCAD({
    noInitialRun: true,
    print: (s) => log.push(String(s)),
    printErr: (s) => log.push(String(s)),
    instantiateWasm: (imports, cb) => {
      WebAssembly.instantiate(wasmModule, imports).then((i) => cb(i));
      return {};
    },
  });
  inst.FS.writeFile('/in.scad', code);
  let rc;
  try {
    rc = inst.callMain(['/in.scad', '-o', out].concat(args));
  } catch (err) {
    rc = err && typeof err.status === 'number' ? err.status : 1;
    if (!(err && typeof err.status === 'number')) log.push('ERROR: ' + ((err && err.message) || err));
  }
  let data = null;
  try {
    const bytes = inst.FS.readFile(out);
    data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch (err) { /* файла нет — значит не собралось */ }
  return { rc, data, log };
}

async function render(code, out) {
  if (!wasmModule) throw new Error('движок не загружен');
  const flags = { backend: true, format: /\.stl$/.test(out) };
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = [];
    if (flags.format) args.push('--export-format=binstl');
    if (flags.backend) args.push('--backend=manifold');
    const r = await runOnce(code, out, args);
    const text = r.log.join('\n');
    // Старые сборки не знают этих флагов — тогда пробуем без них.
    if (r.rc !== 0 && flags.backend && /backend/i.test(text)) { flags.backend = false; continue; }
    if (r.rc !== 0 && flags.format && /export-format/i.test(text)) { flags.format = false; continue; }
    return r;
  }
  return { rc: 1, data: null, log: ['ERROR: не удалось запустить движок'] };
}
