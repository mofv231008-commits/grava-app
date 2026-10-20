/* Грава — вкладка «Создать»: лента работ, как переписка, и композер внизу — создать работу,
   как написать сообщение. Плюс экраны заказа (правка словами с экрана работы, «Изменить запрос»).
   Использует помощники из app.js и jobs.js. */
'use strict';

const PHOTO_MAX_SIDE = 1600;
const PHOTO_MAX_BYTES = 7 * 1024 * 1024;
const PROMPT_MAX = 1500;
const DRAFT_USED_KEY = 'grava.draftUsed';
const LAST_MODE_KEY = 'grava.lastMode';
const MAX_PHOTOS = 6;
const COMPOSER_MAX_H = 6 * 24 + 16; // 6 строк

const FORMS = {
  laser: {
    title: 'Чертёж для лазера',
    modes: true,
    label: 'Что вырезать или выжечь?',
    placeholder: 'например: олень в лесу, тонкие линии',
    chips: ['Волк воет на луну', 'Ключница-домик', 'Узор для разделочной доски', 'Имя в рамке'],
    photoMode: true,
    button: 'Создать',
    kind: (s) => (s.mode === 'photo' ? 'laser_photo' : 'laser_new'),
  },
  '3d': {
    title: '3D-фигурка',
    modes: true,
    label: 'Какую фигурку сделать?',
    placeholder: 'например: дракон сидит, крылья сложены',
    flexi: true,
    extra: true,
    button: 'Создать',
    note: 'Сначала будет эскиз — посмотришь и решишь, делать ли из него 3D-модель',
    kind: (s) => (s.mode === 'photo' ? 'sketch_photo' : 'sketch'),
  },
  cad: {
    title: 'Деталь по размерам',
    label: 'Опиши деталь с размерами в мм',
    placeholder: 'например: пластина 50×30×3, два отверстия 5 мм по краям',
    chips: ['Пластина 50×30×3, два отверстия 5 мм'],
    format: true,
    button: 'Создать',
    note: 'Потом размеры можно поменять в конструкторе — бесплатно',
    kind: () => 'cad',
  },
  scan: {
    title: '3D по фото предмета',
    lead: 'Модель по 3–6 фото с разных сторон. Сними предмет спереди, сбоку, сзади и с другого бока. Однотонный фон, хороший свет, предмет целиком в кадре, без рук',
    photos: 6,
    minPhotos: 3,
    button: 'Создать',
    note: 'Получится похожая модель, но не точная копия по размерам',
    kind: () => 'scan',
  },
  edit: {
    title: 'Изменить описанием',
    label: 'Что изменить?',
    button: 'Изменить',
    kind: (s) => editKind(s.base),
  },
};

const EDIT_PLACEHOLDERS = {
  sketch_edit: 'например: хвост длиннее, лапы толще',
  laser_edit: 'например: убери надпись, линии потолще',
  cad_edit: 'например: добавь паз 10×3 посередине',
};

// Режимы: иконка, название на кнопке композера (short), плитка (tile + sub мелко) и подсказка под полем.
const MODES = {
  laser: { icon: 'laser', name: 'Лазер', short: 'Лазер', tile: 'Лазер', sub: 'DXF', about: 'чертёж для резки и гравировки, файл DXF' },
  '3d': { icon: 'cube', name: '3D', short: '3D', tile: '3D-фигурка', sub: 'STL', about: 'сначала эскиз, потом 3D-модель для печати' },
  flexi: { icon: 'joint', name: 'Подвижная на шарнирах', short: 'Шарниры', tile: 'На шарнирах', sub: 'подвижная', about: 'фигурка на шарнирах, печатается одной деталью' },
  cad: { icon: 'ruler', name: 'Деталь', short: 'Деталь', tile: 'Деталь', sub: 'по размерам', about: 'точные размеры в миллиметрах' },
  scan: { icon: 'scan', name: 'По фото', short: 'По фото', tile: 'По фото', sub: 'скан', about: '3–6 фото предмета с разных сторон' },
  relief: { icon: 'photo', name: 'Рельеф', short: 'Рельеф', tile: 'Рельеф', sub: 'литофания', about: 'литофания или барельеф по фото — бесплатно' },
};
const COMPOSER_PLACEHOLDER = 'Опиши, что нужно сделать…';

// Пустая лента — примеры: тап подставляет текст и режим.
const EXAMPLES = [
  { text: 'Волк воет на луну', mode: 'laser', note: 'для лазера' },
  { text: 'Ящерица на шарнирах', mode: 'flexi', note: 'фигурка на шарнирах' },
  { text: 'Держатель для телефона 75 мм', mode: 'cad', note: 'деталь по размерам' },
  { text: 'Котик спит клубком', mode: '3d', note: '3D-фигурка' },
];

const orderDrafts = {}; // недописанные формы — вернулся назад и снова зашёл, текст на месте
const chat = { seq: 0 }; // запросы черновика из чата

const comp = {
  mode: lastMode(),
  manual: false,       // режим выбрали руками — по числу фото больше не угадываем
  photos: [],          // data URL, уже сжатые
  busyPhotos: 0,
  edit: null,          // работа, которую правим словами («Правка: Котик»)
  fromDraft: null,     // at черновика из чата, если композер заполнен из него
  format: '',          // деталь: stl | dxf | '' (сам реши)
  photoMode: 'redraw', // лазер по фото: перерисовать или обвести
  sending: false,
  modesOpen: false,    // раскрыт выбор режима над полем (кнопка «Лазер ▾»)
};

function editKind(o) {
  if (!o) return 'laser_edit';
  if (o.kind === 'cad' || o.cad === true) return 'cad_edit';
  if (o.kind === 'sketch' || o.sketch === true) return 'sketch_edit';
  return 'laser_edit';
}

function shortTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 40) return t;
  const cut = t.slice(0, 40);
  const sp = cut.lastIndexOf(' ');
  return (sp > 20 ? cut.slice(0, sp) : cut) + '…';
}

// Подвижная не запоминается: включается только тапом по чипу (или примером «Ящерица на шарнирах»).
// Иначе режим «залипает» — человек пишет «дракона», не глядя на чип, и получает фигурку из звеньев.
// «Рельеф» тоже не запоминается — он не про описание, а про одно фото.
function lastMode() {
  try {
    const m = localStorage.getItem(LAST_MODE_KEY);
    if (m === 'flexi') return '3d'; // запомнили раньше, до этого правила
    if (m && m !== 'scan' && m !== 'relief' && MODES[m]) return m;
  } catch (e) { /* приватный режим */ }
  return 'laser';
}

function saveLastMode(m) {
  if (m === 'scan' || m === 'relief') return; // скан выбирается по фото, рельеф — только тапом
  try { localStorage.setItem(LAST_MODE_KEY, m === 'flexi' ? '3d' : m); } catch (e) { /* ок */ }
}

// В тексте просят обычную фигурку — подвижная выбрана по ошибке. Но «подвижный только хвост» — это подвижная.
// Без \w: в JS он не ловит кириллицу.
const STATIC_RE = /неподвиж|не\s+(нужно\s+|надо\s+)?подвиж|(^|[^а-яё])обычн|(^|[^а-яё])цельн|статичн|статуэтк/;
const TAIL_ONLY_RE = /только\s+хвост|хвост\S*\s+подвижн|подвижн\S*\s+(только\s+)?хвост/;

function wantsStatic(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  return STATIC_RE.test(t) && !TAIL_ONLY_RE.test(t);
}

// Цена под композером, отдельным словом: «1 кредит», «Бесплатно», «Бесплатно (подарок)», «Оплачено».
function shortPrice(kind) {
  const p = isGift(kind) ? 'бесплатно (подарок)' : jobPrice(kind);
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/* ---------- Вкладка «Создать» ---------- */

function renderCreate() {
  const me = state.me;
  const name = tg.userName || (me && me.user && me.user.first_name) || '';
  $('hello-title').textContent = name ? 'Что сделаем, ' + name + '?' : 'Что сделаем?';
  const sub = $('hello-sub');
  sub.textContent = '';
  if (me) {
    if (me.free_per_day != null) {
      const free = el('span', 'stat');
      free.appendChild(el('span', 'stat-dot'));
      free.appendChild(document.createTextNode((me.free_left || 0) + ' из ' + (me.free_per_day || 0) + ' бесплатно сегодня'));
      sub.appendChild(free);
    }
    const bal = el('button', 'stat', credits(Number(me.balance) || 0));
    bal.type = 'button';
    bal.setAttribute('aria-label', 'Баланс: ' + credits(Number(me.balance) || 0));
    bal.addEventListener('click', () => {
      haptic();
      setTab('balance');
    });
    sub.appendChild(bal);
  }
  renderFeed();
  renderComposer();
}

/* ---------- Черновик из чата → композер ---------- */
/* Бот не принимает заказы: текст и фото, которые человек написал боту, он сохраняет черновиком
   и присылает кнопку «🚀 Открыть и продолжить» (?draft=1). Сам бот, пока человек в приложении,
   ничего не пишет: статусы и результаты — только здесь, в чат — по кнопке «Отправить в Telegram». */

function draftUsedAt() {
  try { return localStorage.getItem(DRAFT_USED_KEY) || ''; } catch (e) { return ''; }
}

// Черновик использован или отклонён — больше не подставляем.
function markDraftUsed(at) {
  try { localStorage.setItem(DRAFT_USED_KEY, at); } catch (e) { /* приватный режим */ }
  if (comp.fromDraft === at) comp.fromDraft = null;
  renderComposer();
}

// Спрашиваем при старте и при каждом открытии «Создать». Нет черновика или ошибка — молча ничего.
async function loadChatDraft() {
  const seq = ++chat.seq;
  let d;
  try {
    d = (await Api.chatDraft()).draft || null;
  } catch (e) {
    return;
  }
  if (seq !== chat.seq || !d || !d.at) return;
  const at = String(d.at);
  const text = String(d.text || '').trim().slice(0, PROMPT_MAX);
  const photos = Math.min(MAX_PHOTOS, Number(d.photos) || 0);
  if (at === draftUsedAt() || at === comp.fromDraft || (!text && !photos)) return;
  // человек уже что-то пишет — не затираем, подставим в следующий раз
  if ($('composer-input').value.trim() || comp.photos.length || comp.busyPhotos || comp.edit) return;

  projOpen(null); // черновик из Telegram — всегда новый проект
  comp.fromDraft = at;
  $('composer-input').value = text;
  comp.manual = false;
  comp.mode = photos >= 2 ? 'scan' : photos === 1 ? '3d' : lastMode();
  comp.busyPhotos = photos;
  renderComposer();

  // Фото — как будто человек выбрал их сам: скачали → то же сжатие → data URL.
  let failed = 0;
  for (let i = 0; i < photos; i++) {
    try {
      const url = await compressPhoto(await Api.chatDraftPhoto(i));
      if (comp.fromDraft === at) comp.photos.push(url);
    } catch (e) {
      failed++;
    }
    comp.busyPhotos = Math.max(0, comp.busyPhotos - 1);
    renderComposer();
  }
  if (failed && comp.fromDraft === at) {
    hapticNotify('error');
    toast(failed === photos ? 'Фото из сообщения не загрузились — загрузи их ещё раз' : 'Не все фото из сообщения загрузились — загрузи их ещё раз');
  }
}

// Заказ создан (createJob ответил ok): форма больше не нужна, черновик — тоже.
function orderCreated(s) {
  delete orderDrafts[draftKey(s)];
  if (s.fromDraft) markDraftUsed(s.fromDraft);
}

/* ---------- Композер ---------- */

// Уточняющие вопросы в этом проекте: пока они есть, композер отвечает на них.
function composerAsk() {
  const a = askCurrent();
  return a && !comp.edit && !comp.photos.length && !comp.busyPhotos ? a : null;
}

// Что уйдёт при отправке и можно ли отправлять.
function composerPlan() {
  const text = $('composer-input').value.trim();
  const n = comp.photos.length;
  if (comp.busyPhotos) return { kind: comp.edit ? editKind(comp.edit) : null, ok: false, hint: 'Фото ещё обрабатывается…' };
  if (comp.edit) return { kind: editKind(comp.edit), ok: !!text, hint: '' };
  const a = composerAsk();
  if (a) {
    return a.status === 'questions'
      ? { kind: a.kind, ok: !!text, hint: '', answer: true } // текст — «Свой вариант» для всех вопросов
      : { kind: a.kind, ok: false, hint: '', wait: true };   // думаю над вопросами или уже отправляю
  }
  const first = n > 1 ? 'Возьму первое фото' : '';
  switch (comp.mode) {
    case 'laser':
      return n ? { kind: 'laser_photo', ok: true, hint: first } : { kind: 'laser_new', ok: !!text, hint: '' };
    case '3d':
      return n ? { kind: 'sketch_photo', ok: true, hint: first } : { kind: 'sketch', ok: !!text, hint: '' };
    case 'flexi':
      return n
        ? { kind: 'sketch', ok: false, hint: 'Фигурка на шарнирах делается по описанию, без фото. Убери фото или выбери «3D»' }
        : { kind: 'sketch', ok: !!text, hint: '', flexi: true };
    case 'cad':
      return n
        ? { kind: 'cad', ok: false, hint: 'Деталь — по описанию с размерами, фото не нужно' }
        : { kind: 'cad', ok: !!text, hint: '' };
    case 'relief': // ровно одно фото, текст — подпись, необязательно; кнопка открывает экран литофании
      return {
        kind: null,
        ok: n === 1,
        hint: n === 1 ? '' : n ? 'Нужно одно фото — убери лишние' : 'Прикрепи фото или картину',
        litho: true,
      };
    default: // scan
      return {
        kind: 'scan',
        ok: n >= 3,
        hint: n >= 3 ? '' : n ? 'Добавь ещё фото — нужно хотя бы 3' : 'Загрузи 3–6 фото предмета с разных сторон',
      };
  }
}

// Режим по умолчанию — по тому, что есть: 2+ фото → скан, одно фото → 3D, только текст → последний.
function guessMode() {
  if (comp.manual || comp.edit) return;
  const n = comp.photos.length + comp.busyPhotos;
  comp.mode = n >= 2 ? 'scan' : n === 1 ? '3d' : lastMode();
}

function composerTag(iconName, text, onClose, label) {
  const t = el('span', 'tag');
  t.appendChild(icon(iconName));
  t.appendChild(el('span', '', text));
  const x = el('button');
  x.type = 'button';
  x.setAttribute('aria-label', label);
  x.appendChild(icon('x'));
  x.addEventListener('click', () => {
    haptic();
    onClose();
  });
  t.appendChild(x);
  return t;
}

function renderComposer() {
  const tags = $('composer-tags');
  tags.textContent = '';
  if (comp.edit) {
    tags.appendChild(composerTag('pencil', 'Правка: ' + (comp.edit.title || 'Без названия'), composerExitEdit, 'Выйти из правки'));
  }
  if (comp.fromDraft) {
    tags.appendChild(composerTag('message', 'Из сообщения боту', composerDropDraft, 'Убрать текст и фото из сообщения'));
  }

  const box = $('composer-photos');
  box.textContent = '';
  comp.photos.forEach((src, i) => {
    const ph = el('div', 'cphoto');
    const img = new Image();
    img.alt = '';
    img.src = src;
    ph.appendChild(img);
    const del = el('button');
    del.type = 'button';
    del.setAttribute('aria-label', 'Убрать фото');
    del.appendChild(icon('x'));
    del.addEventListener('click', () => {
      haptic();
      comp.photos.splice(i, 1);
      guessMode();
      renderComposer();
    });
    ph.appendChild(del);
    box.appendChild(ph);
  });
  for (let i = 0; i < comp.busyPhotos; i++) {
    const ph = el('div', 'cphoto is-loading');
    ph.appendChild(el('div', 'spinner'));
    box.appendChild(ph);
  }
  box.hidden = !comp.photos.length && !comp.busyPhotos;

  const plan = composerPlan();
  const plain = !comp.edit && !plan.answer && !plan.wait; // обычный новый заказ: режимы, скрепка, опции
  // подвижная выбрана — видно сразу: подпись на кнопке (она встаёт отдельной строкой) и заметная строка под полем
  const flexi = plain && comp.mode === 'flexi';
  $('composer-row').classList.toggle('is-wrap', flexi);
  const input = $('composer-input');
  input.placeholder = comp.edit
    ? 'Что изменить в «' + (comp.edit.title || 'работе') + '»?'
    : plan.answer ? 'Или напиши свой вариант…' : plain && plan.litho ? 'Название — необязательно' : COMPOSER_PLACEHOLDER;

  // режим: на пустом экране — плитка в приветствии, в ленте — кнопка «Лазер ▾», раскрывающая ту же плитку над полем
  const feedEmpty = document.body.classList.contains('feed-empty');
  if (!plain || feedEmpty) comp.modesOpen = false;
  $('composer-modes').hidden = !comp.modesOpen;
  $('composer-mode').hidden = !plain;
  $('composer-mode').setAttribute('aria-expanded', comp.modesOpen ? 'true' : 'false');
  $('composer-mode-name').textContent = MODES[comp.mode].short;
  $('composer-mode-icon').querySelector('use').setAttribute('href', '#i-' + MODES[comp.mode].icon);
  $('composer-clip').hidden = !plain;
  document.querySelectorAll('.mode-tile[data-mode]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === comp.mode);
    b.setAttribute('aria-pressed', b.dataset.mode === comp.mode ? 'true' : 'false');
  });

  // Маленький выбор под полем: формат детали или как перевести фото для лазера.
  const opts = $('composer-opts');
  opts.textContent = '';
  let choices = null;
  if (plain && comp.mode === 'cad') {
    choices = { label: 'Формат:', key: 'format', items: [['stl', 'Печать'], ['dxf', 'Лазер'], ['', 'Сам реши']] };
  } else if (plain && comp.mode === 'laser' && comp.photos.length) {
    choices = { label: 'Фото:', key: 'photoMode', items: [['redraw', 'Перерисовать'], ['trace', 'Обвести как есть']] };
  }
  if (choices) {
    opts.appendChild(el('span', 'composer-opts-label', choices.label));
    choices.items.forEach(([v, text]) => {
      const b = el('button', 'opt-pill' + (comp[choices.key] === v ? ' is-active' : ''), text);
      b.type = 'button';
      b.dataset.v = v;
      b.addEventListener('click', () => {
        haptic();
        comp[choices.key] = v;
        renderComposer();
      });
      opts.appendChild(b);
    });
  }
  opts.hidden = !choices;

  $('composer-hint').textContent = plan.hint;
  $('composer-hint').hidden = !plan.hint;
  $('composer-flexi').hidden = !flexi; // вместо мелкой подсказки под чипсами
  $('composer-about').textContent = comp.edit ? 'изменение описанием'
    : plan.answer ? 'ответ на вопросы выше' : plan.wait ? 'думаю над запросом' : flexi ? '' : MODES[comp.mode].about;
  $('composer-price').textContent = plan.kind ? shortPrice(plan.kind) : '';
  const send = $('composer-send');
  send.disabled = !plan.ok || comp.sending;
  send.classList.toggle('is-busy', comp.sending || !!plan.wait);
  send.classList.toggle('is-labeled', flexi);
  send.setAttribute('aria-label', flexi ? 'Создать подвижную' : 'Отправить');
  composerAutosize();
}

// Плитки режимов: в приветствии пустого проекта и в выборе над полем композера.
function buildModeTiles(box) {
  box.textContent = '';
  Object.keys(MODES).forEach((m) => {
    const b = el('button', 'mode-tile');
    b.type = 'button';
    b.dataset.mode = m;
    b.appendChild(icon(MODES[m].icon));
    const t = el('span');
    t.appendChild(el('span', 'mode-tile-name', MODES[m].tile));
    t.appendChild(el('span', 'mode-tile-sub', MODES[m].sub));
    b.appendChild(t);
    b.addEventListener('click', () => {
      haptic();
      comp.mode = m;
      comp.manual = true;
      comp.modesOpen = false;
      renderComposer();
    });
    box.appendChild(b);
  });
}

function composerAutosize() {
  const ta = $('composer-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, COMPOSER_MAX_H) + 'px';
}

function composerClear() {
  $('composer-input').value = '';
  comp.photos = [];
  comp.edit = null;
  comp.fromDraft = null;
  comp.manual = false;
  guessMode();
  renderComposer();
}

function composerExitEdit() {
  comp.edit = null;
  guessMode();
  renderComposer();
}

// «Из сообщения боту ×» — не надо: убираем подставленное и больше не предлагаем.
function composerDropDraft() {
  const at = comp.fromDraft;
  if (!at) return;
  $('composer-input').value = '';
  comp.photos = [];
  comp.busyPhotos = 0;
  comp.fromDraft = null;
  comp.manual = false;
  guessMode();
  markDraftUsed(at);
}

// Открыть композер в нужном режиме в новом проекте (например, с плашки «первая модель в подарок»).
function composerStart(mode, text) {
  state.order = null;
  state.detail = null;
  state.wait = null;
  if (state.cad) closeCad();
  projOpen(null);
  if (mode && MODES[mode]) {
    comp.mode = mode;
    comp.manual = true;
  }
  comp.edit = null;
  if (text != null) $('composer-input').value = text;
  if (state.tab !== 'create') setTab('create');
  else renderView();
  renderComposer();
  $('composer-input').focus();
}

// «Изменить» в карточке ленты: правка прямо в композере.
function composerEdit(o) {
  haptic();
  comp.edit = o;
  comp.photos = [];
  comp.busyPhotos = 0;
  renderComposer();
  const ta = $('composer-input');
  ta.focus();
}

async function composerAddPhotos(files) {
  let list = Array.from(files || []);
  if (!list.length) return;
  const room = MAX_PHOTOS - comp.photos.length - comp.busyPhotos;
  if (list.length > room) toast('Больше ' + MAX_PHOTOS + ' фото не нужно');
  list = list.slice(0, Math.max(0, room));
  comp.busyPhotos += list.length;
  guessMode();
  renderComposer();
  for (const file of list) {
    try {
      comp.photos.push(await compressPhoto(file));
    } catch (e) {
      hapticNotify('error');
      alertBox(e && e.message === 'too_big' ? 'Фото слишком большое — выбери другое' : 'Не получилось открыть фото — выбери другое');
    }
    comp.busyPhotos = Math.max(0, comp.busyPhotos - 1);
    guessMode();
    renderComposer();
  }
}

async function composerSend() {
  const plan = composerPlan();
  if (!plan.ok || comp.sending || state.creating) return;
  haptic();
  const text = $('composer-input').value.trim().slice(0, PROMPT_MAX);
  if (plan.answer) {
    $('composer-input').value = '';
    renderComposer();
    askAnswerTyped(askCurrent(), text);
    return;
  }
  // «Рельеф»: заказа нет — открываем экран литофании с этим фото. Композер очистится, когда сохранят.
  if (plan.litho) {
    openLitho({ src: comp.photos[0], name: text });
    return;
  }
  const data = { kind: plan.kind };
  let title;
  if (comp.edit) {
    data.prompt = text;
    data.base_order = comp.edit.id;
    title = comp.edit.title || 'Без названия';
  } else if (plan.kind === 'laser_photo' || plan.kind === 'sketch_photo') {
    data.images = comp.photos.slice(0, 1);
    if (text) data.prompt = text;
    if (plan.kind === 'laser_photo') data.photo_mode = comp.photoMode;
    title = text ? shortTitle(text) : plan.kind === 'laser_photo' ? 'Рисунок по фото' : 'Фигурка по фото';
  } else if (plan.kind === 'scan') {
    data.images = comp.photos.slice(0, MAX_PHOTOS);
    title = '3D по фото предмета';
  } else {
    data.prompt = text;
    title = shortTitle(text);
    if (plan.kind === 'sketch') data.flexi = plan.flexi === true;
    if (plan.kind === 'cad') data.format = comp.format;
  }
  data.title = title;

  // Как в переписке: поле очищается сразу — можно писать следующее, пока это отправляется.
  // Не ушло — возвращаем текст и фото, если человек ещё ничего нового не начал.
  const sent = {
    text: $('composer-input').value, photos: comp.photos.slice(), edit: comp.edit,
    fromDraft: comp.fromDraft, mode: comp.mode, manual: comp.manual,
  };
  $('composer-input').value = '';
  comp.photos = [];
  comp.edit = null;
  comp.fromDraft = null;
  if (sent.mode === 'flexi') {
    // подвижная — на один заказ: следующий снова обычный, пока не тапнут чип
    comp.mode = '3d';
    comp.manual = false;
  } else if (!sent.manual) {
    guessMode();
  }

  // Новый заказ по короткому тексту — сначала уточняющие вопросы (ask.js).
  if (askNeeded(data)) {
    askStart(data, title, sent);
    return;
  }
  comp.sending = true;
  renderComposer();
  const ok = await startJob(data, title, 'inline');
  comp.sending = false;
  composerSent(ok, sent);
}

// Заказ из композера ушёл или нет. Не ушёл — возвращаем текст и фото, если человек ещё ничего нового не начал.
function composerSent(ok, sent) {
  if (ok) {
    if (sent.fromDraft) markDraftUsed(sent.fromDraft);
    if (!sent.edit) saveLastMode(sent.mode);
    feedToBottom(true);
  } else if (!$('composer-input').value.trim() && !comp.photos.length && !comp.busyPhotos && !comp.edit) {
    $('composer-input').value = sent.text;
    Object.assign(comp, { photos: sent.photos, edit: sent.edit, fromDraft: sent.fromDraft, mode: sent.mode, manual: sent.manual });
  }
  renderComposer();
}

// Клавиатура не должна закрывать композер: поднимаем его на высоту клавиатуры.
function syncViewport() {
  const kb = Math.max(0, Math.round(window.innerHeight - tg.visibleHeight()));
  document.documentElement.style.setProperty('--kb', kb + 'px');
  const open = kb > 80 && document.activeElement === $('composer-input') && !$('composer').hidden;
  document.body.classList.toggle('kb-open', open);
}

/* ---------- Лента: последние работы и заказы, как переписка ---------- */

function bubble(text, thumbs, count) {
  const msg = el('div', 'msg msg-me');
  const b = el('div', 'bubble');
  const n = Math.max(count || 0, (thumbs || []).length);
  if (n) {
    const row = el('div', 'bubble-photos');
    for (let i = 0; i < Math.min(n, 6); i++) {
      if (thumbs && thumbs[i]) {
        const img = new Image();
        img.alt = '';
        img.src = thumbs[i];
        row.appendChild(img);
      } else {
        const ph = el('span');
        ph.appendChild(icon('photo'));
        row.appendChild(ph);
      }
    }
    b.appendChild(row);
  }
  if (text) b.appendChild(el('div', 'bubble-text', text));
  msg.appendChild(b);
  return msg;
}

function pill(iconName, text, onClick, cls) {
  const b = el('button', 'pill' + (cls ? ' ' + cls : ''));
  b.type = 'button';
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(el('span', '', text));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// Кнопки следующего шага у готовой работы.
function resultActions(o) {
  const k = kindOf(o);
  const out = [];
  if (k === 'sketch') {
    out.push(pill('cube', withPrice('Сделать 3D-модель', 'model'), () => feedMakeModel(o)));
    if (canBase(o)) out.push(baseToggle());
    if (canVariant(o)) {
      const busy = projectBusy(orderProject(o));
      const b = pill('refresh', withPrice('Ещё вариант', 'sketch'), () => sketchVariant(o).then((ok) => { if (ok) feedToBottom(true); }), busy ? 'is-disabled' : '');
      if (busy) b.setAttribute('aria-disabled', 'true');
      out.push(b);
    }
    out.push(pill('pencil', 'Изменить', () => composerEdit(o)));
    if (o.editable !== false) out.push(pill('brush', 'Редактор', () => openOrderInEditor(o)));
  } else if (k === 'model') {
    // сделана подвижной — главный следующий шаг: шарниры поставит приложение
    if (flexiMain(o)) out.push(pill('joint', 'Сделать подвижной', () => openFlexi(o.id), 'is-main'));
    if (canColor(o)) out.push(pill('palette', 'Сделать цветной · ' + colorPrice(), () => openColorSheet(o, 'inline')));
    if (isStl(o) && hasFile(o)) {
      out.push(pill('rotate', 'Посмотреть в 3D', () => {
        openDetail(o);
        openViewer();
      }));
    }
    if (hasFile(o) && o.jointed !== true && isNewestModel(o)) {
      out.push(pill('file', 'Другой формат', () => {
        haptic();
        startJob(withBase({ kind: 'model_format', format: fileFormat(o) === 'STL' ? '3mf' : 'stl', title: o.title || '' }, o), o.title || '3D-модель', 'inline')
          .then((ok) => { if (ok) feedToBottom(true); });
      }));
    }
  } else if (k === 'laser') {
    if (hasFile(o) && o.cad !== true) {
      out.push(pill('ruler', 'Другой размер', () => {
        openDetail(o);
        $('detail-sizes').hidden = false;
      }));
    }
    out.push(pill('pencil', 'Изменить', () => composerEdit(o)));
  } else {
    out.push(pill('ruler', 'Открыть конструктор', () => openCad(o.id)));
    out.push(pill('pencil', 'Изменить', () => composerEdit(o)));
  }
  return out;
}

/* ---------- «Ещё вариант» эскиза ---------- */
// Нейросеть даёт один эскиз; variant: 2 — тот же запрос, но другая поза, ракурс и пропорции (сам предмет тот же).

// В проекте что-то ещё рисуется — второй эскиз одновременно не отправляем.
function projectBusy(pid) {
  return jobs.list.some((j) => j.status === 'running' && (j.project || OLD_PROJECT) === pid);
}

// Только у эскизов по тексту: у правки (3d_edit) в prompt — текст правки, у эскиза по фото (3d_photo) фото не уйдёт;
// у старых работ запроса нет — вариант делать не из чего.
function canVariant(o) {
  return kindOf(o) === 'sketch' && ['3d', '3d_flexi'].includes(o.mode) && !!String(o.prompt || '').trim();
}

function isVariant(o) {
  const saved = savedPrompt(o.id);
  return !!(o.variant || (saved && saved.variant));
}

function sketchVariant(o) {
  if (projectBusy(orderProject(o))) {
    toast('Подожди, пока доделается прошлый');
    return Promise.resolve(false);
  }
  haptic();
  const data = { kind: 'sketch', prompt: o.prompt || o.title, title: o.title || '', variant: 2 };
  if (isFlexiMode(o)) data.flexi = true;
  if (o.project) data.project = String(o.project);
  // в проект этой работы, а не в тот, что открыт на «Создать»
  return startJob(data, o.title || 'Эскиз', 'inline', { project: orderProject(o) });
}

function feedMakeModel(o) {
  haptic();
  const data = withBase({ kind: 'model', base_order: o.id, format: 'stl', title: o.title || '' }, o);
  if (isFlexiMode(o)) data.flexi = true;
  startJob(data, o.title || '3D-модель', 'inline').then((ok) => { if (ok) feedToBottom(true); });
}

function resultCard(o) {
  const msg = el('div', 'msg msg-bot');
  const card = el('div', 'result');
  const main = el('button', 'result-main');
  main.type = 'button';
  const thumb = el('div', 'thumb result-thumb');
  fillPreview(thumb, o);
  main.appendChild(thumb);
  const info = el('div', 'result-info');
  info.appendChild(el('div', 'result-title', o.title || 'Без названия'));
  const meta = [kindName(o)];
  if (kindOf(o) === 'model' || kindOf(o) === 'laser') meta.push(formatLabel(o));
  if (isSketch(o) && isFlexiMode(o)) meta.push('на шарнирах');
  info.appendChild(el('div', 'result-meta', meta.filter(Boolean).join(' · ')));
  main.appendChild(info);
  main.addEventListener('click', () => {
    haptic();
    openDetail(o);
  });
  card.appendChild(main);
  const actions = el('div', 'result-actions');
  resultActions(o).forEach((b) => actions.appendChild(b));
  card.appendChild(actions);
  const check = printCheck(o, 'inline');
  if (check) card.appendChild(check);
  if (flexiMain(o)) card.appendChild(el('p', 'result-hint', 'Шарниры поставлю сам, около минуты'));
  else if (isSketch(o) && canBase(o)) card.appendChild(el('p', 'result-hint', BASE_HINT));
  if (canVariant(o) && projectBusy(orderProject(o))) card.appendChild(el('p', 'result-hint', 'Подожди, пока доделается прошлый'));
  msg.appendChild(card);
  return msg;
}

const JOB_ICONS = { sketch: 'pencil', laser: 'laser', model: 'cube', cad: 'ruler', color: 'palette' };

function jobCard(j) {
  const msg = el('div', 'msg msg-bot');
  const running = j.status === 'running';
  const card = el('div', 'result job ' + (running ? 'is-running' : 'is-' + j.status));
  card.dataset.job = j.id;
  const main = el('button', 'result-main');
  main.type = 'button';
  const thumb = el('div', 'thumb result-thumb');
  const kindIcon = running ? JOB_ICONS[(JOB_KINDS[j.kind] || {}).group] || 'sparkle'
    : j.status === 'no_credits' ? 'wallet' : j.status === 'reply' ? 'message' : 'alert';
  thumb.appendChild(icon(kindIcon));
  main.appendChild(thumb);
  const info = el('div', 'result-info');
  info.appendChild(el('div', 'result-title', j.title || 'Без названия'));
  const stage = el('div', 'job-stage', running ? jobStage(j) : (j.text || jobDefaultText(j)));
  info.appendChild(stage);
  if (running) info.appendChild(el('div', 'job-line'));
  main.appendChild(info);
  main.addEventListener('click', () => {
    haptic();
    openWait(j.id);
  });
  card.appendChild(main);

  const actions = el('div', 'result-actions');
  if (j.status === 'error') actions.appendChild(pill('refresh', 'Попробовать ещё раз', () => feedRetry(j)));
  if (j.status === 'no_credits') {
    actions.appendChild(pill('wallet', 'Пополнить баланс', () => {
      haptic();
      jobRemove(j);
      goToBalance();
    }));
  }
  if (j.status === 'reply') actions.appendChild(pill('pencil', 'Ответить', () => composerFromJob(j)));
  if (!running) {
    actions.appendChild(pill(null, 'Убрать', () => {
      haptic();
      jobRemove(j);
    }, 'is-ghost'));
  }
  card.appendChild(actions);
  msg.appendChild(card);
  return msg;
}

function jobDefaultText(j) {
  if (j.status === 'no_credits') return 'Недостаточно кредитов. Пополни баланс и попробуй ещё раз.';
  if (j.status === 'reply') return 'Не получилось понять запрос. Попробуй описать по-другому.';
  return 'Что-то пошло не так. Кредиты не списались — попробуй ещё раз.';
}

// Ошибка в ленте: то же самое ещё раз. Фото после перезапуска не сохраняются — тогда в композер.
function feedRetry(j) {
  haptic();
  const images = j.data.images || [];
  if (j.photos > images.length) {
    composerFromJob(j);
    toast('Загрузи фото ещё раз');
    return;
  }
  const data = j.data;
  const title = j.title;
  jobRemove(j);
  startJob(data, title, 'inline').then((ok) => { if (ok) feedToBottom(true); });
}

// «Ответить» на вопрос бота — тот же запрос в композер, можно дописать.
function composerFromJob(j) {
  haptic();
  const d = j.data || {};
  jobRemove(j);
  const p = j.project || OLD_PROJECT;
  if (p !== proj.current) projOpen(p); // поправить запрос — в его же проекте
  comp.edit = null;
  comp.fromDraft = null;
  comp.photos = (d.images || []).slice();
  comp.busyPhotos = 0;
  comp.manual = true;
  const k = d.kind;
  if (k === 'laser_edit' || k === 'sketch_edit' || k === 'cad_edit') {
    comp.edit = findOrder(d.base_order);
    comp.manual = false;
  } else if (k === 'laser_new' || k === 'laser_photo') comp.mode = 'laser';
  else if (k === 'sketch') comp.mode = d.flexi ? 'flexi' : '3d';
  else if (k === 'sketch_photo') comp.mode = '3d';
  else if (k === 'cad') comp.mode = 'cad';
  else if (k === 'scan') comp.mode = 'scan';
  if (d.format != null && k === 'cad') comp.format = d.format;
  if (d.photo_mode) comp.photoMode = d.photo_mode;
  $('composer-input').value = d.prompt || '';
  renderComposer();
  $('composer-input').focus();
}

function examplesBlock() {
  const wrap = el('div', 'examples');
  wrap.appendChild(el('p', 'examples-title', 'Попробуй, например'));
  EXAMPLES.forEach((x) => {
    const b = el('button', 'example');
    b.type = 'button';
    const t = el('span', '', x.text);
    t.appendChild(el('small', '', x.note));
    b.appendChild(t);
    b.appendChild(icon('arrow-ur'));
    b.addEventListener('click', () => {
      haptic();
      comp.mode = x.mode;
      comp.manual = true;
      comp.edit = null;
      $('composer-input').value = x.text;
      renderComposer();
      $('composer-input').focus();
    });
    wrap.appendChild(b);
  });
  return wrap;
}

let feedKey = '';

// Лента открытого проекта: облачко запроса справа → карточка результата слева.
function renderFeed() {
  const box = $('feed');
  if (!box) return;
  const p = proj.current !== null ? projectGet(proj.current) : null;
  const orders = p ? p.orders.slice(0, PROJECT_FEED_MAX).reverse() : []; // старые сверху, как в переписке
  const list = p ? p.jobs.slice().reverse() : [];
  const a = askCurrent();
  const empty = !orders.length && !list.length && !a;
  const key = JSON.stringify([viewKey(), state.me ? 1 : 0, a ? a.id : 0, orders, list.map((j) => [j.id, j.status, j.text, (j.thumbs || []).length]), jobPrice('model')]);
  if (key !== feedKey) {
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    feedKey = key;
    box.textContent = '';
    // пришёл второй вариант: два последних эскиза подряд — подсказка, что делать дальше
    const n = orders.length;
    const pickAt = n >= 2 && isSketch(orders[n - 1]) && isSketch(orders[n - 2]) && isVariant(orders[n - 1]) ? n - 2 : -1;
    orders.forEach((o, i) => {
      if (i === pickAt) box.appendChild(el('p', 'feed-pick', 'Выбери, какой нравится больше → «Сделать 3D-модель» под ним'));
      const req = savedPrompt(o.id);
      const ask = req && req.ask;
      const text = isVariant(o) ? 'Ещё вариант' : ask ? ask.text : (req && req.prompt) || o.prompt || o.title || '';
      box.appendChild(bubble(text, req && req.thumbs, req && req.photos));
      if (ask && ask.answers) box.appendChild(askDoneLine(ask.answers));
      box.appendChild(resultCard(o));
    });
    list.forEach((j) => {
      const text = j.data.variant ? 'Ещё вариант' : j.ask ? j.ask.text : j.data.prompt || (j.photos ? '' : j.title);
      box.appendChild(bubble(text, j.thumbs || (j.data.images || []).slice(0, 6), j.photos));
      if (j.ask && j.ask.answers) box.appendChild(askDoneLine(j.ask.answers));
      box.appendChild(jobCard(j));
    });
    if (state.me && empty) box.appendChild(examplesBlock());
    if (nearBottom && state.createOpen) feedToBottom(false);
  }
  $('hello').hidden = !empty; // приветствие — только у пустого проекта
  document.body.classList.toggle('feed-empty', empty); // пустой проект: режимы — плиткой в приветствии
  renderAsk();
  renderTopbar();
  if (proj.drawer) renderDrawer();
  jobsSyncTicker();
}

// Этапы в карточках ожидания — по тому же таймеру, что и на экране ожидания.
function feedTick() {
  document.querySelectorAll('#feed .job.is-running').forEach((card) => {
    const j = jobFind(card.dataset.job);
    if (j && j.status === 'running') card.querySelector('.job-stage').textContent = jobStage(j);
  });
}

function feedToBottom(smooth) {
  requestAnimationFrame(() => {
    // пустой проект — приветствие и режимы сверху, листать вниз нечего
    const top = document.body.classList.contains('feed-empty') ? 0 : document.documentElement.scrollHeight;
    window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  });
}

/* ---------- Экран заказа ---------- */

function newOrderState(form, base) {
  return {
    form,
    base: base || null,
    mode: 'text',
    prompt: '',
    extra: '',
    photos: [],
    photoMode: 'redraw',
    flexi: false,
    format: '',
    busyPhotos: 0,
    returnCad: null,
    fromDraft: null, // at черновика из чата, если форма заполнена из него
  };
}

// form: laser | 3d | cad | scan | edit (тогда opts.base — работа, которую правим).
function openOrder(form, opts) {
  opts = opts || {};
  haptic();
  const base = opts.base || null;
  if (!state.order && !state.detail && !state.wait) state.listScroll = window.scrollY;
  let s = form !== 'edit' && orderDrafts[form];
  if (!s || (base && (!s.base || s.base.id !== base.id))) s = newOrderState(form, base);
  if (form === 'edit') {
    const saved = orderDrafts['edit:' + base.id];
    if (saved) s = saved;
  }
  s.returnCad = opts.returnCad || null;
  state.order = s;
  renderOrder();
  renderView();
  window.scrollTo(0, 0);
}

function draftKey(s) {
  return s.form === 'edit' ? 'edit:' + (s.base && s.base.id) : s.form;
}

function closeOrder() {
  const s = state.order;
  if (!s) return;
  saveOrderFields();
  orderDrafts[draftKey(s)] = s;
  state.order = null;
  if (s.returnCad) {
    openCad(s.returnCad);
    return;
  }
  renderView();
  window.scrollTo(0, state.detail ? 0 : state.listScroll || 0);
}

function saveOrderFields() {
  const s = state.order;
  if (!s) return;
  s.prompt = $('order-prompt').value;
  s.extra = $('order-extra').value;
  s.flexi = $('order-flexi').checked;
}

function renderOrder() {
  const s = state.order;
  if (!s) return;
  const f = FORMS[s.form];
  const photoForm = s.form === 'scan' || (f.modes && s.mode === 'photo');
  const textForm = !!f.label && !(f.modes && s.mode === 'photo');

  $('order-title').textContent = f.title;
  $('order-lead').textContent = f.lead || '';
  $('order-lead').hidden = !f.lead;

  $('order-base').hidden = !s.base;
  if (s.base) {
    fillPreview($('order-base-thumb'), s.base);
    $('order-base-name').textContent = s.base.title || 'Без названия';
  }

  $('order-modes').hidden = !f.modes;
  document.querySelectorAll('#order-modes button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === s.mode);
  });

  $('order-text').hidden = !textForm;
  $('order-label').textContent = f.label || '';
  $('order-prompt').placeholder = s.form === 'edit' ? EDIT_PLACEHOLDERS[editKind(s.base)] : f.placeholder || '';
  $('order-prompt').value = s.prompt;
  const chips = $('order-chips');
  chips.textContent = '';
  (f.chips || []).forEach((text) => {
    const c = el('button', 'chip', text);
    c.type = 'button';
    c.addEventListener('click', () => {
      haptic();
      const ta = $('order-prompt');
      ta.value = text;
      state.order.prompt = text;
      ta.focus();
    });
    chips.appendChild(c);
  });
  chips.hidden = !f.chips;

  $('order-photos-block').hidden = !photoForm;
  $('order-photo-mode').hidden = !(photoForm && f.photoMode);
  document.querySelectorAll('#order-photo-mode .opt').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.v === s.photoMode);
  });
  $('order-extra-block').hidden = !(photoForm && f.extra);
  $('order-extra').value = s.extra;

  $('order-flexi-row').hidden = !(f.flexi && textForm);
  $('order-flexi').checked = s.flexi;

  $('order-format').hidden = !f.format;
  document.querySelectorAll('#order-format .opt').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.v === s.format);
  });

  $('order-note').textContent = s.form === 'edit'
    ? (editKind(s.base) === 'sketch_edit' ? 'Будет новый эскиз с изменениями — старый останется' : 'Будет новая версия — старая останется в «Моих работах»')
    : f.note || '';

  renderPhotos();
}

function renderPhotos() {
  const s = state.order;
  if (!s) return;
  const max = FORMS[s.form].photos || 1;
  const box = $('order-photos');
  box.textContent = '';
  box.classList.toggle('is-single', max === 1);
  $('photo-input').multiple = max > 1; // для скана — сразу несколько фото из галереи
  s.photos.forEach((src, i) => {
    const ph = el('div', 'photo');
    const img = new Image();
    img.alt = '';
    img.src = src;
    ph.appendChild(img);
    const del = el('button', 'photo-del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Убрать фото');
    del.addEventListener('click', () => {
      haptic();
      s.photos.splice(i, 1);
      renderPhotos();
    });
    ph.appendChild(del);
    box.appendChild(ph);
  });
  for (let i = 0; i < s.busyPhotos; i++) {
    const ph = el('div', 'photo is-loading');
    ph.appendChild(el('div', 'spinner'));
    box.appendChild(ph);
  }
  box.hidden = !s.photos.length && !s.busyPhotos;

  const full = s.photos.length + s.busyPhotos >= max;
  const single = max === 1;
  setLabel($('photo-pick'), single && s.photos.length ? 'Другое фото' : single ? 'Выбрать фото' : 'Добавить фото');
  setLabel($('photo-shot'), single && s.photos.length ? 'Переснять' : 'Снять');
  $('photo-btns').hidden = !single && full;

  const min = FORMS[s.form].minPhotos || 0;
  const n = s.photos.length;
  $('photo-count').textContent = single ? '' : 'Фото: ' + n + ' из ' + max;
  $('photo-count').hidden = single;
  // скан: фото уже есть, но мало (например, 2 из чата)
  const more = !single && !s.busyPhotos && n > 0 && n < min;
  $('photo-more').textContent = more ? 'Добавь ещё фото — нужно хотя бы ' + min : '';
  $('photo-more').hidden = !more;
}

function orderMainText() {
  const s = state.order;
  const f = FORMS[s.form];
  return withPrice(f.button, f.kind(s));
}

async function addPhotos(files) {
  const s = state.order;
  if (!s || !files || !files.length) return;
  const max = FORMS[s.form].photos || 1;
  let list = Array.from(files);
  if (max === 1) {
    list = list.slice(0, 1);
    s.photos = [];
  } else {
    const room = max - s.photos.length - s.busyPhotos;
    if (list.length > room) toast('Больше ' + max + ' фото не нужно');
    list = list.slice(0, Math.max(0, room));
  }
  s.busyPhotos += list.length;
  renderPhotos();
  for (const file of list) {
    try {
      const url = await compressPhoto(file);
      s.photos.push(url);
    } catch (e) {
      hapticNotify('error');
      alertBox(e && e.message === 'too_big' ? 'Фото слишком большое — выбери другое' : 'Не получилось открыть фото — выбери другое');
    }
    s.busyPhotos--;
    if (state.order === s) renderPhotos();
  }
}

// Поворачиваем по EXIF, длинная сторона до 1600 px, JPEG 0.85.
async function compressPhoto(file) {
  let src = null;
  let w = 0;
  let h = 0;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch (e) {
    src = await loadImageFile(file); // старые браузеры: <img> сам поворачивает по EXIF
    w = src.naturalWidth;
    h = src.naturalHeight;
  }
  if (!w || !h) throw new Error('decode');
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; // прозрачный PNG — на белом
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const url = c.toDataURL('image/jpeg', 0.85);
  if ((url.length - url.indexOf(',') - 1) * 0.75 > PHOTO_MAX_BYTES) throw new Error('too_big');
  return url;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function orderFail(text, focusId) {
  hapticNotify('error');
  toast(text);
  if (focusId) $(focusId).focus();
}

function submitOrder() {
  const s = state.order;
  if (!s || state.creating) return;
  haptic();
  saveOrderFields();
  if (s.busyPhotos) {
    toast('Подожди, фото ещё обрабатывается');
    return;
  }
  const f = FORMS[s.form];
  const kind = f.kind(s);
  const prompt = s.prompt.trim().slice(0, PROMPT_MAX);
  const data = { kind };
  let title = '';

  if (kind === 'laser_photo' || kind === 'sketch_photo') {
    if (!s.photos.length) return orderFail('Добавь фото');
    data.images = s.photos.slice(0, 1);
    if (kind === 'laser_photo') {
      data.photo_mode = s.photoMode;
      title = 'Рисунок по фото';
    } else {
      const extra = s.extra.trim().slice(0, PROMPT_MAX);
      if (extra) data.prompt = extra;
      title = extra ? shortTitle(extra) : 'Фигурка по фото';
    }
  } else if (kind === 'scan') {
    if (s.photos.length < (f.minPhotos || 1)) return orderFail('Нужно хотя бы ' + f.minPhotos + ' фото');
    data.images = s.photos.slice(0, f.photos);
    title = '3D по фото предмета';
  } else {
    if (!prompt) return orderFail('Опиши, что сделать', 'order-prompt');
    data.prompt = prompt;
    title = s.base ? s.base.title || 'Без названия' : shortTitle(prompt);
    if (kind === 'sketch') data.flexi = s.flexi;
    if (kind === 'cad') data.format = s.format;
    if (s.base) data.base_order = s.base.id;
  }
  data.title = title;
  startJob(data, title, true);
}

/* ---------- Кнопки ---------- */

function bindCreate() {
  bindComposer();

  document.querySelectorAll('#order-modes button').forEach((b) => {
    b.addEventListener('click', () => {
      const s = state.order;
      if (!s || s.mode === b.dataset.mode) return;
      haptic();
      saveOrderFields();
      s.mode = b.dataset.mode;
      renderOrder();
      syncButtons();
    });
  });
  document.querySelectorAll('#order-photo-mode .opt').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.order) return;
      haptic();
      state.order.photoMode = b.dataset.v;
      renderOrder();
    });
  });
  document.querySelectorAll('#order-format .opt').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.order) return;
      haptic();
      saveOrderFields();
      state.order.format = b.dataset.v;
      renderOrder();
    });
  });
  $('order-flexi').addEventListener('change', () => {
    haptic();
    if (state.order) state.order.flexi = $('order-flexi').checked;
  });
  $('order-prompt').addEventListener('input', () => {
    if (state.order) state.order.prompt = $('order-prompt').value;
  });
  $('order-extra').addEventListener('input', () => {
    if (state.order) state.order.extra = $('order-extra').value;
  });

  $('photo-pick').addEventListener('click', () => {
    haptic();
    $('photo-input').click();
  });
  $('photo-shot').addEventListener('click', () => {
    haptic();
    $('photo-camera').click();
  });
  ['photo-input', 'photo-camera'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = ''; // чтобы то же фото можно было выбрать снова
      addPhotos(files);
    });
  });
}

function bindComposer() {
  const input = $('composer-input');
  input.addEventListener('input', () => {
    // «обычный дракон» при выбранной подвижной — переключаем сами
    if (comp.mode === 'flexi' && !comp.edit && wantsStatic(input.value)) {
      comp.mode = '3d';
      comp.manual = true;
      toast('Переключил на обычную 3D-фигурку');
    }
    renderComposer();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      composerSend();
    }
  });
  input.addEventListener('focus', () => setTimeout(syncViewport, 50));
  input.addEventListener('blur', () => setTimeout(syncViewport, 50));
  buildModeTiles($('hello-modes'));
  buildModeTiles($('composer-modes'));
  $('composer-mode').addEventListener('click', () => {
    haptic();
    comp.modesOpen = !comp.modesOpen;
    renderComposer();
  });
  $('composer-flexi-off').addEventListener('click', () => {
    haptic();
    comp.mode = '3d';
    comp.manual = true;
    renderComposer();
    input.focus();
  });
  $('composer-clip').addEventListener('click', () => {
    haptic();
    $('composer-file').click();
  });
  $('composer-file').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    composerAddPhotos(files);
  });
  $('composer-send').addEventListener('click', composerSend);

  tg.onViewport(syncViewport);
  // высота композера — отступ ленты снизу, чтобы последняя карточка не пряталась
  const setH = () => document.documentElement.style.setProperty('--composer-h', $('composer').offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(setH).observe($('composer'));
  else window.addEventListener('resize', setH);
}
