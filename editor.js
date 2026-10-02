/* Грава — вкладка «Редактор»: правка последнего эскиза или чертежа.
   Использует помощники из app.js (tg, state, $, apiUrl, haptic…). */
'use strict';

const EDIT_API = 'https://engrave.app.n8n.cloud/webhook/grava-app-edit';
const ED_MAX_SIDE = 1536;      // больше этого картинку уменьшаем
const ED_HISTORY = 20;         // шагов «Отменить»
const ED_MARK_ALPHA = 0.45;    // красная обводка: rgba(255,0,0,0.45)
const ED_MAX_ZOOM = 8;         // во сколько раз можно приблизить от «целиком»
const ED_SEND_TIMEOUT = 170000;

const ed = {
  what: null,          // 'sketch' | 'drawing' — что выбрано в переключателе
  loadedWhat: null,    // что сейчас лежит в canvas
  version: null,       // версия загруженной картинки
  token: 0,
  ready: false,
  needsFit: false,
  w: 0,
  h: 0,
  original: null,      // исходная картинка (для «Сбросить»)
  tool: 'brush',
  color: '#555555',
  size: 14,
  history: [],
  view: { scale: 1, x: 0, y: 0, fit: 1 },
  lastVw: 0,
  maxInner: 0,
  pointers: new Map(),
  stroke: null,
  gesture: null,
  crop: null,
  cropDrag: null,
  busy: false,
  backup: document.createElement('canvas'),
};

const edBase = () => $('ed-base');
const edMark = () => $('ed-mark');
const edCtx = (c) => c.getContext('2d');

/* ---------- Что есть править ---------- */

function edAvailable() {
  const d = (state.me && state.me.drafts) || {};
  return ['sketch', 'drawing'].filter((k) => !!d[k]);
}

function renderEditor() {
  if (!state.me) {
    $('ed-empty').hidden = true;
    $('ed-main').hidden = true;
    return;
  }
  const avail = edAvailable();
  $('ed-empty').hidden = avail.length > 0;
  $('ed-main').hidden = avail.length === 0;
  if (!avail.length) return;

  if (avail.indexOf(ed.what) === -1) ed.what = avail[0];
  document.querySelectorAll('#ed-switch button').forEach((b) => {
    b.hidden = avail.indexOf(b.dataset.what) === -1;
    b.classList.toggle('is-active', b.dataset.what === ed.what);
  });
  $('ed-switch').classList.toggle('is-single', avail.length === 1);

  $('ed-price').textContent = Number(state.me.free_left) > 0 ? 'бесплатно' : '1 кр.';
  $('ed-hint').textContent = ed.what === 'sketch'
    ? 'После отправки выбери в чате размер — и бот слепит модель'
    : 'После отправки нажми в чате «🔥 Собрать DXF»';
  edRenderTools();
  edUpdateButtons();

  if (!state.editorOpen) return;
  edEnsureLoaded();
  if (ed.ready) {
    edLayout(ed.needsFit);
    ed.needsFit = false;
  }
}

function edEnsureLoaded() {
  const v = state.me.drafts[ed.what];
  if (ed.loadedWhat === ed.what) {
    if (ed.version === v) return;                 // уже загружено или грузится
    if (ed.ready && ed.history.length) return;    // в боте новая версия, но тут есть правки — не трогаем
  }
  edLoad(ed.what, v);
}

/* ---------- Загрузка картинки ---------- */

function edStatus(mode, text) {
  $('ed-status').hidden = mode === 'none';
  $('ed-status-spinner').hidden = mode !== 'loading';
  $('ed-retry').hidden = mode !== 'error';
  $('ed-status-text').textContent = text || 'Загружаю картинку…';
}

// Картинку грузим через fetch → blob, а не <img> с чужого домена: иначе canvas «испачкается».
async function edLoad(what, v) {
  const token = ++ed.token;
  ed.ready = false;
  ed.loadedWhat = what;
  ed.version = v;
  edStatus('loading');
  edUpdateButtons();
  try {
    const res = await fetchWithTimeout(apiUrl({ a: 'draft', what, v }), 60000);
    if (res.status === 401) throw new ApiError('auth');
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.indexOf('json') !== -1) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* не JSON */ }
      throw new ApiError(data && data.error === 'auth' ? 'auth' : 'http_' + res.status);
    }
    const blob = await res.blob();
    const img = await edDecode(blob);
    if (token !== ed.token) return;
    edSetImage(img);
    edStatus('none');
  } catch (err) {
    if (token !== ed.token) return;
    ed.version = null; // чтобы «Попробовать ещё раз» загрузило заново
    if (err && err.code === 'auth') {
      edStatus('error', 'Сессия устарела — перезапусти приложение');
      sessionExpired();
      return;
    }
    edStatus('error', err && err.code === 'network'
      ? 'Не получилось загрузить картинку. Проверь интернет'
      : 'Не получилось загрузить картинку');
  }
  edUpdateButtons();
}

async function edDecode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch (e) { /* попробуем по-другому */ }
  }
  // Запасной путь: blob-ссылка своя, canvas не «пачкается».
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function edSetImage(src) {
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  const k = Math.min(1, ED_MAX_SIDE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));

  const orig = document.createElement('canvas');
  orig.width = w;
  orig.height = h;
  const octx = edCtx(orig);
  octx.fillStyle = '#ffffff'; // прозрачный фон PNG → белый
  octx.fillRect(0, 0, w, h);
  octx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();

  ed.original = orig;
  edRestoreFrom(orig, null);
  ed.history = [];
  ed.ready = true;
  edLayout(true);
  edUpdateButtons();
}

// Кладём картинку в оба слоя (mark = null → пустая обводка).
function edRestoreFrom(baseSrc, markSrc) {
  const w = baseSrc.width;
  const h = baseSrc.height;
  [edBase(), edMark()].forEach((c) => { c.width = w; c.height = h; });
  edCtx(edBase()).drawImage(baseSrc, 0, 0);
  if (markSrc) edCtx(edMark()).drawImage(markSrc, 0, 0);
  ed.w = w;
  ed.h = h;
  const stage = $('ed-stage');
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  edSetCrop(null);
}

function edCopy(c) {
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  edCtx(out).drawImage(c, 0, 0);
  return out;
}

/* ---------- Масштаб и сдвиг ---------- */

function edLayout(refit) {
  const vp = $('ed-viewport');
  const vw = vp.clientWidth;
  if (!vw || !ed.w) {
    ed.needsFit = ed.needsFit || refit;
    return;
  }
  // Высоту считаем от самого высокого окна, чтобы клавиатура не сжимала холст.
  ed.maxInner = Math.max(ed.maxInner, window.innerHeight || 0);
  const maxH = Math.max(260, Math.round(ed.maxInner * 0.58));
  const vh = Math.max(220, Math.min(maxH, Math.round(vw * ed.h / ed.w)));
  vp.style.height = vh + 'px';
  ed.lastVw = vw;

  const v = ed.view;
  const oldFit = v.fit;
  v.fit = Math.min(vw / ed.w, vh / ed.h);
  if (refit || !oldFit) {
    v.scale = v.fit;
    v.x = 0;
    v.y = 0;
  }
  edClampView();
  edApplyView();
}

function edClampView() {
  const vp = $('ed-viewport');
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  const v = ed.view;
  v.scale = Math.min(Math.max(v.scale, v.fit), v.fit * ED_MAX_ZOOM);
  const iw = ed.w * v.scale;
  const ih = ed.h * v.scale;
  v.x = iw <= vw ? (vw - iw) / 2 : Math.min(0, Math.max(vw - iw, v.x));
  v.y = ih <= vh ? (vh - ih) / 2 : Math.min(0, Math.max(vh - ih, v.y));
}

function edApplyView() {
  const v = ed.view;
  $('ed-stage').style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.scale + ')';
  $('ed-crop').style.borderWidth = (2 / v.scale) + 'px';
  $('ed-zoom-in').disabled = v.scale >= v.fit * ED_MAX_ZOOM - 1e-6;
  $('ed-zoom-out').disabled = v.scale <= v.fit + 1e-6;
}

function edZoomAt(factor, px, py) {
  const v = ed.view;
  const nx = (px - v.x) / v.scale;
  const ny = (py - v.y) / v.scale;
  v.scale = Math.min(Math.max(v.scale * factor, v.fit), v.fit * ED_MAX_ZOOM);
  v.x = px - nx * v.scale;
  v.y = py - ny * v.scale;
  edClampView();
  edApplyView();
}

function edZoomButton(factor) {
  if (!ed.ready) return;
  haptic();
  const vp = $('ed-viewport');
  edZoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2);
}

// Точка касания в координатах окна редактора и в пикселях картинки.
function edPoint(e) {
  const r = $('ed-viewport').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function edToImage(p) {
  const v = ed.view;
  return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale };
}

/* ---------- Касания ---------- */

function edPointerDown(e) {
  if (!ed.ready || ed.busy || e.target.closest('.ed-zoom')) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { $('ed-viewport').setPointerCapture(e.pointerId); } catch (err) { /* ок */ }
  ed.pointers.set(e.pointerId, edPoint(e));

  if (ed.pointers.size === 2) {
    // Второй палец — это сдвиг и зум, а не рисование: начатый штрих убираем.
    edCancelStroke();
    edCancelCropDrag();
    edStartGesture();
    return;
  }
  if (ed.pointers.size > 2 || ed.gesture) return;

  if (ed.tool === 'crop') edCropStart(e);
  else edStrokeStart(e);
}

function edPointerMove(e) {
  if (!ed.pointers.has(e.pointerId)) return;
  e.preventDefault();
  ed.pointers.set(e.pointerId, edPoint(e));
  if (ed.gesture) edGestureMove();
  else if (ed.stroke && ed.stroke.id === e.pointerId) edStrokeMove(e);
  else if (ed.cropDrag && ed.cropDrag.id === e.pointerId) edCropMove(e);
}

function edPointerUp(e) {
  if (!ed.pointers.has(e.pointerId)) return;
  ed.pointers.delete(e.pointerId);
  if (ed.stroke && ed.stroke.id === e.pointerId) {
    if (e.type === 'pointercancel') edCancelStroke();
    else edStrokeEnd();
  }
  if (ed.cropDrag && ed.cropDrag.id === e.pointerId) edCropEnd();
  if (ed.gesture && ed.pointers.size < 2) ed.gesture = null;
}

function edWheel(e) {
  if (!ed.ready) return;
  e.preventDefault();
  const p = edPoint(e);
  edZoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
}

/* ---------- Сдвиг и зум двумя пальцами ---------- */

function edStartGesture() {
  const [a, b] = Array.from(ed.pointers.values());
  ed.gesture = {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    scale: ed.view.scale,
    anchor: edToImage({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
  };
}

function edGestureMove() {
  const pts = Array.from(ed.pointers.values());
  if (pts.length < 2) return;
  const [a, b] = pts;
  const g = ed.gesture;
  const v = ed.view;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  v.scale = Math.min(Math.max(g.scale * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist), v.fit), v.fit * ED_MAX_ZOOM);
  v.x = mid.x - g.anchor.x * v.scale;
  v.y = mid.y - g.anchor.y * v.scale;
  edClampView();
  edApplyView();
}

/* ---------- Рисование ---------- */

function edStrokeColor() {
  if (ed.tool === 'eraser') return '#ffffff';
  if (ed.tool === 'mark') return '#ff0000'; // слой обводки сам полупрозрачный
  return ed.what === 'drawing' ? '#000000' : ed.color;
}

function edStrokeStart(e) {
  const layer = ed.tool === 'mark' ? edMark() : edBase();
  // Запоминаем слой до штриха: для «Отменить» и на случай, если это окажется жест.
  const b = ed.backup;
  if (b.width !== layer.width || b.height !== layer.height) {
    b.width = layer.width;
    b.height = layer.height;
  }
  const bctx = edCtx(b);
  bctx.clearRect(0, 0, b.width, b.height);
  bctx.drawImage(layer, 0, 0);

  const ctx = edCtx(layer);
  const lw = ed.size / ed.view.scale; // толщина — в пикселях экрана
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = ctx.fillStyle = edStrokeColor();

  const p = edToImage(edPoint(e));
  ctx.beginPath();
  ctx.arc(p.x, p.y, lw / 2, 0, Math.PI * 2);
  ctx.fill();

  ed.stroke = {
    id: e.pointerId, layer, ctx, lw, last: p,
    minX: p.x, minY: p.y, maxX: p.x, maxY: p.y,
  };
}

function edStrokeMove(e) {
  const s = ed.stroke;
  let events = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  if (!events || !events.length) events = [e];
  s.ctx.beginPath();
  s.ctx.moveTo(s.last.x, s.last.y);
  events.forEach((ev) => {
    const p = edToImage(edPoint(ev));
    s.ctx.lineTo(p.x, p.y);
    s.last = p;
    if (p.x < s.minX) s.minX = p.x;
    if (p.y < s.minY) s.minY = p.y;
    if (p.x > s.maxX) s.maxX = p.x;
    if (p.y > s.maxY) s.maxY = p.y;
  });
  s.ctx.stroke();
}

function edStrokeRect(s) {
  const pad = s.lw / 2 + 2;
  const x = Math.max(0, Math.floor(s.minX - pad));
  const y = Math.max(0, Math.floor(s.minY - pad));
  const x2 = Math.min(s.layer.width, Math.ceil(s.maxX + pad));
  const y2 = Math.min(s.layer.height, Math.ceil(s.maxY + pad));
  return { x, y, w: x2 - x, h: y2 - y };
}

function edStrokeEnd() {
  const s = ed.stroke;
  ed.stroke = null;
  const r = edStrokeRect(s);
  if (r.w <= 0 || r.h <= 0) return;
  // В историю кладём только кусок, который поменялся, — так меньше памяти.
  edPushHistory({
    type: 'stroke',
    layer: s.layer === edMark() ? 'mark' : 'base',
    x: r.x,
    y: r.y,
    data: edCtx(ed.backup).getImageData(r.x, r.y, r.w, r.h),
  });
}

function edCancelStroke() {
  const s = ed.stroke;
  if (!s) return;
  ed.stroke = null;
  const r = edStrokeRect(s);
  if (r.w <= 0 || r.h <= 0) return;
  s.ctx.clearRect(r.x, r.y, r.w, r.h);
  s.ctx.drawImage(ed.backup, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
}

/* ---------- Обрезка ---------- */

function edClampToImage(p) {
  return { x: Math.min(Math.max(p.x, 0), ed.w), y: Math.min(Math.max(p.y, 0), ed.h) };
}

function edCropStart(e) {
  const p = edClampToImage(edToImage(edPoint(e)));
  ed.cropDrag = { id: e.pointerId, x0: p.x, y0: p.y };
  edSetCrop({ x: p.x, y: p.y, w: 0, h: 0 });
}

function edCropMove(e) {
  const d = ed.cropDrag;
  const p = edClampToImage(edToImage(edPoint(e)));
  edSetCrop({
    x: Math.min(d.x0, p.x),
    y: Math.min(d.y0, p.y),
    w: Math.abs(p.x - d.x0),
    h: Math.abs(p.y - d.y0),
  });
}

function edCropEnd() {
  ed.cropDrag = null;
  const c = ed.crop;
  if (c && (c.w < 8 || c.h < 8)) edSetCrop(null);
  edUpdateButtons();
}

function edCancelCropDrag() {
  if (!ed.cropDrag) return;
  ed.cropDrag = null;
  edSetCrop(null);
}

function edSetCrop(c) {
  ed.crop = c;
  const box = $('ed-crop');
  box.hidden = !c;
  if (c) {
    box.style.left = c.x + 'px';
    box.style.top = c.y + 'px';
    box.style.width = c.w + 'px';
    box.style.height = c.h + 'px';
  }
  $('ed-crop-apply').disabled = !c || c.w < 8 || c.h < 8;
}

function edCropApply() {
  const c = ed.crop;
  if (!c || c.w < 8 || c.h < 8) {
    toast('Протяни рамку пальцем по картинке');
    return;
  }
  haptic();
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const w = Math.max(1, Math.min(ed.w - x, Math.round(c.w)));
  const h = Math.max(1, Math.min(ed.h - y, Math.round(c.h)));

  const base = edCopy(edBase());
  const mark = edCopy(edMark());
  edPushHistory({ type: 'crop', base, mark });

  const nb = document.createElement('canvas');
  nb.width = w;
  nb.height = h;
  edCtx(nb).drawImage(base, -x, -y);
  const nm = document.createElement('canvas');
  nm.width = w;
  nm.height = h;
  edCtx(nm).drawImage(mark, -x, -y);
  edRestoreFrom(nb, nm);
  edLayout(true);
  edSetTool('brush');
}

function edCropCancel() {
  haptic();
  edSetCrop(null);
  edSetTool('brush');
}

/* ---------- Отменить / Сбросить ---------- */

function edPushHistory(entry) {
  ed.history.push(entry);
  if (ed.history.length > ED_HISTORY) ed.history.shift();
  edUpdateButtons();
}

function edUndo() {
  const entry = ed.history.pop();
  if (!entry) return;
  haptic();
  if (entry.type === 'stroke') {
    const layer = entry.layer === 'mark' ? edMark() : edBase();
    edCtx(layer).putImageData(entry.data, entry.x, entry.y);
  } else if (entry.type === 'crop') {
    edRestoreFrom(entry.base, entry.mark);
    edLayout(true);
  }
  edUpdateButtons();
}

function edReset() {
  if (!ed.ready || !ed.original) return;
  haptic();
  confirmBox('Вернуть исходную картинку? Все правки пропадут.', (ok) => {
    if (!ok) return;
    edRestoreFrom(ed.original, null);
    ed.history = [];
    edLayout(true);
    edUpdateButtons();
  });
}

/* ---------- Инструменты ---------- */

function edSetTool(tool) {
  if (ed.tool === 'crop' && tool !== 'crop') edSetCrop(null);
  ed.tool = tool;
  edRenderTools();
}

function edRenderTools() {
  document.querySelectorAll('.ed-tool[data-tool]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === ed.tool);
  });
  const crop = ed.tool === 'crop';
  $('ed-options').hidden = crop;
  $('ed-crop-actions').hidden = !crop;
  $('ed-colors').hidden = !(ed.tool === 'brush' && ed.what === 'sketch');
  document.querySelectorAll('.ed-color').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.color === ed.color);
  });

  const tips = {
    brush: ed.what === 'drawing' ? 'Чёрная кисть — дорисуй линии.' : 'Кисть — дорисуй или закрась.',
    eraser: 'Ластик закрашивает белым.',
    mark: 'Обведи красным место, которое должна поправить нейронка.',
    crop: 'Протяни рамку пальцем, потом нажми «Применить».',
  };
  $('ed-tip').textContent = tips[ed.tool] + (crop ? '' : ' Двумя пальцами — сдвиг и зум.');

  const dot = $('ed-size-dot');
  const d = Math.max(4, Math.min(28, ed.size / 2));
  dot.style.width = dot.style.height = d + 'px';
  dot.style.background = ed.tool === 'mark' ? 'rgba(255,0,0,0.45)' : 'var(--text)';
  $('ed-size-val').textContent = ed.size;
}

function edUpdateButtons() {
  const prompt = $('ed-prompt').value.trim();
  $('ed-undo').disabled = !ed.ready || !ed.history.length || ed.busy;
  $('ed-reset').disabled = !ed.ready || ed.busy;
  $('ed-ai').disabled = !ed.ready || !prompt || ed.busy;
  $('ed-save').disabled = !ed.ready || ed.busy;
}

/* ---------- Отправка ---------- */

function edHasMark() {
  const c = edMark();
  if (!c.width || !c.height) return false;
  const data = edCtx(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) return true;
  }
  return false;
}

function edExport(withMark) {
  const out = document.createElement('canvas');
  out.width = ed.w;
  out.height = ed.h;
  const ctx = edCtx(out);
  ctx.drawImage(edBase(), 0, 0);
  if (withMark) {
    ctx.globalAlpha = ED_MARK_ALPHA; // склеиваем слои: обводка уходит вместе с картинкой
    ctx.drawImage(edMark(), 0, 0);
    ctx.globalAlpha = 1;
  }
  return ed.what === 'drawing' ? out.toDataURL('image/png') : out.toDataURL('image/jpeg', 0.92);
}

function edBusy(on, text) {
  ed.busy = on;
  $('busy').hidden = !on;
  if (text) $('busy-text').textContent = text;
  edUpdateButtons();
}

async function edSend(kind) {
  if (!ed.ready || ed.busy) return;
  const prompt = $('ed-prompt').value.trim().slice(0, 500);
  if (kind === 'ai' && !prompt) return;
  haptic();

  let image;
  let marked = false;
  try {
    marked = kind === 'ai' && edHasMark();
    image = edExport(kind === 'ai');
  } catch (e) {
    hapticNotify('error');
    alertBox('Не получилось подготовить картинку. Попробуй ещё раз.');
    return;
  }

  const params = { initData: tg.initData, a: kind, what: ed.what, image };
  if (kind === 'ai') {
    params.prompt = prompt;
    if (marked) params.marked = 'true';
  }

  edBusy(true, kind === 'ai' ? 'Нейронка правит… ~30 секунд' : 'Отправляю…');
  let status = 0;
  let data = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ED_SEND_TIMEOUT);
  try {
    // URLSearchParams → form-urlencoded: простой запрос, без CORS-preflight.
    const res = await fetch(EDIT_API, { method: 'POST', body: new URLSearchParams(params), signal: ctrl.signal });
    status = res.status;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
  } catch (e) {
    status = 0;
  } finally {
    clearTimeout(timer);
    edBusy(false);
  }

  if (status === 401 || (data && data.error === 'auth')) {
    sessionExpired();
  } else if (data && data.ok === true) {
    if (data.balance != null && state.me) {
      state.me.balance = data.balance;
      renderBalance();
    }
    hapticNotify('success');
    if (supports('6.2')) {
      tg.showAlert('Готово! Правка в чате 👌', () => tg.close());
    } else {
      window.alert('Готово! Правка в чате 👌');
      tg.close();
    }
  } else if (data && data.error === 'no_credits') {
    edNoCredits();
  } else {
    hapticNotify('error');
    alertBox('Не вышло, попробуй ещё раз — кредиты не списались.');
  }
}

function edNoCredits() {
  hapticNotify('error');
  const goBalance = () => setTab('balance');
  if (supports('6.2')) {
    tg.showPopup({
      title: 'Не хватает кредитов',
      message: 'Пополни баланс — и попробуй ещё раз.',
      buttons: [{ id: 'balance', type: 'default', text: 'Перейти в «Баланс»' }, { type: 'cancel' }],
    }, (id) => { if (id === 'balance') goBalance(); });
  } else if (window.confirm('Не хватает кредитов. Перейти в «Баланс»?')) {
    goBalance();
  }
}

/* ---------- Кнопки ---------- */

function bindEditor() {
  const vp = $('ed-viewport');
  vp.addEventListener('pointerdown', edPointerDown);
  vp.addEventListener('pointermove', edPointerMove);
  vp.addEventListener('pointerup', edPointerUp);
  vp.addEventListener('pointercancel', edPointerUp);
  vp.addEventListener('wheel', edWheel, { passive: false });

  $('ed-zoom-in').addEventListener('click', () => edZoomButton(1.5));
  $('ed-zoom-out').addEventListener('click', () => edZoomButton(1 / 1.5));

  document.querySelectorAll('.ed-tool[data-tool]').forEach((b) => {
    b.addEventListener('click', () => {
      haptic();
      edSetTool(b.dataset.tool);
    });
  });
  document.querySelectorAll('.ed-color').forEach((b) => {
    b.addEventListener('click', () => {
      haptic();
      ed.color = b.dataset.color;
      edRenderTools();
    });
  });
  $('ed-size').addEventListener('input', (e) => {
    ed.size = Number(e.target.value) || 14;
    edRenderTools();
  });

  $('ed-undo').addEventListener('click', edUndo);
  $('ed-reset').addEventListener('click', edReset);
  $('ed-crop-apply').addEventListener('click', edCropApply);
  $('ed-crop-cancel').addEventListener('click', edCropCancel);
  $('ed-retry').addEventListener('click', () => {
    haptic();
    if (state.me) edLoad(ed.what, state.me.drafts[ed.what]);
  });

  $('ed-prompt').addEventListener('input', edUpdateButtons);
  $('ed-ai').addEventListener('click', () => edSend('ai'));
  $('ed-save').addEventListener('click', () => edSend('save'));

  document.querySelectorAll('#ed-switch button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.what === ed.what || ed.busy) return;
      haptic();
      const go = () => {
        ed.what = b.dataset.what;
        ed.history = [];
        renderEditor();
      };
      if (ed.history.length) {
        confirmBox('Правки в этой картинке пропадут. Переключить?', (ok) => { if (ok) go(); });
      } else {
        go();
      }
    });
  });

  window.addEventListener('resize', () => {
    if (state.editorOpen && ed.ready && $('ed-viewport').clientWidth !== ed.lastVw) edLayout(false);
  });
}
