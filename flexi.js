/* Грава — экран «Шарниры»: фигурка печатается сразу подвижной.
   Каждая ветвь (лапы, хвост, щупальца, шея) — цепочка коротких звеньев.
   Сценарий: приложение само ставит шарниры (точки автопоиска → проверка → красные убираются с понятной
   причиной), само собирает и сразу показывает, как фигурка шевелится. Ручной редактор — по «Изменить шарниры».
   Считает фоновый поток flexi-worker.js; размеры суставов и порядок — из flexi-core.js (тот же код).
   Использует помощники из app.js и cadPost/cadBlobToDataUrl/cadIsAuth/cadMm из cad.js. */
'use strict';

const FLEXI_WORKER_URL = './flexi-worker.js?v=13';
const FLEXI_CORE_URL = './flexi-core.js?v=13';
const FLEXI_MAX_FILE = 12 * 1024 * 1024;
// сустав спрятан внутри — соседние звенья красим двумя цветами по очереди, чтобы было видно, где они
const FLEXI_COLORS = [0xc8c8c8, 0xf0a35e];
const FLEXI_RED = '#e53935';
let flexiCore = null;
function flexiLoadCore() {
  if (!flexiCore) flexiCore = import(FLEXI_CORE_URL).catch((e) => { flexiCore = null; throw e; });
  return flexiCore;
}

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
    core: null,
    data: null,
    worker: null,
    seq: 0,
    pending: {},
    origLen: 0,
    length: 150,
    cut: 1,
    g: 0.45,
    k: 1.2,
    kBody: 0.5, // звенья позвоночника внутри тела — короче (тело широкое)
    alphaSeg: 20, // «ушко в петле» свободно ходит на ±20°
    prep: null,
    paths: null,
    cuts: [], // разрезы ставит человек: тап по фигурке; на старте — ни одного
    nextId: 1,
    menu: null, // разрез, у которого открыто меню «Убрать»
    sugg: null, // предложения автопоиска — точки для «✨ Предложить»
    showSugg: false,
    suggSeq: 0,
    legs: null,
    built: null,
    stale: true,
    prepTimer: 0,
    mode: 'load',    // load | auto — шаги; fail — «Не получилось»; result — фигурка шевелится; editor — ручная правка
    manual: false,   // шарниры правили руками — при смене размера они сохраняются, а не ставятся заново
    missed: [],      // где шарнир не получился: { place, why } — для «Где не получилось»
    verSeq: 0,       // версии разрезов — общий счётчик: старый ответ потока никогда не перепутается с новым
    autoRun: 0,      // номер автосборки: «Назад», новый размер или ручная правка отменяют прежнюю
    resultCuts: null, // шарниры собранного результата — «Назад» из редактора возвращает к нему
  };

  $('flexi-missing').hidden = true;
  $('flexi-main').hidden = false;
  $('flexi-title').textContent = 'Загружаю модель…';
  $('flexi-warn-pose').hidden = true;
  $('flexi-warn-parts').hidden = true;
  $('flexi-small-joints').hidden = true;
  $('flexi-pop').hidden = true;
  $('flexi-saved').hidden = true;
  $('flexi-size-box').hidden = true;
  $('flexi-size-btn').setAttribute('aria-expanded', 'false');
  flexiShow(f, 'load');
  flexiStep('load', 'Загружаю модель…');
  flexiRenderSettings();
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  flexiUpdateMainButton();

  flexiLoadCore()
    .then((core) => {
      f.core = core;
      return Api.flexi(id);
    })
    .then((data) => {
      if (state.flexi !== f) return;
      f.data = data;
      $('flexi-title').textContent = data.title || 'Фигурка';
      // сделана не в режиме «Подвижная на шарнирах» — может лежать не плашмя
      const pose = $('flexi-warn-pose');
      pose.hidden = data.flexi !== false;
      pose.textContent = '';
      if (data.flexi === false) pose.appendChild(flexiExplainEl(flexiExplain('поза', ''), ''));
      return flexiDownload(f);
    })
    .catch((err) => {
      if (state.flexi !== f) return;
      const code = err && err.code;
      if (code === 'auth') {
        flexiShowMissing('Сессия устарела — перезапусти приложение', 'close');
        sessionExpired();
      } else if (code === 'network') {
        flexiShowMissing('Нет связи с сервером. Проверь интернет и попробуй ещё раз', 'retry');
      } else if (code === 'holes') {
        flexiShowMissing('В модели есть дыры — шарниры не собрать. Попробуй сделать модель заново', 'back');
      } else if (code === 'worker' || !f.core) {
        flexiShowMissing('Сборщик не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз', 'back');
      } else if (code === 'bad_stl') {
        flexiShowMissing('Файл модели не читается. Попробуй сделать модель заново', 'back');
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
  tg.MainButton.setParams(Object.assign({ is_active: true }, mainButtonColors(true)));
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

/* ---------- Настройки сборки ---------- */

// Опции для flexi-core: размеры звена и шаг цепочки.
function flexiOpts(f) {
  return { g: f.g, alphaSeg: f.alphaSeg, k: f.k, kBody: f.kBody };
}

/* ---------- Фоновый поток ---------- */

function flexiWorker(f) {
  if (f.worker) return f.worker;
  let w;
  try { w = new Worker(FLEXI_WORKER_URL, { type: 'module' }); } catch (e) { throw new FlexiUiError('worker'); }
  w.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress' && (msg.phase === 'repair' || msg.phase === 'analyze')) {
      if (msg.phase === 'repair') flexiStep('load', 'Готовлю модель…');
      else flexiStep('find', 'Ищу, где фигурка должна гнуться…');
      return;
    }
    if (msg.type === 'progress') {
      const text = msg.phase === 'check'
        ? 'Проверяю звенья… ' + msg.k + ' из ' + msg.n
        : 'Собираю звено ' + msg.k + ' из ' + msg.n + '…';
      if (f.mode === 'auto') flexiStep('build', text);
      else $('busy-text').textContent = text;
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
  const res = await Api.download({ a: 'file', id: f.id, what: 'file' }, 180000);
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
  flexiRenderSettings();
  await flexiPrepare(f, true);
}

/* ---------- Подготовка и предложения ---------- */

async function flexiPrepare(f, first) {
  if (first) flexiStep('load', 'Готовлю модель…');
  else if (f.mode === 'editor') $('flexi-count').textContent = 'Пересчитываю под новый размер…';
  else {
    flexiShow(f, 'auto');
    flexiStep('find', 'Пересчитываю под новый размер…');
  }
  const oldLen = f.prep ? f.prep.length : f.length;
  let r;
  try {
    r = await flexiCall(f, { type: 'prepare', length: f.length, cut: f.cut });
  } catch (err) {
    if (state.flexi !== f || (err && err.code === 'cancelled')) return;
    flexiShowFail(f, 'Не получилось подготовить модель', [{ text: flexiCap((err && err.message) || String(err)), tip: 'Попробуй ещё раз или сделай модель заново' }]);
    return;
  }
  if (state.flexi !== f || r.length !== f.length) return; // уже двигают ползунок дальше
  const sk = r.skeleton;
  r.skel = [];
  for (let k = 0; k < sk.length / 5; k++) r.skel.push({ x: sk[k * 5], y: sk[k * 5 + 1], dt: sk[k * 5 + 2], parent: sk[k * 5 + 3], dist: sk[k * 5 + 4] });
  f.prep = r; // r.geo — шея, тело, лапы, хвост для названий мест (flexiGeo)
  // ветви, по которым можно резать (позвоночник и лапы): разрез тянется вдоль них
  f.paths = new Map();
  r.branches.forEach((b) => {
    const n = b.pts.length / 2, cum = new Float32Array(n);
    for (let k = 1; k < n; k++) cum[k] = cum[k - 1] + Math.hypot(b.pts[k * 2] - b.pts[k * 2 - 2], b.pts[k * 2 + 1] - b.pts[k * 2 - 1]);
    f.paths.set(b.i, { pts: b.pts, cum, from: b.from, spine: b.spine });
  });
  f.legs = r.legs;
  // после починки остались крупные отдельные куски — они не соединены с телом
  const warnParts = $('flexi-warn-parts');
  warnParts.hidden = !(r.parts > 1);
  if (r.parts > 1) warnParts.textContent = 'Модель из ' + r.parts + ' ' + plural(r.parts, 'части', 'частей', 'частей') + ' — куски, не связанные с телом, останутся отдельными';
  // предложения (и подсказка «сделай крупнее») — для нового размера
  f.sugg = null;
  await flexiSuggest(f);
  if (state.flexi !== f) return;
  // размер поменялся: модель отцентрована в (0,0) — разрезы едут вместе с ней и ставятся заново (суставы другие)
  if (f.cuts.length && oldLen && r.length !== oldLen) {
    const k = r.length / oldLen;
    f.cuts.forEach((c) => {
      c.P = [c.P[0] * k, c.P[1] * k];
      c.Rh *= k;
      flexiPlace(f, c, c.P[0], c.P[1], null, true, false);
    });
  }
  f.stale = true;
  flexiAfterPrepare(f);
}

// Предложения автопоиска (скелет, бороздки, корни ветвей) — только точки для «✨ Предложить», не разрезы.
async function flexiSuggest(f) {
  if (!f.prep) return;
  const seq = ++f.suggSeq;
  let r;
  try {
    r = await flexiCall(f, { type: 'auto', opts: flexiOpts(f) });
  } catch (err) {
    return;
  }
  if (state.flexi !== f || seq !== f.suggSeq) return;
  f.sugg = r.sugg;
  // суставы с минимумами в мм: на маленькой фигурке хвосту и лапам их не хватает — просим сделать крупнее
  $('flexi-small-joints').hidden = !r.small;
  flexiDraw();
}

function flexiInvalidate() {
  const f = state.flexi;
  if (!f) return;
  f.stale = true;
  flexiUpdateMainButton();
}

// Зазор или гибкость поменялись: суставы другие — разрезы проверяются заново, предложения тоже.
function flexiSettingChanged(recheck) {
  const f = state.flexi;
  if (!f) return;
  flexiRenderSettings();
  if (!f.prep) return;
  flexiSuggest(f);
  if (recheck) {
    flexiInvalidate();
    f.cuts.forEach((c) => flexiPlace(f, c, c.P[0], c.P[1], c.br, false, false));
  }
  flexiDraw();
}

/* ---------- Разрезы: поставить и проверить ---------- */

// Данные разреза для потока.
function flexiCutMsg(c) {
  return { id: c.id, P: c.P, n: c.n, w: c.w, chain: c.chain, br: c.br, s: c.s, root: !!c.root, spine: !!c.spine };
}

// Без ответа: поток только помечает старые проверки разреза ненужными.
function flexiPost(f, msg) {
  try { flexiWorker(f).postMessage(msg); } catch (e) { /* поток уже закрыт */ }
}

// Новый разрез там, куда тапнули (или из точки-предложения). Пока поток не ответил — серый.
// auto — ставит автосборка: без вибрации и тостов, и это не ручная правка.
function flexiAddCut(f, x, y, br, snap, auto) {
  const near = flexiNearestSkel(f, x, y);
  const s = near ? f.prep.skel[near.k] : { x, y };
  const c = {
    id: f.nextId++, P: [s.x, s.y], n: near ? flexiSkelDir(f, near.k) : [1, 0], w: 3, Rh: 0,
    br, s: Infinity, chain: -1, spine: false, root: false, st: 'wait', why: '', ver: 0, auto: !!auto,
  };
  f.cuts.push(c);
  f.menu = null;
  if (!auto) {
    haptic('medium');
    flexiManual(f);
  }
  flexiInvalidate();
  flexiDraw();
  flexiPlace(f, c, x, y, br, snap, true);
  return c;
}

// Человек сам поправил шарниры: автосборка (если шла) больше не нужна, при смене размера они сохраняются.
function flexiManual(f) {
  f.manual = true;
  f.autoRun++;
}

// Разрез ближе к телу на той же цепочке: проверяется вместе с этим (звено между ними — как при сборке).
function flexiPrevCut(f, c) {
  const b = f.paths && f.paths.get(c.br);
  return f.core.prevCut(f.cuts, c, (P) => {
    if (!b) return false;
    for (let k = 0; k < b.pts.length; k += 2) if (Math.hypot(b.pts[k] - P[0], b.pts[k + 1] - P[1]) < 1.5) return true;
    return false;
  });
}

// Разрез поставили, сдвинули или убрали — дальше по цепочке (от s0) звено ближе к телу у разрезов поменялось.
function flexiRecheckChain(f, c, s0) {
  f.cuts.forEach((o) => {
    if (o !== c && o.chain === c.chain && o.Rh > 0 && o.s > s0) flexiPlace(f, o, o.P[0], o.P[1], o.br, false, false);
  });
}

/* Поставить разрез (поперёк ветви в ближайшей точке скелета, к бороздке ближе 3 мм — притянуть) и проверить:
   сначала быстро — по размерам сустава и запасу от кожи, потом булевыми операциями на целой модели (держит в 6 сторон,
   поворачивается, ничего не отрезал) — вместе с разрезом ближе к телу на той же цепочке. Сдвинули или убрали,
   пока считалось, — старый ответ не нужен (c.ver). cascade — разрез поставили или сдвинули рукой: разрезы дальше
   по цепочке проверяются заново.
   Возвращает промис, который завершается, когда проверка закончилась (или стала ненужной): c.busy — последний
   такой промис, c.placing — сколько проверок разреза ещё идёт. Автосборка ждёт их (flexiSettle). */
function flexiPlace(f, c, x, y, br, snap, cascade) {
  c.placing = (c.placing || 0) + 1;
  const p = flexiPlaceRun(f, c, x, y, br, snap, cascade).finally(() => { c.placing--; });
  c.busy = p;
  return p;
}

async function flexiPlaceRun(f, c, x, y, br, snap, cascade) {
  const ver = c.ver = ++f.verSeq;
  const oldS = c.s, oldChain = c.chain;
  c.st = 'wait';
  c.why = '';
  const fresh = () => state.flexi === f && c.ver === ver && f.cuts.indexOf(c) !== -1;
  const bad = (why) => { c.st = 'bad'; c.why = why; flexiDraw(); };
  let r;
  try {
    r = await flexiCall(f, { type: 'place', key: c.id, ver, x, y, br, snap, opts: flexiOpts(f) });
  } catch (err) {
    if (fresh()) bad('не получилось проверить — сдвинь разрез');
    return;
  }
  if (!fresh()) return;
  if (!r.cut) {
    // мимо шеи, лап и хвоста (середина круглого тела, фон)
    flexiDropCut(f, c);
    if (!c.auto) toast('Тут не гнётся — тапни по шее, лапе или хвосту');
    return;
  }
  Object.assign(c, r.cut);
  if (cascade) {
    if (oldChain >= 0 && oldChain !== c.chain) flexiRecheckChain(f, { chain: oldChain }, oldS);
    flexiRecheckChain(f, c, Math.min(oldS, c.s));
  }
  if (!r.cut.fit) { bad(r.cut.why); return; }
  flexiDraw();
  const prev = flexiPrevCut(f, c);
  let v;
  try {
    v = await flexiCall(f, { type: 'check', key: c.id, ver, cut: flexiCutMsg(c), prev: prev && flexiCutMsg(prev), opts: flexiOpts(f) });
  } catch (err) {
    if (fresh()) bad('не получилось проверить — сдвинь разрез');
    return;
  }
  if (!fresh() || v.stale) return;
  if (v.ok) { c.st = 'ok'; c.why = ''; flexiDraw(); } else bad(v.why);
}

function flexiDropCut(f, c, cascade = true) {
  f.cuts = f.cuts.filter((x) => x !== c);
  if (f.menu === c.id) f.menu = null;
  flexiPost(f, { type: 'drop', key: c.id, ver: c.ver = ++f.verSeq });
  if (cascade && c.Rh > 0) flexiRecheckChain(f, c, c.s);
  flexiInvalidate();
  flexiDraw();
}

// Зелёный, красный или «проверяю»: зелёный рядом с соседом (кружки ближе 2 мм) — тоже красный.
function flexiCutState(f, c) {
  if (c.st !== 'ok') return c.st;
  return f.cuts.some((o) => o !== c && o.Rh > 0 && f.core.tooClose(c, o)) ? 'near' : 'ok';
}
function flexiCutWhy(f, c) {
  const st = flexiCutState(f, c);
  return st === 'near' ? f.core.NEAR_WHY : st === 'bad' ? c.why : '';
}
// «Готово» — когда проверка закончилась и есть хотя бы один зелёный (красные при сборке пропускаются).
function flexiCanBuild(f) {
  return !!(f && f.prep && !f.cuts.some((c) => c.st === 'wait') && f.cuts.some((c) => flexiCutState(f, c) === 'ok'));
}

/* ---------- Вид сверху ---------- */

const flexiView = { img: null, k: 1, ox: 0, oy: 0, drag: null, dpr: 1 };
const FLEXI_GREEN = '#34c759';

function flexiLayoutCanvas() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  const canvas = $('flexi-canvas');
  const cw = $('flexi-top').clientWidth || 360;
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

  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ictx = img.getContext('2d');
  const id = ictx.createImageData(W, H);
  const hts = f.prep.heights;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = hts[y * W + x];
      if (!v) continue;
      const o = ((H - 1 - y) * W + x) * 4; // ось Y — вверх
      id.data[o] = id.data[o + 1] = id.data[o + 2] = v;
      id.data[o + 3] = 255;
    }
  }
  ictx.putImageData(id, 0, 0);
  flexiView.img = img;
}

function flexiToScreen(x, y) {
  const g = state.flexi.prep.grid;
  return [flexiView.ox + ((x - g.x0) / g.step) * flexiView.k, flexiView.oy + (g.H - (y - g.y0) / g.step) * flexiView.k];
}
function flexiToModel(sx, sy) {
  const g = state.flexi.prep.grid;
  return [g.x0 + ((sx - flexiView.ox) / flexiView.k) * g.step, g.y0 + (g.H - (sy - flexiView.oy) / flexiView.k) * g.step];
}
function flexiPx(mm) {
  return (mm / state.flexi.prep.grid.step) * flexiView.k;
}

// Порядок сборки (номер на экране): от ядра вдоль скелета — как в потоке.
function flexiOrdered(f) {
  return f.core.orderCuts(f.cuts, f.prep.skel);
}

// Кружок сустава (радиус Rh; пока поток не ответил — 6 мм) и черта поперёк ветви.
const flexiR = (c) => c.Rh || 6;
function flexiHalfBar(c) {
  return Math.max(c.w, flexiR(c)) + 2;
}

function flexiDraw() {
  const f = state.flexi;
  if (!f || !f.prep || !flexiView.img) return;
  const canvas = $('flexi-canvas');
  const ctx = canvas.getContext('2d');
  ctx.setTransform(flexiView.dpr, 0, 0, flexiView.dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const g = f.prep.grid;
  ctx.drawImage(flexiView.img, flexiView.ox, flexiView.oy, g.W * flexiView.k, g.H * flexiView.k);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2481cc';

  // предложения — полупрозрачные точки (не разрезы): тут сустав помещается — цветом, тут тонко — серым
  if (f.showSugg) {
    flexiVisibleSugg(f).forEach((q) => {
      const [px, py] = flexiToScreen(q.P[0], q.P[1]);
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = q.fit ? accent : '#8e8e93';
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  const order = flexiOrdered(f);
  order.forEach((c, i) => {
    const st = flexiCutState(f, c);
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const r = flexiPx(flexiR(c));
    const open = f.menu === c.id;
    const color = st === 'ok' ? FLEXI_GREEN : st === 'wait' ? '#8e8e93' : FLEXI_RED;

    // кружок — размер сустава; пока проверяется — пунктиром
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = open ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.15)';
    ctx.fill();
    ctx.lineWidth = open ? 3 : 2;
    ctx.strokeStyle = color;
    ctx.setLineDash(st === 'wait' ? [5, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    // черта поперёк ветви — место разреза
    const L = flexiHalfBar(c);
    const [ax, ay] = flexiToScreen(c.P[0] + c.n[1] * L, c.P[1] - c.n[0] * L);
    const [bx, by] = flexiToScreen(c.P[0] - c.n[1] * L, c.P[1] + c.n[0] * L);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineWidth = open ? 3.5 : 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    // номер (на маленьком кружке — поменьше, чтобы кружок было видно)
    const small = r < 15;
    ctx.beginPath();
    ctx.arc(px, py, small ? 6 : 8.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = (small ? '700 8px ' : '700 10.5px ') + '-apple-system, BlinkMacSystemFont, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), px, py + 0.5);
  });

  $('flexi-reset').disabled = !f.cuts.length;
  $('flexi-count').textContent = flexiChainInfo(f);
  flexiRenderCutNotes(f, order);
  flexiRenderMenu(f);
  $('flexi-build').disabled = !flexiCanBuild(f) || !!state.flexiBusy;
}

// Красные шарниры — понятная причина и совет под видом сверху (номер — как на картинке); пока поток проверяет — «Проверяю…».
function flexiRenderCutNotes(f, order) {
  const box = $('flexi-cut-notes');
  box.textContent = '';
  order.forEach((c, i) => {
    const why = flexiCutWhy(f, c);
    if (why) box.appendChild(flexiExplainEl(flexiExplain(why, flexiPlaceName(f, c)), 'is-bad', i + 1));
  });
  const wait = f.cuts.filter((c) => c.st === 'wait').length;
  if (wait) box.appendChild(el('div', 'flexi-note is-ok', wait === 1 ? 'Проверяю шарнир…' : 'Проверяю шарниры… (' + wait + ')'));
}

// Маленькое меню у разреза — «Убрать» (причина красного — под видом сверху), над разрезом или под ним.
function flexiRenderMenu(f) {
  const pop = $('flexi-pop');
  const c = f.menu != null && f.cuts.find((x) => x.id === f.menu);
  if (!c) { pop.hidden = true; return; }
  pop.hidden = false;
  const box = $('flexi-top');
  const [px, py] = flexiToScreen(c.P[0], c.P[1]);
  const r = flexiPx(flexiR(c));
  const w = pop.offsetWidth, h = pop.offsetHeight, bw = box.clientWidth, bh = $('flexi-canvas').clientHeight;
  const left = Math.max(8, Math.min(bw - w - 8, px - w / 2));
  const top = py - r - h - 8 >= 4 ? py - r - h - 8 : Math.min(bh - h - 4, py + r + 8);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(Math.max(4, top)) + 'px';
}

// Что где стоит, простыми словами: { parts: «шея, 4 лапы, хвост — 4 звена», bend: 80 } — до скольких градусов
// гнётся хвост (или тело, или самая длинная цепочка, если хвоста нет).
function flexiCutsInfo(f, cuts) {
  let neck = 0, body = 0, tail = 0;
  const legs = new Set();
  const per = {};
  cuts.forEach((c) => {
    per[c.chain] = (per[c.chain] || 0) + 1;
    const name = flexiPlaceName(f, c);
    if (name === 'Шея') neck++;
    else if (name === 'Тело') body++;
    else if (name === 'Хвост' || name === 'Кончик хвоста') tail++;
    else legs.add(name); // «Лапа 2» — одна лапа, даже если на ней несколько шарниров
  });
  const links = (k) => k + ' ' + plural(k, 'звено', 'звена', 'звеньев');
  const parts = [];
  if (neck) parts.push(neck > 1 ? 'шея — ' + links(neck) : 'шея');
  if (body) parts.push(body > 1 ? 'тело — ' + links(body) : 'тело');
  if (legs.size) parts.push(legs.size + ' ' + plural(legs.size, 'лапа', 'лапы', 'лап'));
  if (tail) parts.push('хвост — ' + links(tail));
  const longest = Math.max(0, ...Object.values(per));
  return { parts: parts.join(', '), bend: (tail || neck + body || longest) * f.alphaSeg };
}

function flexiJoints(n) {
  return n + ' ' + plural(n, 'шарнир', 'шарнира', 'шарниров');
}

// Строка в ручном редакторе: «Шарниров: 9 — шея, 4 лапы, хвост — 4 звена».
function flexiChainInfo(f) {
  if (!f.cuts.length) return 'Шарниров пока нет — фигурка целиком';
  const info = flexiCutsInfo(f, f.cuts);
  return 'Шарниров: ' + f.cuts.length + (info.parts ? ' — ' + info.parts : '');
}

/* ---------- Места и причины — понятными словами ---------- */

const flexiCap = (s) => { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

// Где у фигурки шея, тело, хвост и какая лапа какая — по ветвям из подготовки (считается раз на размер).
// Позвоночник идёт от морды к кончику хвоста: тело — между местами, где из него выходят передние и задние лапы.
// Ветви лап начинаются в ядре, и одну лапу часто ведут несколько почти одинаковых ветвей — их объединяем
// по концу лапы; место лапы на позвоночнике — по её выходу из тела (b.from).
function flexiGeo(f) {
  const prep = f.prep;
  if (prep.geo) return prep.geo;
  const geo = { spine: null, sFront: 0, sBack: 0, total: 0, legNo: new Map() };
  const all = Array.from(f.paths.entries());
  const sp = all.find(([, b]) => b.spine);
  const nearestS = (b, x, y) => {
    let kb = 0, bd = Infinity;
    for (let k = 0; k < b.pts.length / 2; k++) {
      const d = (b.pts[k * 2] - x) ** 2 + (b.pts[k * 2 + 1] - y) ** 2;
      if (d < bd) { bd = d; kb = k; }
    }
    return { s: b.cum[kb], k: kb };
  };
  // ветви одной лапы: концы цепочкой ближе 14 мм друг к другу
  const raw = all.filter(([, b]) => !b.spine).map(([i, b]) => {
    const n = b.pts.length / 2, a = Math.min(n - 1, Math.max(0, b.from));
    return { i, ax: b.pts[a * 2], ay: b.pts[a * 2 + 1], ex: b.pts[n * 2 - 2], ey: b.pts[n * 2 - 1], len: b.cum[n - 1] };
  });
  const root = raw.map((x, k) => k);
  const find = (k) => (root[k] === k ? k : (root[k] = find(root[k])));
  raw.forEach((x, k) => raw.forEach((y, m) => { if (m > k && Math.hypot(x.ex - y.ex, x.ey - y.ey) < 14) root[find(m)] = find(k); }));
  const legs = [];
  raw.forEach((x, k) => {
    let leg = legs.find((q) => q.key === find(k));
    if (!leg) legs.push(leg = { key: find(k), ids: [], len: -1 });
    leg.ids.push(x.i);
    if (x.len > leg.len) Object.assign(leg, { ax: x.ax, ay: x.ay, ex: x.ex, ey: x.ey, len: x.len }); // лапа — по самой длинной ветви
  });
  if (sp) {
    const [si, sb] = sp;
    geo.spine = si;
    geo.total = sb.cum[sb.cum.length - 1];
    legs.forEach((L) => {
      const q = nearestS(sb, L.ax, L.ay);
      const k2 = Math.min(sb.pts.length / 2 - 1, q.k + 1), k1 = Math.max(0, k2 - 1);
      const dx = sb.pts[k2 * 2] - sb.pts[k1 * 2], dy = sb.pts[k2 * 2 + 1] - sb.pts[k1 * 2 + 1];
      L.s = q.s;
      L.side = dx * (L.ey - sb.pts[k1 * 2 + 1]) - dy * (L.ex - sb.pts[k1 * 2]) > 0 ? 0 : 1;
    });
    // передние раньше задних, в паре — сначала одна сторона, потом другая
    legs.sort((a, b) => (Math.abs(a.s - b.s) > 6 ? a.s - b.s : a.side - b.side));
    if (legs.length) {
      geo.sFront = Math.min(...legs.map((x) => x.s));
      geo.sBack = Math.max(...legs.map((x) => x.s));
    } else {
      // без лап (змея): тело — у ядра
      const sc = nearestS(sb, prep.core[0], prep.core[1]).s;
      geo.sFront = sc - geo.total * 0.1;
      geo.sBack = sc + geo.total * 0.1;
    }
  } else if (legs.length <= 2 || f.legs <= 1) {
    // без лап (змея, червяк; ядро тоже видит одну цепочку): длинная цепочка — тело, короткая (к морде) — шея
    geo.body = true;
    geo.neck = new Set();
    if (legs.length === 2) (legs[0].len < legs[1].len ? legs[0] : legs[1]).ids.forEach((i) => geo.neck.add(i));
  } else {
    // без позвоночника (осьминог): лапы — по кругу от ядра
    legs.forEach((L) => { L.a = Math.atan2(L.ey - prep.core[1], L.ex - prep.core[0]); });
    legs.sort((a, b) => a.a - b.a);
  }
  if (!geo.body) legs.forEach((L, k) => L.ids.forEach((i) => geo.legNo.set(i, k + 1)));
  prep.geo = geo;
  return geo;
}

// «Шея», «Тело», «Хвост», «Кончик хвоста», «Лапа 1…4» — по ветви и месту разреза на ней.
function flexiPlaceName(f, c) {
  if (!f.prep || !f.paths || c.br == null || !f.paths.has(c.br)) return 'Шарнир';
  const geo = flexiGeo(f);
  if (geo.body) return geo.neck.has(c.br) ? 'Шея' : 'Тело';
  if (c.br !== geo.spine) return 'Лапа' + (geo.legNo.has(c.br) ? ' ' + geo.legNo.get(c.br) : '');
  const s = Number.isFinite(c.s) ? c.s : 0;
  if (s < geo.sFront - 1) return 'Шея';
  if (s <= geo.sBack + 1) return 'Тело';
  return s > geo.sBack + (geo.total - geo.sBack) * 0.8 ? 'Кончик хвоста' : 'Хвост';
}

// Техническая причина из ядра (c.why, NEAR_WHY, заметки сборки) → { text, tip } для человека.
// key и what — для объединения одинаковых причин в разных местах (flexiExplainAll).
function flexiExplain(why, place) {
  const w = String(why || '').toLowerCase();
  const at = place || 'Здесь';
  const f = state.flexi;
  const say = (key, what, tip) => ({ key, what, text: at + ': ' + what, tip });
  if (/поз|лёжа|лежа|плашмя/.test(w)) {
    return { key: 'pose', text: 'Фигурка не лежит плашмя — шарниры могут не напечататься', tip: 'Лучше создать новую в режиме «Подвижная на шарнирах»' };
  }
  if (/наружу|отрезал|отрезает|задевает|кожу/.test(w)) return say('outside', 'шарнир вылезет наружу', 'Сдвинь шарнир ближе к середине лапы');
  if (/близко к соседн/.test(w)) return say('near', 'шарниры стоят слишком близко', 'Поставь его чуть дальше от соседнего');
  if (/тонк|не помещается|мало места|близко к кончику|крупнее/.test(w)) {
    return say('thin', 'слишком тонкое для шарнира', f && f.length >= 180 ? 'Сделай фигурку ещё крупнее' : 'Сделай фигурку крупнее — от 18 см');
  }
  const raw = String(why || '').trim();
  return { key: 'other:' + raw, what: raw, text: place ? place + ': ' + raw : flexiCap(raw), tip: '' };
}

// «Лапа 1», «Лапа 3», «Хвост» → «Хвост, лапы 1, 3».
function flexiJoinPlaces(places) {
  const leg = /^Лапа (\d+)$/;
  const nums = places.filter((p) => leg.test(p)).map((p) => Number(p.match(leg)[1])).sort((a, b) => a - b);
  const parts = places.filter((p) => !leg.test(p));
  if (nums.length === 1) parts.push('Лапа ' + nums[0]);
  else if (nums.length) parts.push('Лапы ' + nums.join(', '));
  return parts.map((p, i) => (i ? p.charAt(0).toLowerCase() + p.slice(1) : p)).join(', ');
}

// Список мест и причин → строки объяснений: одна строка на место, одинаковые причины в разных местах — одной строкой.
function flexiExplainAll(items) {
  const groups = [];
  const seen = new Set();
  items.forEach((m) => {
    if (seen.has(m.place)) return;
    seen.add(m.place);
    const x = flexiExplain(m.why, m.place);
    const g = x.key !== 'pose' && groups.find((q) => q.x.key === x.key);
    if (g) g.places.push(m.place);
    else groups.push({ x, places: [m.place] });
  });
  return groups.map(({ x, places }) => {
    if (places.length < 2 || !x.what) return { text: x.text, tip: x.tip };
    const what = x.key === 'thin' ? 'слишком тонкие для шарнира' : x.what;
    return { text: flexiJoinPlaces(places) + ': ' + what, tip: x.tip };
  });
}

// Строка объяснения: жирным — что не так, ниже — совет; num — номер шарнира, как на картинке.
function flexiExplainEl(x, cls, num) {
  const d = el('div', 'flexi-explain' + (cls ? ' ' + cls : ''));
  if (num) d.appendChild(el('span', 'flexi-num', String(num)));
  const body = el('div', 'flexi-explain-body');
  body.appendChild(el('b', '', x.text));
  if (x.tip) body.appendChild(el('span', '', x.tip));
  d.appendChild(body);
  return d;
}

// «Где не получилось»: место, где в итоге есть зелёный шарнир, не считается.
function flexiMissedLines(f) {
  const okPlaces = new Set(f.cuts.filter((c) => flexiCutState(f, c) === 'ok').map((c) => flexiPlaceName(f, c)));
  return flexiExplainAll(f.missed.filter((m) => !okPlaces.has(m.place)));
}

// Точки-предложения, на которых ещё нет разреза.
function flexiVisibleSugg(f) {
  return (f.sugg || []).filter((q) => !f.cuts.some((c) => Math.hypot(c.P[0] - q.P[0], c.P[1] - q.P[1]) < 2));
}

/* ---------- Скелет: ближайшая точка, направление ---------- */

function flexiNearestSkel(f, x, y) {
  let best = -1, bd = Infinity;
  f.prep.skel.forEach((s, k) => {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bd) { bd = d; best = k; }
  });
  return best < 0 ? null : { k: best, dist: Math.sqrt(bd) };
}

// От ядра наружу: точка минус её предок на 3 мм ближе к ядру.
function flexiSkelDir(f, k) {
  const s = f.prep.skel;
  let a = k, len = 0;
  while (s[a].parent >= 0 && len < 3) {
    const p = s[a].parent;
    len += Math.hypot(s[a].x - s[p].x, s[a].y - s[p].y);
    a = p;
  }
  let nx = s[k].x - s[a].x, ny = s[k].y - s[a].y;
  if (Math.hypot(nx, ny) < 1e-6) { nx = s[k].x - f.prep.core[0]; ny = s[k].y - f.prep.core[1]; }
  const l = Math.hypot(nx, ny) || 1;
  return [nx / l, ny / l];
}

// Ближайшая точка ветви bi (только та часть, где можно резать) и направление вдоль неё (как в потоке: ±3 мм).
function flexiAlong(f, bi, x, y) {
  const b = f.paths && f.paths.get(bi);
  if (!b) return null;
  const n = b.pts.length / 2;
  let kb = -1, bd = Infinity;
  for (let k = Math.max(0, b.from); k < n; k++) {
    const d = (b.pts[k * 2] - x) ** 2 + (b.pts[k * 2 + 1] - y) ** 2;
    if (d < bd) { bd = d; kb = k; }
  }
  if (kb < 0) return null;
  const at = (s) => { let k = 0; while (k < n - 1 && b.cum[k] < s) k++; return k; };
  const a = at(b.cum[kb] - 3), z = at(b.cum[kb] + 3);
  const dx = b.pts[z * 2] - b.pts[a * 2], dy = b.pts[z * 2 + 1] - b.pts[a * 2 + 1], l = Math.hypot(dx, dy) || 1;
  return { P: [b.pts[kb * 2], b.pts[kb * 2 + 1]], n: [dx / l, dy / l] };
}

// Точка на фигурке (по картинке высот, с запасом 1 мм у края).
function flexiOnModel(f, x, y) {
  const g = f.prep.grid, h = f.prep.heights;
  const cx = Math.floor((x - g.x0) / g.step), cy = Math.floor((y - g.y0) / g.step), r = Math.ceil(1 / g.step);
  for (let py = cy - r; py <= cy + r; py++) {
    for (let px = cx - r; px <= cx + r; px++) {
      if (px >= 0 && py >= 0 && px < g.W && py < g.H && h[py * g.W + px]) return true;
    }
  }
  return false;
}

/* ---------- Пальцем по виду сверху ---------- */

function flexiPoint(e) {
  const r = $('flexi-canvas').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

// Разрез под пальцем (ближайший, в пределах кружка, но не меньше 16 и не больше 26 px).
function flexiHitCut(f, sx, sy) {
  let hit = null, hd = Infinity;
  f.cuts.forEach((c) => {
    const [px, py] = flexiToScreen(c.P[0], c.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < Math.max(16, Math.min(26, flexiPx(flexiR(c)))) && d < hd) { hd = d; hit = c; }
  });
  return hit;
}
function flexiHitSugg(f, sx, sy) {
  let hit = null, hd = 18;
  flexiVisibleSugg(f).forEach((q) => {
    const [px, py] = flexiToScreen(q.P[0], q.P[1]);
    const d = Math.hypot(sx - px, sy - py);
    if (d < hd) { hd = d; hit = q; }
  });
  return hit;
}

function flexiPointerDown(e) {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  e.preventDefault();
  const [sx, sy] = flexiPoint(e);
  try { $('flexi-canvas').setPointerCapture(e.pointerId); } catch (err) { /* ок */ }
  const hit = flexiHitCut(f, sx, sy);
  flexiView.drag = { pointer: e.pointerId, x0: sx, y0: sy, id: hit ? hit.id : null, moved: false };
}

// Тянут разрез — он едет вдоль своей ветви (позвоночника, лапы); проверяется, когда отпустят.
function flexiPointerMove(e) {
  const f = state.flexi;
  const d = flexiView.drag;
  if (!f || !d || d.pointer !== e.pointerId) return;
  e.preventDefault();
  const [sx, sy] = flexiPoint(e);
  if (!d.moved && Math.hypot(sx - d.x0, sy - d.y0) < 8) return;
  const c = d.id != null && f.cuts.find((x) => x.id === d.id);
  if (!c) return;
  if (!d.moved) { d.moved = true; f.menu = null; haptic(); }
  const q = flexiAlong(f, c.br, ...flexiToModel(sx, sy));
  if (q) { c.P = q.P; c.n = q.n; }
  c.st = 'wait';
  c.ver = ++f.verSeq; // старая проверка устарела
  flexiManual(f);
  flexiInvalidate();
  flexiDraw();
}

function flexiPointerUp(e) {
  const f = state.flexi;
  const d = flexiView.drag;
  if (!d || d.pointer !== e.pointerId) return;
  flexiView.drag = null;
  if (!f || !f.prep) return;
  if (d.moved) {
    const c = d.id != null && f.cuts.find((x) => x.id === d.id);
    if (c) flexiPlace(f, c, c.P[0], c.P[1], c.br, true, true);
    return;
  }
  if (e.type === 'pointercancel') return;
  // тап по разрезу — меню «Убрать»
  if (d.id != null) {
    haptic();
    f.menu = f.menu === d.id ? null : d.id;
    flexiDraw();
    return;
  }
  // меню было открыто — тап мимо просто закрывает его
  if (f.menu != null) {
    f.menu = null;
    flexiDraw();
    return;
  }
  // тап по точке-предложению — она становится разрезом
  const q = f.showSugg && flexiHitSugg(f, d.x0, d.y0);
  if (q) { flexiAddCut(f, q.P[0], q.P[1], q.br, false); return; }
  // тап по фигурке — разрез поперёк ветви в ближайшей точке скелета
  const [mx, my] = flexiToModel(d.x0, d.y0);
  if (flexiOnModel(f, mx, my)) flexiAddCut(f, mx, my, null, true);
}

function flexiRemoveMenu() {
  const f = state.flexi;
  const c = f && f.menu != null && f.cuts.find((x) => x.id === f.menu);
  if (!c) return;
  haptic();
  flexiManual(f);
  flexiDropCut(f, c);
}

function flexiReset() {
  const f = state.flexi;
  if (!f || !f.cuts.length) return;
  haptic();
  flexiManual(f);
  f.cuts.slice().forEach((c) => flexiDropCut(f, c, false));
  f.menu = null;
  flexiDraw();
}

// «Поставить автоматически»: ручные правки сбрасываются, автосборка — заново.
function flexiSuggestBtn() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  haptic();
  f.showSugg = false;
  f.menu = null;
  f.resultCuts = null;
  flexiAuto(f);
}

/* ---------- Настройки на экране ---------- */

// «Размер: 15 см» вверху экрана и на кнопке — длина фигурки, на которую рассчитаны суставы.
function flexiShowDim(f) {
  const t = 'Размер: ' + String(Math.round(f.length) / 10).replace('.', ',') + ' см';
  $('flexi-dim').textContent = t;
  $('flexi-size-label').textContent = t;
}

function flexiRenderSettings() {
  const f = state.flexi;
  if (!f) return;
  flexiShowDim(f);
  $('flexi-length').value = String(f.length);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-size').hidden = f.length >= 150;
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.v) === f.g));
  $('flexi-k').value = String(f.k);
  $('flexi-kb').value = String(f.kBody);
  $('flexi-kb-val').textContent = f.kBody.toFixed(1);
  $('flexi-k-val').textContent = f.k.toFixed(1);
  $('flexi-aseg').value = String(f.alphaSeg);
  $('flexi-aseg-val').textContent = '±' + f.alphaSeg + '°';
}

function flexiOnLength() {
  const f = state.flexi;
  if (!f) return;
  f.length = Number($('flexi-length').value);
  flexiShowDim(f);
  $('flexi-length-val').textContent = f.length + ' мм';
  $('flexi-size').hidden = f.length >= 150;
  flexiSchedulePrepare();
}

function flexiSchedulePrepare() {
  const f = state.flexi;
  if (!f || !f.prep) return;
  if (!f.manual) {
    // поставленные автоматически — на новом размере ставятся заново
    f.autoRun++;
    f.cuts.slice().forEach((c) => flexiDropCut(f, c, false));
  } else {
    // ручные — сохраняются и едут вместе с моделью; проверятся заново, когда модель пересчитается
    f.cuts.forEach((c) => { c.ver = ++f.verSeq; c.st = 'wait'; c.why = ''; });
  }
  f.resultCuts = null; // результат был на другом размере
  flexiInvalidate();
  flexiDraw();
  clearTimeout(f.prepTimer);
  f.prepTimer = setTimeout(() => flexiPrepare(f, false), 450);
}

// «Сделать крупнее» на экране «Не получилось»: +40 мм — и автосборка заново.
function flexiBigger() {
  const f = state.flexi;
  if (!f || !f.prep || f.length >= 250) return;
  haptic();
  f.length = Math.min(250, f.length + 40);
  f.manual = false;
  flexiRenderSettings();
  flexiSchedulePrepare();
}

/* ---------- Сборка ---------- */

function flexiBuildCall(f) {
  clearTimeout(f.prepTimer);
  f.menu = null;
  return flexiCall(f, { type: 'build', opts: flexiOpts(f), cuts: f.cuts.map(flexiCutMsg) });
}

function flexiBuildErrorText(err) {
  return err && err.code === 'worker'
    ? 'Сборщик не запустился на этом телефоне. Обнови Telegram и попробуй ещё раз'
    : flexiCap((err && err.message) || String(err));
}

// Ошибки сборки — красными на своих шарнирах (ничего не пропускается молча). Возвращает их список.
function flexiMarkBuildErrors(f, r) {
  const errors = r.notes.filter((x) => x.level === 'error');
  errors.forEach((x) => {
    const c = x.id != null && f.cuts.find((q) => q.id === x.id);
    if (c) { c.st = 'bad'; c.why = x.why; }
  });
  return errors;
}

// «Готово» в ручном редакторе: красные пропускаем (их причины — в «Где не получилось»), по зелёным собираем
// и показываем, как шевелится. Не собралось — остаёмся в редакторе с красными шарнирами.
async function flexiBuild() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  if (!flexiCanBuild(f)) {
    toast(f.cuts.some((c) => c.st === 'wait') ? 'Подожди, проверяю шарниры' : f.cuts.length ? 'Ни один шарнир не получился — поставь в другом месте' : 'Тапни по фигурке там, где она должна гнуться');
    return;
  }
  haptic();
  flexiManual(f);
  f.cuts.filter((c) => flexiCutState(f, c) !== 'ok').forEach((c) => {
    flexiMiss(f, c, flexiCutWhy(f, c));
    flexiDropCut(f, c, false);
  });
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Собираю подвижную модель…';
  let r;
  try {
    r = await flexiBuildCall(f);
  } catch (err) {
    state.flexiBusy = false;
    $('busy').hidden = true;
    if (state.flexi !== f || (err && err.code === 'cancelled')) return;
    hapticNotify('error');
    alertBox('Не получилось собрать. ' + flexiBuildErrorText(err));
    return;
  }
  state.flexiBusy = false;
  $('busy').hidden = true;
  if (state.flexi !== f) return;
  if (flexiMarkBuildErrors(f, r).length) {
    flexiDraw();
    hapticNotify('error');
    toast('Не все шарниры получились — причина под картинкой');
    return;
  }
  flexiShowResult(f, r);
}

/* ---------- Автосборка: шарниры в лучших местах без единого тапа ---------- */

const flexiSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём, пока у всех разрезов закончится проверка (st не «wait»). onProgress(готово, всего) — для шага на экране.
async function flexiSettle(f, onProgress) {
  for (let i = 0; i < 2000; i++) {
    if (state.flexi !== f) return false;
    const waiting = f.cuts.filter((c) => c.st === 'wait');
    if (onProgress) onProgress(f.cuts.length - waiting.length, f.cuts.length);
    if (!waiting.length) return true;
    // проверка потерялась (модель пересчитали) — ставим разрез заново
    waiting.forEach((c) => { if (!c.placing) flexiPlace(f, c, c.P[0], c.P[1], c.br, false, false); });
    await Promise.race(waiting.map((c) => c.busy).filter(Boolean).concat(flexiSleep(1500)));
  }
  return false;
}

// Где не получилось: место и причина — для «Где не получилось» и экрана «Не получилось».
function flexiMiss(f, c, why) {
  f.missed.push({ place: flexiPlaceName(f, c), why: why || c.why || flexiCutWhy(f, c) });
}

// Красные убрать (причины запомнить), из стоящих слишком близко оставить первый по порядку сборки.
// Убрали разрез — следующие на той же цепочке проверяются заново, поэтому по кругу, пока всё не устоится.
async function flexiPrune(f, alive, onProgress) {
  for (let round = 0; round < 8; round++) {
    if (!(await flexiSettle(f, onProgress)) || !alive()) return false;
    const bad = f.cuts.filter((c) => c.st === 'bad');
    if (bad.length) {
      bad.forEach((c) => { flexiMiss(f, c, c.why); flexiDropCut(f, c); });
      continue;
    }
    const kept = [];
    const near = [];
    flexiOrdered(f).forEach((c) => (kept.some((o) => f.core.tooClose(c, o)) ? near : kept).push(c));
    if (!near.length) return true;
    near.forEach((c) => flexiDropCut(f, c));
  }
  return alive();
}

// §2: точки автопоиска → каждую проверить → красные убрать → собрать → показать, как шевелится.
// «Назад», новый размер или ручная правка увеличивают f.autoRun — тогда этот проход тихо заканчивается.
async function flexiAuto(f) {
  const run = ++f.autoRun;
  const alive = () => state.flexi === f && f.autoRun === run;
  f.manual = false;
  f.missed = [];
  f.built = null;
  f.stale = true;
  f.resultCuts = null;
  $('flexi-saved').hidden = true;
  flexiShow(f, 'auto');
  flexiStep('find', 'Ищу, где фигурка должна гнуться…');
  if (!f.sugg) await flexiSuggest(f);
  if (!alive()) return;
  f.cuts.slice().forEach((c) => flexiDropCut(f, c, false));
  (f.sugg || []).forEach((q) => flexiAddCut(f, q.P[0], q.P[1], q.br, true, true));
  const progress = (done, n) => { if (alive()) flexiStep('check', 'Проверяю шарниры… (' + done + ' из ' + n + ')'); };
  if (!(await flexiPrune(f, alive, progress)) || !alive()) return;
  if (!f.cuts.length) {
    flexiShowFail(f);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    flexiStep('build', 'Собираю подвижную модель…');
    let r;
    try {
      r = await flexiBuildCall(f);
    } catch (err) {
      if (!alive() || (err && err.code === 'cancelled')) return;
      flexiShowFail(f, 'Не получилось собрать', [{ text: flexiBuildErrorText(err), tip: '' }]);
      return;
    }
    if (!alive()) return;
    const errors = r.notes.filter((x) => x.level === 'error');
    if (!errors.length) {
      flexiShowResult(f, r);
      return;
    }
    if (attempt === 0) {
      // эти шарниры при сборке не получились — убираем и собираем ещё раз
      errors.forEach((x) => {
        const c = x.id != null && f.cuts.find((q) => q.id === x.id);
        if (c) { flexiMiss(f, c, x.why); flexiDropCut(f, c); }
      });
      if (!(await flexiPrune(f, alive, progress)) || !alive()) return;
      if (!f.cuts.length) {
        flexiShowFail(f);
        return;
      }
      continue;
    }
    // и второй раз не собралось — показываем редактор с красными шарнирами
    flexiMarkBuildErrors(f, r);
    f.manual = true;
    flexiShow(f, 'editor');
    hapticNotify('error');
    toast('Не все шарниры получились — причина под картинкой');
  }
}

// После подготовки (открыли, поменяли размер): автосборка — или ручные шарниры на новом размере.
async function flexiAfterPrepare(f) {
  if (!f.manual) {
    flexiAuto(f);
    return;
  }
  if (f.mode === 'editor' || !f.cuts.length) {
    flexiShow(f, 'editor');
    return;
  }
  // ручные шарниры: проверить на новом размере, всё зелёное — собрать, иначе — в редактор
  const run = ++f.autoRun;
  const alive = () => state.flexi === f && f.autoRun === run;
  flexiShow(f, 'auto');
  const ok = await flexiSettle(f, (done, n) => { if (alive()) flexiStep('check', 'Проверяю шарниры… (' + done + ' из ' + n + ')'); });
  if (!ok || !alive()) return;
  if (!flexiCanBuild(f)) {
    flexiShow(f, 'editor');
    toast('На новом размере не все шарниры получились — причина под картинкой');
    return;
  }
  flexiStep('build', 'Собираю подвижную модель…');
  let r;
  try {
    r = await flexiBuildCall(f);
  } catch (err) {
    if (!alive() || (err && err.code === 'cancelled')) return;
    flexiShowFail(f, 'Не получилось собрать', [{ text: flexiBuildErrorText(err), tip: '' }]);
    return;
  }
  if (!alive()) return;
  if (flexiMarkBuildErrors(f, r).length) {
    flexiShow(f, 'editor');
    toast('Не все шарниры получились — причина под картинкой');
    return;
  }
  flexiShowResult(f, r);
}

/* ---------- Экраны: шаги, «Не получилось», результат, редактор ---------- */

const FLEXI_STEPS = ['load', 'find', 'check', 'build'];

function flexiStep(step, text) {
  const i = FLEXI_STEPS.indexOf(step);
  document.querySelectorAll('#flexi-steps li').forEach((li, k) => {
    li.classList.toggle('is-done', k < i);
    li.classList.toggle('is-now', k === i);
  });
  if (text) $('flexi-status-text').textContent = text;
}

function flexiShow(f, mode) {
  f.mode = mode;
  const steps = mode === 'load' || mode === 'auto';
  $('flexi-status').hidden = !steps;
  $('flexi-fail').hidden = mode !== 'fail';
  $('flexi-result').hidden = mode !== 'result';
  $('flexi-editor').hidden = mode !== 'editor';
  $('flexi-size-block').hidden = !(mode === 'result' || mode === 'editor');
  $('flexi-print').hidden = mode !== 'result';
  if (mode !== 'result') flexiSetWiggle(false);
  if (mode === 'editor') {
    flexiLayoutCanvas();
    flexiDraw();
  }
  flexiUpdateMainButton();
}

// «Не получилось поставить шарниры»: почему — простыми словами, и что можно сделать.
function flexiShowFail(f, title, lines) {
  flexiShow(f, 'fail');
  $('flexi-fail-title').textContent = title || 'Не получилось поставить шарниры';
  const list = lines || flexiExplainAll(f.missed);
  if (!list.length) {
    list.push((f.sugg || []).length
      ? { text: 'Шарниры не прошли проверку', tip: 'Сделай фигурку крупнее или поставь шарниры вручную' }
      : { text: 'Не нашёл, где фигурка может гнуться', tip: 'Подвижными получаются фигурки с шеей, лапами и хвостом — ящерица, дракон, осьминог' });
  }
  if (f.data && f.data.flexi === false && !lines) list.unshift(flexiExplain('поза', ''));
  const box = $('flexi-fail-why');
  box.textContent = '';
  list.forEach((x) => box.appendChild(flexiExplainEl(x, 'is-warn')));
  $('flexi-bigger').hidden = f.length >= 250 || !f.prep;
  hapticNotify('warning');
  window.scrollTo(0, 0);
}

// Готово: большое превью сверху, фигурка сама шевелится; ниже — что сделано и где не получилось.
function flexiShowResult(f, r) {
  f.built = Object.assign(r, { errors: [] });
  f.builtLength = f.length;
  f.stale = false;
  $('flexi-saved').hidden = true;
  flexiShow(f, 'result');
  flexiRenderResult(f);
  f.previewReady = flexiShowPreview(f).then(() => {
    if (state.flexi === f && f.mode === 'result') flexiSetWiggle(true);
  });
  hapticNotify('success');
  window.scrollTo(0, 0);
}

function flexiRenderResult(f) {
  const b = f.built;
  const info = flexiCutsInfo(f, f.cuts);
  const n = f.cuts.length;
  $('flexi-summary').textContent = (f.manual ? 'Шарниров: ' + n + (info.parts ? ' — ' : '') : 'Поставил ' + flexiJoints(n) + (info.parts ? ': ' : '')) +
    info.parts + '. Гнётся до ±' + info.bend + '°';
  $('flexi-parts').textContent = 'Файл STL · ' + cadMm(b.stl.byteLength / 1048576) + ' МБ';
  // где не получилось + предупреждения сборки (жёлтым, это не ошибки)
  const lines = flexiMissedLines(f);
  b.notes.filter((x) => x.level === 'warn').forEach((x) => {
    const c = x.id != null && f.cuts.find((q) => q.id === x.id);
    lines.push(flexiExplain(String(x.text).replace(/^Разрез[^:]*:\s*/, ''), c ? flexiPlaceName(f, c) : ''));
  });
  const box = $('flexi-missed-list');
  box.textContent = '';
  lines.forEach((x) => box.appendChild(flexiExplainEl(x, 'is-warn')));
  $('flexi-missed').hidden = !lines.length;
}

// «Изменить шарниры»: ручной редактор с уже стоящими шарнирами. Шарниры результата запоминаем — для «Назад».
function flexiOpenEditor() {
  const f = state.flexi;
  if (!f || !f.prep || state.flexiBusy) return;
  haptic();
  f.autoRun++;
  f.resultCuts = f.built && !f.stale ? f.cuts.map((c) => Object.assign({}, c)) : null;
  f.resultManual = f.manual;
  f.menu = null;
  flexiShow(f, 'editor');
  window.scrollTo(0, 0);
}

// «Назад» в редакторе — к результату, правки шарниров не применяются. false — закрыть экран.
function flexiBack() {
  const f = state.flexi;
  if (!f || f.mode !== 'editor' || !f.resultCuts || !f.built || f.builtLength !== f.length) return false;
  if (f.stale) {
    f.cuts.forEach((c) => flexiPost(f, { type: 'drop', key: c.id, ver: c.ver = ++f.verSeq }));
    f.cuts = f.resultCuts.map((c) => Object.assign({}, c, { ver: ++f.verSeq, placing: 0, busy: null }));
    f.manual = f.resultManual;
    f.stale = false;
  }
  f.menu = null;
  flexiShow(f, 'result');
  flexiSetWiggle(true);
  window.scrollTo(0, 0);
  return true;
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

  const b = f.built;
  const geoms = b.parts.map((p) => flexiGeometry(T, p));
  const depthOfPart = (p) => { let d = 0; for (let x = p.joint; x >= 0; x = b.joints[x].parent) d++; return d; };
  const mats = b.parts.map((p) => new T.MeshStandardMaterial({ color: FLEXI_COLORS[depthOfPart(p) % 2], roughness: 0.8, metalness: 0 }));

  // «Собранная»: иерархия суставов — лапа поворачивается вокруг вертикали через P вместе с вложенными звеньями
  const assembled = new T.Group();
  const pivots = [];
  const holder = [];
  const depthOf = (j) => { let d = 0; for (let x = j; x >= 0; x = b.joints[x].parent) d++; return d; };
  const mkHolder = (j) => {
    if (holder[j]) return holder[j];
    const J = b.joints[j];
    const parentHolder = J.parent >= 0 ? mkHolder(J.parent) : assembled;
    const pivot = new T.Group();
    pivot.position.set(J.P[0], J.P[1], 0);
    const inner = new T.Group();
    inner.position.set(-J.P[0], -J.P[1], 0);
    pivot.add(inner);
    parentHolder.add(pivot);
    pivots.push({ pivot, alpha: J.alpha * Math.PI / 180, depth: depthOf(j), chain: Math.max(0, J.chain), spine: !!J.spine, s: J.s || 0 });
    holder[j] = inner;
    return inner;
  };
  const box = new T.Box3();
  const meshes = [];
  b.parts.forEach((p, i) => {
    geoms[i].computeBoundingBox();
    box.union(geoms[i].boundingBox);
    const mesh = new T.Mesh(geoms[i], mats[i]);
    meshes.push(mesh);
    (p.joint >= 0 ? mkHolder(p.joint) : assembled).add(mesh);
  });
  scene.add(assembled);

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
  controls.minDistance = radius * 0.4;
  controls.maxDistance = radius * 12;
  controls.update();
  // палец вверх-вниз по превью листает страницу (превью не дёргается), вбок — крутит фигурку, щипок — приближает
  renderer.domElement.style.touchAction = 'pan-y';

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
  const loop = (now) => {
    flexiPrev.raf = requestAnimationFrame(loop);
    if (state.flexi && state.flexi.mode !== 'result') return; // превью спрятано (редактор, шаги) — не рисуем
    if (flexiPrev.wiggle) {
      const t = (now - flexiPrev.t0) / 1000;
      // волна: каждое звено качается на ±α, дальние от тела — со сдвигом фазы
      // позвоночник — волна от головы к хвосту (по месту звена вдоль позвоночника), лапы — от тела к кончикам
      pivots.forEach((p) => { p.pivot.rotation.z = Math.sin(t * 2.4 - (p.spine ? p.s * 0.06 : p.depth * 0.8 + p.chain * 1.3)) * p.alpha; });
    }
    controls.update();
    renderer.render(scene, camera);
  };
  flexiPrev.raf = requestAnimationFrame(loop);
  flexiPrev.v = { T, renderer, scene, camera, controls, geoms, mats, pivots, center, radius, dist, assembled, box };
  flexiSetWiggle(false); // шевелить начинает экран результата
}

function flexiGeometry(T, p) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(p.vert, 3));
  g.setIndex(new T.BufferAttribute(p.tri, 1));
  const flat = g.toNonIndexed(); // нормали по граням
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

function flexiSetWiggle(on) {
  flexiPrev.wiggle = on;
  flexiPrev.t0 = performance.now();
  if (!on && flexiPrev.v) flexiPrev.v.pivots.forEach((p) => { p.pivot.rotation.z = 0; });
  $('flexi-wiggle').textContent = on ? '⏸ Остановить' : '▶ Пошевелить';
}

function flexiDestroyPreview() {
  cancelAnimationFrame(flexiPrev.raf);
  if (flexiPrev.ro) flexiPrev.ro.disconnect();
  flexiPrev.ro = null;
  const v = flexiPrev.v;
  flexiPrev.v = null;
  if (!v) return;
  v.controls.dispose();
  v.geoms.forEach((g) => g.dispose());
  v.mats.forEach((m) => m.dispose());
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

// Снимок 800×800: вид 3/4 сверху, светлый фон, звенья в покое.
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

/* ---------- Сохранить STL: подвижная модель — новой работой в «Мои работы» ---------- */

function flexiReady(f) {
  return !!(f && f.built && !f.stale && !f.built.errors.length && f.built.joints.length);
}

// Главная кнопка Телеги — только на экране результата: «Сохранить подвижную модель».
// Пока идёт автосборка, на «Не получилось» и в редакторе (там своя «Готово») — скрыта.
function flexiUpdateMainButton() {
  const f = state.flexi;
  if (!f) return;
  if (!f.prep || f.mode !== 'result') {
    tg.MainButton.hide();
    return;
  }
  const ready = flexiReady(f);
  tg.MainButton.setParams(Object.assign({
    text: 'Сохранить подвижную модель',
    is_visible: true,
    is_active: ready,
  }, mainButtonColors(ready)));
}

async function flexiExport() {
  const f = state.flexi;
  if (f && f.previewReady) await f.previewReady; // снимок делаем из превью
  if (!flexiReady(f) || state.flexiBusy || !flexiPrev.v || f.mode !== 'result') return;
  haptic();
  const bytes = f.built.stl;
  if (bytes.byteLength > FLEXI_MAX_FILE) {
    hapticNotify('error');
    alertBox('Модель слишком подробная — файл больше 12 МБ');
    return;
  }
  state.flexiBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Сохраняю…';
  let r;
  try {
    let snapshot = '';
    try { snapshot = flexiSnapshot(); } catch (e) { /* без снимка */ }
    r = await cadPost({
      a: 'flexi', id: f.id, file: await cadBlobToDataUrl(bytes), snapshot,
      caption: 'Не меняй размер в программе для печати — шарниры рассчитаны на этот размер', // подпись к файлу, если его отправят в Telegram
    }, 120000);
  } catch (e) {
    r = { status: 0, data: null };
  }
  state.flexiBusy = false;
  $('busy').hidden = true;
  if (cadIsAuth(r)) {
    sessionExpired();
  } else if (r.data && r.data.ok === true) {
    hapticNotify('success');
    loadMe(false);
    // { ok, id } — номер новой работы; сервер кладёт её в проект исходной модели
    if (state.flexi === f && r.data.id != null) {
      const base = findOrder(f.id);
      showSavedWork($('flexi-saved'), String(r.data.id), {
        kind: 'model', mode: '3d', format: 'stl', jointed: true, size_mm: Math.round(f.length),
        title: (f.data && f.data.title) || (base && base.title) || 'Фигурка', project: (base && base.project) || '',
        has_file: true, has_preview: true,
      });
    } else if (state.flexi === f) {
      toast('Сохранено в «Мои работы»');
    }
  } else {
    hapticNotify('error');
    alertBox('Не вышло, попробуй ещё раз');
  }
}

/* ---------- Кнопки ---------- */

function bindFlexi() {
  bindSavedWork($('flexi-saved'), closeFlexi);
  const canvas = $('flexi-canvas');
  canvas.addEventListener('pointerdown', flexiPointerDown);
  canvas.addEventListener('pointermove', flexiPointerMove);
  canvas.addEventListener('pointerup', flexiPointerUp);
  canvas.addEventListener('pointercancel', flexiPointerUp);
  $('flexi-pop-remove').addEventListener('click', flexiRemoveMenu);
  $('flexi-suggest').addEventListener('click', flexiSuggestBtn);
  $('flexi-reset').addEventListener('click', flexiReset);
  $('flexi-length').addEventListener('input', flexiOnLength);
  $('flexi-edit').addEventListener('click', flexiOpenEditor);
  $('flexi-bigger').addEventListener('click', flexiBigger);
  $('flexi-manual').addEventListener('click', () => {
    const f = state.flexi;
    if (!f || !f.prep) return;
    haptic();
    f.manual = true;
    f.resultCuts = null;
    flexiShow(f, 'editor');
    window.scrollTo(0, 0);
  });
  $('flexi-size-btn').addEventListener('click', () => {
    haptic();
    const box = $('flexi-size-box');
    box.hidden = !box.hidden;
    $('flexi-size-btn').setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    if (!box.hidden) setTimeout(() => box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
  });

  const withF = (fn) => (e) => { const f = state.flexi; if (f) fn(f, e); };
  document.querySelectorAll('#flexi-gap button').forEach((b) => b.addEventListener('click', withF((f) => {
    haptic();
    f.g = Number(b.dataset.v);
    flexiSettingChanged(true);
  })));
  // длина звена и звенья тела — шаг предложений; гибкость меняет сам сустав — разрезы проверяются заново
  let sliderTimer = 0;
  const slider = (id, apply, recheck) => $(id).addEventListener('input', withF((f) => {
    apply(f, Number($(id).value));
    flexiRenderSettings();
    if (recheck) flexiInvalidate();
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => { if (state.flexi === f) flexiSettingChanged(recheck); }, 350);
  }));
  slider('flexi-k', (f, v) => { f.k = v; }, false);
  slider('flexi-kb', (f, v) => { f.kBody = v; }, false);
  slider('flexi-aseg', (f, v) => { f.alphaSeg = v; }, true);

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
  const m = (location.search + location.hash).match(/[?#&]flexi=([\w-]+)/); // в ?mock=1 номера вида o14
  return m ? m[1] : null;
}
