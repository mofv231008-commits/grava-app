/* Грава — «Идеи»: работы, которые авторы сами показали всем (имён авторов нет специально).
   Тап по карточке — большая карточка и «Сделать такую же»: композер в нужном режиме, запрос уже в поле.
   Своя работа — «Показать в Идеях» на экране работы и в меню карточки «Моих работ» (?a=share, оптимистично).
   Админ может убрать любую работу. Список живёт 2 минуты; обновить — свайпом вниз или кнопкой.
   Использует помощники из app.js, create.js (composerStart) и litho.js (lithoKind). */
'use strict';

const GALLERY_TTL = 2 * 60 * 1000;
const GALLERY_PULL = 70; // на сколько потянуть вниз, чтобы обновить, px

const gallery = { items: null, admin: false, at: 0, loading: false, error: '', sharing: {}, pull: null };

/* ---------- Что за работа ---------- */

// Подпись мелко: «Фигурка», «На шарнирах», «Чертёж», «Литофания», «Деталь».
function galleryType(it) {
  const lk = lithoKind(it);
  if (lk) return LITHO_NAMES[lk];
  if (it.cad === true || it.kind === 'cad') return 'Деталь';
  if (it.kind === 'laser') return 'Чертёж';
  if (it.jointed === true || it['3d_flexi'] === true || it.mode === '3d_flexi') return 'На шарнирах';
  if (it.mode === 'color') return 'Цветная фигурка';
  return 'Фигурка';
}

// «Сделать такую же»: в каком режиме открыть композер.
function galleryMode(it) {
  if (lithoKind(it)) return 'relief';
  if (it.cad === true || it.kind === 'cad') return 'cad';
  if (it.kind === 'laser') return 'laser';
  if (it['3d_flexi'] === true || it.mode === '3d_flexi' || it.jointed === true) return 'flexi';
  return '3d';
}

// Для fillPreview: у показанной работы превью есть всегда (без картинки сервер её не покажет).
function galleryOrder(it) {
  return Object.assign({}, it, { has_preview: true });
}

/* ---------- Список ---------- */

async function galleryLoad(force) {
  if (gallery.loading) return;
  if (!force && gallery.items && Date.now() - gallery.at < GALLERY_TTL) {
    renderGallery();
    return;
  }
  gallery.loading = true;
  gallery.error = '';
  renderGallery();
  try {
    const r = await Api.gallery();
    gallery.items = Array.isArray(r.items) ? r.items : [];
    gallery.admin = r.admin === true;
    gallery.at = Date.now();
  } catch (err) {
    if (err && err.code === 'auth') sessionExpired();
    gallery.error = err && err.code === 'network'
      ? 'Нет связи с сервером. Проверь интернет и попробуй ещё раз'
      : 'Не получилось загрузить Идеи. Попробуй ещё раз';
  } finally {
    gallery.loading = false;
    renderGallery();
  }
}

function renderGallery() {
  const grid = $('gallery-grid');
  const items = gallery.items;
  $('gallery-refresh').classList.toggle('is-spinning', gallery.loading);
  $('gallery-refresh').disabled = gallery.loading;
  $('gallery-loading').hidden = !(gallery.loading && !items);
  $('gallery-error').hidden = !gallery.error || !!(items && items.length);
  $('gallery-error-text').textContent = gallery.error;
  $('gallery-empty').hidden = !items || items.length > 0 || !!gallery.error;
  grid.textContent = '';
  (items || []).forEach((it) => grid.appendChild(galleryCard(it)));
}

function galleryCard(it) {
  const card = el('div', 'work idea-card');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  const thumb = el('div', 'thumb');
  fillPreview(thumb, galleryOrder(it));
  if (it.mine === true) thumb.appendChild(el('span', 'work-badge is-sketch', 'твоя'));
  card.appendChild(thumb);
  const body = el('div', 'work-body');
  body.appendChild(el('div', 'work-title', it.title || 'Без названия'));
  body.appendChild(el('div', 'work-meta', galleryType(it)));
  if (gallery.admin) {
    const rm = el('button', 'idea-remove', 'Убрать');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Убрать «' + (it.title || 'работу') + '» из Идей');
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      galleryRemove(it);
    });
    body.appendChild(rm);
  }
  card.appendChild(body);
  const open = () => {
    haptic();
    openIdea(it);
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

// Админ: убрать любую работу из Идей.
function galleryRemove(it) {
  haptic();
  confirmBox('Убрать «' + (it.title || 'работу') + '» из Идей?', async (ok) => {
    if (!ok) return;
    try {
      await Api.share(it.id, false);
      gallery.items = (gallery.items || []).filter((x) => x.id !== it.id);
      const mine = findOrder(it.id);
      if (mine) mine.public = false;
      renderGallery();
      if (state.idea && state.idea.id === it.id) closeIdea();
      hapticNotify('success');
      toast('Убрано из Идей');
    } catch (err) {
      if (err && err.code === 'auth') sessionExpired();
      else {
        hapticNotify('error');
        toast('Не получилось убрать, попробуй ещё раз');
      }
    }
  });
}

/* ---------- Большая карточка ---------- */

function openIdea(it) {
  state.listScroll = window.scrollY;
  state.idea = it;
  fillPreview($('idea-preview'), galleryOrder(it));
  $('idea-title').textContent = it.title || 'Без названия';
  const meta = $('idea-meta');
  meta.textContent = '';
  [galleryType(it), it.mine === true ? 'твоя работа' : ''].filter(Boolean).forEach((t) => meta.appendChild(el('span', '', t)));
  const prompt = String(it.prompt || '').trim();
  $('idea-prompt-box').hidden = !prompt;
  $('idea-prompt').textContent = prompt;
  $('idea-remove').hidden = !gallery.admin;
  renderView();
  window.scrollTo(0, 0);
}

function closeIdea() {
  state.idea = null;
  renderView();
  window.scrollTo(0, state.listScroll || 0);
}

// «Сделать такую же»: новый проект, композер в нужном режиме, в поле — запрос (или название). Можно поправить.
function ideaUse() {
  const it = state.idea;
  if (!it) return;
  haptic();
  state.idea = null;
  composerStart(galleryMode(it), String(it.prompt || '').trim() || it.title || '');
}

/* ---------- «Показать в Идеях» у своей работы ---------- */

function shareErrorText(err) {
  const why = [err && err.code, err && err.data && (err.data.text || err.data.message || err.data.error)].join(' ');
  if (/no_preview|preview|картинк/i.test(why)) return 'Сначала нужна картинка-превью';
  if (err && err.code === 'network') return 'Нет связи, попробуй ещё раз';
  return 'Не получилось, попробуй ещё раз';
}

// Сразу показываем новое состояние; не вышло — возвращаем как было и говорим почему.
async function shareSet(o, on) {
  if (!o || gallery.sharing[o.id]) return;
  const id = String(o.id);
  const before = o.public === true;
  const apply = (v) => {
    o.public = v;
    const same = findOrder(id);
    if (same) same.public = v;
    syncShareUI();
  };
  gallery.sharing[id] = true;
  apply(on);
  try {
    const r = await Api.share(id, on);
    apply(typeof r.public === 'boolean' ? r.public : on);
    gallery.at = 0; // список Идей устарел
    hapticNotify('success');
    toast(on ? 'Работа видна в Идеях' : 'Убрал из Идей');
  } catch (err) {
    apply(before);
    if (err && err.code === 'auth') sessionExpired();
    else {
      hapticNotify('error');
      toast(shareErrorText(err));
    }
  } finally {
    delete gallery.sharing[id];
    renderWorks();
  }
}

function syncShareUI() {
  const o = state.detail;
  if (o) $('detail-share-input').checked = o.public === true;
}

// Меню карточки в «Моих работах»: «Показать в Идеях» / «Убрать из Идей».
function workMenu(o) {
  haptic();
  const on = o.public === true;
  tg.popup({
    title: (o.title || 'Работа').slice(0, 60),
    message: on
      ? 'Работа видна в Идеях: другие видят картинку, название и запрос. Имени там нет'
      : 'Покажи работу в Идеях — другие увидят картинку, название и запрос. Имени там нет',
    buttons: [{ id: 'share', type: on ? 'destructive' : 'default', text: on ? 'Убрать из Идей' : 'Показать в Идеях' }, { type: 'cancel' }],
  }, (btn) => {
    if (btn === 'share') shareSet(o, !on);
  });
}

/* ---------- Свайп вниз — обновить ---------- */

function galleryPullStart(e) {
  if (window.scrollY > 0 || gallery.loading || !e.touches || e.touches.length !== 1) return;
  gallery.pull = { y: e.touches[0].clientY, dy: 0 };
}

function galleryPullMove(e) {
  const p = gallery.pull;
  if (!p || !e.touches) return;
  p.dy = Math.max(0, e.touches[0].clientY - p.y);
  const hint = $('gallery-pull');
  hint.hidden = p.dy < 12;
  hint.textContent = p.dy >= GALLERY_PULL ? 'Отпусти, чтобы обновить' : 'Потяни, чтобы обновить';
  hint.style.height = Math.min(p.dy * 0.5, 44) + 'px';
}

function galleryPullEnd() {
  const p = gallery.pull;
  gallery.pull = null;
  $('gallery-pull').hidden = true;
  if (p && p.dy >= GALLERY_PULL) {
    haptic();
    galleryLoad(true);
  }
}

function bindGallery() {
  $('gallery-refresh').addEventListener('click', () => {
    haptic();
    galleryLoad(true);
  });
  $('gallery-retry').addEventListener('click', () => {
    haptic();
    galleryLoad(true);
  });
  $('idea-remove').addEventListener('click', () => {
    if (state.idea) galleryRemove(state.idea);
  });
  $('detail-share-input').addEventListener('change', () => {
    haptic();
    if (state.detail) shareSet(state.detail, $('detail-share-input').checked);
  });
  const view = $('view-gallery');
  view.addEventListener('touchstart', galleryPullStart, { passive: true });
  view.addEventListener('touchmove', galleryPullMove, { passive: true });
  view.addEventListener('touchend', galleryPullEnd);
  view.addEventListener('touchcancel', galleryPullEnd);
}
