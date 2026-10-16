/* Грава — уточняющие вопросы. Человек пишет «змея» — приложение сначала спрашивает, какая змея
   и в каком стиле, и только потом создаёт. Только для нового заказа по тексту в режимах Лазер,
   3D, Подвижная и Деталь. Не получилось спросить, долго нет ответа или вопросов нет — сразу
   обычный заказ, без лишних сообщений. Использует помощники из app.js, jobs.js, create.js и projects.js. */
'use strict';

const ASKED_KEY = 'grava.asked';
const ASK_MODES = { laser_new: 'laser', sketch: 'sketch', cad: 'cad' };

const asks = {}; // ключ — viewKey(): в каждом проекте свои вопросы
let askSeq = 0;
let askTypingTimer = 0;

function askCurrent() {
  return asks[viewKey()] || null;
}

const askNorm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Запросы, по которым уже спрашивали: второй раз про то же не спрашиваем.
function askedList() {
  try {
    const v = JSON.parse(localStorage.getItem(ASKED_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function askedAdd(text) {
  const t = askNorm(text);
  if (!t) return;
  const list = askedList().filter((x) => x !== t);
  list.unshift(t);
  try { localStorage.setItem(ASKED_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* приватный режим */ }
}

// Правки, 3D из эскиза, размер, формат, скан и заказы с фото — без вопросов.
function askNeeded(data) {
  if (!ASK_MODES[data.kind] || data.base_order != null || (data.images && data.images.length)) return false;
  const t = askNorm(data.prompt);
  return !!t && askedList().indexOf(t) === -1;
}

function askMode(data) {
  return data.kind === 'sketch' && data.flexi === true ? 'flexi' : ASK_MODES[data.kind];
}

// Не больше 2 вопросов и 4 вариантов в каждом — что бы ни прислал сервер.
function askQuestions(list) {
  return (Array.isArray(list) ? list : []).slice(0, 2).map((x) => ({
    q: String((x && x.q) || '').trim().slice(0, 140),
    options: (Array.isArray(x && x.options) ? x.options : [])
      .map((o) => String(o == null ? '' : o).trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 4),
  })).filter((x) => x.q);
}

// Итоговый текст: «змея. Какая змея?: Кобра. Стиль?: Мультяшный».
function askPrompt(text, questions, answers) {
  const base = String(text).trim().replace(/\.+$/, '');
  const parts = questions.map((q, i) => q.q + ': ' + String(answers[i]).trim().replace(/\.+$/, ''));
  return base + (/[!?…]$/.test(base) ? ' ' : '. ') + parts.join('. ');
}

function askReady(a) {
  return a.answers.every((x) => (typeof x.pick === 'number' && x.pick >= 0) || (x.pick === 'own' && !!x.own.trim()));
}

function askAnswers(a) {
  return a.answers.map((x, i) => (x.pick === 'own' ? x.own.trim() : a.questions[i].options[x.pick]));
}

/* ---------- Ход разговора ---------- */

// Отправили из композера: облачко с текстом и «Думаю…», пока сервер решает, о чём спросить.
function askStart(data, title, sent) {
  const key = viewKey();
  const a = {
    id: ++askSeq, key, project: proj.current, text: data.prompt, data, title, kind: data.kind,
    status: 'thinking', questions: null, answers: [], sent,
  };
  asks[key] = a;
  renderFeed();
  renderComposer();
  feedToBottom(true);
  askRun(a);
}

async function askRun(a) {
  let r = null;
  try {
    r = await Api.clarify({ prompt: a.text, mode: askMode(a.data), has_photo: false });
  } catch (e) {
    r = null; // ошибка или 15 секунд без ответа — создаём как есть
  }
  if (asks[a.key] !== a) return;
  const questions = r && r.ready === false ? askQuestions(r.questions) : [];
  if (!questions.length) {
    askSubmit(a, null);
    return;
  }
  a.questions = questions;
  a.answers = questions.map(() => ({ pick: -1, own: '' }));
  a.status = 'questions';
  haptic();
  renderFeed();
  renderComposer();
  feedToBottom(true);
}

// answers — ответы по порядку вопросов; null — по исходному тексту («Пропустить», вопросов нет).
// typed — текст из композера, если ответили там: не ушло — вернём его в поле.
async function askSubmit(a, answers, typed) {
  if (a.status === 'sending') return;
  const back = a.status;
  a.status = 'sending';
  const data = Object.assign({}, a.data);
  let summary = '';
  if (answers) {
    data.prompt = askPrompt(a.text, a.questions, answers).slice(0, PROMPT_MAX);
    summary = answers.map((x) => String(x).trim()).filter((x, i, all) => x && all.indexOf(x) === i).join(' · ');
    askedAdd(data.prompt);
  }
  askedAdd(a.text);
  renderFeed();
  renderComposer();

  const ok = await startJob(data, a.title, 'inline', { project: a.project, from: a.key, ask: { text: a.text, answers: summary } });
  if (ok) {
    if (asks[a.key] === a) delete asks[a.key];
    composerSent(true, a.sent);
  } else if (back === 'questions') {
    a.status = 'questions'; // вопросы остаются — можно отправить ещё раз
    if (typed && !$('composer-input').value.trim()) $('composer-input').value = typed;
  } else {
    if (asks[a.key] === a) delete asks[a.key];
    composerSent(false, a.sent); // текст и фото — обратно в композер
  }
  renderFeed();
  renderComposer();
}

// Пока висят вопросы, текст из композера — «Свой вариант» сразу для всех вопросов.
function askAnswerTyped(a, text) {
  askSubmit(a, a.questions.map(() => text), text);
}

/* ---------- Карточки ---------- */

function renderAsk() {
  const box = $('feed-ask');
  const a = askCurrent();
  const key = a ? a.id + (a.questions ? ':q' : ':t') : '';
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.textContent = '';
    if (a) {
      box.appendChild(bubble(a.text));
      box.appendChild(a.questions ? askCard(a) : thinkingCard());
    }
  }
  if (a && a.questions) askSync(a);
  else askTypingCheck();
}

function thinkingCard() {
  const msg = el('div', 'msg msg-bot');
  const card = el('div', 'ask-thinking');
  card.setAttribute('role', 'status');
  const dots = el('span', 'dots');
  for (let i = 0; i < 3; i++) dots.appendChild(el('i'));
  card.appendChild(dots);
  card.appendChild(el('span', '', 'Думаю…'));
  msg.appendChild(card);
  return msg;
}

function askCard(a) {
  const msg = el('div', 'msg msg-bot');
  const card = el('div', 'result ask');
  const head = el('div', 'ask-head');
  head.appendChild(icon('sparkle'));
  head.appendChild(el('span', '', 'Уточню пару деталей'));
  card.appendChild(head);

  a.questions.forEach((q, qi) => {
    const block = el('div', 'ask-q');
    const title = el('p', 'ask-q-text', q.q);
    title.id = 'ask-q-' + a.id + '-' + qi;
    block.appendChild(title);
    const opts = el('div', 'ask-opts');
    opts.dataset.q = qi;
    opts.setAttribute('role', 'group');
    opts.setAttribute('aria-labelledby', title.id);
    block.appendChild(opts);
    card.appendChild(block);
    askRenderOpts(a, qi, opts, false);
  });

  const foot = el('div', 'ask-foot');
  const go = el('button', 'btn btn-primary ask-go');
  go.type = 'button';
  go.addEventListener('click', () => {
    if (a.status !== 'questions' || !askReady(a)) return;
    haptic();
    askSubmit(a, askAnswers(a));
  });
  const skip = el('button', 'btn btn-ghost ask-skip', 'Пропустить');
  skip.type = 'button';
  skip.addEventListener('click', () => {
    if (a.status !== 'questions') return;
    haptic();
    askSubmit(a, null);
  });
  foot.appendChild(go);
  foot.appendChild(skip);
  card.appendChild(foot);
  msg.appendChild(card);
  return msg;
}

// Варианты одного вопроса: выбирается один. Последний — «Свой вариант», он становится полем ввода.
function askRenderOpts(a, qi, box, focusOwn) {
  box = box || document.querySelector('#feed-ask .ask-opts[data-q="' + qi + '"]');
  if (!box) return;
  const q = a.questions[qi];
  const ans = a.answers[qi];
  box.textContent = '';
  q.options.forEach((text, oi) => {
    const on = ans.pick === oi;
    const c = el('button', 'ask-chip' + (on ? ' is-active' : ''), text);
    c.type = 'button';
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
    c.addEventListener('click', () => {
      if (a.status !== 'questions') return;
      haptic();
      ans.pick = oi;
      askRenderOpts(a, qi, null, false);
      askSync(a);
    });
    box.appendChild(c);
  });

  if (ans.pick === 'own') {
    const wrap = el('span', 'ask-own');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 120;
    input.placeholder = 'Свой вариант';
    input.value = ans.own;
    input.enterKeyHint = 'done';
    input.setAttribute('aria-label', 'Свой вариант: ' + q.q);
    input.addEventListener('input', () => {
      ans.own = input.value;
      askSync(a);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (a.status === 'questions' && askReady(a)) {
        haptic();
        askSubmit(a, askAnswers(a));
      } else {
        input.blur();
      }
    });
    input.addEventListener('focus', () => askTyping(true, input));
    input.addEventListener('blur', () => askTyping(false));
    wrap.appendChild(input);
    box.appendChild(wrap);
    if (focusOwn) input.focus();
  } else {
    const c = el('button', 'ask-chip is-own');
    c.type = 'button';
    c.appendChild(icon('pencil'));
    c.appendChild(el('span', '', 'Свой вариант'));
    c.addEventListener('click', () => {
      if (a.status !== 'questions') return;
      haptic();
      ans.pick = 'own';
      askRenderOpts(a, qi, null, true);
      askSync(a);
    });
    box.appendChild(c);
  }
}

// Кнопки карточки: «Создать» — когда на каждый вопрос есть ответ; пока отправляется — всё неактивно.
function askSync(a) {
  const card = document.querySelector('#feed-ask .ask');
  if (!card) return;
  const sending = a.status === 'sending';
  const go = card.querySelector('.ask-go');
  go.textContent = sending ? 'Отправляю…' : withPrice('Создать', a.kind);
  go.disabled = sending || !askReady(a);
  card.querySelector('.ask-skip').disabled = sending;
  card.classList.toggle('is-sending', sending);
  card.querySelectorAll('.ask-chip, .ask-own input').forEach((b) => { b.disabled = sending; });
  askTypingCheck();
}

// Поле «Свой вариант» убрали (выбрали другой вариант, отправили) — blur при этом не приходит.
function askTypingCheck() {
  const f = document.activeElement;
  if (!(f && f.closest && f.closest('.ask-own') && !f.disabled)) document.body.classList.remove('ask-typing');
}

// Своё слово в карточке: композер и вкладки прячем, чтобы над клавиатурой они не закрыли поле.
function askTyping(on, input) {
  clearTimeout(askTypingTimer);
  if (on) {
    document.body.classList.add('ask-typing');
    askTypingTimer = setTimeout(() => {
      if (document.activeElement === input) input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 300);
    return;
  }
  askTypingTimer = setTimeout(askTypingCheck, 120);
}

// Карточка вопросов после отправки сворачивается в строку «Кобра · Мультяшный».
function askDoneLine(answers) {
  const msg = el('div', 'msg msg-bot msg-line');
  const line = el('div', 'ask-done');
  line.appendChild(icon('check'));
  line.appendChild(el('span', '', answers));
  msg.appendChild(line);
  return msg;
}
