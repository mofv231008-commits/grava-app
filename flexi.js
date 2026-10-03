/* Грава — экран «🦴 Шарниры»: подвижная фигурка (print-in-place).
   Считает всё фоновый поток flexi-worker.js; тут — вид сверху, разрезы, настройки, превью, отправка.
   Использует помощники из app.js и cadPost из cad.js. */
'use strict';

const FLEXI_WORKER_URL = './flexi-worker.js?v=1';
const FLEXI_MAX_FILE = 12 * 1024 * 1024;
const FLEXI_COLORS = [0xb8b8b8, 0x6fa8dc, 0xf6b26b, 0x93c47d, 0xe06666, 0x8e7cc3, 0xffd966, 0x76a5af, 0xc27ba0, 0xa2c4c9, 0xd5a6bd, 0xb6d7a8, 0xf9cb9c, 0x9fc5e8, 0xea9999];
const FLEXI_RED = '#e53935';

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
    data: null,
    worker: null,
    seq: 0,
    pending: {},
    origLen: 0,
    length: 150,
    cut: 1,
    g: 0.45,
    alpha: 25,
    prep: null,
    autoCuts: [],
    cuts: [],
    edited: false,
    nextId: 1,
    selected: null,
    addMode: false,
    built: null,
    stale: true,
    prepTimer: 0,
  };

  $('flexi-missing').hidden = true;
  $('flexi-main').hidden = false;
  $('flexi-title').textContent = 'Загружаю модель…';
  $('flexi-warn-pose').hidden = true;
  $('flexi-status').hidden = false;
  $('flexi-status-text').textContent = 'Загружаю модель…';
  $('flexi-editor').hidden = true;
  $('flexi-result').hidden = true;
  flexiResetSettingsUi();
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  flexiUpdateMainButton();

  api({ a: 'flexi', id })
    .then((data) => {
      if (state.flexi !== f) return;
      f.data = data;
      $('flexi-title').textContent = data.title || 'Фигурка';
      $('flexi-warn-pose').hidden = data.flexi !== false;
      return flexiDownload(f);
    })
    .catch((err) => {
      if (state.flexi !== f) return;
      if (err && err.code === 'auth') {
        flexiShowMissing('Сессия устарела — перезапусти приложение', 'close');
        sessionExpired();
      } else if (err && err.code === 'network') {
        flexiShowMissing('Нет связи с сервером. Проверь интернет и попробуй ещё раз', 'retry');
      } else if (err && err.code === 'holes') {
        flexiShowMissing('Модель с дырками — шарниры не собрать. Попроси бота слепить заново', 'back');
      } else if (err && err.code === 'worker') {
        flexiShowMissing('Сборщик не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз', 'back');
      } else if (err && err.code === 'bad_stl') {
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

/* ---------- Фоновый поток ---------- */

function flexiWorker(f) {
  if (f.worker) return f.worker;
  let w;
  try { w = new Worker(FLEXI_WORKER_URL, { type: 'module' }); } catch (e) { throw new FlexiUiError('worker'); }
  w.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      $('busy-text').textContent = 'Сустав ' + msg.k + ' из ' + msg.n + '…';
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
  let res;
  try { res = await fetchWithTimeout(apiUrl({ a: 'file', id: f.id, what: 'file' }), 180000); } catch (e) { throw e; }
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
  flexiResetSettingsUi();
  await flexiPrepare(f, true);
}

/* ---------- Подготовка: масштаб, срез, автопоиск разрезов ---------- */

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
  if (state.flexi !== f) return;
  // ответ на старый запрос (ползунок уже сдвинули ещё раз) — ждём следующий
  if (r.length !== f.length) return;
  f.prep = r;
  f.autoCuts = r.cuts.map((c) => ({ P: c.P, n: c.n, w: c.w }));
  if (!f.edited) {
    flexiSetAuto(f);
  } else if (oldLen && r.length !== oldLen) {
    const k = r.length / oldLen; // модель отцентрована в (0,0) — разрезы масштабируются вместе с ней
    f.cuts.forEach((c) => { c.P = [c.P[0] * k, c.P[1] * k]; c.w *= k; });
  }
  f.stale = true;
  $('flexi-status').hidden = true;
  $('flexi-editor').hidden = false;
  flexiLayoutCanvas();
  flexiDraw();
  flexiUpdateMainButton();
}

function flexiSetAuto(f) {
  f.cuts = f.autoCuts.map((c) => ({ id: f.nextId++, P: c.P.slice(), n: c.n.slice(), w: c.w }));
  f.edited = false;
  f.selected = null;
  flexiInvalidate();
}

function flexiInvalidate() {
  const f = state.flexi;
  if (!f) return;
  f.stale = true;
  if (f.built) {
    f.built.errorIds = [];
    $('flexi-result-stale').hidden = false;
  }
  flexiUpdateMainButton();
}

/* ---------- Вид сверху ---------- */

const flexiView = { img: null, k: 1, ox: 0, oy: 0, drag: null };

function flexiLayoutCanvas() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  const canvas = $('flexi-canvas');
  const wrap = $('flexi-top');
  const cw = wrap.clientWidth || 360;
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

  // картинка высот (вид сверху, ось Y — вверх)
  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ictx = img.getContext('2d');
  const id = ictx.createImageData(W, H);
  const hts = f.prep.heights;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = hts[y * W + x];
      const o = ((H - 1 - y) * W + x) * 4;
      if (!v) continue;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = v;
      id.data[o + 3] = 255;
    }
  }
  ictx.putImageData(id, 0, 0);
  flexiView.img = img;
}

// мм ↔ точки экрана
function flexiToScreen(x, y) {
  const g = state.flexi.prep.grid;
  return [flexiView.ox + ((x - g.x0) / g.step) * flexiView.k, flexiView.oy + (g.H - (y - g.y0) / g.step) * flexiView.k];
}
function flexiToModel(sx, sy) {
  const g = state.flexi.prep.grid;
  return [g.x0 + ((sx - flexiView.ox) / flexiView.k) * g.step, g.y0 + (g.H - (sy - flexiView.oy) / flexiView.k) * g.step];
}
function flexiMmToPx(mm) {
  return (mm / state.flexi.prep.grid.step) * flexiView.k;
}

// Порядок сборки: по удалению от ядра. Номер на экране — место в этом порядке.
function flexiOrdered(f) {
  const core = f.prep.core;
  return f.cuts.slice().sort((a, b) => Math.hypot(a.P[0] - core[0], a.P[1] - core[1]) - Math.hypot(b.P[0] - core[0], b.P[1] - core[1]));
}

function flexiCutR(f, c) {
  return c.w / Math.cos(f.alpha * Math.PI / 180) + 2 + 0.5; // c ≈ cMax, точное R посчитает сборка
}

function flexiDraw() {
  const f = state.flexi;
  if (!f || !f.prep || !flexiView.img) return;
  const canvas = $('flexi-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = flexiView.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  const g = f.prep.grid;
  ctx.drawImage(flexiView.img, flexiView.ox, flexiView.oy, g.W * flexiView.k, g.H * flexiView.k);

  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#2481cc';
  const errorIds = (f.built && !f.stale && f.built.errorIds) || [];
  const order = flexiOrdered(f);
  order.forEach((c, i) => {
    const R = flexiCutR(f, c);
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const t = [-c.n[1], c.n[0]];
    const [ax, ay] = flexiToScreen(c.P[0] - t[0] * R, c.P[1] - t[1] * R);
    const [bx, by] = flexiToScreen(c.P[0] + t[0] * R, c.P[1] + t[1] * R);
    const [tx, ty] = flexiToScreen(c.P[0] + c.n[0] * R * 0.8, c.P[1] + c.n[1] * R * 0.8);
    const selected = f.selected === c.id;
    const color = errorIds.indexOf(c.id) !== -1 ? FLEXI_RED : accent;

    if (selected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 4 : 3;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    // стрелка — в сторону лапы
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
    const ang = Math.atan2(ty - py, tx - px);
    ctx.beginPath();
    ctx.moveTo(tx + Math.cos(ang) * 6, ty + Math.sin(ang) * 6);
    ctx.lineTo(tx + Math.cos(ang + 2.5) * 7, ty + Math.sin(ang + 2.5) * 7);
    ctx.lineTo(tx + Math.cos(ang - 2.5) * 7, ty + Math.sin(ang - 2.5) * 7);
    ctx.closePath();
    ctx.fill();
    // кружок на конце — поворот
    ctx.beginPath(); ctx.arc(bx, by, selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
    // номер в центре
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 11px -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), px, py + 0.5);
  });

  $('flexi-remove').disabled = f.selected == null;
  $('flexi-add').classList.toggle('is-active', f.addMode);
  $('flexi-count').textContent = f.cuts.length
    ? 'Разрезов: ' + f.cuts.length + ' → деталей: ' + (f.cuts.length + 1)
    : 'Разрезов нет — нажми «＋ Разрез» или «↺ Авто»';
  $('flexi-tip').textContent = f.addMode
    ? 'Тапни по лапе или хвосту — там появится разрез.'
    : 'Тап по разрезу — выделить. Тяни за центр — сдвинуть (прилипает к скелету), за кружок — повернуть.';
}

/* ---------- Скелет: ближайшая точка, направление, ширина ---------- */

function flexiSkel(f) {
  const s = f.prep.skeleton;
  return { n: s.length / 4, x: (k) => s[k * 4], y: (k) => s[k * 4 + 1], dt: (k) => s[k * 4 + 2], parent: (k) => s[k * 4 + 3] };
}

function flexiNearestSkel(f, x, y) {
  const s = flexiSkel(f);
  let best = -1, bd = Infinity;
  for (let k = 0; k < s.n; k++) {
    const d = (s.x(k) - x) ** 2 + (s.y(k) - y) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best < 0 ? null : { k: best, dist: Math.sqrt(bd) };
}

// Направление от ядра наружу: точка минус её предок на 3 мм ближе к ядру.
function flexiSkelDir(f, k) {
  const s = flexiSkel(f);
  let a = k, len = 0;
  while (s.parent(a) >= 0 && len < 3) {
    const p = s.parent(a);
    len += Math.hypot(s.x(a) - s.x(p), s.y(a) - s.y(p));
    a = p;
  }
  let nx = s.x(k) - s.x(a), ny = s.y(k) - s.y(a);
  const l = Math.hypot(nx, ny);
  if (l < 1e-6) {
    const core = f.prep.core;
    nx = s.x(k) - core[0]; ny = s.y(k) - core[1];
  }
  const l2 = Math.hypot(nx, ny) || 1;
  return [nx / l2, ny / l2];
}

function flexiSkelWidth(f, x, y) {
  const s = flexiSkel(f);
  let w = 0;
  for (let k = 0; k < s.n; k++) {
    if ((s.x(k) - x) ** 2 + (s.y(k) - y) ** 2 <= 4) w = Math.max(w, s.dt(k)); // ±2 мм
  }
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

  // кружок на конце выделенного разреза — поворот
  const sel = f.cuts.find((c) => c.id === f.selected);
  if (sel) {
    const R = flexiCutR(f, sel);
    const [bx, by] = flexiToScreen(sel.P[0] - sel.n[1] * R, sel.P[1] + sel.n[0] * R);
    if (Math.hypot(sx - bx, sy - by) < 22) {
      flexiView.drag = { mode: 'rotate', id: sel.id, pointer: e.pointerId };
      haptic();
      return;
    }
  }
  // центр разреза — выделить и тянуть
  let hit = null, hd = 24;
  f.cuts.forEach((c) => {
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < hd) { hd = d; hit = c; }
  });
  if (!hit) {
    // или кружок поворота любого разреза
    f.cuts.forEach((c) => {
      const R = flexiCutR(f, c);
      const [bx, by] = flexiToScreen(c.P[0] - c.n[1] * R, c.P[1] + c.n[0] * R);
      const d = Math.hypot(sx - bx, sy - by);
      if (d < 18 && !hit) {
        hit = c;
        f.selected = c.id;
        flexiView.drag = { mode: 'rotate', id: c.id, pointer: e.pointerId };
      }
    });
    if (hit) {
      haptic();
      flexiDraw();
      return;
    }
  }
  if (hit) {
    haptic();
    f.selected = hit.id;
    flexiView.drag = { mode: 'move', id: hit.id, pointer: e.pointerId, moved: false };
    flexiDraw();
    return;
  }
  if (f.addMode) {
    const [mx, my] = flexiToModel(sx, sy);
    const near = flexiNearestSkel(f, mx, my);
    if (near) {
      const s = flexiSkel(f);
      const P = [s.x(near.k), s.y(near.k)];
      const c = { id: f.nextId++, P, n: flexiSkelDir(f, near.k), w: flexiSkelWidth(f, P[0], P[1]) };
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
  const [sx, sy] = flexiPoint(e);
  const [mx, my] = flexiToModel(sx, sy);
  if (d.mode === 'move') {
    d.moved = true;
    const near = flexiNearestSkel(f, mx, my);
    const snapMm = Math.max(4, (24 / flexiView.k) * f.prep.grid.step);
    if (near && near.dist <= snapMm) {
      // прилипает к скелету: направление и ширина — оттуда
      const s = flexiSkel(f);
      c.P = [s.x(near.k), s.y(near.k)];
      let n = flexiSkelDir(f, near.k);
      if (n[0] * c.n[0] + n[1] * c.n[1] < 0) n = [-n[0], -n[1]];
      c.n = n;
      c.w = flexiSkelWidth(f, c.P[0], c.P[1]);
    } else {
      c.P = [mx, my];
    }
  } else {
    const tx = mx - c.P[0], ty = my - c.P[1];
    const l = Math.hypot(tx, ty);
    if (l > 0.5) c.n = [ty / l, -tx / l]; // кружок лежит на +t, где t = (−n.y, n.x)
  }
  f.edited = true;
  flexiInvalidate();
  flexiDraw();
}

function flexiPointerUp(e) {
  const d = flexiView.drag;
  if (d && d.pointer === e.pointerId) flexiView.drag = null;
}

/* ---------- Кнопки над видом сверху ---------- */

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

function flexiAuto() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  haptic();
  flexiSetAuto(f);
  flexiDraw();
}

/* ---------- Настройки ---------- */

function flexiResetSettingsUi() {
  const f = state.flexi;
  if (!f) return;
  $('flexi-length').value = String(f.length);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-alpha').value = String(f.alpha);
  $('flexi-alpha-val').textContent = f.alpha + '°';
  $('flexi-cut').value = String(f.cut);
  $('flexi-cut-val').textContent = cadMm(f.cut) + ' мм';
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.gap) === f.g));
  $('flexi-small').hidden = f.length >= 120;
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

function flexiOnAlpha() {
  const f = state.flexi;
  if (!f) return;
  f.alpha = Number($('flexi-alpha').value);
  $('flexi-alpha-val').textContent = f.alpha + '°';
  flexiInvalidate();
  flexiDraw();
}

function flexiOnGap(b) {
  const f = state.flexi;
  if (!f) return;
  haptic();
  f.g = Number(b.dataset.gap);
  document.querySelectorAll('#flexi-gap button').forEach((x) => x.classList.toggle('is-active', x === b));
  flexiInvalidate();
}

/* ---------- Сборка ---------- */

async function flexiBuild() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  if (!f.cuts.length) {
    toast('Добавь хотя бы один разрез');
    return;
  }
  haptic();
  clearTimeout(f.prepTimer);
  const order = flexiOrdered(f);
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Сустав 1 из ' + order.length + '…';
  let r;
  try {
    r = await flexiCall(f, {
      type: 'build', g: f.g, alpha: f.alpha,
      cuts: order.map((c) => ({ id: c.id, P: c.P, n: c.n, w: c.w })),
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

  const numOf = {};
  order.forEach((c, i) => { numOf[c.id] = i + 1; });
  f.built = {
    stl: r.stl,
    parts: r.parts,
    joints: r.joints,
    warnings: r.warnings,
    errors: r.errors,
    errorIds: r.errors.map((x) => x.id),
    numOf,
  };
  f.stale = false;
  $('flexi-result').hidden = false;
  $('flexi-result-stale').hidden = true;
  flexiRenderNotes(f);
  flexiDraw();
  await flexiShowPreview(f);
  flexiUpdateMainButton();
  if (r.errors.length) {
    hapticNotify('error');
    toast('Есть разрезы с ошибкой — они красные');
  } else {
    hapticNotify('success');
  }
  setTimeout(() => $('flexi-result').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function flexiRenderNotes(f) {
  const b = f.built;
  const box = $('flexi-notes');
  box.textContent = '';
  const add = (cls, text) => box.appendChild(el('div', 'flexi-note ' + cls, text));
  b.errors.forEach((x) => add('is-error', '✖ Разрез ' + (b.numOf[x.id] || '?') + ': ' + x.text));
  const seen = {};
  b.warnings.forEach((x) => {
    const key = x.text + '|' + x.id;
    if (seen[key]) return;
    seen[key] = 1;
    add('is-warn', '⚠ Разрез ' + (b.numOf[x.id] || '?') + ': ' + x.text);
  });
  if (!b.errors.length && !b.warnings.length) add('is-ok', '✔ Все суставы собрались без замечаний');
  $('flexi-parts').textContent = 'Деталей: ' + b.parts.length + ' · файл ' + cadMm(b.stl.byteLength / 1048576) + ' МБ';
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

  // иерархия суставов: поворот лапы вокруг вертикали через P, вложенные — вместе с родителем
  const root = new T.Group();
  scene.add(root);
  const holders = [root];
  const pivots = [];
  const jointHolder = [];
  const b = f.built;
  const mkHolder = (j) => {
    if (jointHolder[j]) return jointHolder[j];
    const J = b.joints[j];
    const parentHolder = J.parent >= 0 ? mkHolder(J.parent) : root;
    const pivot = new T.Group();
    pivot.position.set(J.P[0], J.P[1], 0);
    const inner = new T.Group();
    inner.position.set(-J.P[0], -J.P[1], 0);
    pivot.add(inner);
    parentHolder.add(pivot);
    pivots.push({ pivot, j });
    jointHolder[j] = inner;
    holders.push(inner);
    return inner;
  };
  const box = new T.Box3();
  const meshes = [];
  b.parts.forEach((p, i) => {
    const geometry = flexiGeometry(T, p);
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
    const material = new T.MeshStandardMaterial({ color: FLEXI_COLORS[i % FLEXI_COLORS.length], roughness: 0.8, metalness: 0 });
    const mesh = new T.Mesh(geometry, material);
    meshes.push(mesh);
    (p.joint >= 0 ? mkHolder(p.joint) : root).add(mesh);
  });

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
  controls.minDistance = radius * 0.6;
  controls.maxDistance = radius * 8;
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
  const alphaRad = f.alpha * Math.PI / 180;
  const loop = (now) => {
    flexiPrev.raf = requestAnimationFrame(loop);
    if (flexiPrev.wiggle) {
      const t = (now - flexiPrev.t0) / 1000;
      pivots.forEach((p, i) => { p.pivot.rotation.z = Math.sin(t * 2.2 + i * 1.3) * alphaRad; });
    }
    controls.update();
    renderer.render(scene, camera);
  };
  flexiPrev.raf = requestAnimationFrame(loop);
  flexiPrev.v = { T, renderer, scene, camera, controls, meshes, pivots, center, radius, dist };
  flexiSetWiggle(false);
}

function flexiGeometry(T, p) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(p.vert, 3));
  g.setIndex(new T.BufferAttribute(p.tri, 1));
  // плоские грани: разворачиваем индекс, чтобы нормали были по граням
  const flat = g.toNonIndexed();
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
  v.meshes.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

// Снимок 800×800, вид 3/4 сверху, светлый фон, суставы в покое.
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

/* ---------- Прислать STL в чат ---------- */

function flexiReady(f) {
  return !!(f && f.built && !f.stale && !f.built.errors.length);
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
  if (!flexiReady(f) || state.flexiBusy || !flexiPrev.v) {
    if (f && f.built && f.stale) toast('Сначала пересобери — нажми «🔧 Собрать»');
    return;
  }
  haptic();
  const bytes = f.built.stl;
  if (bytes.byteLength > FLEXI_MAX_FILE) {
    hapticNotify('error');
    alertBox('Модель слишком подробная для отправки (больше 12 МБ)');
    return;
  }
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Отправляю в чат…';
  let r;
  try {
    const snapshot = flexiSnapshot();
    const file = await cadBlobToDataUrl(bytes);
    r = await cadPost({ a: 'flexi', id: f.id, file, snapshot }, 120000);
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
  $('flexi-auto').addEventListener('click', flexiAuto);
  $('flexi-length').addEventListener('input', flexiOnLength);
  $('flexi-cut').addEventListener('input', flexiOnCut);
  $('flexi-alpha').addEventListener('input', flexiOnAlpha);
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.addEventListener('click', () => flexiOnGap(b)));
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
