/* Грава — экран «🦴 Шарниры», режим «⛓ Цепочка»: фигурка печатается сразу подвижной.
   Каждая ветвь (лапы, хвост, щупальца, шея) — цепочка коротких звеньев.
   Считает фоновый поток flexi-worker.js; размеры суставов и порядок — из flexi-core.js (тот же код).
   Использует помощники из app.js и cadPost/cadBlobToDataUrl/cadIsAuth/cadMm из cad.js. */
'use strict';

const FLEXI_WORKER_URL = './flexi-worker.js?v=10';
const FLEXI_CORE_URL = './flexi-core.js?v=10';
const FLEXI_MAX_FILE = 12 * 1024 * 1024;
// сустав спрятан внутри — соседние звенья красим двумя цветами по очереди, чтобы было видно, где они
const FLEXI_COLORS = [0xc8c8c8, 0xf0a35e];
const FLEXI_RED = '#e53935';
let flexiCore = null;
function flexiLoadCore() {
  if (!flexiCore) flexiCore = import(FLEXI_CORE_URL).catch((e) => { flexiCore = null; throw e; });
  return flexiCore;
}

/* ---------- Открыть / закрыть ---------- */

function openFlexi(id) {
  id = String(id);
  haptic();
  if (state.viewer) closeViewer();
  if (state.cad) closeCad();
  if (state.detail) {
    state.detail = null;
    tg.MainButton.hideProgress();
  } else if (!state.flexi) {
    state.listScroll = window.scrollY;
  }
  if (state.flexi) flexiTeardown();

  const f = state.flexi = {
    id,
    core: null,
    data: null,
    worker: null,
    seq: 0,
    pending: {},
    origLen: 0,
    length: 150,
    cut: 1,
    g: 0.45,
    k: 1.2,
    kBody: 0.5, // звенья позвоночника внутри тела — короче (тело широкое)
    alphaSeg: 20, // «ушко в петле» свободно ходит на ±20°
    prep: null,
    paths: null,
    cuts: [], // разрезы ставит человек: тап по фигурке; на старте — ни одного
    nextId: 1,
    menu: null, // разрез, у которого открыто меню «Убрать»
    sugg: null, // предложения автопоиска — точки для «✨ Предложить»
    showSugg: false,
    suggSeq: 0,
    legs: null,
    built: null,
    stale: true,
    prepTimer: 0,
  };

  $('flexi-missing').hidden = true;
  $('flexi-main').hidden = false;
  $('flexi-title').textContent = 'Загружаю модель…';
  $('flexi-warn-pose').hidden = true;
  $('flexi-warn-parts').hidden = true;
  $('flexi-small-joints').hidden = true;
  $('flexi-pop').hidden = true;
  $('flexi-status').hidden = false;
  $('flexi-status-text').textContent = 'Загружаю модель…';
  $('flexi-editor').hidden = true;
  $('flexi-result').hidden = true;
  flexiRenderSettings();
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  flexiUpdateMainButton();

  flexiLoadCore()
    .then((core) => {
      f.core = core;
      return api({ a: 'flexi', id });
    })
    .then((data) => {
      if (state.flexi !== f) return;
      f.data = data;
      $('flexi-title').textContent = data.title || 'Фигурка';
      $('flexi-warn-pose').hidden = data.flexi !== false;
      return flexiDownload(f);
    })
    .catch((err) => {
      if (state.flexi !== f) return;
      const code = err && err.code;
      if (code === 'auth') {
        flexiShowMissing('Сессия устарела — перезапусти приложение', 'close');
        sessionExpired();
      } else if (code === 'network') {
        flexiShowMissing('Нет связи с сервером. Проверь интернет и попробуй ещё раз', 'retry');
      } else if (code === 'holes') {
        flexiShowMissing('Модель с дырками — шарниры не собрать. Попроси бота слепить заново', 'back');
      } else if (code === 'worker' || !f.core) {
        flexiShowMissing('Сборщик не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз', 'back');
      } else if (code === 'bad_stl') {
        flexiShowMissing('Файл модели не читается. Попроси бота слепить заново', 'back');
      } else {
        flexiShowMissing('Модель не найдена', 'back');
      }
    });
}

function flexiShowMissing(text, action) {
  $('flexi-main').hidden = true;
  $('flexi-missing').hidden = false;
  $('flexi-missing-text').textContent = text;
  const btn = $('flexi-missing-btn');
  btn.dataset.action = action;
  btn.textContent = action === 'retry' ? 'Попробовать ещё раз' : action === 'close' ? 'Закрыть' : 'К моим работам';
  flexiUpdateMainButton();
}

function closeFlexi() {
  if (!state.flexi) return;
  flexiTeardown();
  state.flexi = null;
  tg.MainButton.hideProgress();
  tg.MainButton.setParams({ is_active: true, color: tg.themeParams.button_color || undefined, text_color: tg.themeParams.button_text_color || undefined });
  tg.MainButton.hide();
  tg.BackButton.hide();
  $('busy').hidden = true;
  renderView();
  window.scrollTo(0, state.listScroll || 0);
}

function flexiTeardown() {
  const f = state.flexi;
  if (!f) return;
  clearTimeout(f.prepTimer);
  if (f.worker) f.worker.terminate();
  f.worker = null;
  Object.values(f.pending).forEach((p) => p.reject(new FlexiUiError('cancelled')));
  f.pending = {};
  flexiDestroyPreview();
}

class FlexiUiError extends Error {
  constructor(code, text) {
    super(text || code);
    this.code = code;
  }
}

/* ---------- Настройки сборки ---------- */

// Опции для flexi-core: размеры звена и шаг цепочки.
function flexiOpts(f) {
  return { g: f.g, alphaSeg: f.alphaSeg, k: f.k, kBody: f.kBody };
}

/* ---------- Фоновый поток ---------- */

function flexiWorker(f) {
  if (f.worker) return f.worker;
  let w;
  try { w = new Worker(FLEXI_WORKER_URL, { type: 'module' }); } catch (e) { throw new FlexiUiError('worker'); }
  w.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress' && (msg.phase === 'repair' || msg.phase === 'analyze')) {
      $('flexi-status-text').textContent = msg.phase === 'repair' ? 'Чиню модель…' : 'Смотрю, где гнётся…';
      return;
    }
    if (msg.type === 'progress') {
      $('busy-text').textContent = msg.phase === 'check'
        ? 'Проверяю звенья… ' + msg.k + ' из ' + msg.n
        : 'Звено ' + msg.k + ' из ' + msg.n + '…';
      return;
    }
    const p = f.pending[msg.id];
    if (!p) return;
    delete f.pending[msg.id];
    if (msg.type === 'error') p.reject(new FlexiUiError(msg.code, msg.text));
    else p.resolve(msg);
  };
  w.onerror = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    Object.values(f.pending).forEach((p) => p.reject(new FlexiUiError('worker')));
    f.pending = {};
    w.terminate();
    if (f.worker === w) f.worker = null;
  };
  f.worker = w;
  return w;
}

function flexiCall(f, msg, transfer) {
  const id = ++f.seq;
  return new Promise((resolve, reject) => {
    f.pending[id] = { resolve, reject };
    try {
      flexiWorker(f).postMessage(Object.assign({ id }, msg), transfer || []);
    } catch (e) {
      delete f.pending[id];
      reject(e instanceof FlexiUiError ? e : new FlexiUiError('worker'));
    }
  });
}

/* ---------- Загрузка STL ---------- */

async function flexiDownload(f) {
  const res = await fetchWithTimeout(apiUrl({ a: 'file', id: f.id, what: 'file' }), 180000);
  if (res.status === 401) throw new ApiError('auth');
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.indexOf('json') !== -1) {
    let data = null;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
    throw new ApiError(data && data.error === 'auth' ? 'auth' : 'http_' + res.status);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  let buffer;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (state.flexi !== f) return;
      $('flexi-status-text').textContent = total
        ? 'Загружаю модель… ' + Math.min(99, Math.round((got / total) * 100)) + '%'
        : 'Загружаю модель… ' + (got / 1048576).toFixed(1) + ' МБ';
    }
    const all = new Uint8Array(got);
    let off = 0;
    chunks.forEach((c) => { all.set(c, off); off += c.length; });
    buffer = all.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }
  if (state.flexi !== f) return;
  $('flexi-status-text').textContent = 'Разбираю модель…';
  const r = await flexiCall(f, { type: 'load', buffer }, [buffer]);
  if (state.flexi !== f) return;
  f.origLen = r.length;
  f.length = Math.round(Math.min(250, Math.max(80, Math.max(150, r.length))));
  flexiRenderSettings();
  await flexiPrepare(f, true);
}

/* ---------- Подготовка и предложения ---------- */

async function flexiPrepare(f, first) {
  $('flexi-status').hidden = false;
  $('flexi-status-text').textContent = first ? 'Ищу суставы…' : 'Пересчитываю…';
  const oldLen = f.prep ? f.prep.length : f.length;
  let r;
  try {
    r = await flexiCall(f, { type: 'prepare', length: f.length, cut: f.cut });
  } catch (err) {
    if (state.flexi !== f || (err && err.code === 'cancelled')) return;
    $('flexi-status-text').textContent = 'Не получилось подготовить модель: ' + ((err && err.message) || err);
    return;
  }
  if (state.flexi !== f || r.length !== f.length) return; // уже двигают ползунок дальше
  const sk = r.skeleton;
  r.skel = [];
  for (let k = 0; k < sk.length / 5; k++) r.skel.push({ x: sk[k * 5], y: sk[k * 5 + 1], dt: sk[k * 5 + 2], parent: sk[k * 5 + 3], dist: sk[k * 5 + 4] });
  f.prep = r;
  // ветви, по которым можно резать (позвоночник и лапы): разрез тянется вдоль них
  f.paths = new Map();
  r.branches.forEach((b) => {
    const n = b.pts.length / 2, cum = new Float32Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(b.pts[k * 2] - b.pts[k * 2 - 2], b.pts[k * 2 + 1] - b.pts[k * 2 - 1]);
    f.paths.set(b.i, { pts: b.pts, cum, from: b.from, spine: b.spine });
  });
  f.legs = r.legs;
  // после починки остались крупные отдельные куски — они не соединены с телом
  const warnParts = $('flexi-warn-parts');
  warnParts.hidden = !(r.parts > 1);
  if (r.parts > 1) warnParts.textContent = 'Модель из ' + r.parts + ' ' + plural(r.parts, 'части', 'частей', 'частей') + ' — куски, не связанные с телом, останутся отдельными';
  // предложения (и подсказка «сделай крупнее») — для нового размера
  f.sugg = null;
  await flexiSuggest(f);
  if (state.flexi !== f) return;
  // размер поменялся: модель отцентрована в (0,0) — разрезы едут вместе с ней и ставятся заново (суставы другие)
  if (f.cuts.length && oldLen && r.length !== oldLen) {
    const k = r.length / oldLen;
    f.cuts.forEach((c) => {
      c.P = [c.P[0] * k, c.P[1] * k];
      c.Rh *= k;
      flexiPlace(f, c, c.P[0], c.P[1], null, true, false);
    });
  }
  f.stale = true;
  $('flexi-status').hidden = true;
  $('flexi-editor').hidden = false;
  flexiLayoutCanvas();
  flexiDraw();
  flexiUpdateMainButton();
}

// Предложения автопоиска (скелет, бороздки, корни ветвей) — только точки для «✨ Предложить», не разрезы.
async function flexiSuggest(f) {
  if (!f.prep) return;
  const seq = ++f.suggSeq;
  let r;
  try {
    r = await flexiCall(f, { type: 'auto', opts: flexiOpts(f) });
  } catch (err) {
    return;
  }
  if (state.flexi !== f || seq !== f.suggSeq) return;
  f.sugg = r.sugg;
  // суставы с минимумами в мм: на маленькой фигурке хвосту и лапам их не хватает — просим сделать крупнее
  $('flexi-small-joints').hidden = !r.small;
  flexiDraw();
}

function flexiInvalidate() {
  const f = state.flexi;
  if (!f) return;
  f.stale = true;
  if (f.built) $('flexi-result-stale').hidden = false;
  flexiUpdateMainButton();
}

// Зазор или гибкость поменялись: суставы другие — разрезы проверяются заново, предложения тоже.
function flexiSettingChanged(recheck) {
  const f = state.flexi;
  if (!f) return;
  flexiRenderSettings();
  if (!f.prep) return;
  flexiSuggest(f);
  if (recheck) {
    flexiInvalidate();
    f.cuts.forEach((c) => flexiPlace(f, c, c.P[0], c.P[1], c.br, false, false));
  }
  flexiDraw();
}

/* ---------- Разрезы: поставить и проверить ---------- */

// Данные разреза для потока.
function flexiCutMsg(c) {
  return { id: c.id, P: c.P, n: c.n, w: c.w, chain: c.chain, br: c.br, s: c.s, root: !!c.root, spine: !!c.spine };
}

// Без ответа: поток только помечает старые проверки разреза ненужными.
function flexiPost(f, msg) {
  try { flexiWorker(f).postMessage(msg); } catch (e) { /* поток уже закрыт */ }
}

// Новый разрез там, куда тапнули (или из точки-предложения). Пока поток не ответил — серый.
function flexiAddCut(f, x, y, br, snap) {
  const near = flexiNearestSkel(f, x, y);
  const s = near ? f.prep.skel[near.k] : { x, y };
  const c = {
    id: f.nextId++, P: [s.x, s.y], n: near ? flexiSkelDir(f, near.k) : [1, 0], w: 3, Rh: 0,
    br, s: Infinity, chain: -1, spine: false, root: false, st: 'wait', why: '', ver: 0,
  };
  f.cuts.push(c);
  f.menu = null;
  haptic('medium');
  flexiInvalidate();
  flexiDraw();
  flexiPlace(f, c, x, y, br, snap, true);
  return c;
}

// Разрез ближе к телу на той же цепочке: проверяется вместе с этим (звено между ними — как при сборке).
function flexiPrevCut(f, c) {
  const b = f.paths && f.paths.get(c.br);
  return f.core.prevCut(f.cuts, c, (P) => {
    if (!b) return false;
    for (let k = 0; k < b.pts.length; k += 2) if (Math.hypot(b.pts[k] - P[0], b.pts[k + 1] - P[1]) < 1.5) return true;
    return false;
  });
}

// Разрез поставили, сдвинули или убрали — дальше по цепочке (от s0) звено ближе к телу у разрезов поменялось.
function flexiRecheckChain(f, c, s0) {
  f.cuts.forEach((o) => {
    if (o !== c && o.chain === c.chain && o.Rh > 0 && o.s > s0) flexiPlace(f, o, o.P[0], o.P[1], o.br, false, false);
  });
}

/* Поставить разрез (поперёк ветви в ближайшей точке скелета, к бороздке ближе 3 мм — притянуть) и проверить:
   сначала быстро — по размерам сустава и запасу от кожи, потом булевыми операциями на целой модели (держит в 6 сторон,
   поворачивается, ничего не отрезал) — вместе с разрезом ближе к телу на той же цепочке. Сдвинули или убрали,
   пока считалось, — старый ответ не нужен (c.ver). cascade — разрез поставили или сдвинули рукой: разрезы дальше
   по цепочке проверяются заново. */
async function flexiPlace(f, c, x, y, br, snap, cascade) {
  const ver = ++c.ver;
  const oldS = c.s, oldChain = c.chain;
  c.st = 'wait';
  c.why = '';
  const fresh = () => state.flexi === f && c.ver === ver && f.cuts.indexOf(c) !== -1;
  const bad = (why) => { c.st = 'bad'; c.why = why; flexiDraw(); };
  let r;
  try {
    r = await flexiCall(f, { type: 'place', key: c.id, ver, x, y, br, snap, opts: flexiOpts(f) });
  } catch (err) {
    if (fresh()) bad('не получилось проверить — сдвинь разрез');
    return;
  }
  if (!fresh()) return;
  if (!r.cut) {
    // мимо шеи, лап и хвоста (середина круглого тела, фон)
    flexiDropCut(f, c);
    toast('Тут не гнётся — тапни по шее, лапе или хвосту');
    return;
  }
  Object.assign(c, r.cut);
  if (cascade) {
    if (oldChain >= 0 && oldChain !== c.chain) flexiRecheckChain(f, { chain: oldChain }, oldS);
    flexiRecheckChain(f, c, Math.min(oldS, c.s));
  }
  if (!r.cut.fit) { bad(r.cut.why); return; }
  flexiDraw();
  const prev = flexiPrevCut(f, c);
  let v;
  try {
    v = await flexiCall(f, { type: 'check', key: c.id, ver, cut: flexiCutMsg(c), prev: prev && flexiCutMsg(prev), opts: flexiOpts(f) });
  } catch (err) {
    if (fresh()) bad('не получилось проверить — сдвинь разрез');
    return;
  }
  if (!fresh() || v.stale) return;
  if (v.ok) { c.st = 'ok'; c.why = ''; flexiDraw(); } else bad(v.why);
}

function flexiDropCut(f, c, cascade = true) {
  f.cuts = f.cuts.filter((x) => x !== c);
  if (f.menu === c.id) f.menu = null;
  flexiPost(f, { type: 'drop', key: c.id, ver: ++c.ver });
  if (cascade && c.Rh > 0) flexiRecheckChain(f, c, c.s);
  flexiInvalidate();
  flexiDraw();
}

// Зелёный, красный или «проверяю»: зелёный рядом с соседом (кружки ближе 2 мм) — тоже красный.
function flexiCutState(f, c) {
  if (c.st !== 'ok') return c.st;
  return f.cuts.some((o) => o !== c && o.Rh > 0 && f.core.tooClose(c, o)) ? 'near' : 'ok';
}
function flexiCutWhy(f, c) {
  const st = flexiCutState(f, c);
  return st === 'near' ? f.core.NEAR_WHY : st === 'bad' ? c.why : '';
}
// «Собрать STL» — когда есть хотя бы один разрез и все зелёные.
function flexiCanBuild(f) {
  return !!(f && f.prep && f.cuts.length && f.cuts.every((c) => flexiCutState(f, c) === 'ok'));
}

/* ---------- Вид сверху ---------- */

const flexiView = { img: null, k: 1, ox: 0, oy: 0, drag: null, dpr: 1 };
const FLEXI_GREEN = '#34c759';

function flexiLayoutCanvas() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  const canvas = $('flexi-canvas');
  const cw = $('flexi-top').clientWidth || 360;
  const { W, H } = f.prep.grid;
  const ch = Math.round(Math.max(220, Math.min(cw * H / W + 24, (window.innerHeight || 640) * 0.6)));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  flexiView.k = Math.min((cw - 16) / W, (ch - 16) / H);
  flexiView.ox = (cw - W * flexiView.k) / 2;
  flexiView.oy = (ch - H * flexiView.k) / 2;
  flexiView.dpr = dpr;

  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ictx = img.getContext('2d');
  const id = ictx.createImageData(W, H);
  const hts = f.prep.heights;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = hts[y * W + x];
      if (!v) continue;
      const o = ((H - 1 - y) * W + x) * 4; // ось Y — вверх
      id.data[o] = id.data[o + 1] = id.data[o + 2] = v;
      id.data[o + 3] = 255;
    }
  }
  ictx.putImageData(id, 0, 0);
  flexiView.img = img;
}

function flexiToScreen(x, y) {
  const g = state.flexi.prep.grid;
  return [flexiView.ox + ((x - g.x0) / g.step) * flexiView.k, flexiView.oy + (g.H - (y - g.y0) / g.step) * flexiView.k];
}
function flexiToModel(sx, sy) {
  const g = state.flexi.prep.grid;
  return [g.x0 + ((sx - flexiView.ox) / flexiView.k) * g.step, g.y0 + (g.H - (sy - flexiView.oy) / flexiView.k) * g.step];
}
function flexiPx(mm) {
  return (mm / state.flexi.prep.grid.step) * flexiView.k;
}

// Порядок сборки (номер на экране): от ядра вдоль скелета — как в потоке.
function flexiOrdered(f) {
  return f.core.orderCuts(f.cuts, f.prep.skel);
}

// Кружок сустава (радиус Rh; пока поток не ответил — 6 мм) и черта поперёк ветви.
const flexiR = (c) => c.Rh || 6;
function flexiHalfBar(c) {
  return Math.max(c.w, flexiR(c)) + 2;
}

function flexiDraw() {
  const f = state.flexi;
  if (!f || !f.prep || !flexiView.img) return;
  const canvas = $('flexi-canvas');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(flexiView.dpr, 0, 0, flexiView.dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const g = f.prep.grid;
  ctx.drawImage(flexiView.img, flexiView.ox, flexiView.oy, g.W * flexiView.k, g.H * flexiView.k);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2481cc';

  // предложения — полупрозрачные точки (не разрезы): тут сустав помещается — цветом, тут тонко — серым
  if (f.showSugg) {
    flexiVisibleSugg(f).forEach((q) => {
      const [px, py] = flexiToScreen(q.P[0], q.P[1]);
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = q.fit ? accent : '#8e8e93';
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  const order = flexiOrdered(f);
  order.forEach((c, i) => {
    const st = flexiCutState(f, c);
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const r = flexiPx(flexiR(c));
    const open = f.menu === c.id;
    const color = st === 'ok' ? FLEXI_GREEN : st === 'wait' ? '#8e8e93' : FLEXI_RED;

    // кружок — размер сустава; пока проверяется — пунктиром
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = open ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
    ctx.fill();
    ctx.lineWidth = open ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.setLineDash(st === 'wait' ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    // черта поперёк ветви — место разреза
    const L = flexiHalfBar(c);
    const [ax, ay] = flexiToScreen(c.P[0] + c.n[1] * L, c.P[1] - c.n[0] * L);
    const [bx, by] = flexiToScreen(c.P[0] - c.n[1] * L, c.P[1] + c.n[0] * L);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = open ? 3.5 : 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    // номер (на маленьком кружке — поменьше, чтобы кружок было видно)
    const small = r < 15;
    ctx.beginPath();
    ctx.arc(px, py, small ? 6 : 8.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = (small ? '700 8px ' : '700 10.5px ') + '-apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), px, py + 0.5);
  });

  $('flexi-suggest').classList.toggle('is-active', !!f.showSugg);
  $('flexi-reset').disabled = !f.cuts.length;
  $('flexi-count').textContent = flexiChainInfo(f);
  flexiRenderCutNotes(f, order);
  flexiRenderMenu(f);
  $('flexi-build').disabled = !flexiCanBuild(f) || !!state.flexiBusy;
}

// Красные разрезы — короткая причина под видом сверху; пока поток проверяет — «Проверяю…».
function flexiRenderCutNotes(f, order) {
  const box = $('flexi-cut-notes');
  box.textContent = '';
  order.forEach((c, i) => {
    const why = flexiCutWhy(f, c);
    if (why) box.appendChild(el('div', 'flexi-note is-error', '✖ Разрез ' + (i + 1) + ': ' + why));
  });
  const wait = f.cuts.filter((c) => c.st === 'wait').length;
  if (wait) box.appendChild(el('div', 'flexi-note is-ok', wait === 1 ? 'Проверяю разрез…' : 'Проверяю разрезы… (' + wait + ')'));
}

// Маленькое меню у разреза — «Убрать» (причина красного — под видом сверху), над разрезом или под ним.
function flexiRenderMenu(f) {
  const pop = $('flexi-pop');
  const c = f.menu != null && f.cuts.find((x) => x.id === f.menu);
  if (!c) { pop.hidden = true; return; }
  pop.hidden = false;
  const box = $('flexi-top');
  const [px, py] = flexiToScreen(c.P[0], c.P[1]);
  const r = flexiPx(flexiR(c));
  const w = pop.offsetWidth, h = pop.offsetHeight, bw = box.clientWidth, bh = $('flexi-canvas').clientHeight;
  const left = Math.max(8, Math.min(bw - w - 8, px - w / 2));
  const top = py - r - h - 8 >= 4 ? py - r - h - 8 : Math.min(bh - h - 4, py + r + 8);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(Math.max(4, top)) + 'px';
}

// «Позвоночник: 5 звеньев · лапы: 4 · гнётся до ±100°» или «8 ветвей · 24 звена · хвост гнётся до ±60°».
function flexiChainInfo(f) {
  if (!f.cuts.length) return 'Разрезов пока нет — фигурка целиком';
  const per = {};
  f.cuts.forEach((c) => { per[c.chain] = (per[c.chain] || 0) + 1; });
  // позвоночник — цепочка, в которой есть звенья позвоночника; остальные цепочки — лапы
  const sc = f.cuts.find((c) => c.spine);
  if (sc) {
    const ns = per[sc.chain], legs = f.legs != null ? f.legs : Object.keys(per).length - 1;
    return 'Позвоночник: ' + ns + ' ' + plural(ns, 'звено', 'звена', 'звеньев') + ' · лапы: ' + legs + ' · гнётся до ±' + ns * f.alphaSeg + '°';
  }
  const counts = Object.values(per);
  const longest = Math.max(...counts);
  const nb = counts.length, nl = f.cuts.length;
  return nb + ' ' + plural(nb, 'ветвь', 'ветви', 'ветвей') + ' · ' + nl + ' ' + plural(nl, 'звено', 'звена', 'звеньев') +
    ' · ' + (nb === 1 ? 'гнётся' : 'хвост гнётся') + ' до ±' + longest * f.alphaSeg + '°';
}

// Точки-предложения, на которых ещё нет разреза.
function flexiVisibleSugg(f) {
  return (f.sugg || []).filter((q) => !f.cuts.some((c) => Math.hypot(c.P[0] - q.P[0], c.P[1] - q.P[1]) < 2));
}

/* ---------- Скелет: ближайшая точка, направление ---------- */

function flexiNearestSkel(f, x, y) {
  let best = -1, bd = Infinity;
  f.prep.skel.forEach((s, k) => {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bd) { bd = d; best = k; }
  });
  return best < 0 ? null : { k: best, dist: Math.sqrt(bd) };
}

// От ядра наружу: точка минус её предок на 3 мм ближе к ядру.
function flexiSkelDir(f, k) {
  const s = f.prep.skel;
  let a = k, len = 0;
  while (s[a].parent >= 0 && len < 3) {
    const p = s[a].parent;
    len += Math.hypot(s[a].x - s[p].x, s[a].y - s[p].y);
    a = p;
  }
  let nx = s[k].x - s[a].x, ny = s[k].y - s[a].y;
  if (Math.hypot(nx, ny) < 1e-6) { nx = s[k].x - f.prep.core[0]; ny = s[k].y - f.prep.core[1]; }
  const l = Math.hypot(nx, ny) || 1;
  return [nx / l, ny / l];
}

// Ближайшая точка ветви bi (только та часть, где можно резать) и направление вдоль неё (как в потоке: ±3 мм).
function flexiAlong(f, bi, x, y) {
  const b = f.paths && f.paths.get(bi);
  if (!b) return null;
  const n = b.pts.length / 2;
  let kb = -1, bd = Infinity;
  for (let k = Math.max(0, b.from); k < n; k++) {
    const d = (b.pts[k * 2] - x) ** 2 + (b.pts[k * 2 + 1] - y) ** 2;
    if (d < bd) { bd = d; kb = k; }
  }
  if (kb < 0) return null;
  const at = (s) => { let k = 0; while (k < n - 1 && b.cum[k] < s) k++; return k; };
  const a = at(b.cum[kb] - 3), z = at(b.cum[kb] + 3);
  const dx = b.pts[z * 2] - b.pts[a * 2], dy = b.pts[z * 2 + 1] - b.pts[a * 2 + 1], l = Math.hypot(dx, dy) || 1;
  return { P: [b.pts[kb * 2], b.pts[kb * 2 + 1]], n: [dx / l, dy / l] };
}

// Точка на фигурке (по картинке высот, с запасом 1 мм у края).
function flexiOnModel(f, x, y) {
  const g = f.prep.grid, h = f.prep.heights;
  const cx = Math.floor((x - g.x0) / g.step), cy = Math.floor((y - g.y0) / g.step), r = Math.ceil(1 / g.step);
  for (let py = cy - r; py <= cy + r; py++) {
    for (let px = cx - r; px <= cx + r; px++) {
      if (px >= 0 && py >= 0 && px < g.W && py < g.H && h[py * g.W + px]) return true;
    }
  }
  return false;
}

/* ---------- Пальцем по виду сверху ---------- */

function flexiPoint(e) {
  const r = $('flexi-canvas').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// Разрез под пальцем (ближайший, в пределах кружка, но не меньше 16 и не больше 26 px).
function flexiHitCut(f, sx, sy) {
  let hit = null, hd = Infinity;
  f.cuts.forEach((c) => {
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < Math.max(16, Math.min(26, flexiPx(flexiR(c)))) && d < hd) { hd = d; hit = c; }
  });
  return hit;
}
function flexiHitSugg(f, sx, sy) {
  let hit = null, hd = 18;
  flexiVisibleSugg(f).forEach((q) => {
    const [px, py] = flexiToScreen(q.P[0], q.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < hd) { hd = d; hit = q; }
  });
  return hit;
}

function flexiPointerDown(e) {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  e.preventDefault();
  const [sx, sy] = flexiPoint(e);
  try { $('flexi-canvas').setPointerCapture(e.pointerId); } catch (err) { /* ок */ }
  const hit = flexiHitCut(f, sx, sy);
  flexiView.drag = { pointer: e.pointerId, x0: sx, y0: sy, id: hit ? hit.id : null, moved: false };
}

// Тянут разрез — он едет вдоль своей ветви (позвоночника, лапы); проверяется, когда отпустят.
function flexiPointerMove(e) {
  const f = state.flexi;
  const d = flexiView.drag;
  if (!f || !d || d.pointer !== e.pointerId) return;
  e.preventDefault();
  const [sx, sy] = flexiPoint(e);
  if (!d.moved && Math.hypot(sx - d.x0, sy - d.y0) < 8) return;
  const c = d.id != null && f.cuts.find((x) => x.id === d.id);
  if (!c) return;
  if (!d.moved) { d.moved = true; f.menu = null; haptic(); }
  const q = flexiAlong(f, c.br, ...flexiToModel(sx, sy));
  if (q) { c.P = q.P; c.n = q.n; }
  c.st = 'wait';
  c.ver++; // старая проверка устарела
  flexiInvalidate();
  flexiDraw();
}

function flexiPointerUp(e) {
  const f = state.flexi;
  const d = flexiView.drag;
  if (!d || d.pointer !== e.pointerId) return;
  flexiView.drag = null;
  if (!f || !f.prep) return;
  if (d.moved) {
    const c = d.id != null && f.cuts.find((x) => x.id === d.id);
    if (c) flexiPlace(f, c, c.P[0], c.P[1], c.br, true, true);
    return;
  }
  if (e.type === 'pointercancel') return;
  // тап по разрезу — меню «Убрать»
  if (d.id != null) {
    haptic();
    f.menu = f.menu === d.id ? null : d.id;
    flexiDraw();
    return;
  }
  // меню было открыто — тап мимо просто закрывает его
  if (f.menu != null) {
    f.menu = null;
    flexiDraw();
    return;
  }
  // тап по точке-предложению — она становится разрезом
  const q = f.showSugg && flexiHitSugg(f, d.x0, d.y0);
  if (q) { flexiAddCut(f, q.P[0], q.P[1], q.br, false); return; }
  // тап по фигурке — разрез поперёк ветви в ближайшей точке скелета
  const [mx, my] = flexiToModel(d.x0, d.y0);
  if (flexiOnModel(f, mx, my)) flexiAddCut(f, mx, my, null, true);
}

function flexiRemoveMenu() {
  const f = state.flexi;
  const c = f && f.menu != null && f.cuts.find((x) => x.id === f.menu);
  if (!c) return;
  haptic();
  flexiDropCut(f, c);
}

function flexiReset() {
  const f = state.flexi;
  if (!f || !f.cuts.length) return;
  haptic();
  f.cuts.slice().forEach((c) => flexiDropCut(f, c, false));
  f.menu = null;
  flexiDraw();
}

function flexiSuggestBtn() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  haptic();
  f.showSugg = !f.showSugg;
  f.menu = null;
  if (f.showSugg && !f.sugg) flexiSuggest(f);
  flexiDraw();
}

/* ---------- Настройки на экране ---------- */

function flexiRenderSettings() {
  const f = state.flexi;
  if (!f) return;
  $('flexi-length').value = String(f.length);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-size').hidden = f.length >= 150;
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === f.g));
  $('flexi-k').value = String(f.k);
  $('flexi-kb').value = String(f.kBody);
  $('flexi-kb-val').textContent = f.kBody.toFixed(1);
  $('flexi-k-val').textContent = f.k.toFixed(1);
  $('flexi-aseg').value = String(f.alphaSeg);
  $('flexi-aseg-val').textContent = '±' + f.alphaSeg + '°';
}

function flexiOnLength() {
  const f = state.flexi;
  if (!f) return;
  f.length = Number($('flexi-length').value);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-size').hidden = f.length >= 150;
  flexiSchedulePrepare();
}

function flexiSchedulePrepare() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  // суставы на новом размере другие: разрезы проверятся заново, когда модель пересчитается
  f.cuts.forEach((c) => { c.ver++; c.st = 'wait'; c.why = ''; });
  flexiInvalidate();
  flexiDraw();
  clearTimeout(f.prepTimer);
  f.prepTimer = setTimeout(() => flexiPrepare(f, false), 450);
}

/* ---------- Сборка ---------- */

async function flexiBuild() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  if (!flexiCanBuild(f)) {
    toast(f.cuts.length ? 'Сначала сделай все разрезы зелёными' : 'Тапни по фигурке там, где она должна гнуться');
    return;
  }
  haptic();
  clearTimeout(f.prepTimer);
  state.flexiBusy = true;
  f.menu = null;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Готовлю звенья…';
  let r;
  try {
    r = await flexiCall(f, { type: 'build', opts: flexiOpts(f), cuts: f.cuts.map(flexiCutMsg) });
  } catch (err) {
    state.flexiBusy = false;
    $('busy').hidden = true;
    if (state.flexi !== f || (err && err.code === 'cancelled')) return;
    hapticNotify('error');
    alertBox(err && err.code === 'worker'
      ? 'Сборщик не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз'
      : 'Не получилось собрать: ' + ((err && err.message) || err));
    return;
  }
  state.flexiBusy = false;
  $('busy').hidden = true;
  if (state.flexi !== f) return;

  // разрез, который при сборке всё-таки не получился, — красный, с причиной (ничего не пропускается молча)
  const errors = r.notes.filter((x) => x.level === 'error');
  errors.forEach((x) => {
    const c = x.id != null && f.cuts.find((q) => q.id === x.id);
    if (c && c.st === 'ok') { c.st = 'bad'; c.why = x.why; }
  });
  f.built = Object.assign(r, { errors });
  f.stale = false;
  $('flexi-result').hidden = false;
  $('flexi-result-stale').hidden = true;
  flexiRenderResult(f);
  flexiDraw();
  f.previewReady = flexiShowPreview(f);
  await f.previewReady;
  flexiUpdateMainButton();
  if (errors.length) hapticNotify('error');
  else hapticNotify('success');
  setTimeout(() => $('flexi-result').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function flexiRenderResult(f) {
  const b = f.built;
  const sum = $('flexi-summary');
  sum.className = 'flexi-summary ' + (b.errors.length ? 'is-bad' : 'is-ok');
  sum.textContent = b.errors.length
    ? '⚠ ' + b.errors.length + ' ' + plural(b.errors.length, 'проблема', 'проблемы', 'проблем') + ' — смотри ниже'
    : b.summary;

  const box = $('flexi-notes');
  box.textContent = '';
  const add = (cls, text) => box.appendChild(el('div', 'flexi-note ' + cls, text));
  b.errors.forEach((x) => add('is-error', '✖ ' + x.text));
  b.notes.filter((x) => x.level === 'warn').forEach((x) => add('is-warn', '⚠ ' + x.text));

  $('flexi-parts').textContent = 'Деталей: ' + b.parts.length + ' · звеньев: ' + b.joints.length + ' · ' + cadMm(b.stl.byteLength / 1048576) + ' МБ';
}

/* ---------- 3D-превью ---------- */

const flexiPrev = { v: null, raf: 0, ro: null, wiggle: false, t0: 0 };

async function flexiShowPreview(f) {
  const T = await loadThree();
  if (state.flexi !== f) return;
  flexiDestroyPreview();
  const stage = $('flexi-3d');
  stage.textContent = '';
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  scene.add(camera);
  scene.add(new T.HemisphereLight(0xffffff, 0x888888, 1.6));
  const key = new T.DirectionalLight(0xffffff, 1.9);
  key.position.set(1, 1.5, 2);
  camera.add(key);

  const b = f.built;
  const geoms = b.parts.map((p) => flexiGeometry(T, p));
  const depthOfPart = (p) => { let d = 0; for (let x = p.joint; x >= 0; x = b.joints[x].parent) d++; return d; };
  const mats = b.parts.map((p) => new T.MeshStandardMaterial({ color: FLEXI_COLORS[depthOfPart(p) % 2], roughness: 0.8, metalness: 0 }));

  // «Собранная»: иерархия суставов — лапа поворачивается вокруг вертикали через P вместе с вложенными звеньями
  const assembled = new T.Group();
  const pivots = [];
  const holder = [];
  const depthOf = (j) => { let d = 0; for (let x = j; x >= 0; x = b.joints[x].parent) d++; return d; };
  const mkHolder = (j) => {
    if (holder[j]) return holder[j];
    const J = b.joints[j];
    const parentHolder = J.parent >= 0 ? mkHolder(J.parent) : assembled;
    const pivot = new T.Group();
    pivot.position.set(J.P[0], J.P[1], 0);
    const inner = new T.Group();
    inner.position.set(-J.P[0], -J.P[1], 0);
    pivot.add(inner);
    parentHolder.add(pivot);
    pivots.push({ pivot, alpha: J.alpha * Math.PI / 180, depth: depthOf(j), chain: Math.max(0, J.chain), spine: !!J.spine, s: J.s || 0 });
    holder[j] = inner;
    return inner;
  };
  const box = new T.Box3();
  const meshes = [];
  b.parts.forEach((p, i) => {
    geoms[i].computeBoundingBox();
    box.union(geoms[i].boundingBox);
    const mesh = new T.Mesh(geoms[i], mats[i]);
    meshes.push(mesh);
    (p.joint >= 0 ? mkHolder(p.joint) : assembled).add(mesh);
  });
  scene.add(assembled);

  const center = new T.Vector3();
  const size = new T.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(size.length() / 2, 1);
  const dist = (radius / Math.sin((35 / 2) * Math.PI / 180)) * 1.05;
  camera.position.copy(center).add(new T.Vector3(0.6, -1, 1.1).normalize().multiplyScalar(dist));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();

  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.minDistance = radius * 0.4;
  controls.maxDistance = radius * 12;
  controls.update();

  const resize = () => {
    const w = stage.clientWidth || 300, h = stage.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  if (window.ResizeObserver) {
    flexiPrev.ro = new ResizeObserver(resize);
    flexiPrev.ro.observe(stage);
  }
  const loop = (now) => {
    flexiPrev.raf = requestAnimationFrame(loop);
    if (flexiPrev.wiggle) {
      const t = (now - flexiPrev.t0) / 1000;
      // волна: каждое звено качается на ±α, дальние от тела — со сдвигом фазы
      // позвоночник — волна от головы к хвосту (по месту звена вдоль позвоночника), лапы — от тела к кончикам
      pivots.forEach((p) => { p.pivot.rotation.z = Math.sin(t * 2.4 - (p.spine ? p.s * 0.06 : p.depth * 0.8 + p.chain * 1.3)) * p.alpha; });
    }
    controls.update();
    renderer.render(scene, camera);
  };
  flexiPrev.raf = requestAnimationFrame(loop);
  flexiPrev.v = { T, renderer, scene, camera, controls, geoms, mats, pivots, center, radius, dist, assembled, box };
  flexiSetWiggle(false);
}

function flexiGeometry(T, p) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(p.vert, 3));
  g.setIndex(new T.BufferAttribute(p.tri, 1));
  const flat = g.toNonIndexed(); // нормали по граням
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

function flexiSetWiggle(on) {
  flexiPrev.wiggle = on;
  flexiPrev.t0 = performance.now();
  if (!on && flexiPrev.v) flexiPrev.v.pivots.forEach((p) => { p.pivot.rotation.z = 0; });
  $('flexi-wiggle').textContent = on ? '⏸ Остановить' : '🦎 Пошевелить';
}

function flexiDestroyPreview() {
  cancelAnimationFrame(flexiPrev.raf);
  if (flexiPrev.ro) flexiPrev.ro.disconnect();
  flexiPrev.ro = null;
  const v = flexiPrev.v;
  flexiPrev.v = null;
  if (!v) return;
  v.controls.dispose();
  v.geoms.forEach((g) => g.dispose());
  v.mats.forEach((m) => m.dispose());
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

// Снимок 800×800: вид 3/4 сверху, светлый фон, звенья в покое.
function flexiSnapshot() {
  const v = flexiPrev.v;
  const r = v.renderer, cam = v.camera;
  const wasWiggle = flexiPrev.wiggle;
  v.pivots.forEach((p) => { p.pivot.rotation.z = 0; });
  const savedPos = cam.position.clone(), savedAspect = cam.aspect, savedRatio = r.getPixelRatio();
  const stage = $('flexi-3d');
  r.setPixelRatio(1);
  r.setSize(800, 800, false);
  cam.aspect = 1;
  cam.position.copy(v.center).add(new v.T.Vector3(0.6, -1, 1.1).normalize().multiplyScalar(v.dist));
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
  flexiPrev.wiggle = wasWiggle;
  return url;
}

/* ---------- Прислать в чат ---------- */

function flexiReady(f) {
  return !!(f && f.built && !f.stale && !f.built.errors.length && f.built.joints.length);
}

function flexiUpdateMainButton() {
  const f = state.flexi;
  if (!f) return;
  if (!f.prep) {
    tg.MainButton.hide();
    return;
  }
  const ready = flexiReady(f);
  const theme = tg.themeParams || {};
  tg.MainButton.setParams({
    text: '📤 Прислать STL в чат',
    is_visible: true,
    is_active: ready,
    color: ready ? theme.button_color || undefined : theme.hint_color || theme.button_color || undefined,
    text_color: theme.button_text_color || undefined,
  });
}

async function flexiExport() {
  const f = state.flexi;
  if (f && f.previewReady) await f.previewReady; // снимок делаем из превью
  if (!flexiReady(f) || state.flexiBusy || !flexiPrev.v) {
    if (f && f.built && f.stale) toast('Сначала пересобери — нажми «🔧 Собрать STL»');
    else if (f && f.built && f.built.errors.length) toast('Есть красные ошибки — исправь их и пересобери');
    return;
  }
  haptic();
  const bytes = f.built.stl;
  if (bytes.byteLength > FLEXI_MAX_FILE) {
    hapticNotify('error');
    alertBox('Модель слишком подробная для отправки (файл больше 12 МБ)');
    return;
  }
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Отправляю в чат…';
  let r;
  try {
    let snapshot = '';
    try { snapshot = flexiSnapshot(); } catch (e) { /* без снимка */ }
    r = await cadPost({
      a: 'flexi', id: f.id, file: await cadBlobToDataUrl(bytes), snapshot,
      caption: 'Не масштабируй в слайсере — суставы рассчитаны на этот размер', // текст к STL в чате
    }, 120000);
  } catch (e) {
    r = { status: 0, data: null };
  }
  state.flexiBusy = false;
  $('busy').hidden = true;
  if (cadIsAuth(r)) {
    sessionExpired();
  } else if (r.data && r.data.ok === true) {
    hapticNotify('success');
    alertBox('Готово! Файл в чате 👌');
    loadMe(false);
  } else {
    hapticNotify('error');
    alertBox('Не вышло, попробуй ещё раз');
  }
}

/* ---------- Кнопки ---------- */

function bindFlexi() {
  const canvas = $('flexi-canvas');
  canvas.addEventListener('pointerdown', flexiPointerDown);
  canvas.addEventListener('pointermove', flexiPointerMove);
  canvas.addEventListener('pointerup', flexiPointerUp);
  canvas.addEventListener('pointercancel', flexiPointerUp);
  $('flexi-pop-remove').addEventListener('click', flexiRemoveMenu);
  $('flexi-suggest').addEventListener('click', flexiSuggestBtn);
  $('flexi-reset').addEventListener('click', flexiReset);
  $('flexi-length').addEventListener('input', flexiOnLength);

  const withF = (fn) => (e) => { const f = state.flexi; if (f) fn(f, e); };
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.addEventListener('click', withF((f) => {
    haptic();
    f.g = Number(b.dataset.v);
    flexiSettingChanged(true);
  })));
  // длина звена и звенья тела — шаг предложений; гибкость меняет сам сустав — разрезы проверяются заново
  let sliderTimer = 0;
  const slider = (id, apply, recheck) => $(id).addEventListener('input', withF((f) => {
    apply(f, Number($(id).value));
    flexiRenderSettings();
    if (recheck) flexiInvalidate();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { if (state.flexi === f) flexiSettingChanged(recheck); }, 350);
  }));
  slider('flexi-k', (f, v) => { f.k = v; }, false);
  slider('flexi-kb', (f, v) => { f.kBody = v; }, false);
  slider('flexi-aseg', (f, v) => { f.alphaSeg = v; }, true);

  $('flexi-build').addEventListener('click', flexiBuild);
  $('flexi-wiggle').addEventListener('click', () => {
    haptic();
    flexiSetWiggle(!flexiPrev.wiggle);
  });
  $('flexi-missing-btn').addEventListener('click', () => {
    haptic();
    const action = $('flexi-missing-btn').dataset.action;
    if (action === 'close') tg.close();
    else if (action === 'retry' && state.flexi) openFlexi(state.flexi.id);
    else closeFlexi();
  });
  window.addEventListener('resize', () => {
    if (state.flexi && state.flexi.prep && !$('flexi-editor').hidden) {
      flexiLayoutCanvas();
      flexiDraw();
    }
  });
}

// Номер модели из ссылки: ?flexi=123 или #…&flexi=123.
function flexiIdFromUrl() {
  const m = (location.search + location.hash).match(/[?#&]flexi=(\d+)/);
  return m ? m[1] : null;
}
