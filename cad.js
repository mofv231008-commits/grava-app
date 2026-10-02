/* Грава — конструктор деталей по размерам (OpenSCAD в телефоне).
   Использует помощники из app.js (tg, state, $, api, apiUrl, haptic, loadThree…). */
'use strict';

const CAD_API = 'https://engrave.app.n8n.cloud/webhook/grava-app-cad';
const CAD_WASM_URL = './vendor/openscad/openscad.wasm?v=1';
const CAD_WASM_SIZE = 9603115;            // размер openscad.wasm — для процентов загрузки
const CAD_WORKER_URL = './cad-worker.js?v=1';
const CAD_RENDER_TIMEOUT = 90000;
const CAD_FIX_TIMEOUT = 240000;
const CAD_EXPORT_TIMEOUT = 120000;
const CAD_DEBOUNCE = 600;
const CAD_MAX_FILE = 12 * 1024 * 1024;

class CadError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/* ---------- Движок: загрузка wasm и фоновый поток ---------- */

const engine = { modulePromise: null, onProgress: null, worker: null, job: null, seq: 0 };

// Один раз качаем openscad.wasm с процентами и компилируем. Дальше — из кэша браузера.
function cadLoadEngine() {
  if (!engine.modulePromise) {
    engine.modulePromise = (async () => {
      let res;
      try { res = await fetch(CAD_WASM_URL); } catch (e) { throw new CadError('engine_network'); }
      if (!res.ok) throw new CadError('engine_network');
      let bytes;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          if (engine.onProgress) engine.onProgress(Math.min(99, Math.round((got / CAD_WASM_SIZE) * 100)));
        }
        bytes = new Uint8Array(got);
        let off = 0;
        chunks.forEach((c) => { bytes.set(c, off); off += c.length; });
      } else {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      if (engine.onProgress) engine.onProgress(100);
      try { return await WebAssembly.compile(bytes); } catch (e) { throw new CadError('engine_compile'); }
    })().catch((e) => {
      engine.modulePromise = null;
      throw e;
    });
  }
  return engine.modulePromise;
}

function cadKillWorker() {
  if (engine.worker) {
    engine.worker.terminate();
    engine.worker = null;
  }
}

// Отмена: если человек снова двинул ползунок — гасим поток, следующий рендер создаст новый.
function cadCancelJob() {
  const job = engine.job;
  if (!job) return;
  engine.job = null;
  clearTimeout(job.timer);
  cadKillWorker();
  job.reject(new CadError('cancelled'));
}

function cadEngineRender(code, out) {
  return cadLoadEngine().then((module) => {
    cadCancelJob();
    if (!engine.worker) {
      let worker;
      try { worker = new Worker(CAD_WORKER_URL, { type: 'module' }); } catch (e) { throw new CadError('worker'); }
      worker.onmessage = (e) => {
        const msg = e.data || {};
        const job = engine.job;
        if (msg.type !== 'result' || !job || job.id !== msg.id) return;
        engine.job = null;
        clearTimeout(job.timer);
        job.resolve(msg);
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const job = engine.job;
        engine.job = null;
        cadKillWorker();
        if (job) {
          clearTimeout(job.timer);
          job.reject(new CadError('worker'));
        }
      };
      worker.postMessage({ type: 'init', module });
      engine.worker = worker;
    }
    const id = ++engine.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!engine.job || engine.job.id !== id) return;
        engine.job = null;
        cadKillWorker();
        reject(new CadError('timeout'));
      }, CAD_RENDER_TIMEOUT);
      engine.job = { id, resolve, reject, timer };
      engine.worker.postMessage({ type: 'render', id, code, out });
    });
  });
}

function cadIsFailure(r) {
  const text = (r.log || []).join('\n');
  if (r.rc !== 0 || !r.data || !r.data.byteLength) return true;
  if (/ERROR:/.test(text) || /Current top level object is empty/.test(text)) return true;
  // бинарный STL без треугольников — тоже пусто
  if (r.data.byteLength >= 84 && /\.stl$/.test(r.out || '') && new DataView(r.data).getUint32(80, true) === 0) return true;
  return false;
}

/* ---------- Параметры из кода ---------- */

const CAD_PARAM_RE = /^(\s*)([A-Za-z_$][\w$]*)(\s*=\s*)(-?\d+(?:\.\d+)?|-?\.\d+|true|false)(\s*;)(.*)$/;

function cadDecimals(x) {
  const s = String(x);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

// Число без «хвостов»: 82.50000001 → 82.5
function cadFmt(v) {
  return String(parseFloat(Number(v).toFixed(6)));
}

function cadParse(code) {
  const lines = code.split('\n');
  const params = [];
  let group = '';
  let label = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const g = t.match(/^\/\*\s*\[([^\]]*)\]\s*\*\/$/);
    if (g) {
      if (/^hidden$/i.test(g[1].trim())) break; // дальше — служебные переменные
      group = g[1].trim();
      label = null;
      continue;
    }
    if (/^\/\//.test(t)) {
      label = t.replace(/^\/\/+\s*/, '');
      continue;
    }
    const m = line.match(CAD_PARAM_RE);
    if (!m) {
      label = null;
      continue;
    }
    const raw = m[4];
    const p = {
      name: m[2],
      line: i,
      pre: m[1] + m[2] + m[3],
      post: m[5] + m[6],
      label: label || m[2],
      group,
    };
    label = null;
    if (raw === 'true' || raw === 'false') {
      p.type = 'bool';
      p.initial = raw === 'true';
    } else {
      p.type = 'number';
      p.initial = parseFloat(raw);
      p.decimals = cadDecimals(raw);
      const cm = m[6].match(/\/\/\s*\[([^\]]*)\]/);
      if (cm) {
        const inner = cm[1].trim();
        if (inner.indexOf(',') !== -1) {
          const opts = inner.split(',').map((s) => {
            const [v, lbl] = s.split(':').map((x) => x.trim());
            return { value: parseFloat(v), label: lbl || v };
          });
          if (opts.every((o) => isFinite(o.value))) p.options = opts;
        } else {
          const nums = inner.split(':').map((x) => parseFloat(x));
          if (nums.length >= 2 && nums.every(isFinite)) {
            p.min = nums[0];
            p.max = nums[nums.length - 1];
            p.step = nums.length === 3 ? nums[1] : (p.decimals ? Math.pow(10, -p.decimals) : 1);
            if (p.min > p.max) [p.min, p.max] = [p.max, p.min];
            if (!(p.step > 0)) p.step = 1;
          }
        }
      }
    }
    p.value = p.initial;
    params.push(p);
  }
  return { lines, params };
}

function cadClamp(p, v) {
  if (p.min != null) v = Math.max(p.min, v);
  if (p.max != null) v = Math.min(p.max, v);
  return v;
}

// Код с текущими значениями: меняем только значение в строке параметра, комментарий оставляем.
function cadCurrentCode() {
  const c = state.cad;
  const lines = c.parsed.lines.slice();
  c.parsed.params.forEach((p) => {
    const v = p.type === 'bool' ? String(p.value) : cadFmt(p.value);
    lines[p.line] = p.pre + v + p.post;
  });
  return lines.join('\n');
}

/* ---------- Экран ---------- */

function cadFormat(data) {
  if (data && (data.format === 'dxf' || data.format === 'stl')) return data.format;
  return data && data.kind === 'laser' ? 'dxf' : 'stl';
}

function openCad(id) {
  id = String(id);
  haptic();
  if (state.viewer) closeViewer();
  if (state.detail) {
    state.detail = null;
    tg.MainButton.hideProgress();
  } else if (!state.cad) {
    state.listScroll = window.scrollY;
  }
  if (state.cad) cadTeardown();

  state.cad = {
    id,
    data: null,
    parsed: null,
    status: 'loading',   // loading | rendering | ok | error
    pending: false,
    timer: 0,
    token: 0,
    last: null,
    log: [],
    fixesLeft: 0,
  };
  const c = state.cad;

  $('cad-missing').hidden = true;
  $('cad-main').hidden = false;
  $('cad-title').textContent = 'Загружаю деталь…';
  $('cad-format').hidden = true;
  $('cad-params').textContent = '';
  $('cad-reset').hidden = true;
  $('cad-error').hidden = true;
  $('cad-dims').textContent = '';
  $('cad-stage').textContent = '';
  $('cad-stage').appendChild(el('div', 'cad-empty', '📐'));
  $('cad-busy').hidden = true;
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  cadUpdateMainButton();

  // Сообщаем боту, что открыта эта деталь (правки словами в чате — к ней). Ответ не ждём.
  cadPost({ a: 'select', id }, 15000);
  cadEnsureEngine();

  api({ a: 'cad', id })
    .then((data) => {
      if (state.cad !== c) return;
      cadSetData(data);
    })
    .catch((err) => {
      if (state.cad !== c) return;
      if (err && err.code === 'auth') {
        cadShowMissing('Сессия устарела — перезапусти приложение', 'close');
        sessionExpired();
      } else if (err && err.code === 'network') {
        cadShowMissing('Нет связи с сервером. Проверь интернет и попробуй ещё раз', 'retry');
      } else {
        cadShowMissing('Деталь не найдена', 'back');
      }
    });
}

function cadShowMissing(text, action) {
  $('cad-main').hidden = true;
  $('cad-missing').hidden = false;
  $('cad-missing-text').textContent = text;
  const btn = $('cad-missing-btn');
  btn.dataset.action = action;
  btn.textContent = action === 'retry' ? 'Попробовать ещё раз' : action === 'close' ? 'Закрыть' : 'К моим работам';
  cadUpdateMainButton();
}

function cadSetData(data) {
  const c = state.cad;
  c.data = data;
  c.format = cadFormat(data);
  c.fixesLeft = Number(data.fixes_left) || 0;
  $('cad-title').textContent = data.title || 'Деталь по размерам';
  $('cad-format').textContent = c.format === 'dxf' ? '🔥 DXF для лазера' : '🧊 STL для 3D-принтера';
  $('cad-format').hidden = false;
  $('cad-preview').classList.toggle('is-sheet', c.format === 'dxf');
  cadSetCode(String(data.scad || ''));
}

function cadSetCode(code) {
  const c = state.cad;
  c.parsed = cadParse(code);
  cadRenderParams();
  cadScheduleRender(0);
}

function closeCad() {
  if (!state.cad) return;
  cadTeardown();
  state.cad = null;
  tg.MainButton.hideProgress();
  tg.MainButton.setParams({ is_active: true, color: tg.themeParams.button_color || undefined, text_color: tg.themeParams.button_text_color || undefined });
  tg.MainButton.hide();
  tg.BackButton.hide();
  $('busy').hidden = true;
  renderView();
  window.scrollTo(0, state.listScroll || 0);
}

function cadTeardown() {
  const c = state.cad;
  if (c) clearTimeout(c.timer);
  cadCancelJob();
  cadDestroyStl();
  cadResetSvgZoom();
  $('cad-stage').textContent = '';
}

/* ---------- Поля параметров ---------- */

function cadRenderParams() {
  const c = state.cad;
  const box = $('cad-params');
  box.textContent = '';
  const params = c.parsed.params;
  $('cad-reset').hidden = params.length === 0;
  if (!params.length) return;

  let group = null;
  let list = null;
  params.forEach((p) => {
    if (!list || p.group !== group) {
      group = p.group;
      if (group) box.appendChild(el('h2', 'section-title', group));
      list = el('div', 'card cad-list');
      box.appendChild(list);
    }
    list.appendChild(cadParamRow(p));
  });
}

function cadParamRow(p) {
  const row = el('div', 'cad-param');
  const head = el('div', 'cad-param-head');
  const label = el('label', 'cad-param-label', p.label);
  const inputId = 'cad-p-' + p.name;
  label.htmlFor = inputId;
  head.appendChild(label);
  row.appendChild(head);

  if (p.type === 'bool') {
    const sw = el('input', 'cad-switch');
    sw.type = 'checkbox';
    sw.id = inputId;
    sw.checked = !!p.value;
    sw.addEventListener('change', () => {
      haptic();
      p.value = sw.checked;
      cadChanged();
    });
    head.appendChild(sw);
    p.sync = () => { sw.checked = !!p.value; };
    return row;
  }

  if (p.options) {
    const sel = el('select', 'cad-select');
    sel.id = inputId;
    p.options.forEach((o, i) => {
      const opt = el('option', '', o.label);
      opt.value = String(i);
      sel.appendChild(opt);
    });
    const syncSel = () => {
      const i = p.options.findIndex((o) => o.value === p.value);
      sel.value = String(i === -1 ? 0 : i);
    };
    syncSel();
    sel.addEventListener('change', () => {
      haptic();
      p.value = p.options[Number(sel.value)].value;
      cadChanged();
    });
    head.appendChild(sel);
    p.sync = syncSel;
    return row;
  }

  // Число: поле для точного ввода с кнопками − и +, а при диапазоне — ещё и ползунок.
  const num = el('div', 'cad-num');
  const minus = el('button', '', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', 'Меньше');
  const input = el('input', 'cad-num-input');
  input.id = inputId;
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  const plus = el('button', '', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Больше');
  num.appendChild(minus);
  num.appendChild(input);
  num.appendChild(plus);
  head.appendChild(num);

  let slider = null;
  if (p.min != null) {
    slider = el('input', 'cad-slider');
    slider.type = 'range';
    slider.min = String(p.min);
    slider.max = String(p.max);
    slider.step = String(p.step);
    slider.setAttribute('aria-label', p.label);
    row.appendChild(slider);
    slider.addEventListener('input', () => {
      p.value = cadClamp(p, parseFloat(slider.value));
      input.value = cadFmt(p.value);
      cadChanged();
    });
  }

  const sync = () => {
    input.value = cadFmt(p.value);
    if (slider) slider.value = String(p.value);
    minus.disabled = p.min != null && p.value <= p.min;
    plus.disabled = p.max != null && p.value >= p.max;
  };
  p.sync = sync;
  sync();

  // Вводим как есть (например, ровно 82.5): применяем по «Готово»/уходу из поля, только ограничиваем min…max.
  const commit = () => {
    const v = parseFloat(String(input.value).replace(',', '.').replace(/\s/g, ''));
    if (!isFinite(v)) {
      sync();
      return;
    }
    const nv = cadClamp(p, v);
    const changed = nv !== p.value;
    p.value = nv;
    sync();
    if (changed) cadChanged();
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  const stepBy = (dir) => {
    haptic();
    const step = p.step || (p.decimals ? Math.pow(10, -p.decimals) : 1);
    const dec = Math.max(cadDecimals(step), cadDecimals(cadFmt(p.value)));
    p.value = cadClamp(p, parseFloat((p.value + dir * step).toFixed(dec)));
    sync();
    cadChanged();
  };
  minus.addEventListener('click', () => stepBy(-1));
  plus.addEventListener('click', () => stepBy(1));
  if (slider) slider.addEventListener('input', () => {
    minus.disabled = p.value <= p.min;
    plus.disabled = p.value >= p.max;
  });
  return row;
}

function cadChanged() {
  const c = state.cad;
  if (!c || !c.parsed) return;
  cadScheduleRender(CAD_DEBOUNCE);
}

function cadResetParams() {
  const c = state.cad;
  if (!c || !c.parsed) return;
  haptic();
  c.parsed.params.forEach((p) => {
    p.value = p.initial;
    if (p.sync) p.sync();
  });
  cadScheduleRender(0);
}

/* ---------- Рендер ---------- */

function cadScheduleRender(delay) {
  const c = state.cad;
  clearTimeout(c.timer);
  if (engine.job) cadCancelJob(); // считали старые размеры — уже не нужно
  c.pending = true;
  cadUpdateMainButton();
  c.timer = setTimeout(cadRender, delay);
}

async function cadRender() {
  const c = state.cad;
  if (!c || !c.parsed) return;
  const token = ++c.token;
  const code = cadCurrentCode();
  const out = c.format === 'dxf' ? '/out.svg' : '/out.stl';
  c.pending = false;
  c.status = 'rendering';
  $('cad-busy').hidden = false; // старое превью не убираем
  cadUpdateMainButton();

  let r;
  try {
    r = await cadEngineRender(code, out);
    r.out = out;
  } catch (err) {
    if (state.cad !== c || token !== c.token || (err && err.code === 'cancelled')) return;
    $('cad-busy').hidden = true;
    if (err && err.code === 'timeout') {
      cadShowError(['Деталь считается слишком долго (больше 90 секунд).']);
    } else {
      c.status = 'engine_error';
      cadEngineError(err);
    }
    cadUpdateMainButton();
    return;
  }
  if (state.cad !== c || token !== c.token) return;
  $('cad-busy').hidden = true;

  if (cadIsFailure(r)) {
    cadShowError(r.log);
    cadUpdateMainButton();
    return;
  }
  try {
    if (c.format === 'dxf') cadShowSvg(new TextDecoder().decode(r.data));
    else await cadShowStl(r.data);
  } catch (e) {
    if (state.cad !== c || token !== c.token) return;
    cadShowError(['Не получилось показать деталь: ' + ((e && e.message) || e)]);
    cadUpdateMainButton();
    return;
  }
  if (state.cad !== c || token !== c.token) return;
  c.status = 'ok';
  c.last = { code, data: r.data };
  $('cad-error').hidden = true;
  cadUpdateMainButton();
}

function cadShowError(log) {
  const c = state.cad;
  c.status = 'error';
  c.log = log || [];
  hapticNotify('error');
  // служебная строка движка, к детали отношения не имеет
  const tail = c.log.filter((l) => String(l).trim() && !/Could not initialize localization/.test(l)).slice(-15).join('\n');
  $('cad-log').textContent = tail || 'Движок не сообщил подробностей.';
  $('cad-error').hidden = false;
  cadRenderFix();
}

function cadRenderFix() {
  const c = state.cad;
  const left = c.fixesLeft;
  $('cad-fix').hidden = left <= 0;
  $('cad-fix').textContent = '🔧 Починить нейронкой (бесплатно, осталось ' + left + ')';
  $('cad-fix-limit').hidden = left > 0;
}

/* ---------- Загрузка движка на экране ---------- */

function cadEnsureEngine() {
  const box = $('cad-engine');
  let loaded = false;
  engine.onProgress = (pct) => {
    if (!loaded) $('cad-engine-text').textContent = 'Загружаю движок чертежей… ' + pct + '%';
  };
  // Если движок уже в памяти, плашку даже не показываем.
  const t = setTimeout(() => {
    if (loaded) return;
    box.hidden = false;
    $('cad-engine-spinner').hidden = false;
    $('cad-engine-retry').hidden = true;
    $('cad-engine-text').textContent = 'Загружаю движок чертежей…';
  }, 150);
  cadLoadEngine().then(() => {
    loaded = true;
    clearTimeout(t);
    box.hidden = true;
  }, (err) => {
    loaded = true;
    clearTimeout(t);
    cadEngineError(err);
  });
}

function cadEngineError(err) {
  const box = $('cad-engine');
  box.hidden = false;
  $('cad-engine-spinner').hidden = true;
  $('cad-engine-retry').hidden = false;
  $('cad-busy').hidden = true;
  const code = err && err.code;
  $('cad-engine-text').textContent = code === 'engine_network'
    ? 'Не получилось скачать движок чертежей. Проверь интернет и попробуй ещё раз'
    : code === 'worker' || code === 'engine_compile'
      ? 'Движок чертежей не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз'
      : 'Не получилось запустить движок чертежей';
}

function cadRetryEngine() {
  haptic();
  if (!state.cad) return;
  cadEnsureEngine();
  if (state.cad.parsed) cadScheduleRender(0);
}

/* ---------- Превью STL (three.js) ---------- */

const cadView = { scene: null, raf: 0, ro: null, fitDir: null };

async function cadShowStl(buffer) {
  const T = await loadThree();
  if (!state.cad) return;
  const v = cadEnsureStlView(T);
  const geometry = new T.STLLoader().parse(buffer);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!isFinite(box.min.x)) throw new Error('пустая деталь');

  if (v.mesh.geometry) v.mesh.geometry.dispose();
  v.mesh.geometry = geometry;

  const size = new T.Vector3();
  const center = new T.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // «Стол»: сетка с клеткой 10 мм на z=0 под деталью.
  if (v.grid) {
    v.scene.remove(v.grid);
    v.grid.geometry.dispose();
    v.grid.material.dispose();
  }
  const cell = 10;
  const span = Math.max(40, Math.ceil((Math.max(size.x, size.y) * 1.6) / (cell * 2)) * cell * 2);
  const grid = new T.GridHelper(span, span / cell, 0x8a8a8a, 0xbdbdbd);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(Math.round(center.x / cell) * cell, Math.round(center.y / cell) * cell, 0);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  v.scene.add(grid);
  v.grid = grid;

  // Камера сама вписывает деталь, направление взгляда сохраняем.
  const radius = Math.max(size.length() / 2, 1);
  v.radius = radius;
  v.center = center.clone();
  const dir = v.camera.position.clone().sub(v.controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(1, -1.4, 1);
  dir.normalize();
  v.controls.target.copy(center);
  v.camera.position.copy(center).add(dir.multiplyScalar(cadFitDistance(radius)));
  v.camera.near = radius / 100;
  v.camera.far = radius * 100;
  v.camera.updateProjectionMatrix();
  v.controls.minDistance = radius * 0.6;
  v.controls.maxDistance = radius * 12;
  v.controls.update();

  $('cad-dims').textContent = 'Габариты: ' + cadMm(size.x) + ' × ' + cadMm(size.y) + ' × ' + cadMm(size.z) + ' мм';
}

function cadMm(x) {
  return Number(x).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function cadFitDistance(radius) {
  return (radius / Math.sin((35 / 2) * Math.PI / 180)) * 1.08;
}

function cadEnsureStlView(T) {
  if (cadView.scene) return cadView.scene;
  const stage = $('cad-stage');
  stage.textContent = '';
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1); // в OpenSCAD «вверх» — это Z
  camera.position.set(1, -1.4, 1);
  scene.add(camera);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
  const key = new T.DirectionalLight(0xffffff, 1.9);
  key.position.set(1, 1.5, 2);
  camera.add(key);

  const mesh = new T.Mesh(undefined, new T.MeshStandardMaterial({ color: 0xc9c9c9, roughness: 0.85, metalness: 0 }));
  scene.add(mesh);

  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.rotateSpeed = 0.8;

  const v = { T, renderer, scene, camera, controls, mesh, grid: null, radius: 1, center: null };
  const resize = () => {
    const w = stage.clientWidth || 300;
    const h = stage.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  if (window.ResizeObserver) {
    cadView.ro = new ResizeObserver(resize);
    cadView.ro.observe(stage);
  }
  const loop = () => {
    cadView.raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
  cadView.scene = v;
  return v;
}

function cadDestroyStl() {
  const v = cadView.scene;
  cadView.scene = null;
  cancelAnimationFrame(cadView.raf);
  if (cadView.ro) cadView.ro.disconnect();
  cadView.ro = null;
  if (!v) return;
  v.controls.dispose();
  if (v.mesh.geometry) v.mesh.geometry.dispose();
  v.mesh.material.dispose();
  if (v.grid) {
    v.grid.geometry.dispose();
    v.grid.material.dispose();
  }
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

// Снимок 800×800 на светлом фоне, вид 3/4 сверху.
function cadSnapshotStl() {
  const v = cadView.scene;
  const r = v.renderer;
  const cam = v.camera;
  const savedPos = cam.position.clone();
  const savedAspect = cam.aspect;
  const savedRatio = r.getPixelRatio();
  const stage = $('cad-stage');

  r.setPixelRatio(1);
  r.setSize(800, 800, false);
  cam.aspect = 1;
  cam.position.copy(v.center).add(new v.T.Vector3(1, -1.4, 1.1).normalize().multiplyScalar(cadFitDistance(v.radius)));
  cam.lookAt(v.center);
  cam.updateProjectionMatrix();
  r.setClearColor(0xf4f4f4, 1);
  r.render(v.scene, cam);
  const url = r.domElement.toDataURL('image/jpeg', 0.85);

  r.setClearColor(0x000000, 0);
  r.setPixelRatio(savedRatio);
  r.setSize(stage.clientWidth || 300, stage.clientHeight || 300, false);
  cam.aspect = savedAspect;
  cam.position.copy(savedPos);
  cam.lookAt(v.controls.target);
  cam.updateProjectionMatrix();
  return url;
}

/* ---------- Превью DXF (SVG из OpenSCAD) ---------- */

const cadSvg = { box: null, paths: [], scale: 1, x: 0, y: 0, pointers: new Map(), gesture: null };

function cadShowSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = doc.documentElement;
  if (!src || src.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('плохой SVG');
  const vb = (src.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(isFinite) || !(vb[2] > 0) || !(vb[3] > 0)) throw new Error('нет размеров');
  const paths = Array.from(src.querySelectorAll('path')).map((p) => p.getAttribute('d')).filter(Boolean);
  if (!paths.length) throw new Error('нет контуров');

  const pad = Math.max(vb[2], vb[3]) * 0.06;
  cadSvg.box = [vb[0] - pad, vb[1] - pad, vb[2] + pad * 2, vb[3] + pad * 2];
  cadSvg.paths = paths;

  // Собираем свой SVG: чёрные контуры без заливки, вписаны в квадрат.
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', cadSvg.box.join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'cad-svg');
  paths.forEach((d) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#000');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  });
  const stage = $('cad-stage');
  let wrap = stage.querySelector('.cad-svg-wrap');
  if (!wrap) {
    stage.textContent = '';
    wrap = el('div', 'cad-svg-wrap');
    stage.appendChild(wrap);
  }
  wrap.textContent = '';
  wrap.appendChild(svg);
  cadApplySvgZoom();
  $('cad-dims').textContent = 'Лист: ' + cadMm(vb[2]) + ' × ' + cadMm(vb[3]) + ' мм';
}

function cadApplySvgZoom() {
  const wrap = $('cad-stage').querySelector('.cad-svg-wrap');
  if (!wrap) return;
  wrap.style.transform = 'translate(' + cadSvg.x + 'px,' + cadSvg.y + 'px) scale(' + cadSvg.scale + ')';
  // линии остаются тонкими при любом зуме
  wrap.querySelectorAll('path').forEach((p) => p.setAttribute('stroke-width', String(1.6 / cadSvg.scale)));
}

function cadResetSvgZoom() {
  cadSvg.scale = 1;
  cadSvg.x = 0;
  cadSvg.y = 0;
  cadSvg.pointers.clear();
  cadSvg.gesture = null;
  cadApplySvgZoom();
}

function cadClampSvg() {
  const stage = $('cad-stage');
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  cadSvg.scale = Math.min(Math.max(cadSvg.scale, 1), 8);
  cadSvg.x = Math.min(0, Math.max(w - w * cadSvg.scale, cadSvg.x));
  cadSvg.y = Math.min(0, Math.max(h - h * cadSvg.scale, cadSvg.y));
}

// Зум двумя пальцами, сдвиг одним — когда уже приблизили.
function cadSvgPointer(e) {
  const c = state.cad;
  if (!c || c.format !== 'dxf') return;
  const stage = $('cad-stage');
  const r = stage.getBoundingClientRect();
  const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (e.type === 'pointerdown') {
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ок */ }
    cadSvg.pointers.set(e.pointerId, pt);
    cadSvg.gesture = null;
    return;
  }
  if (!cadSvg.pointers.has(e.pointerId)) return;
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    cadSvg.pointers.delete(e.pointerId);
    cadSvg.gesture = null;
    return;
  }
  const prev = cadSvg.pointers.get(e.pointerId);
  cadSvg.pointers.set(e.pointerId, pt);
  const pts = Array.from(cadSvg.pointers.values());
  if (pts.length >= 2) {
    const [a, b] = pts;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    if (!cadSvg.gesture) {
      cadSvg.gesture = { dist, scale: cadSvg.scale, ax: (mid.x - cadSvg.x) / cadSvg.scale, ay: (mid.y - cadSvg.y) / cadSvg.scale };
    }
    const g = cadSvg.gesture;
    cadSvg.scale = Math.min(Math.max(g.scale * (dist / g.dist), 1), 8);
    cadSvg.x = mid.x - g.ax * cadSvg.scale;
    cadSvg.y = mid.y - g.ay * cadSvg.scale;
  } else if (cadSvg.scale > 1) {
    cadSvg.x += pt.x - prev.x;
    cadSvg.y += pt.y - prev.y;
  }
  cadClampSvg();
  cadApplySvgZoom();
}

async function cadSnapshotSvg() {
  const [x, y, w, h] = cadSvg.box;
  const sw = Math.max(w, h) / 400; // ~2 px на снимке 800×800
  const body = cadSvg.paths.map((d) => '<path d="' + d.replace(/"/g, '') + '" fill="none" stroke="#000" stroke-width="' + sw + '" stroke-linejoin="round"/>').join('');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="' + [x, y, w, h].join(' ') +
    '" preserveAspectRatio="xMidYMid meet">' + body + '</svg>';
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 800, 800);
  ctx.drawImage(img, 0, 0, 800, 800);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/* ---------- Кнопка «Прислать в чат» ---------- */

function cadUpdateMainButton() {
  const c = state.cad;
  if (!c) return;
  if (!c.data) {
    tg.MainButton.hide();
    return;
  }
  const ready = c.status === 'ok' && !c.pending;
  const theme = tg.themeParams || {};
  tg.MainButton.setParams({
    text: c.format === 'dxf' ? '📤 Прислать DXF в чат' : '📤 Прислать STL в чат',
    is_visible: true,
    is_active: ready,
    color: ready ? theme.button_color || undefined : theme.hint_color || theme.button_color || undefined,
    text_color: theme.button_text_color || undefined,
  });
}

function cadBusy(on, text) {
  $('busy').hidden = !on;
  if (text) $('busy-text').textContent = text;
  state.cadBusy = on;
}

function cadBlobToDataUrl(bytes) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(new Blob([bytes]));
  });
}

async function cadPost(params, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  let data = null;
  try {
    // URLSearchParams → form-urlencoded: простой запрос, без CORS-preflight.
    const body = new URLSearchParams(Object.assign({ initData: tg.initData }, params));
    const res = await fetch(CAD_API, { method: 'POST', body, signal: ctrl.signal });
    status = res.status;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
  } catch (e) {
    status = 0;
  } finally {
    clearTimeout(timer);
  }
  return { status, data };
}

function cadIsAuth(r) {
  return r.status === 401 || (r.data && r.data.error === 'auth');
}

async function cadExport() {
  const c = state.cad;
  if (!c || c.status !== 'ok' || c.pending || state.cadBusy || !c.last) return;
  haptic();
  cadBusy(true, 'Готовлю файл…');
  let bytes;
  let snapshot;
  try {
    if (c.format === 'dxf') {
      const r = await cadEngineRender(c.last.code, '/out.dxf');
      r.out = '/out.dxf';
      if (cadIsFailure(r)) throw new CadError('dxf_failed');
      bytes = r.data;
      snapshot = await cadSnapshotSvg();
    } else {
      bytes = c.last.data;
      snapshot = cadSnapshotStl();
    }
  } catch (e) {
    cadBusy(false);
    if (state.cad !== c) return;
    hapticNotify('error');
    alertBox('Не получилось подготовить файл. Попробуй ещё раз.');
    return;
  }
  if (bytes.byteLength > CAD_MAX_FILE) {
    cadBusy(false);
    hapticNotify('error');
    alertBox('Деталь слишком подробная для отправки');
    return;
  }

  const file = await cadBlobToDataUrl(bytes);
  cadBusy(true, 'Отправляю в чат…');
  const r = await cadPost({ a: 'export', id: c.id, file, snapshot, scad: c.last.code }, CAD_EXPORT_TIMEOUT);
  cadBusy(false);

  if (cadIsAuth(r)) {
    sessionExpired();
  } else if (r.data && r.data.ok === true) {
    hapticNotify('success');
    alertBox('Готово! Файл в чате 👌');
    loadMe(false); // в «Моих работах» появилась новая работа
  } else {
    hapticNotify('error');
    alertBox('Не вышло, попробуй ещё раз');
  }
}

/* ---------- Починка нейронкой ---------- */

async function cadFix() {
  const c = state.cad;
  if (!c || !c.parsed || state.cadBusy || c.fixesLeft <= 0) return;
  haptic();
  clearTimeout(c.timer);
  cadCancelJob();
  const error = c.log.filter((l) => !/Could not initialize localization/.test(l)).join('\n').slice(-4000);
  cadBusy(true, 'Нейронка чинит… ~30 секунд');
  const r = await cadPost({ a: 'fix', id: c.id, error, scad: cadCurrentCode() }, CAD_FIX_TIMEOUT);
  cadBusy(false);
  if (state.cad !== c) return;

  if (cadIsAuth(r)) {
    sessionExpired();
  } else if (r.data && r.data.ok === true && r.data.scad) {
    hapticNotify('success');
    c.fixesLeft = Number(r.data.fixes_left) || 0;
    $('cad-error').hidden = true;
    cadSetCode(String(r.data.scad)); // заново разбираем параметры и перерисовываем
    toast('Нейронка поправила код 🔧');
  } else if (r.data && r.data.error === 'fix_limit') {
    c.fixesLeft = 0;
    cadRenderFix();
    hapticNotify('error');
    alertBox('Лимит починок исчерпан. Опиши в чате, что не так, — бот перечертит (1 кр.)');
  } else {
    hapticNotify('error');
    alertBox('Не вышло, попробуй ещё раз');
  }
}

/* ---------- Кнопки ---------- */

function bindCad() {
  $('cad-reset').addEventListener('click', cadResetParams);
  $('cad-fix').addEventListener('click', cadFix);
  $('cad-engine-retry').addEventListener('click', cadRetryEngine);
  $('cad-missing-btn').addEventListener('click', () => {
    haptic();
    const action = $('cad-missing-btn').dataset.action;
    if (action === 'close') tg.close();
    else if (action === 'retry' && state.cad) openCad(state.cad.id);
    else closeCad();
  });
  $('cad-credit').addEventListener('click', (e) => {
    e.preventDefault();
    try { tg.openLink('https://github.com/openscad/openscad'); } catch (err) { window.open('https://github.com/openscad/openscad', '_blank'); }
  });
  const stage = $('cad-stage');
  ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((t) => stage.addEventListener(t, cadSvgPointer));
}

// Номер детали из ссылки: ?cad=123 или #…&cad=123 (Telegram дописывает свои параметры в hash).
function cadIdFromUrl() {
  const m = (location.search + location.hash).match(/[?#&]cad=(\d+)/);
  return m ? m[1] : null;
}
