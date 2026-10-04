/* Грава — экран «🦴 Шарниры»: подвижная фигурка.
   Режимы: 🧩 Сборная (детали печатаются раздельно и защёлкиваются) и 🖨 Целиком (print-in-place).
   Считает фоновый поток flexi-worker.js; размеры суставов и порядок — из flexi-core.js (тот же код).
   Использует помощники из app.js и cadPost/cadBlobToDataUrl/cadIsAuth/cadMm из cad.js. */
'use strict';

const FLEXI_WORKER_URL = './flexi-worker.js?v=2';
const FLEXI_CORE_URL = './flexi-core.js?v=2';
const FLEXI_MAX_FILE = 12 * 1024 * 1024;
const FLEXI_COLORS = [0xb8b8b8, 0x6fa8dc, 0xf6b26b, 0x93c47d, 0xe06666, 0x8e7cc3, 0xffd966, 0x76a5af, 0xc27ba0, 0xa2c4c9, 0xd5a6bd, 0xb6d7a8, 0xf9cb9c, 0x9fc5e8, 0xea9999];
const FLEXI_RED = '#e53935';
const FLEXI_HINT = {
  pip: 'Печатай без поддержек, масштаб 100%, слой 0.2. После печати разработай каждый сустав. Прилипло — зазор 0.55 и пересобери. Болтается — 0.35.',
  kit: 'Печатай детали как разложены, без поддержек, слой 0.2. Сборка: вдави кулак лапы в кольцо сбоку до щелчка. Туго — натяг 0.2, болтается — 0.5.',
};
const FLEXI_MODE_TIP = {
  kit: 'Детали печатаются отдельно и защёлкиваются — ничего не слипнется, сустав держит позу.',
  pip: 'Печатается сразу подвижной, без сборки.',
};

let flexiCore = null;
function flexiLoadCore() {
  if (!flexiCore) flexiCore = import(FLEXI_CORE_URL).catch((e) => { flexiCore = null; throw e; });
  return flexiCore;
}

function flexiStore(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) { /* приватный режим — не страшно */ }
  return null;
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

  const plate = Number(flexiStore('grava.flexi.plate')) || 220;
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
    mode: 'kit',
    pip: { g: 0.45, alpha: 20, links: true },
    kit: { g: 0.2, snap: 0.35, links: false, plate: [180, 220, 250, 300].indexOf(plate) >= 0 ? plate : 220 },
    k: 1.2,
    alphaSeg: 15,
    prep: null,
    cuts: [],
    edited: false,
    nextId: 1,
    selected: null,
    addMode: false,
    built: null,
    stale: true,
    prepTimer: 0,
    autoSeq: 0,
    view: 'assembled',
  };

  $('flexi-missing').hidden = true;
  $('flexi-main').hidden = false;
  $('flexi-title').textContent = 'Загружаю модель…';
  $('flexi-warn-pose').hidden = true;
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

// Опции для flexi-core: размеры суставов, автопоиск, раскладка.
function flexiOpts(f) {
  if (f.mode === 'kit') {
    return { mode: 'kit', g: f.kit.g, snap: f.kit.snap, plate: f.kit.plate, links: f.kit.links, k: f.k, alphaSeg: f.alphaSeg };
  }
  return { mode: 'pip', g: f.pip.g, alpha: f.pip.alpha, links: f.pip.links, k: f.k, alphaSeg: f.alphaSeg };
}

function flexiDims(f, c) {
  return f.core.jointDims(flexiOpts(f), c.w, flexiZtop(f, c.P[0], c.P[1]), c.link);
}

// Верх модели в радиусе 3 мм — по картинке высот (точное значение считает поток при сборке).
function flexiZtop(f, x, y) {
  const g = f.prep.grid, h = f.prep.heights;
  const cx = (x - g.x0) / g.step - 0.5, cy = (y - g.y0) / g.step - 0.5, rp = 3 / g.step;
  let best = 0;
  for (let py = Math.max(0, Math.floor(cy - rp)); py <= Math.min(g.H - 1, Math.ceil(cy + rp)); py++) {
    for (let px = Math.max(0, Math.floor(cx - rp)); px <= Math.min(g.W - 1, Math.ceil(cx + rp)); px++) {
      if ((px - cx) ** 2 + (py - cy) ** 2 <= rp * rp && h[py * g.W + px] > best) best = h[py * g.W + px];
    }
  }
  return best ? ((best - 40) / 215) * f.prep.zMax : 0;
}

/* ---------- Фоновый поток ---------- */

function flexiWorker(f) {
  if (f.worker) return f.worker;
  let w;
  try { w = new Worker(FLEXI_WORKER_URL, { type: 'module' }); } catch (e) { throw new FlexiUiError('worker'); }
  w.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      $('busy-text').textContent = msg.phase === 'check'
        ? 'Проверяю суставы… ' + msg.k + ' из ' + msg.n
        : (msg.link ? 'Звено ' : 'Сустав ') + msg.k + ' из ' + msg.n + '…';
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

/* ---------- Подготовка и автопоиск ---------- */

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
  if (f.edited && oldLen && r.length !== oldLen) {
    const k = r.length / oldLen; // модель отцентрована в (0,0) — разрезы масштабируются вместе с ней
    f.cuts.forEach((c) => { c.P = [c.P[0] * k, c.P[1] * k]; c.w *= k; });
  }
  if (!f.edited) await flexiAuto(f, true);
  f.stale = true;
  if (state.flexi !== f) return;
  $('flexi-status').hidden = true;
  $('flexi-editor').hidden = false;
  flexiLayoutCanvas();
  flexiDraw();
  flexiUpdateMainButton();
}

async function flexiAuto(f, silent) {
  if (!f.prep) return;
  const seq = ++f.autoSeq;
  let r;
  try {
    r = await flexiCall(f, { type: 'auto', opts: flexiOpts(f) });
  } catch (err) {
    return;
  }
  if (state.flexi !== f || seq !== f.autoSeq) return;
  f.cuts = r.cuts.map((c) => ({ id: f.nextId++, P: c.P, n: c.n, w: c.w, link: !!c.link, chain: c.chain }));
  f.edited = false;
  f.selected = null;
  flexiInvalidate();
  if (!silent) flexiDraw();
}

function flexiInvalidate() {
  const f = state.flexi;
  if (!f) return;
  f.stale = true;
  if (f.built) $('flexi-result-stale').hidden = false;
  flexiUpdateMainButton();
}

// Настройка поменялась: если разрезы не трогали руками — переставим их заново (размеры суставов другие).
function flexiSettingChanged() {
  const f = state.flexi;
  if (!f) return;
  flexiRenderSettings();
  flexiInvalidate();
  if (!f.prep) return;
  if (!f.edited) flexiAuto(f, false);
  else flexiDraw();
}

/* ---------- Вид сверху ---------- */

const flexiView = { img: null, k: 1, ox: 0, oy: 0, drag: null, dpr: 1 };

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

// Кружок поворота — на конце стрелки n.
function flexiHandle(f, c) {
  const L = flexiDims(f, c).Rh + 5;
  return [c.P[0] + c.n[0] * L, c.P[1] + c.n[1] * L];
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
  const red = (f.built && !f.stale && f.built.redIds) || [];
  const order = flexiOrdered(f);
  order.forEach((c, i) => {
    const d = flexiDims(f, c);
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const [hx, hy] = flexiToScreen(...flexiHandle(f, c));
    const r = flexiPx(d.Rh);
    const selected = f.selected === c.id;
    const color = red.indexOf(c.id) !== -1 ? FLEXI_RED : accent;

    // кружок — реальный размер сустава
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = selected ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.lineWidth = selected ? 3.5 : 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    // стрелка n — к лапе
    ctx.beginPath();
    ctx.moveTo(px + (hx - px) * (r / Math.max(1, Math.hypot(hx - px, hy - py))), py + (hy - py) * (r / Math.max(1, Math.hypot(hx - px, hy - py))));
    ctx.lineTo(hx, hy);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // кружок поворота
    ctx.beginPath();
    ctx.arc(hx, hy, selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2.5;
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

  $('flexi-remove').disabled = f.selected == null;
  $('flexi-add').classList.toggle('is-active', f.addMode);
  const links = f.cuts.filter((c) => c.link).length;
  $('flexi-count').textContent = f.cuts.length
    ? 'Суставов: ' + f.cuts.length + (links ? ' (из них звеньев ' + links + ')' : '') + ' → деталей: ' + (f.cuts.length + 1)
    : 'Суставов нет — нажми «＋ Разрез» или «↺ Авто»';
  $('flexi-tip').textContent = f.addMode
    ? 'Тапни по лапе или хвосту — там появится сустав.'
    : 'Кружок — сустав в натуральную величину. Тяни его — сдвинуть (прилипает к скелету), кружок на конце стрелки — повернуть.';
  flexiRenderSwing(f);
}

/* ---------- Скелет: ближайшая точка, направление, ширина ---------- */

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

// Полуширина лапы: максимум dt на участке [P, P + 4 мм] — берём точки скелета рядом и чуть дальше от ядра.
function flexiSkelWidth(f, x, y, n) {
  let w = 0;
  f.prep.skel.forEach((s) => {
    const dx = s.x - x, dy = s.y - y;
    const along = dx * n[0] + dy * n[1];
    if (along >= -0.6 && along <= 4 && Math.abs(dx * n[1] - dy * n[0]) <= 1.5) w = Math.max(w, s.dt);
  });
  return w || 3;
}

/* ---------- Пальцем по виду сверху ---------- */

function flexiPoint(e) {
  const r = $('flexi-canvas').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function flexiPointerDown(e) {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  e.preventDefault();
  const [sx, sy] = flexiPoint(e);
  try { $('flexi-canvas').setPointerCapture(e.pointerId); } catch (err) { /* ок */ }

  // кружок поворота (сначала у выделенного)
  const byHandle = (c) => {
    const [hx, hy] = flexiToScreen(...flexiHandle(f, c));
    return Math.hypot(sx - hx, sy - hy) < 20;
  };
  const sel = f.cuts.find((c) => c.id === f.selected);
  const rot = (sel && byHandle(sel) && sel) || f.cuts.find(byHandle);
  if (rot) {
    f.selected = rot.id;
    flexiView.drag = { mode: 'rotate', id: rot.id, pointer: e.pointerId };
    haptic();
    flexiDraw();
    return;
  }
  // сустав — выделить и тянуть (тап внутри кружка)
  let hit = null, hd = Infinity;
  f.cuts.forEach((c) => {
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < Math.max(20, flexiPx(flexiDims(f, c).Rh)) && d < hd) { hd = d; hit = c; }
  });
  if (hit && !f.addMode) {
    haptic();
    f.selected = hit.id;
    flexiView.drag = { mode: 'move', id: hit.id, pointer: e.pointerId };
    flexiDraw();
    return;
  }
  if (f.addMode) {
    const [mx, my] = flexiToModel(sx, sy);
    const near = flexiNearestSkel(f, mx, my);
    if (near) {
      const s = f.prep.skel[near.k];
      const n = flexiSkelDir(f, near.k);
      const c = { id: f.nextId++, P: [s.x, s.y], n, w: flexiSkelWidth(f, s.x, s.y, n), link: false, chain: -1 };
      f.cuts.push(c);
      f.selected = c.id;
      f.edited = true;
      f.addMode = false;
      haptic('medium');
      flexiInvalidate();
    }
    flexiDraw();
    return;
  }
  if (f.selected != null) {
    f.selected = null;
    flexiDraw();
  }
}

function flexiPointerMove(e) {
  const f = state.flexi;
  const d = flexiView.drag;
  if (!f || !d || d.pointer !== e.pointerId) return;
  e.preventDefault();
  const c = f.cuts.find((x) => x.id === d.id);
  if (!c) return;
  const [mx, my] = flexiToModel(...flexiPoint(e));
  if (d.mode === 'move') {
    const near = flexiNearestSkel(f, mx, my);
    const snapMm = Math.max(4, (24 / flexiView.k) * f.prep.grid.step);
    if (near && near.dist <= snapMm) {
      // прилипает к скелету: направление и ширина — оттуда
      const s = f.prep.skel[near.k];
      c.P = [s.x, s.y];
      let n = flexiSkelDir(f, near.k);
      if (n[0] * c.n[0] + n[1] * c.n[1] < 0) n = [-n[0], -n[1]];
      c.n = n;
      c.w = flexiSkelWidth(f, s.x, s.y, n);
    } else {
      c.P = [mx, my];
    }
  } else {
    const tx = mx - c.P[0], ty = my - c.P[1];
    const l = Math.hypot(tx, ty);
    if (l > 0.5) c.n = [tx / l, ty / l];
  }
  f.edited = true;
  flexiInvalidate();
  flexiDraw();
}

function flexiPointerUp(e) {
  const d = flexiView.drag;
  if (d && d.pointer === e.pointerId) flexiView.drag = null;
}

function flexiRemove() {
  const f = state.flexi;
  if (!f || f.selected == null) return;
  haptic();
  f.cuts = f.cuts.filter((c) => c.id !== f.selected);
  f.selected = null;
  f.edited = true;
  flexiInvalidate();
  flexiDraw();
}

function flexiAddMode() {
  const f = state.flexi;
  if (!f) return;
  haptic();
  f.addMode = !f.addMode;
  flexiDraw();
}

function flexiAutoBtn() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  haptic();
  flexiAuto(f, false);
}

/* ---------- Настройки на экране ---------- */

function flexiSeg(id, value) {
  document.querySelectorAll('#' + id + ' button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === value));
}

function flexiRenderSettings() {
  const f = state.flexi;
  if (!f) return;
  const kit = f.mode === 'kit';
  document.querySelectorAll('#flexi-mode button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === f.mode));
  document.querySelectorAll('.flexi-pip').forEach((el2) => { el2.hidden = kit; });
  document.querySelectorAll('.flexi-kit').forEach((el2) => { el2.hidden = !kit; });
  $('flexi-mode-tip').textContent = FLEXI_MODE_TIP[f.mode];
  $('flexi-hint').textContent = FLEXI_HINT[f.mode];
  $('flexi-length').value = String(f.length);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-small').hidden = f.length >= 120;
  $('flexi-cut').value = String(f.cut);
  $('flexi-cut-val').textContent = cadMm(f.cut) + ' мм';
  flexiSeg('flexi-gap', f.pip.g);
  $('flexi-alpha').value = String(f.pip.alpha);
  $('flexi-alpha-val').textContent = '±' + f.pip.alpha + '°';
  flexiSeg('flexi-fit', f.kit.g);
  flexiSeg('flexi-snap', f.kit.snap);
  flexiSeg('flexi-plate', f.kit.plate);
  const links = kit ? f.kit.links : f.pip.links;
  $('flexi-links').checked = links;
  $('flexi-links-warn').hidden = !(kit && links);
  document.querySelectorAll('.flexi-links-opt').forEach((el2) => { el2.hidden = !links || (el2.classList.contains('flexi-pip') && kit); });
  $('flexi-k').value = String(f.k);
  $('flexi-k-val').textContent = f.k.toFixed(1);
  $('flexi-aseg').value = String(f.alphaSeg);
  $('flexi-aseg-val').textContent = '±' + f.alphaSeg + '°';
  flexiRenderSwing(f);
}

// 🧩 Сборная: поворот не задаётся, а получается из размеров — показываем «ходит ±N°».
function flexiRenderSwing(f) {
  if (!f || f.mode !== 'kit' || !f.core || !f.prep || !f.cuts.length) {
    $('flexi-swing').textContent = f && f.mode === 'kit' ? 'Поворот считается сам из размеров сустава' : '';
    return;
  }
  const a = f.cuts.map((c) => flexiDims(f, c).alpha);
  const lo = Math.round(Math.min(...a)), hi = Math.round(Math.max(...a));
  $('flexi-swing').textContent = 'Ходит ±' + (lo === hi ? lo : lo + '–' + hi) + '°';
}

function flexiOnLength() {
  const f = state.flexi;
  if (!f) return;
  f.length = Number($('flexi-length').value);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-small').hidden = f.length >= 120;
  flexiSchedulePrepare();
}

function flexiOnCut() {
  const f = state.flexi;
  if (!f) return;
  f.cut = Number($('flexi-cut').value);
  $('flexi-cut-val').textContent = cadMm(f.cut) + ' мм';
  flexiSchedulePrepare();
}

function flexiSchedulePrepare() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  flexiInvalidate();
  clearTimeout(f.prepTimer);
  f.prepTimer = setTimeout(() => flexiPrepare(f, false), 450);
}

/* ---------- Сборка ---------- */

async function flexiBuild() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  if (!f.cuts.length) {
    toast('Добавь хотя бы один сустав');
    return;
  }
  haptic();
  clearTimeout(f.prepTimer);
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Готовлю суставы…';
  let r;
  try {
    r = await flexiCall(f, {
      type: 'build', opts: flexiOpts(f),
      cuts: f.cuts.map((c) => ({ id: c.id, P: c.P, n: c.n, w: c.w, link: c.link, chain: c.chain })),
    });
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

  const errors = r.notes.filter((x) => x.level === 'error');
  f.built = Object.assign(r, { mode: f.mode, errors, alphaByJoint: r.joints.map((J) => J.alpha) });
  f.stale = false;
  f.view = 'assembled';
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

  const chains = $('flexi-chains');
  chains.textContent = '';
  b.chains.forEach((c, i) => {
    const name = b.chains.length === 1 ? 'Хвост' : 'Цепочка ' + (i + 1);
    chains.appendChild(el('div', '', name + ': ' + c.count + ' ' + plural(c.count, 'звено', 'звена', 'звеньев') + ', гнётся до ±' + Math.round(c.bend) + '°'));
  });

  const size = b.mode === 'kit'
    ? b.plates.reduce((s, p) => s + p.stl.byteLength, 0)
    : b.stl.byteLength;
  $('flexi-parts').textContent = 'Деталей: ' + b.parts.length + (b.mode === 'kit' ? ' · столов: ' + b.plates.length + ' по ' + f.kit.plate + ' мм' : '') +
    ' · ' + cadMm(size / 1048576) + ' МБ';
  $('flexi-view').hidden = b.mode !== 'kit';
  document.querySelectorAll('#flexi-view button').forEach((x) => x.classList.toggle('is-active', x.dataset.view === f.view));
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
  const mats = b.parts.map((_, i) => new T.MeshStandardMaterial({ color: FLEXI_COLORS[i % FLEXI_COLORS.length], roughness: 0.8, metalness: 0 }));

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
    pivots.push({ pivot, alpha: J.alpha * Math.PI / 180, depth: depthOf(j), j });
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

  // «Как на столе» (🧩 Сборная): столы рядом, квадрат каждого стола
  let platesGroup = null;
  if (b.mode === 'kit') {
    platesGroup = new T.Group();
    const size = f.kit.plate;
    b.plates.forEach((pl, pi) => {
      const ox = pi * (size + 30);
      const sq = new T.GridHelper(size, 1, 0x888888, 0x888888);
      sq.rotation.x = Math.PI / 2;
      sq.position.set(ox + size / 2, size / 2, 0);
      platesGroup.add(sq);
      const grid = new T.GridHelper(size, size / 20, 0xcccccc, 0xcccccc);
      grid.rotation.x = Math.PI / 2;
      grid.position.set(ox + size / 2, size / 2, -0.05);
      grid.material.transparent = true;
      grid.material.opacity = 0.5;
      platesGroup.add(grid);
      pl.items.forEach((it) => {
        const m = new T.Mesh(geoms[it.index], mats[it.index]);
        m.position.set(ox + it.dx, it.dy, 0);
        platesGroup.add(m);
      });
    });
    platesGroup.visible = false;
    scene.add(platesGroup);
  }

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
    if (flexiPrev.wiggle && assembled.visible) {
      const t = (now - flexiPrev.t0) / 1000;
      // волна: дальние звенья отстают от ближних
      pivots.forEach((p) => { p.pivot.rotation.z = Math.sin(t * 2.4 - p.depth * 0.7 + p.j * 0.4) * p.alpha; });
    }
    controls.update();
    renderer.render(scene, camera);
  };
  flexiPrev.raf = requestAnimationFrame(loop);
  flexiPrev.v = { T, renderer, scene, camera, controls, geoms, mats, pivots, center, radius, dist, assembled, platesGroup, box };
  flexiSetWiggle(false);
  flexiSetView(f, 'assembled');
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

function flexiSetView(f, view) {
  const v = flexiPrev.v;
  f.view = view;
  document.querySelectorAll('#flexi-view button').forEach((x) => x.classList.toggle('is-active', x.dataset.view === view));
  $('flexi-wiggle').hidden = view !== 'assembled'; // «Пошевелить» — только в собранной
  if (!v) return;
  const plates = view === 'plates' && v.platesGroup;
  v.assembled.visible = !plates;
  if (v.platesGroup) v.platesGroup.visible = !!plates;
  if (plates) flexiSetWiggle(false);
  // камера: на всё, что видно
  const T = v.T;
  const box = plates ? new T.Box3().setFromObject(v.platesGroup) : v.box;
  const center = new T.Vector3(), size = new T.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(size.length() / 2, 1);
  const dist = (radius / Math.sin((35 / 2) * Math.PI / 180)) * 1.05;
  v.controls.target.copy(center);
  v.camera.position.copy(center).add(new T.Vector3(plates ? 0.2 : 0.6, plates ? -0.6 : -1, plates ? 1.6 : 1.1).normalize().multiplyScalar(dist));
  v.camera.far = radius * 100;
  v.camera.updateProjectionMatrix();
  v.controls.maxDistance = radius * 12;
  v.controls.update();
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

// Снимок 800×800: «Собранная», вид 3/4 сверху, светлый фон, суставы в покое.
function flexiSnapshot() {
  const v = flexiPrev.v;
  const r = v.renderer, cam = v.camera;
  const wasWiggle = flexiPrev.wiggle;
  const wasPlates = v.platesGroup && v.platesGroup.visible;
  v.pivots.forEach((p) => { p.pivot.rotation.z = 0; });
  v.assembled.visible = true;
  if (v.platesGroup) v.platesGroup.visible = false;
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
  if (wasPlates) {
    v.assembled.visible = false;
    v.platesGroup.visible = true;
  }
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
    if (f && f.built && f.stale) toast('Сначала пересобери — нажми «🔧 Собрать»');
    else if (f && f.built && f.built.errors.length) toast('Есть красные ошибки — исправь их и пересобери');
    return;
  }
  haptic();
  const b = f.built;
  const files = b.mode === 'kit'
    ? b.plates.map((p, i) => ({ bytes: p.stl, plate: (i + 1) + '/' + b.plates.length }))
    : [{ bytes: b.stl }];
  if (files.some((x) => x.bytes.byteLength > FLEXI_MAX_FILE)) {
    hapticNotify('error');
    alertBox('Модель слишком подробная для отправки (файл больше 12 МБ)');
    return;
  }
  state.flexiBusy = true;
  $('busy').hidden = false;
  let snapshot;
  try { snapshot = flexiSnapshot(); } catch (e) { snapshot = ''; }
  let r = { status: 0, data: null };
  for (let i = 0; i < files.length; i++) {
    $('busy-text').textContent = files.length > 1 ? 'Отправляю стол ' + (i + 1) + ' из ' + files.length + '…' : 'Отправляю в чат…';
    try {
      const params = { a: 'flexi', id: f.id, file: await cadBlobToDataUrl(files[i].bytes), snapshot };
      if (b.mode === 'kit') {
        params.kit = '1';
        params.plate = files[i].plate;
      }
      r = await cadPost(params, 120000); // столы — по очереди, ждём ответ на каждый
    } catch (e) {
      r = { status: 0, data: null };
    }
    if (!(r.data && r.data.ok === true)) break;
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
  $('flexi-remove').addEventListener('click', flexiRemove);
  $('flexi-add').addEventListener('click', flexiAddMode);
  $('flexi-auto').addEventListener('click', flexiAutoBtn);
  $('flexi-length').addEventListener('input', flexiOnLength);
  $('flexi-cut').addEventListener('input', flexiOnCut);

  const withF = (fn) => (e) => { const f = state.flexi; if (f) fn(f, e); };
  document.querySelectorAll('#flexi-mode button').forEach((b) => b.addEventListener('click', withF((f) => {
    if (f.mode === b.dataset.mode) return;
    haptic();
    f.mode = b.dataset.mode;
    flexiSettingChanged();
  })));
  const seg = (id, apply) => document.querySelectorAll('#' + id + ' button').forEach((b) => b.addEventListener('click', withF((f) => {
    haptic();
    apply(f, Number(b.dataset.v));
    flexiSettingChanged();
  })));
  seg('flexi-gap', (f, v) => { f.pip.g = v; });
  seg('flexi-fit', (f, v) => { f.kit.g = v; });
  seg('flexi-snap', (f, v) => { f.kit.snap = v; });
  seg('flexi-plate', (f, v) => { f.kit.plate = v; flexiStore('grava.flexi.plate', String(v)); });
  let sliderTimer = 0;
  const slider = (id, apply) => $(id).addEventListener('input', withF((f) => {
    apply(f, Number($(id).value));
    flexiRenderSettings();
    flexiInvalidate();
    if (f.prep) flexiDraw();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { if (state.flexi === f && !f.edited) flexiAuto(f, false); }, 350);
  }));
  slider('flexi-alpha', (f, v) => { f.pip.alpha = v; });
  slider('flexi-k', (f, v) => { f.k = v; });
  slider('flexi-aseg', (f, v) => { f.alphaSeg = v; });
  $('flexi-links').addEventListener('change', withF((f) => {
    haptic();
    if (f.mode === 'kit') f.kit.links = $('flexi-links').checked;
    else f.pip.links = $('flexi-links').checked;
    flexiSettingChanged();
  }));

  $('flexi-build').addEventListener('click', flexiBuild);
  document.querySelectorAll('#flexi-view button').forEach((b) => b.addEventListener('click', withF((f) => {
    haptic();
    flexiSetView(f, b.dataset.view);
  })));
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
