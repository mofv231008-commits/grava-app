/* Грава — экран «🦴 Шарниры», режим «⛓ Цепочка»: фигурка печатается сразу подвижной.
   Каждая ветвь (лапы, хвост, щупальца, шея) — цепочка коротких звеньев.
   Считает фоновый поток flexi-worker.js; размеры суставов и порядок — из flexi-core.js (тот же код).
   Использует помощники из app.js и cadPost/cadBlobToDataUrl/cadIsAuth/cadMm из cad.js. */
'use strict';

const FLEXI_WORKER_URL = './flexi-worker.js?v=6';
const FLEXI_CORE_URL = './flexi-core.js?v=6';
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
  };

  $('flexi-missing').hidden = true;
  $('flexi-main').hidden = false;
  $('flexi-title').textContent = 'Загружаю модель…';
  $('flexi-warn-pose').hidden = true;
  $('flexi-warn-parts').hidden = true;
  $('flexi-skipped').hidden = true;
  $('flexi-thin').hidden = true;
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

// на позвоночнике кулак не больше 4.5 мм — как в потоке
function flexiDims(f, c) {
  const o = c.spine ? Object.assign(flexiOpts(f), { rCap: f.core.SPINE_R }) : flexiOpts(f);
  return f.core.jointDims(o, c.w, flexiZtop(f, c.P[0], c.P[1]));
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
    if (msg.type === 'progress' && (msg.phase === 'repair' || msg.phase === 'analyze')) {
      $('flexi-status-text').textContent = msg.phase === 'repair' ? 'Чиню модель…' : 'Ищу суставы…';
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
  // после починки остались крупные отдельные куски — они не соединены с телом
  const warnParts = $('flexi-warn-parts');
  warnParts.hidden = !(r.parts > 1);
  if (r.parts > 1) warnParts.textContent = 'Модель из ' + r.parts + ' ' + plural(r.parts, 'части', 'частей', 'частей') + ' — куски, не связанные с телом, останутся отдельными';
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
  // auto — поставлен автопоиском: если не режется, сборщик сдвинет его или тихо пропустит
  f.cuts = r.cuts.map((c) => ({ id: f.nextId++, P: c.P, n: c.n, w: c.w, chain: c.chain, auto: true, br: c.br, s: c.s, root: c.root, spine: c.spine }));
  f.edited = false;
  $('flexi-skipped').hidden = true;
  // места, где сустав не помещается внутри (тонкие лапки, кончик хвоста) — серые точки на виде сверху
  f.thin = r.thin || [];
  f.legs = r.legs; // сколько лап у фигурки (со звеньями или цельных)
  $('flexi-thin').hidden = !f.thin.length;
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

// Настройка поменялась: если звенья не трогали руками — переставим их заново (размеры другие).
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

// Половина черты поперёк ветви; ручка поворота — на её конце.
function flexiHalfBar(f, c) {
  return Math.max(c.w, flexiDims(f, c).Rh) + 2;
}
function flexiHandle(f, c) {
  const L = flexiHalfBar(f, c);
  return [c.P[0] - c.n[1] * L, c.P[1] + c.n[0] * L];
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

  // серые точки — тут сустав внутри не помещается
  (f.thin || []).forEach((q) => {
    const [px, py] = flexiToScreen(q[0], q[1]);
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(142,142,147,0.9)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke();
  });

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

    // кружок — реальный размер звена (наружный радиус кольца Rh)
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = selected ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    // черта поперёк ветви — место разреза
    const L = flexiHalfBar(f, c);
    const [ax, ay] = flexiToScreen(c.P[0] + c.n[1] * L, c.P[1] - c.n[0] * L);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(hx, hy);
    ctx.lineWidth = selected ? 3.5 : 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    // ручка поворота
    if (selected) {
      ctx.beginPath();
      ctx.arc(hx, hy, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
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
  $('flexi-count').textContent = flexiChainInfo(f);
  $('flexi-tip').textContent = f.addMode
    ? 'Тапни по лапе или хвосту — там появится звено.'
    : 'Тап по звену — выделить («🗑 Убрать» сольёт соседние). Тяни — сдвинуть (прилипает к скелету), кружок на конце черты — повернуть.';
}

// «8 ветвей · 34 звена · хвост гнётся до ±120°»: самая длинная цепочка — звенья × α.
function flexiChainInfo(f) {
  if (!f.cuts.length) return 'Звеньев нет — нажми «↺ Авто» или «＋ Звено»';
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
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const dh = Math.hypot(sx - hx, sy - hy);
    return dh < 20 && dh < Math.hypot(sx - px, sy - py); // на маленьком звене ручка близко к центру — побеждает ближайшее
  };
  const sel = f.cuts.find((c) => c.id === f.selected);
  const rot = sel && byHandle(sel) ? sel : null; // ручка видна только у выделенного
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
      let chain = Math.max(-1, ...f.cuts.map((x) => x.chain)) + 1, bd = Infinity;
      f.cuts.forEach((x) => { const d = Math.hypot(x.P[0] - s.x, x.P[1] - s.y); if (d < bd && d < 40) { bd = d; chain = x.chain; } });
      const c = { id: f.nextId++, P: [s.x, s.y], n, w: flexiSkelWidth(f, s.x, s.y, n), chain };
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
    c.auto = false; // сдвинули рукой — теперь ошибки по нему показываем
  } else {
    // ручка — на конце черты (направление t = (−n.y, n.x))
    const tx = mx - c.P[0], ty = my - c.P[1];
    const l = Math.hypot(tx, ty);
    if (l > 0.5) c.n = [ty / l, -tx / l];
    c.auto = false;
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
  flexiInvalidate();
  clearTimeout(f.prepTimer);
  f.prepTimer = setTimeout(() => flexiPrepare(f, false), 450);
}

/* ---------- Сборка ---------- */

async function flexiBuild() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  if (!f.cuts.length) {
    toast('Добавь хотя бы одно звено');
    return;
  }
  haptic();
  clearTimeout(f.prepTimer);
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Готовлю звенья…';
  let r;
  try {
    r = await flexiCall(f, {
      type: 'build', opts: flexiOpts(f),
      cuts: f.cuts.map((c) => ({ id: c.id, P: c.P, n: c.n, w: c.w, chain: c.chain, auto: !!c.auto, br: c.br, s: c.s, root: c.root, spine: c.spine })),
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

  // автоматические разрезы, которые так и не разрезались, убираем (соседние звенья сливаются), сдвинутые — переставляем
  const skipped = r.skipped || [];
  if (skipped.length) f.cuts = f.cuts.filter((c) => skipped.indexOf(c.id) === -1);
  f.cuts.forEach((c) => { const m = r.moved && r.moved[c.id]; if (m) Object.assign(c, m); });
  if (f.selected != null && !f.cuts.some((c) => c.id === f.selected)) f.selected = null;
  const why = r.skipWhy || {};
  const nThin = skipped.filter((id) => why[id] === 'thin').length, nCut = skipped.length - nThin;
  const skLine = (n, tail) => n + ' ' + plural(n, 'звено', 'звена', 'звеньев') + ' пропущено — ' + tail;
  const sk = $('flexi-skipped');
  sk.hidden = !skipped.length;
  sk.textContent = [nCut ? skLine(nCut, 'там не режется') : '', nThin ? skLine(nThin, 'тут тонко') : ''].filter(Boolean).join(' · ');
  const errors = r.notes.filter((x) => x.level === 'error');
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
    if (f && f.built && f.stale) toast('Сначала пересобери — нажми «🔧 Собрать»');
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
    r = await cadPost({ a: 'flexi', id: f.id, file: await cadBlobToDataUrl(bytes), snapshot }, 120000);
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
  $('flexi-remove').addEventListener('click', flexiRemove);
  $('flexi-add').addEventListener('click', flexiAddMode);
  $('flexi-auto').addEventListener('click', flexiAutoBtn);
  $('flexi-length').addEventListener('input', flexiOnLength);

  const withF = (fn) => (e) => { const f = state.flexi; if (f) fn(f, e); };
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.addEventListener('click', withF((f) => {
    haptic();
    f.g = Number(b.dataset.v);
    flexiSettingChanged();
  })));
  let sliderTimer = 0;
  const slider = (id, apply) => $(id).addEventListener('input', withF((f) => {
    apply(f, Number($(id).value));
    flexiRenderSettings();
    flexiInvalidate();
    if (f.prep) flexiDraw();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { if (state.flexi === f && !f.edited) flexiAuto(f, false); }, 350);
  }));
  slider('flexi-k', (f, v) => { f.k = v; });
  slider('flexi-kb', (f, v) => { f.kBody = v; });
  slider('flexi-aseg', (f, v) => { f.alphaSeg = v; });

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
