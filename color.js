/* Грава — «Сделать цветной»: сервер раскрашивает готовую 3D-модель нейросетью и делит её на цвета
   под катушки ACE Pro / AMS → 3MF, который открывается в Anycubic Slicer Next с разложенными цветами.
   Нижняя шторка: сколько цветов, стиль, пожелания. Дальше — обычное задание (kind 'color', 1–3 минуты),
   отправляется через startJob(…, { endpoint: 'color' }) на отдельный адрес grava-app-color.
   Использует помощники из app.js, jobs.js (startJob, jobPrice) и create.js (feedToBottom). */
'use strict';

const COLOR_WISHES_MAX = 300;
const COLOR_STYLE_HINT = {
  cartoon: 'ровные пятна цвета, печатается чище',
  realistic: 'больше оттенков и переходов, печать дольше',
};

// Можно ли красить — решает сервер: поле color: true у модели. Готовую цветную второй раз не красим.
function canColor(o) {
  return !!o && isModel(o) && o.color === true && o.mode !== 'color' && hasFile(o);
}

function isColor(o) {
  return !!o && o.mode === 'color';
}

// Цена коротко, как на кнопке: «3 кр.» (у админа сервер не спишет — это его решение).
function colorPrice() {
  const p = (state.me && state.me.prices) || {};
  return (p.color != null ? p.color : 3) + ' кр.';
}

// Что человек попросил — для облачка в ленте: «Сделать цветной · 4 цв. · мультяшный · …».
function colorRequestText(colors, style, wishes) {
  return ['Сделать цветной', colors + ' цв.', style === 'realistic' ? 'реалистичный' : 'мультяшный', wishes].filter(Boolean).join(' · ');
}

// «3MF · цветная · 4 цв.» — число цветов из ответа сервера или из того, что заказали.
function colorLabel(o) {
  const saved = savedPrompt(o.id);
  const n = o.colors || (saved && saved.colors);
  return [fileFormat(o), 'цветная', n ? n + ' цв.' : ''].filter(Boolean).join(' · ');
}

/* ---------- Шторка ---------- */

// how — как отправить задание: 'inline' из ленты (экран не меняется), false — с экрана работы (экран ожидания).
function openColorSheet(o, how) {
  if (!canColor(o)) return;
  haptic();
  state.colorSheet = { o, how, colors: 4, more: false, style: 'cartoon' };
  $('color-sub').textContent = (o.title || 'Модель') + ' · 3MF для ACE Pro, 1–3 минуты';
  $('color-wishes').value = '';
  renderColorSheet();
  const sheet = $('color-sheet');
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  syncButtons();
}

function closeColorSheet() {
  if (!state.colorSheet) return;
  state.colorSheet = null;
  const sheet = $('color-sheet');
  sheet.classList.remove('is-open');
  if (document.activeElement === $('color-wishes')) $('color-wishes').blur();
  setTimeout(() => { if (!state.colorSheet) sheet.hidden = true; }, 220);
  syncButtons();
}

function renderColorSheet() {
  const c = state.colorSheet;
  if (!c) return;
  const seg = (id, v) => document.querySelectorAll('#' + id + ' button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.v === String(v));
    b.setAttribute('aria-pressed', b.dataset.v === String(v) ? 'true' : 'false');
  });
  seg('color-count', c.more ? 'more' : c.colors);
  $('color-more').hidden = !c.more;
  seg('color-more', c.colors);
  $('color-count-hint').textContent = c.more ? 'нужен второй ACE или ручная смена' : 'у ACE Pro 4 катушки';
  seg('color-style', c.style);
  $('color-style-hint').textContent = COLOR_STYLE_HINT[c.style];
  setLabel($('color-go'), 'Покрасить · ' + colorPrice());
}

async function colorGo() {
  const c = state.colorSheet;
  if (!c || state.creating) return;
  haptic();
  const o = c.o;
  const wishes = $('color-wishes').value.replace(/\s+/g, ' ').trim().slice(0, COLOR_WISHES_MAX);
  const title = (o.title || 'Модель') + ' (цветная)';
  // prompt — только для облачка в ленте; на сервер уходят id, colors, style, wishes, project (Api.createColor)
  const data = { kind: 'color', id: String(o.id), colors: c.colors, style: c.style, wishes, title, prompt: colorRequestText(c.colors, c.style, wishes) };
  if (o.project) data.project = String(o.project);
  const how = c.how === 'inline' ? 'inline' : 'overlay';
  const btn = $('color-go');
  btn.disabled = true;
  setLabel(btn, 'Отправляю…');
  const ok = await startJob(data, title, how, { endpoint: 'color', project: orderProject(o) });
  btn.disabled = false;
  if (ok) {
    closeColorSheet();
    if (how === 'inline') feedToBottom(true);
  } else {
    renderColorSheet(); // ошибка уже показана; шторка остаётся — можно поправить и отправить ещё раз
  }
}

function bindColor() {
  const withC = (fn) => () => { const c = state.colorSheet; if (c) fn(c); };
  document.querySelectorAll('#color-count button').forEach((b) => b.addEventListener('click', withC((c) => {
    haptic();
    if (b.dataset.v === 'more') {
      c.more = true;
      if (c.colors < 5) c.colors = 5;
    } else {
      c.more = false;
      c.colors = Number(b.dataset.v);
    }
    renderColorSheet();
  })));
  document.querySelectorAll('#color-more button').forEach((b) => b.addEventListener('click', withC((c) => {
    haptic();
    c.colors = Number(b.dataset.v);
    renderColorSheet();
  })));
  document.querySelectorAll('#color-style button').forEach((b) => b.addEventListener('click', withC((c) => {
    haptic();
    c.style = b.dataset.v;
    renderColorSheet();
  })));
  $('color-go').addEventListener('click', colorGo);
  $('color-close').addEventListener('click', () => {
    haptic();
    closeColorSheet();
  });
  $('color-scrim').addEventListener('click', closeColorSheet);
}
