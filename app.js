/* Грава — Telegram Mini App для бота @grava_ai_bot */
'use strict';

const API = 'https://engrave.app.n8n.cloud/webhook/grava-app';
const THREE_URL = './vendor/three/three-viewer.min.js?v=2';

const tg = window.Telegram && window.Telegram.WebApp;
const $ = (id) => document.getElementById(id);

const state = {
  me: null,
  tab: 'works',
  detail: null,     // открытая работа
  viewer: false,    // открыт ли 3D-просмотр
  listScroll: 0,
  lastLoad: 0,
  ordersKey: '',
  sending: false,
  buying: false,
  editorOpen: false,
  noSwipes: false,
  cad: null,        // открытый конструктор
  cadBusy: false,
};

/* ---------- Помощники Телеги ---------- */

function supports(version) {
  try { return tg.isVersionAtLeast(version); } catch (e) { return false; }
}

function haptic(style) {
  try { tg.HapticFeedback.impactOccurred(style || 'light'); } catch (e) { /* старый клиент */ }
}

function hapticNotify(type) {
  try { tg.HapticFeedback.notificationOccurred(type); } catch (e) { /* старый клиент */ }
}

function alertBox(text) {
  if (supports('6.2')) tg.showAlert(text);
  else window.alert(text);
}

function confirmBox(text, cb) {
  if (supports('6.2')) tg.showConfirm(text, cb);
  else cb(window.confirm(text));
}

function sessionExpired() {
  hapticNotify('error');
  confirmBox('Сессия устарела. Закрыть приложение? Потом открой его заново из бота.', (ok) => {
    if (ok) tg.close();
  });
}

/* ---------- Запросы к серверу ---------- */

class ApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function apiUrl(params) {
  const parts = Object.keys(params).map((k) => k + '=' + encodeURIComponent(params[k]));
  parts.push('initData=' + encodeURIComponent(tg.initData));
  return API + '?' + parts.join('&');
}

// Только GET и без своих заголовков — так браузер не делает лишний CORS-запрос.
async function fetchWithTimeout(url, ms, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (outerSignal && outerSignal.aborted) throw e;
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

async function api(params, timeoutMs) {
  const res = await fetchWithTimeout(apiUrl(params), timeoutMs || 20000);
  let data = null;
  try { data = await res.json(); } catch (e) { /* не JSON */ }
  if (res.status === 401 || (data && data.error === 'auth')) throw new ApiError('auth');
  if (!res.ok || !data || data.ok !== true) throw new ApiError((data && data.error) || 'http_' + res.status);
  return data;
}

function handleActionError(err, what) {
  if (err && err.code === 'auth') {
    sessionExpired();
    return;
  }
  hapticNotify('error');
  const tail = err && err.code === 'network'
    ? 'Проверь интернет и попробуй ещё раз.'
    : 'Попробуй ещё раз чуть позже.';
  alertBox(what + '. ' + tail);
}

/* ---------- Мелочи ---------- */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function plural(n, one, few, many) {
  const n100 = Math.abs(n) % 100;
  const n10 = n100 % 10;
  if (n100 > 10 && n100 < 20) return many;
  if (n10 > 1 && n10 < 5) return few;
  if (n10 === 1) return one;
  return many;
}

const pad = (n) => String(n).padStart(2, '0');

function formatDate(iso, withYear) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  return withYear ? s + '.' + d.getFullYear() : s;
}

function formatNumber(n) {
  return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function isModel(o) { return o.kind === 'model'; }
function fileFormat(o) { return isModel(o) ? String(o.format || 'stl').toUpperCase() : 'DXF'; }
function isStl(o) { return isModel(o) && fileFormat(o) === 'STL'; }
function kindEmoji(o) { return o.kind === 'cad' ? '📐' : isModel(o) ? '🧊' : '🔥'; }
function hasFile(o) { return o.has_file !== false; } // в старых ответах поля нет — файл есть

function formatLabel(o) {
  return o.size_mm ? fileFormat(o) + ' · ' + o.size_mm + ' мм' : fileFormat(o);
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  void t.offsetWidth; // чтобы сработала анимация появления
  t.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('is-shown');
    toastTimer = setTimeout(() => { t.hidden = true; }, 250);
  }, 2600);
}

// Превью работы: картинка с сервера или заглушка с эмодзи.
function fillPreview(box, o) {
  box.textContent = '';
  const ph = el('div', 'placeholder');
  box.appendChild(ph);
  if (!o.has_preview) {
    ph.textContent = kindEmoji(o);
    return;
  }
  ph.classList.add('is-loading');
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.onload = () => {
    img.classList.add('is-loaded');
    ph.classList.remove('is-loading');
  };
  img.onerror = () => {
    img.remove();
    ph.classList.remove('is-loading');
    ph.textContent = kindEmoji(o);
  };
  img.src = apiUrl({ a: 'file', what: 'preview', id: o.id });
  box.appendChild(img);
}

/* ---------- Экраны ---------- */

function showScreen(name) {
  ['outside', 'boot', 'fatal'].forEach((id) => { $(id).hidden = id !== name; });
  $('app').hidden = name !== 'app';
  renderView();
}

function renderView() {
  const inApp = !$('app').hidden;
  const inCad = !!state.cad;
  const inDetail = !inCad && !!state.detail;
  const overlay = inCad || inDetail; // экраны поверх вкладок
  $('view-works').hidden = overlay || state.tab !== 'works';
  $('view-balance').hidden = overlay || state.tab !== 'balance';
  $('view-editor').hidden = overlay || state.tab !== 'editor';
  $('view-detail').hidden = !inDetail;
  $('view-cad').hidden = !inCad;
  $('tabbar').hidden = !inApp || overlay;
  document.body.classList.toggle('no-tabbar', !inApp || overlay);
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === state.tab);
  });

  const editorOpen = inApp && !overlay && state.tab === 'editor';
  if (editorOpen !== state.editorOpen) {
    state.editorOpen = editorOpen;
    if (editorOpen) renderEditor();
  }

  // В редакторе рисуют пальцем, в конструкторе крутят 3D — свайп вниз не должен сворачивать приложение.
  const noSwipes = editorOpen || (inApp && inCad);
  if (noSwipes !== state.noSwipes) {
    state.noSwipes = noSwipes;
    if (supports('7.7')) {
      try {
        if (noSwipes) tg.disableVerticalSwipes();
        else tg.enableVerticalSwipes();
      } catch (e) { /* ок */ }
    }
  }
}

function setTab(tab) {
  if (state.tab === tab) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  state.tab = tab;
  renderView();
  window.scrollTo(0, 0);
  softRefresh();
}

function showFatal(err) {
  const auth = err && err.code === 'auth';
  const network = err && err.code === 'network';
  $('fatal-emoji').textContent = auth ? '⌛' : '😕';
  $('fatal-text').textContent = auth
    ? 'Сессия устарела. Закрой приложение и открой его заново из бота @grava_ai_bot'
    : network
      ? 'Нет связи с сервером. Проверь интернет и попробуй ещё раз'
      : 'Не получилось загрузить данные. Попробуй ещё раз';
  $('fatal-btn').textContent = auth ? 'Закрыть' : 'Попробовать ещё раз';
  $('fatal-btn').dataset.action = auth ? 'close' : 'retry';
  showScreen('fatal');
}

/* ---------- Мои работы ---------- */

function renderSkeleton() {
  const grid = $('works-grid');
  grid.textContent = '';
  $('works-empty').hidden = true;
  for (let i = 0; i < 4; i++) {
    const card = el('div', 'work skeleton');
    card.appendChild(el('div', 'thumb'));
    const body = el('div', 'work-body');
    body.appendChild(el('div', 'sk-line'));
    body.appendChild(el('div', 'sk-line short'));
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function workCard(o) {
  const isCadDraft = o.kind === 'cad'; // деталь из бота, файла ещё нет
  const card = el('div', 'work');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  const thumb = el('div', 'thumb');
  fillPreview(thumb, o);
  card.appendChild(thumb);

  const body = el('div', 'work-body');
  body.appendChild(el('div', 'work-title', o.title || 'Без названия'));
  const meta = el('div', 'work-meta');
  if (isCadDraft) {
    meta.classList.add('is-wrap');
    meta.appendChild(el('span', '', 'Деталь по размерам · файла ещё нет'));
  } else {
    meta.appendChild(el('span', '', formatLabel(o)));
    meta.appendChild(el('span', '', formatDate(o.date)));
  }
  body.appendChild(meta);

  if (isCadDraft || o.cad === true) {
    const btn = el('button', 'work-cad-btn', isCadDraft ? '📐 Открыть в конструкторе' : '📐 В конструктор');
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCad(o.id);
    });
    body.appendChild(btn);
  }
  card.appendChild(body);

  const open = () => {
    if (isCadDraft) {
      openCad(o.id);
      return;
    }
    haptic();
    openDetail(o);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

function renderWorks() {
  const orders = (state.me && state.me.orders) || [];
  const key = JSON.stringify(orders);
  if (key === state.ordersKey) return; // ничего не поменялось — не мигаем картинками
  state.ordersKey = key;

  const grid = $('works-grid');
  grid.textContent = '';
  orders.forEach((o) => grid.appendChild(workCard(o)));
  $('works-empty').hidden = orders.length > 0;
}

/* ---------- Экран работы ---------- */

function openDetail(o) {
  state.listScroll = window.scrollY;
  state.detail = o;

  const preview = $('detail-preview');
  fillPreview(preview, o);
  const can3d = isStl(o) && hasFile(o);
  preview.classList.toggle('is-clickable', can3d);
  if (can3d) preview.appendChild(el('div', 'badge-3d', '🧊 3D'));

  $('detail-title').textContent = o.title || 'Без названия';

  const meta = $('detail-meta');
  meta.textContent = '';
  [isModel(o) ? '3D-модель' : 'Чертёж для лазера', formatLabel(o), formatDate(o.date, true)]
    .filter(Boolean)
    .forEach((text) => meta.appendChild(el('span', '', text)));

  $('detail-3d').hidden = !can3d;
  $('detail-edit').hidden = o.editable !== true || o.cad === true; // у деталей из конструктора — свой редактор
  $('detail-cad').hidden = o.cad !== true;
  $('detail-note').textContent = !isModel(o)
    ? 'Файл DXF открывается в LightBurn, RDWorks и других программах для лазера.'
    : isStl(o)
      ? 'Файл STL открой в слайсере (Bambu Studio, PrusaSlicer, Cura) — и можно печатать.'
      : '3MF в браузере не показываем — пришлю файл в чат, открой его в слайсере (Bambu Studio, PrusaSlicer, Cura).';

  renderView();
  window.scrollTo(0, 0);

  tg.BackButton.show();
  // «Прислать в чат» — только если файл есть.
  if (hasFile(o)) tg.MainButton.setParams({ text: '📩 Прислать в чат', is_active: true, is_visible: true });
  else tg.MainButton.hide();
}

function closeDetail() {
  state.detail = null;
  tg.MainButton.hideProgress();
  tg.MainButton.hide();
  tg.BackButton.hide();
  renderView();
  window.scrollTo(0, state.listScroll);
}

function goBack() {
  haptic();
  if (state.viewer) closeViewer();
  else if (state.cad) closeCad();
  else if (state.detail) closeDetail();
}

// Одна кнопка Телеги на два экрана: на экране работы — «Прислать в чат», в конструкторе — файл детали.
function onMainButton() {
  if (state.cad) cadExport();
  else sendToChat();
}

async function sendToChat() {
  const o = state.detail;
  if (!o || state.sending || !hasFile(o)) return;
  haptic();
  state.sending = true;
  tg.MainButton.showProgress(false);
  try {
    await api({ a: 'send', id: o.id }, 45000);
    hapticNotify('success');
    toast('Отправил в чат 👌');
  } catch (err) {
    handleActionError(err, 'Не получилось отправить файл');
  } finally {
    state.sending = false;
    tg.MainButton.hideProgress();
  }
}

/* ---------- Баланс ---------- */

function renderBalance() {
  const me = state.me;
  const balance = Number(me.balance) || 0;
  const prices = me.prices || {};

  $('bal-value').textContent = formatNumber(balance);
  $('bal-unit').textContent = plural(balance, 'кредит', 'кредита', 'кредитов');
  $('bal-free').textContent = 'Сегодня бесплатно ещё: ' + (me.free_left || 0) + ' из ' + (me.free_per_day || 0);
  $('price-image').textContent = (prices.image != null ? prices.image : 1) + ' кр.';
  $('price-model').textContent = (prices.model != null ? prices.model : 4) + ' кр.';

  // Первая 3D-модель в подарок. В старых ответах API поля free_3d нет — тогда ничего не показываем.
  const free3d = me.free_3d === true;
  $('gift').hidden = !free3d;
  $('price-model-note').hidden = !free3d;

  // Детали по размерам. В старых ответах API цены нет — строку не показываем.
  const cadPrice = prices.cad;
  $('price-cad-row').hidden = cadPrice == null;
  if (cadPrice != null) {
    $('price-cad').textContent = cadPrice + ' кр.';
    $('price-cad-note').hidden = me.free_cad !== true;
    $('price-cad-edit').textContent = prices.cad_edit != null ? 'правка словами — ' + prices.cad_edit + ' кр.' : '';
    $('price-cad-edit').hidden = prices.cad_edit == null;
  }

  // Поштучно оплаченные 3D-модели. Нет поля или 0 — строку не показываем.
  const modelsLeft = Number(me.models_left) || 0;
  $('bal-models').textContent = '🧊 Оплаченных 3D-моделей: ' + formatNumber(modelsLeft);
  $('bal-models').hidden = modelsLeft <= 0;

  const chip = $('balance-chip');
  chip.textContent = 'Баланс: ' + formatNumber(balance) + ' кр.';
  chip.hidden = false;

  const packs = me.packs || [];
  const perCredit = (p) => p.stars / p.credits;
  const maxPer = Math.max.apply(null, packs.map(perCredit));
  const box = $('packs');
  box.textContent = '';

  packs.forEach((p) => {
    const card = el('div', 'card pack');
    const info = el('div', 'pack-info');

    const title = el('div', 'pack-title', p.credits + ' ' + plural(p.credits, 'кредит', 'кредита', 'кредитов'));
    const saving = Math.round((1 - perCredit(p) / maxPer) * 100);
    if (saving >= 5) title.appendChild(el('span', 'pack-badge', '−' + saving + '%'));
    info.appendChild(title);

    const price = el('div', 'pack-price');
    price.appendChild(el('b', '', formatNumber(p.stars) + ' ⭐'));
    price.appendChild(document.createTextNode(' · ' + formatNumber(perCredit(p)) + ' ⭐ за кредит'));
    info.appendChild(price);

    const btn = el('button', 'btn btn-primary', 'Купить');
    btn.type = 'button';
    btn.addEventListener('click', () => buy(p, btn));

    card.appendChild(info);
    card.appendChild(btn);
    box.appendChild(card);
  });

  // Одна 3D-модель без пакета. Если one_model = null или поля нет — карточку не показываем.
  const one = me.one_model;
  if (one && one.id && Number(one.stars) > 0) {
    const card = el('div', 'pack pack-single');
    const info = el('div', 'pack-info');
    info.appendChild(el('div', 'pack-title', '🧊 Одна 3D-модель\u00a0—\u00a0' + formatNumber(one.stars) + '\u00a0⭐'));
    info.appendChild(el('div', 'pack-price', 'Без пакета. В пакете 10 кредитов модель выходит дешевле'));

    const btn = el('button', 'btn btn-secondary', 'Купить');
    btn.type = 'button';
    btn.addEventListener('click', () => buy(one, btn));

    card.appendChild(info);
    card.appendChild(btn);
    box.appendChild(card);
  }
}

// Что меняется после оплаты: кредиты или поштучные 3D-модели.
function paymentSnapshot() {
  const me = state.me || {};
  return (Number(me.balance) || 0) + '/' + (Number(me.models_left) || 0);
}

async function buy(pack, btn) {
  haptic();
  if (state.buying) return;
  state.buying = true;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const data = await api({ a: 'buy', pack: pack.id });
    if (!data.link) throw new ApiError('bad_response');
    const before = paymentSnapshot();
    tg.openInvoice(data.link, (status) => {
      if (status === 'paid') {
        hapticNotify('success');
        toast('Оплата прошла 🎉');
        setTimeout(() => refreshAfterPayment(before, 1), 2000);
      } else if (status === 'pending') {
        toast('Платёж обрабатывается…');
        setTimeout(() => refreshAfterPayment(before, 2), 4000);
      } else if (status === 'failed') {
        hapticNotify('error');
        toast('Оплата не прошла');
      }
    });
  } catch (err) {
    handleActionError(err, 'Не получилось открыть оплату');
  } finally {
    state.buying = false;
    btn.disabled = false;
    btn.textContent = 'Купить';
  }
}

// Через 2 секунды после оплаты перезапрашиваем баланс.
// Если покупка ещё не дошла — пробуем ещё пару раз.
async function refreshAfterPayment(before, triesLeft) {
  await loadMe(false);
  if (paymentSnapshot() === before && triesLeft > 0) {
    setTimeout(() => refreshAfterPayment(before, triesLeft - 1), 3000);
  }
}

/* ---------- Загрузка профиля ---------- */

async function loadMe(first) {
  if (first) {
    state.ordersKey = '';
    showScreen('app');
    renderSkeleton();
  }
  try {
    state.me = await api({ a: 'me' });
    state.lastLoad = Date.now();
    renderWorks();
    renderBalance();
    renderEditor();
  } catch (err) {
    if (first) showFatal(err);
    else if (err.code === 'auth') sessionExpired();
    // при тихом обновлении сетевые ошибки просто пропускаем
  }
}

function softRefresh() {
  if (state.me && !state.buying && Date.now() - state.lastLoad > 15000) loadMe(false);
}

/* ---------- 3D-просмотр ---------- */

const viewer = {
  token: 0,
  abort: null,
  cache: { id: null, buffer: null },
  scene: null,
  hintTimer: 0,
};

let threePromise = null;
function loadThree() {
  if (!threePromise) {
    threePromise = import(THREE_URL).catch((e) => {
      threePromise = null;
      throw e;
    });
  }
  return threePromise;
}

function openViewer() {
  const o = state.detail;
  if (!o || !isStl(o) || state.viewer) return;
  haptic();
  state.viewer = true;
  $('viewer').hidden = false;
  document.body.classList.add('no-scroll');
  // чтобы свайп по модели не сворачивал приложение
  if (supports('7.7')) try { tg.disableVerticalSwipes(); } catch (e) { /* ок */ }
  startViewer(o);
}

function closeViewer() {
  viewer.token++;
  if (viewer.abort) viewer.abort.abort();
  viewer.abort = null;
  destroyScene();
  state.viewer = false;
  $('viewer').hidden = true;
  document.body.classList.remove('no-scroll');
  if (supports('7.7')) try { tg.enableVerticalSwipes(); } catch (e) { /* ок */ }
}

function setViewerStatus(mode, text) {
  $('viewer-loading').hidden = mode !== 'loading';
  $('viewer-error').hidden = mode !== 'error';
  if (mode === 'loading') $('viewer-progress').textContent = text || 'Загружаю модель…';
  if (mode === 'error') $('viewer-error-text').textContent = text;
}

async function startViewer(o) {
  const token = ++viewer.token;
  setViewerStatus('loading');
  $('viewer-hint').hidden = true;
  try {
    const [lib, buffer] = await Promise.all([loadThree(), fetchModel(o, token)]);
    if (token !== viewer.token) return;
    setViewerStatus('loading', 'Готовлю модель…');
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    if (token !== viewer.token) return;
    buildScene(lib, buffer);
    setViewerStatus('none');
    showHint();
  } catch (err) {
    if (token !== viewer.token || (err && err.name === 'AbortError')) return;
    if (err && err.code === 'auth') {
      closeViewer();
      sessionExpired();
      return;
    }
    hapticNotify('error');
    setViewerStatus('error', err && err.code === 'network'
      ? 'Не получилось скачать модель. Проверь интернет и попробуй ещё раз'
      : 'Не получилось открыть модель. Попробуй ещё раз');
  }
}

async function fetchModel(o, token) {
  if (viewer.cache.id === o.id) return viewer.cache.buffer;

  const ctrl = new AbortController();
  viewer.abort = ctrl;
  const res = await fetchWithTimeout(apiUrl({ a: 'file', id: o.id }), 120000, ctrl.signal);
  if (res.status === 401) throw new ApiError('auth');
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.indexOf('json') !== -1) {
    let data = null;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
    throw new ApiError(data && data.error === 'auth' ? 'auth' : (data && data.error) || 'http_' + res.status);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  let buffer;
  try {
    if (total && res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (token === viewer.token) {
          const pct = Math.min(99, Math.round((got / total) * 100));
          $('viewer-progress').textContent = 'Загружаю модель… ' + pct + '%';
        }
      }
      const all = new Uint8Array(got);
      let offset = 0;
      chunks.forEach((c) => { all.set(c, offset); offset += c.length; });
      buffer = all.buffer;
    } else {
      buffer = await res.arrayBuffer();
    }
  } catch (e) {
    if (ctrl.signal.aborted) throw e;
    throw new ApiError('network');
  }

  viewer.cache = { id: o.id, buffer };
  return buffer;
}

function buildScene(T, buffer) {
  const stage = $('viewer-stage');
  let geometry = null;
  let renderer = null;
  try {
    geometry = new T.STLLoader().parse(buffer);
    if (!geometry.attributes.position || !geometry.attributes.position.count) throw new Error('empty');
    geometry.rotateX(-Math.PI / 2); // в STL «вверх» — это Z, а в three.js — Y
    geometry.center();
    // Сглаживаем грани, но острые рёбра оставляем острыми. Для огромных моделей пропускаем.
    if (geometry.attributes.position.count <= 1500000) {
      try { geometry = T.toCreasedNormals(geometry, Math.PI / 4); } catch (e) { /* оставим как есть */ }
    }
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    if (geometry) geometry.dispose();
    throw new ApiError('render');
  }

  const radius = geometry.boundingSphere.radius || 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); // прозрачный фон — видно цвет темы
  stage.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const fov = 35;
  const camera = new T.PerspectiveCamera(fov, 1, radius / 100, radius * 100);
  camera.position.set(0.6, 0.4, 0.8).normalize();
  scene.add(camera);

  // Расстояние, с которого модель целиком влезает в экран (по узкой стороне).
  const fitDistance = (aspect) => {
    const vHalf = (fov / 2) * Math.PI / 180;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    return (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
  };

  // Мягкий свет: заливка сверху + основной свет, который «смотрит» вместе с камерой.
  scene.add(new T.HemisphereLight(0xffffff, 0x5a5a5a, 1.5));
  const key = new T.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.4, 1.6);
  camera.add(key);

  const material = new T.MeshStandardMaterial({ color: 0xa9a9a9, roughness: 0.9, metalness: 0 });
  const mesh = new T.Mesh(geometry, material);
  scene.add(mesh);

  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.8;
  controls.minDistance = radius * 1.2;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 2;

  const s = { renderer, scene, camera, controls, mesh, raf: 0, idleTimer: 0, ro: null, onResize: null, touched: false };

  // Авто-поворот, пока модель не трогают; через 3 секунды без касаний — снова крутится.
  controls.addEventListener('start', () => {
    s.touched = true;
    controls.autoRotate = false;
    clearTimeout(s.idleTimer);
    hideHint();
  });
  controls.addEventListener('end', () => {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => { controls.autoRotate = true; }, 3000);
  });

  const resize = () => {
    const w = stage.clientWidth || window.innerWidth;
    const h = stage.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const fit = fitDistance(camera.aspect);
    controls.maxDistance = fit * 4;
    if (!s.touched) camera.position.setLength(fit); // пока не трогали — модель целиком в кадре
  };
  resize();
  if (window.ResizeObserver) {
    s.ro = new ResizeObserver(resize);
    s.ro.observe(stage);
  } else {
    s.onResize = resize;
    window.addEventListener('resize', resize);
  }

  const loop = () => {
    s.raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  viewer.scene = s;
}

function destroyScene() {
  const s = viewer.scene;
  viewer.scene = null;
  hideHint();
  if (!s) return;
  cancelAnimationFrame(s.raf);
  clearTimeout(s.idleTimer);
  if (s.ro) s.ro.disconnect();
  if (s.onResize) window.removeEventListener('resize', s.onResize);
  s.controls.dispose();
  s.mesh.geometry.dispose();
  s.mesh.material.dispose();
  s.renderer.dispose();
  s.renderer.forceContextLoss();
  s.renderer.domElement.remove();
}

function showHint() {
  const hint = $('viewer-hint');
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  hint.textContent = touch ? 'Крути пальцем · щипок — приблизить' : 'Крути мышкой · колёсико — приблизить';
  hint.classList.remove('is-fading');
  hint.hidden = false;
  clearTimeout(viewer.hintTimer);
  viewer.hintTimer = setTimeout(hideHint, 3500);
}

function hideHint() {
  const hint = $('viewer-hint');
  clearTimeout(viewer.hintTimer);
  if (hint.hidden) return;
  hint.classList.add('is-fading');
  viewer.hintTimer = setTimeout(() => { hint.hidden = true; }, 600);
}

/* ---------- Запуск ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      haptic();
      setTab(t.dataset.tab);
    });
  });

  $('balance-chip').addEventListener('click', () => {
    haptic();
    setTab('balance');
  });

  // Плашка «первая 3D-модель в подарок» возвращает в чат с ботом.
  $('gift').addEventListener('click', () => {
    haptic('light');
    tg.close();
  });

  $('detail-3d').addEventListener('click', openViewer);
  $('detail-cad').addEventListener('click', () => {
    if (state.detail) openCad(state.detail.id);
  });
  $('detail-edit').addEventListener('click', () => {
    if (state.detail) openOrderInEditor(state.detail);
  });
  $('detail-preview').addEventListener('click', () => {
    if (state.detail && isStl(state.detail)) openViewer();
  });

  $('viewer-retry').addEventListener('click', () => {
    haptic();
    if (state.detail) startViewer(state.detail);
  });

  $('fatal-btn').addEventListener('click', () => {
    haptic();
    if ($('fatal-btn').dataset.action === 'close') tg.close();
    else loadMe(true);
  });

  bindEditor();
  bindCad();

  tg.BackButton.onClick(goBack);
  tg.MainButton.onClick(onMainButton);

  // Вернулись в приложение (например, из чата с ботом) — тихо обновим данные.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) softRefresh();
  });
  try { tg.onEvent('activated', softRefresh); } catch (e) { /* старый клиент */ }
}

function start() {
  if (!tg || !tg.initData) {
    showScreen('outside');
    return;
  }

  tg.ready();
  tg.expand();
  if (supports('6.1')) {
    try {
      tg.setHeaderColor('bg_color');
      tg.setBackgroundColor('bg_color');
    } catch (e) { /* ок */ }
  }

  // Ссылка с #editor (или startapp=editor) сразу открывает «Редактор».
  const path = location.hash.replace(/^#/, '').split(/[?&]/)[0];
  const startParam = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
  if (path === 'editor' || startParam === 'editor') state.tab = 'editor';

  bindEvents();
  loadMe(true);

  // Бот открывает конструктор кнопкой «📐 Открыть конструктор» со ссылкой ?cad=<id>.
  const cadId = cadIdFromUrl();
  if (cadId) openCad(cadId);
}

// editor.js подключается после этого файла — стартуем, когда загрузятся оба.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
