/* Грава — проекты. Каждая новая работа живёт в своём проекте, как отдельная переписка:
   свой запрос, свои эскизы, модели и правки. Список собирается тут же, на фронте:
   работы из ?a=me группируются по полю project, активные заказы из localStorage — тоже
   в своём проекте. Работы без проекта (сделаны до проектов) — в одном проекте «Ранее».
   Использует помощники из app.js, jobs.js и create.js. */
'use strict';

const PROJECT_KEY = 'grava.project';
const OLD_PROJECT = '~old'; // «Ранее». Тильды в id проекта не бывает: там только латиница, цифры, _ и -
const PROJECT_FRESH_MS = 24 * 3600 * 1000; // дольше суток без работ — при открытии начинаем новый проект
const PROJECT_FEED_MAX = 30;

const proj = {
  current: readProject(), // id проекта; null — новый проект, пока пустой; OLD_PROJECT — «Ранее»
  fresh: 0,               // номер пустого «Нового проекта»: у каждого свои уточняющие вопросы
  inited: false,
  drawer: false,
  drawerTimer: 0,
};

function readProject() {
  try { return localStorage.getItem(PROJECT_KEY) || null; } catch (e) { return null; }
}

function saveProject() {
  try {
    if (proj.current === null) localStorage.removeItem(PROJECT_KEY);
    else localStorage.setItem(PROJECT_KEY, proj.current);
  } catch (e) { /* приватный режим */ }
}

// Что уходит в createJob: только настоящий id проекта, «Ранее» и новый — ничего.
function realProject(id) {
  return id && id !== OLD_PROJECT ? id : '';
}

function orderProject(o) {
  return o && o.project ? String(o.project) : OLD_PROJECT;
}

// Ключ экрана: у проекта — его id, у каждого нового пустого — свой.
function viewKey() {
  return proj.current !== null ? proj.current : 'new:' + proj.fresh;
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const orderTime = (o) => Date.parse(o.date) || 0;

// Исходный запрос человека: с уточнением — то, что он написал сам, без ответов на вопросы.
function orderRequestText(o) {
  const saved = savedPrompt(o.id);
  return (saved && saved.ask && saved.ask.text) || o.prompt || (saved && saved.prompt) || '';
}

function jobRequestText(j) {
  return (j.ask && j.ask.text) || j.data.prompt || '';
}

/* ---------- Список проектов ---------- */

function projectsAll() {
  const map = new Map();
  const get = (id) => {
    let p = map.get(id);
    if (!p) {
      p = { id, orders: [], jobs: [], last: 0 };
      map.set(id, p);
    }
    return p;
  };
  ((state.me && state.me.orders) || []).forEach((o) => {
    const p = get(orderProject(o));
    p.orders.push(o);
    p.last = Math.max(p.last, orderTime(o));
  });
  jobs.list.forEach((j) => {
    const p = get(j.project || OLD_PROJECT);
    p.jobs.push(j);
    p.last = Math.max(p.last, j.started || 0);
  });
  const list = Array.from(map.values());
  list.forEach((p) => {
    p.orders.sort((a, b) => orderTime(b) - orderTime(a)); // свежие сверху
    p.name = projectName(p);
  });
  // свежие сверху, «Ранее» — всегда внизу
  list.sort((a, b) => (a.id === OLD_PROJECT) - (b.id === OLD_PROJECT) || b.last - a.last);
  return list;
}

function projectGet(id) {
  if (id == null) return null;
  return projectsAll().find((p) => p.id === id) || null;
}

// Название = запрос первой работы (до ~40 символов), если пусто — её название.
function projectName(p) {
  if (p.id === OLD_PROJECT) return 'Ранее';
  const first = p.orders[p.orders.length - 1] || null;
  const firstJob = p.jobs.reduce((a, j) => (!a || j.started < a.started ? j : a), null);
  let text = '';
  if (first && (!firstJob || orderTime(first) <= firstJob.started)) text = orderRequestText(first) || first.title || '';
  else if (firstJob) text = jobRequestText(firstJob) || firstJob.title || '';
  return capitalize(shortTitle(text)) || 'Без названия';
}

// «Сегодня», «Вчера» или «14.10».
function projectDate(t) {
  if (!t) return '';
  const d = new Date(t);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return formatDate(d.toISOString(), d.getFullYear() !== now.getFullYear());
}

/* ---------- Переключение ---------- */

// id — проект, null — новый пустой проект. opts.follow — заказ из этого экрана попал в другой проект
// (например, первый заказ нового проекта): идём за ним, не создавая новый пустой экран.
function projOpen(id, opts) {
  opts = opts || {};
  if (id === undefined) id = null;
  if (id === null && !opts.follow) {
    // старые вопросы пустого проекта больше не показываем; те, что ещё думают, создадут заказ сами
    const a = asks[viewKey()];
    if (proj.current === null && a && a.status === 'questions') delete asks[viewKey()];
    proj.fresh++;
  }
  if (id !== proj.current) comp.edit = null; // правка относится к работе из прежнего проекта
  proj.current = id;
  saveProject();
  renderFeed();
  renderComposer();
  if (state.createOpen) feedToBottom(false);
}

// При открытии приложения — последний проект. Если в нём больше суток не было работ — новый.
function projInit() {
  if (proj.inited) return;
  proj.inited = true;
  if (proj.current === null) return;
  const p = projectGet(proj.current);
  if (!p || Date.now() - p.last > PROJECT_FRESH_MS) {
    proj.current = null;
    saveProject();
  }
}

/* ---------- Шапка «Создать» ---------- */

function renderTopbar() {
  const p = proj.current !== null ? projectGet(proj.current) : null;
  const a = askCurrent();
  const title = p ? p.name : a ? capitalize(shortTitle(a.text)) : 'Новый проект';
  $('proj-title').textContent = title;
  $('proj-add').hidden = !p && !a; // пустой новый проект — «+» не нужен
}

/* ---------- Боковая панель: список проектов, как список чатов ---------- */

function openDrawer() {
  if (proj.drawer) return;
  haptic();
  proj.drawer = true;
  clearTimeout(proj.drawerTimer);
  renderDrawer();
  const d = $('drawer');
  d.hidden = false;
  void d.offsetWidth; // чтобы панель выехала, а не появилась сразу
  d.classList.add('is-open');
  document.body.classList.add('no-scroll', 'drawer-open');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  syncButtons();
}

function closeDrawer() {
  if (!proj.drawer) return;
  proj.drawer = false;
  const d = $('drawer');
  d.classList.remove('is-open');
  clearTimeout(proj.drawerTimer);
  proj.drawerTimer = setTimeout(() => { if (!proj.drawer) d.hidden = true; }, 260);
  document.body.classList.remove('drawer-open');
  if (!state.viewer) document.body.classList.remove('no-scroll');
  syncButtons();
}

function renderDrawer() {
  const box = $('proj-list');
  box.textContent = '';
  const list = projectsAll();
  list.forEach((p) => box.appendChild(projectRow(p)));
  $('proj-empty').hidden = list.length > 0;
}

function projectRow(p) {
  const row = el('button', 'proj' + (p.id === proj.current ? ' is-active' : ''));
  row.type = 'button';
  if (p.id === proj.current) row.setAttribute('aria-current', 'true');

  // превью последней работы; если готовых ещё нет — значок заказа
  const thumb = el('div', 'thumb proj-thumb');
  const lastOrder = p.orders[0] || null;
  const lastJob = p.jobs[0] || null;
  if (lastOrder) fillPreview(thumb, lastOrder);
  else {
    const ph = el('div', 'placeholder');
    ph.appendChild(icon(JOB_ICONS[(JOB_KINDS[lastJob.kind] || {}).group] || 'sparkle'));
    thumb.appendChild(ph);
  }
  row.appendChild(thumb);

  const info = el('div', 'proj-info');
  info.appendChild(el('div', 'proj-name', p.name));
  const running = p.jobs.some((j) => j.status === 'running');
  const meta = p.id === OLD_PROJECT
    ? [formatNumber(p.orders.length) + ' ' + plural(p.orders.length, 'работа', 'работы', 'работ')]
    : [projectDate(p.last)];
  if (running) meta.push('создаётся…');
  info.appendChild(el('div', 'proj-meta', meta.filter(Boolean).join(' · ')));
  row.appendChild(info);

  row.addEventListener('click', () => {
    haptic();
    closeDrawer();
    if (p.id !== proj.current) projOpen(p.id);
    else feedToBottom(false);
  });
  return row;
}

// Строчка с названием проекта в карточке «Моих работ»: тап — открыть этот проект.
function openProjectFromWorks(id) {
  haptic();
  state.detail = null;
  state.order = null;
  projOpen(id);
  setTab('create');
}

function bindProjects() {
  $('proj-menu').addEventListener('click', openDrawer);
  $('proj-add').addEventListener('click', () => {
    haptic();
    projOpen(null);
    $('composer-input').focus();
  });
  $('proj-new').addEventListener('click', () => {
    haptic();
    closeDrawer();
    projOpen(null);
  });
  $('drawer-close').addEventListener('click', () => {
    haptic();
    closeDrawer();
  });
  $('drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && proj.drawer) closeDrawer();
  });
}
