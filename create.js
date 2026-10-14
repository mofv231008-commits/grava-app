/* Грава — вкладка «✨ Создать»: плитки, «Продолжить» и экраны заказа (лазер, 3D, деталь, скан, правка словами).
   Использует помощники из app.js и jobs.js. */
'use strict';

const PHOTO_MAX_SIDE = 1600;
const PHOTO_MAX_BYTES = 7 * 1024 * 1024;
const PROMPT_MAX = 1500;

const FORMS = {
  laser: {
    title: '🔥 Чертёж для лазера',
    modes: true,
    label: 'Что вырезать или выжечь?',
    placeholder: 'например: олень в лесу, тонкие линии',
    chips: ['Волк воет на луну', 'Ключница-домик', 'Узор для разделочной доски', 'Имя в рамке'],
    photoMode: true,
    button: 'Нарисовать',
    kind: (s) => (s.mode === 'photo' ? 'laser_photo' : 'laser_new'),
  },
  '3d': {
    title: '🧊 3D-фигурка',
    modes: true,
    label: 'Что слепить?',
    placeholder: 'например: дракон сидит, крылья сложены',
    flexi: true,
    extra: true,
    button: 'Нарисовать',
    note: 'Сначала нарисую эскиз — посмотришь и решишь, лепить ли из него 3D-модель',
    kind: (s) => (s.mode === 'photo' ? 'sketch_photo' : 'sketch'),
  },
  cad: {
    title: '📐 Деталь по размерам',
    label: 'Опиши деталь с размерами в мм',
    placeholder: 'например: пластина 50×30×3, два отверстия 5 мм по краям',
    chips: ['Пластина 50×30×3, два отверстия 5 мм по краям'],
    format: true,
    button: 'Начертить',
    note: 'Потом размеры можно поменять в конструкторе — бесплатно',
    kind: () => 'cad',
  },
  scan: {
    title: '📷 Скан по фото',
    lead: 'Сними предмет со всех сторон: спереди, сбоку, сзади, с другого бока. Однотонный фон, хороший свет, предмет целиком в кадре, без рук',
    photos: 6,
    minPhotos: 3,
    button: 'Слепить модель',
    note: 'Получится похожая модель, но не точная копия по размерам',
    kind: () => 'scan',
  },
  edit: {
    title: '✏️ Поправить словами',
    label: 'Что поменять?',
    button: 'Поправить',
    kind: (s) => editKind(s.base),
  },
};

const EDIT_PLACEHOLDERS = {
  sketch_edit: 'например: хвост длиннее, лапы толще',
  laser_edit: 'например: убери надпись, линии потолще',
  cad_edit: 'например: добавь паз 10×3 посередине',
};

const orderDrafts = {}; // недописанные формы — вернулся назад и снова зашёл, текст на месте

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

/* ---------- Вкладка «Создать» ---------- */

function tilePrices() {
  const me = state.me || {};
  const p = me.prices || {};
  const free = Number(me.free_left) || 0;
  const modelsLeft = Number(me.models_left) || 0;

  const laser = [];
  if (p.image != null) laser.push(credits(p.image));
  if (free > 0) laser.push('сегодня бесплатно ещё ' + free);

  let fig = '';
  if (me.free_3d === true) fig = '🎁 первая модель в подарок';
  else if (p.image != null && (p.model != null || modelsLeft > 0)) {
    fig = 'эскиз ' + credits(p.image) + ', модель ' + (modelsLeft > 0 ? 'из оплаченных' : credits(p.model));
  }

  let cad = '';
  if (me.free_cad === true) cad = '🎁 первая в подарок';
  else if (p.cad != null) cad = credits(p.cad);

  const scanPrice = jobPrice('scan');
  return {
    laser: laser.join(' · '),
    '3d': fig,
    cad,
    scan: 'как 3D-модель' + (scanPrice ? ' · ' + scanPrice.replace('🎁 бесплатно', '🎁 в подарок') : ''),
  };
}

function renderCreate() {
  const prices = tilePrices();
  document.querySelectorAll('.tile').forEach((t) => {
    t.querySelector('.tile-price').textContent = state.me ? prices[t.dataset.form] || '' : '';
  });

  const orders = ((state.me && state.me.orders) || []).slice(0, 3);
  const key = JSON.stringify(orders);
  if (key !== renderCreate.key) {
    renderCreate.key = key;
    const row = $('continue-row');
    row.textContent = '';
    orders.forEach((o) => {
      const card = el('button', 'mini');
      card.type = 'button';
      const thumb = el('div', 'thumb');
      fillPreview(thumb, o);
      card.appendChild(thumb);
      card.appendChild(el('span', 'mini-title', o.title || 'Без названия'));
      card.addEventListener('click', () => {
        haptic();
        openDetail(o);
      });
      row.appendChild(card);
    });
    $('continue').hidden = orders.length === 0;
  }
  renderJobsBar();
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

function dropOrderDraft(form) {
  if (state.order && state.order.form === form) delete orderDrafts[draftKey(state.order)];
  else delete orderDrafts[form];
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

// «Изменить запрос» после вопроса бота или ошибки — та же форма с теми же данными.
function openOrderFromJob(form, j) {
  const d = j.data || {};
  const base = form === 'edit' ? findOrder(d.base_order) : null;
  const s = newOrderState(form, base);
  if (d.kind === 'laser_photo' || d.kind === 'sketch_photo') s.mode = 'photo';
  if (d.kind === 'sketch_photo') s.extra = d.prompt || '';
  else s.prompt = d.prompt || '';
  if (d.photo_mode) s.photoMode = d.photo_mode;
  s.flexi = d.flexi === true;
  if (d.format != null) s.format = d.format;
  s.photos = (d.images || []).slice();
  orderDrafts[draftKey(s)] = s;
  openOrder(form, { base });
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
    ? (editKind(s.base) === 'sketch_edit' ? 'Нарисую новый эскиз с правкой — старый останется' : 'Сделаю новую версию — старая останется в «Моих работах»')
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
  $('photo-pick').textContent = single && s.photos.length ? '🖼 Другое фото' : single ? '🖼 Выбрать фото' : '🖼 Добавить фото';
  $('photo-shot').textContent = single && s.photos.length ? '📷 Переснять' : '📷 Снять';
  $('photo-btns').hidden = !single && full;

  const min = FORMS[s.form].minPhotos || 0;
  let hint = '';
  if (!single) {
    const n = s.photos.length;
    hint = 'Фото: ' + n + ' из ' + max;
    if (n < min) hint += ' · нужно ещё ' + (min - n);
  }
  $('photo-count').textContent = hint;
  $('photo-count').hidden = !hint;
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
    title = 'Скан по фото';
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
  document.querySelectorAll('.tile').forEach((t) => {
    t.addEventListener('click', () => openOrder(t.dataset.form));
  });

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
