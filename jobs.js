/* Грава — заказы: цены, отправка, опрос статуса раз в 3 секунды, экран ожидания и плашки на главной.
   Активные заказы лежат в localStorage — закрыли приложение и открыли снова, опрос продолжится.
   Использует помощники из app.js (state, $, el, toast…) и api.js. */
'use strict';

const JOBS_KEY = 'grava.jobs';
const PROMPTS_KEY = 'grava.prompts';
const JOB_POLL_MS = 3000;

// Что за заказ: к какой группе относится и как считается цена.
const JOB_KINDS = {
  laser_new: { group: 'laser', price: 'image' },
  laser_photo: { group: 'laser', price: 'image' },
  laser_edit: { group: 'laser', price: 'image' },
  laser_resize: { group: 'laser', price: 'free', verb: 'Меняю размер', stages: [[0, 'Меняю размер…']] },
  sketch: { group: 'sketch', price: 'image' },
  sketch_photo: { group: 'sketch', price: 'image' },
  sketch_edit: { group: 'sketch', price: 'image' },
  model: { group: 'model', price: 'model' },
  model_format: { group: 'model', price: 'free', verb: 'Готовлю', stages: [[0, 'Пересохраняю модель в другом формате…']] },
  scan: { group: 'model', price: 'model' },
  cad: { group: 'cad', price: 'cad' },
  cad_edit: { group: 'cad', price: 'cad_edit' },
};

// Этапы — по таймеру, сервер про них не знает. T — характерное время для полоски, сек.
const JOB_GROUPS = {
  sketch: { emoji: '✏️', verb: 'Рисую', eta: 'Обычно 30–60 секунд', T: 40, stages: [[0, 'Рисую эскиз…'], [25, 'Дорисовываю детали…']] },
  laser: { emoji: '🔥', verb: 'Рисую', eta: 'Обычно около минуты', T: 50, stages: [[0, 'Рисую…'], [30, 'Перевожу в контуры для лазера…']] },
  model: { emoji: '🧊', verb: 'Леплю', eta: 'Обычно 2–5 минут', T: 170, stages: [[0, 'Леплю 3D-модель…'], [90, 'Чиню сетку для печати…'], [180, 'Почти готово…']] },
  cad: { emoji: '📐', verb: 'Черчу', eta: 'Обычно около минуты', T: 50, stages: [[0, 'Черчу деталь…']] },
};

const JOB_ERRORS = {
  prompt: 'Опиши, что сделать',
  photo: 'Добавь фото',
  photos: 'Нужно хотя бы 3 фото',
  photo_too_big: 'Фото слишком большое — выбери другое',
  size: 'Размер — от 10 до 1000 мм',
  format: 'Выбери формат файла',
  kind: 'Такой заказ пока не принимается. Обнови приложение и попробуй ещё раз',
  order: 'Работа не найдена',
  base_order: 'Работа не найдена',
  not_found: 'Работа не найдена',
};

const jobs = { list: [], timer: 0, busy: false, stopped: false, ticker: 0 };

const jobGroup = (kind) => JOB_GROUPS[(JOB_KINDS[kind] || {}).group] || JOB_GROUPS.laser;
const jobFind = (id) => jobs.list.find((j) => j.id === id) || null;

/* ---------- Цены — только из ?a=me ---------- */

function credits(n) {
  return formatNumber(n) + ' кр.';
}

// Цена одного заказа: «1 кр.», «бесплатно», «🎁 бесплатно», «из оплаченных». Нет цены в ответе — ''.
function jobPrice(kind) {
  const me = state.me || {};
  const p = me.prices || {};
  switch ((JOB_KINDS[kind] || {}).price) {
    case 'free':
      return 'бесплатно';
    case 'image':
      if (Number(me.free_left) > 0) return 'бесплатно';
      return p.image != null ? credits(p.image) : '';
    case 'model':
      if (me.free_3d === true) return '🎁 бесплатно';
      if (Number(me.models_left) > 0) return 'из оплаченных';
      return p.model != null ? credits(p.model) : '';
    case 'cad':
      if (me.free_cad === true) return '🎁 бесплатно';
      return p.cad != null ? credits(p.cad) : '';
    case 'cad_edit':
      return p.cad_edit != null ? credits(p.cad_edit) : '';
    default:
      return '';
  }
}

function withPrice(label, kind) {
  const price = jobPrice(kind);
  return price ? label + ' · ' + price : label;
}

/* ---------- Хранилище ---------- */

function jobsLoad() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch (e) { list = []; }
  const dayAgo = Date.now() - 86400000;
  jobs.list = (Array.isArray(list) ? list : [])
    .filter((j) => j && j.id && JOB_KINDS[j.kind] && j.started > dayAgo)
    .map((j) => Object.assign(j, { data: j.data || {} }));
}

// Фото в localStorage не кладём — места мало. Без них «Попробовать ещё раз» откроет форму.
function jobsSave() {
  const light = jobs.list.map((j) => {
    const data = Object.assign({}, j.data);
    delete data.images;
    return Object.assign({}, j, { data });
  });
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(light)); } catch (e) { /* приватный режим */ }
}

function jobRemove(j) {
  const i = jobs.list.indexOf(j);
  if (i !== -1) jobs.list.splice(i, 1);
  jobsSave();
  renderJobsBar();
}

// Текст эскиза — для «🔄 Другой вариант».
function rememberPrompt(orderId, data) {
  if (!orderId || !data || data.kind !== 'sketch' || !data.prompt) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(PROMPTS_KEY) || '{}') || {}; } catch (e) { all = {}; }
  all[orderId] = { prompt: data.prompt, flexi: data.flexi === true, title: data.title || '', at: Date.now() };
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  keys.slice(50).forEach((k) => delete all[k]);
  try { localStorage.setItem(PROMPTS_KEY, JSON.stringify(all)); } catch (e) { /* ок */ }
}

function savedPrompt(orderId) {
  try {
    const all = JSON.parse(localStorage.getItem(PROMPTS_KEY) || '{}') || {};
    return all[orderId] || null;
  } catch (e) {
    return null;
  }
}

/* ---------- Отправка заказа ---------- */

// fromMain — нажали MainButton: крутим её прогресс. Иначе — затемнение «Отправляю…».
async function startJob(data, title, fromMain) {
  if (state.creating) return false;
  state.creating = true;
  if (fromMain) tg.MainButton.showProgress(false);
  else {
    $('busy-text').textContent = 'Отправляю…';
    $('busy').hidden = false;
  }
  try {
    const r = await Api.createJob(data);
    const j = {
      id: String(r.job_id),
      kind: data.kind,
      title: title || data.title || 'Без названия',
      started: Date.now(),
      status: 'running',
      text: '',
      photos: (data.images || []).length,
      data,
    };
    jobs.list.unshift(j);
    jobsSave();
    renderJobsBar();
    if (state.order) orderCreated(state.order);
    state.order = null;
    state.detail = null;
    openWait(j.id);
    jobsEnsureTimer();
    return true;
  } catch (err) {
    jobCreateError(err);
    return false;
  } finally {
    state.creating = false;
    if (fromMain) tg.MainButton.hideProgress();
    else $('busy').hidden = true;
  }
}

function jobCreateError(err) {
  const code = err && err.code;
  if (code === 'auth') {
    sessionExpired();
    return;
  }
  if (code === 'no_credits') {
    noCreditsPopup(err.data && err.data.text);
    return;
  }
  hapticNotify('error');
  let text = JOB_ERRORS[code];
  if (!text && code === 'network') text = 'Нет связи с сервером. Проверь интернет и попробуй ещё раз';
  if (!text && err && err.data && err.data.text) text = err.data.text;
  if (!text && /[а-яё]/i.test(code || '')) text = code; // сервер прислал готовую фразу
  alertBox(text || 'Не получилось отправить заказ. Попробуй ещё раз');
}

function noCreditsPopup(text) {
  hapticNotify('error');
  tg.popup({
    title: 'Не хватает кредитов',
    message: text || 'Пополни баланс — и попробуй ещё раз.',
    buttons: [{ id: 'balance', type: 'default', text: 'Пополнить' }, { type: 'cancel' }],
  }, (id) => {
    if (id === 'balance') goToBalance();
  });
}

function goToBalance() {
  state.order = null;
  state.detail = null;
  state.wait = null;
  if (state.cad) closeCad();
  if (state.tab === 'balance') renderView();
  else setTab('balance');
}

/* ---------- Опрос статуса ---------- */

function jobsEnsureTimer() {
  const need = !jobs.stopped && jobs.list.some((j) => j.status === 'running');
  if (need && !jobs.timer) {
    jobs.timer = setInterval(jobsPoll, JOB_POLL_MS);
    setTimeout(jobsPoll, 0);
  } else if (!need && jobs.timer) {
    clearInterval(jobs.timer);
    jobs.timer = 0;
  }
}

async function jobsPoll() {
  if (jobs.busy || jobs.stopped) return;
  const running = jobs.list.filter((j) => j.status === 'running');
  if (running.length) {
    jobs.busy = true;
    try { await Promise.all(running.map(jobPollOne)); } finally { jobs.busy = false; }
  }
  jobsEnsureTimer();
}

async function jobPollOne(j) {
  let r;
  try {
    r = await Api.jobStatus(j.id);
  } catch (err) {
    if (jobs.list.indexOf(j) === -1) return;
    if (err && err.code === 'auth') {
      jobs.stopped = true;
      jobsEnsureTimer();
      sessionExpired();
    } else if (err && (err.code === 'not_found' || err.code === 'job')) {
      jobFinish(j, { status: 'error', text: 'Заказ потерялся на сервере. Попробуй ещё раз.' });
    }
    return; // нет связи — спросим в следующий раз
  }
  if (jobs.list.indexOf(j) === -1 || j.status !== 'running') return;
  if (r.status === 'done') jobDone(j, r);
  else if (r.status === 'error' || r.status === 'no_credits' || r.status === 'reply') jobFinish(j, r);
  else if (state.wait === j.id) renderWait();
}

function orderFromJob(o) {
  return Object.assign({ date: new Date().toISOString(), editable: o.kind === 'sketch' || o.kind === 'laser' }, o);
}

async function jobDone(j, r) {
  const watching = state.wait === j.id;
  jobRemove(j);
  const order = r.order || null;
  if (order) rememberPrompt(order.id, j.data);
  hapticNotify('success');
  const title = (order && order.title) || j.title;
  if (watching) {
    $('wait-stage').textContent = 'Готово! Открываю…';
    $('wait-bar').style.width = '100%';
  }
  await loadMe(false);
  if (watching && state.wait === j.id) {
    state.wait = null;
    if (!order) goHome();
    else if (order.kind === 'cad') openCad(order.id);
    else openDetail(findOrder(order.id) || orderFromJob(order), { fresh: true });
  } else {
    toast('✅ Готово: ' + title);
  }
}

function jobFinish(j, r) {
  j.status = r.status;
  j.text = r.text || '';
  jobsSave();
  renderJobsBar();
  loadMe(false);
  hapticNotify(r.status === 'reply' ? 'warning' : 'error');
  if (state.wait === j.id) renderWait();
  else if (r.status === 'no_credits') toast('💰 Не хватает кредитов: ' + j.title);
  else if (r.status === 'reply') toast('💬 Есть вопрос: ' + j.title);
  else toast('😕 Не вышло: ' + j.title);
}

/* ---------- Экран ожидания ---------- */

function openWait(id) {
  const j = jobFind(id);
  if (!j) return;
  if (!state.wait && !state.order && !state.detail) state.listScroll = window.scrollY;
  jobs.list.forEach((x) => { x.watch = x === j; });
  jobsSave();
  state.wait = id;
  renderWait();
  renderView();
  window.scrollTo(0, 0);
}

// «Свернуть» — на главную, опрос продолжается. Закончившийся с ошибкой заказ человек уже видел — убираем.
function closeWait() {
  const j = jobFind(state.wait);
  if (j) {
    j.watch = false;
    if (j.status !== 'running') jobRemove(j);
    else jobsSave();
  }
  state.wait = null;
  goHome();
}

function goHome() {
  state.order = null;
  state.detail = null;
  state.tab = 'create';
  renderView();
  window.scrollTo(0, 0);
}

function jobElapsed(j) {
  return Math.max(0, (Date.now() - j.started) / 1000);
}

function jobStage(j) {
  const stages = (JOB_KINDS[j.kind] || {}).stages || jobGroup(j.kind).stages;
  const t = jobElapsed(j);
  let text = stages[0][1];
  stages.forEach((s) => { if (t >= s[0]) text = s[1]; });
  return text;
}

function renderWait() {
  const j = jobFind(state.wait);
  if (!j) return;
  const g = jobGroup(j.kind);
  const running = j.status === 'running';
  $('view-wait').classList.toggle('is-done', !running);
  $('wait-emoji').textContent = running ? g.emoji : j.status === 'no_credits' ? '💰' : j.status === 'reply' ? '💬' : '😕';
  $('wait-title').textContent = j.title || 'Без названия';
  $('wait-progress').hidden = !running;
  $('wait-note').hidden = !running;
  $('wait-result').hidden = running;
  if (running) {
    renderWaitTick();
  } else {
    $('wait-text').textContent = j.text || (j.status === 'no_credits'
      ? 'Не хватает кредитов. Пополни баланс — и попробуй ещё раз.'
      : j.status === 'reply' ? 'Бот не понял запрос. Попробуй описать по-другому.' : 'Что-то пошло не так. Кредиты не списались — попробуй ещё раз.');
  }
  $('wait-retry').hidden = j.status !== 'error';
  $('wait-topup').hidden = j.status !== 'no_credits';
  $('wait-change').hidden = running || !jobFormFor(j);
  $('wait-hide').textContent = running ? 'Свернуть' : 'Закрыть';
}

function renderWaitTick() {
  const j = jobFind(state.wait);
  if (!j || j.status !== 'running') return;
  const g = jobGroup(j.kind);
  $('wait-stage').textContent = jobStage(j);
  $('wait-eta').textContent = (JOB_KINDS[j.kind] || {}).stages ? '' : g.eta;
  // Плавно ползёт к 95 % и там ждёт — честнее, чем застрявшие 100 %.
  const p = 0.95 * (1 - Math.exp(-jobElapsed(j) / g.T));
  $('wait-bar').style.width = (p * 100).toFixed(1) + '%';
}

function jobsSyncTicker() {
  const need = !!state.wait && !state.cad && !state.flexi;
  if (need && !jobs.ticker) jobs.ticker = setInterval(renderWaitTick, 1000);
  else if (!need && jobs.ticker) {
    clearInterval(jobs.ticker);
    jobs.ticker = 0;
  }
}

// Какая форма у заказа — чтобы «Изменить запрос» открыл её с тем же текстом.
function jobFormFor(j) {
  const k = j.kind;
  if (k === 'laser_new' || k === 'laser_photo') return 'laser';
  if (k === 'sketch' || k === 'sketch_photo') return '3d';
  if (k === 'cad') return 'cad';
  if (k === 'scan') return 'scan';
  if ((k === 'laser_edit' || k === 'sketch_edit' || k === 'cad_edit') && findOrder(j.data.base_order)) return 'edit';
  return null;
}

function jobRetry() {
  const j = jobFind(state.wait);
  if (!j) return;
  haptic();
  const images = j.data.images || [];
  if (j.photos > images.length) {
    // фото после перезапуска не сохранились — пусть выберет заново
    jobChange();
    toast('Добавь фото ещё раз');
    return;
  }
  const data = j.data;
  const title = j.title;
  jobRemove(j);
  state.wait = null;
  startJob(data, title, false).then((ok) => {
    if (!ok) goHome();
  });
}

function jobChange() {
  const j = jobFind(state.wait);
  if (!j) return;
  haptic();
  const form = jobFormFor(j);
  jobRemove(j);
  state.wait = null;
  if (!form) {
    goHome();
    return;
  }
  state.tab = 'create';
  openOrderFromJob(form, j);
}

function jobTopUp() {
  const j = jobFind(state.wait);
  haptic();
  if (j) jobRemove(j);
  goToBalance();
}

/* ---------- Плашки заказов на главной ---------- */

function jobPillText(j) {
  const q = '„' + (j.title || 'Без названия') + '“';
  if (j.status === 'error') return '😕 Не вышло: ' + q;
  if (j.status === 'no_credits') return '💰 Не хватает кредитов: ' + q;
  if (j.status === 'reply') return '💬 Есть вопрос: ' + q;
  return '⏳ ' + ((JOB_KINDS[j.kind] || {}).verb || jobGroup(j.kind).verb) + ' ' + q + '…';
}

function renderJobsBar() {
  const box = $('jobs-bar');
  box.textContent = '';
  jobs.list.forEach((j) => {
    const b = el('button', 'job-pill' + (j.status !== 'running' ? ' is-' + j.status : ''));
    b.type = 'button';
    b.appendChild(el('span', 'job-pill-text', jobPillText(j)));
    b.appendChild(el('span', 'job-pill-go', '›'));
    b.addEventListener('click', () => {
      haptic();
      openWait(j.id);
    });
    box.appendChild(b);
  });
  box.hidden = jobs.list.length === 0;
}

/* ---------- Запуск ---------- */

function bindJobs() {
  $('wait-hide').addEventListener('click', () => {
    haptic();
    closeWait();
  });
  $('wait-retry').addEventListener('click', jobRetry);
  $('wait-change').addEventListener('click', jobChange);
  $('wait-topup').addEventListener('click', jobTopUp);
}

// После перезапуска: опрос продолжается; если ждали результат на экране ожидания — открываем его снова.
function jobsResume(openWatched) {
  jobsLoad();
  renderJobsBar();
  const watched = jobs.list.find((j) => j.watch);
  if (openWatched && watched) openWait(watched.id);
  jobsEnsureTimer();
}
