/* Грава — все запросы к серверу. Других мест, где приложение ходит в API, нет.
   Авторизацию добавляет одна функция authParams(): сейчас это initData Телеги, потом — токен сайта.
   ?mock=1 — сервер не нужен: ответы сочиняются тут же (для проверки экранов). */
'use strict';

const API_BASE = 'https://engrave.app.n8n.cloud/webhook/';
const API = API_BASE + 'grava-app';
const JOB_API = API_BASE + 'grava-app-job';
const EDIT_API = API_BASE + 'grava-app-edit';
const CAD_API = API_BASE + 'grava-app-cad';
const MOCK = /[?&]mock=1(&|$)/.test(location.search);

class ApiError extends Error {
  constructor(code, data) {
    super(code);
    this.code = code;
    this.data = data || null;
  }
}

function authParams() {
  return { initData: tg.initData };
}

function apiUrl(params) {
  const all = Object.assign({}, params, authParams());
  return API + '?' + Object.keys(all).map((k) => k + '=' + encodeURIComponent(all[k])).join('&');
}

// Без своих заголовков — так браузер не делает лишний CORS-запрос.
async function fetchWithTimeout(url, ms, outerSignal, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
  } catch (e) {
    if (outerSignal && outerSignal.aborted) throw e;
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

const isAuth = (status, data) => status === 401 || status === 403 || !!(data && data.error === 'auth');

async function api(params, timeoutMs) {
  if (MOCK) return mockGet(params);
  const res = await fetchWithTimeout(apiUrl(params), timeoutMs || 20000);
  let data = null;
  try { data = await res.json(); } catch (e) { /* не JSON */ }
  if (isAuth(res.status, data)) throw new ApiError('auth');
  if (!res.ok || !data || data.ok !== true) throw new ApiError((data && data.error) || 'http_' + res.status, data);
  return data;
}

// POST формой (URLSearchParams → form-urlencoded): простой запрос, без CORS-preflight.
// Ошибки не бросает — отдаёт { status, data }, status 0 — нет связи.
async function postForm(url, params, timeoutMs) {
  if (MOCK) return mockPost(url, params);
  let status = 0;
  let data = null;
  try {
    const body = new URLSearchParams(Object.assign({}, authParams(), params));
    const res = await fetchWithTimeout(url, timeoutMs, null, { method: 'POST', body });
    status = res.status;
    try { data = await res.json(); } catch (e) { /* не JSON */ }
  } catch (e) {
    status = 0;
  }
  return { status, data };
}

const Api = {
  mock: MOCK,

  me: () => api({ a: 'me' }),

  // Новый заказ. Тело — payload=<JSON>, тип form-urlencoded: тоже без preflight.
  async createJob(data) {
    if (MOCK) return mockCreate(data);
    const json = JSON.stringify(Object.assign({}, data, authParams()));
    const body = new Blob(['payload=' + encodeURIComponent(json)], { type: 'application/x-www-form-urlencoded' });
    const res = await fetchWithTimeout(JOB_API, 90000, null, { method: 'POST', body });
    let out = null;
    try { out = await res.json(); } catch (e) { /* не JSON */ }
    if (isAuth(res.status, out)) throw new ApiError('auth');
    if (!out || out.ok !== true || !out.job_id) throw new ApiError((out && out.error) || 'http_' + res.status, out);
    return out;
  },

  jobStatus: (id) => api({ a: 'job', id }, 15000),

  fileUrl: (id, what) => (MOCK ? mockFileUrl(id, what) : apiUrl({ a: 'file', what, id })),

  send: (id) => api({ a: 'send', id }, 45000),

  buy: (pack) => api({ a: 'buy', pack: pack.id }),

  cad: (id) => api({ a: 'cad', id }),

  flexi: (id) => api({ a: 'flexi', id }),

  // Черновик из чата: бот больше не принимает заказы, а сохраняет текст и фото сюда.
  // { draft: { text, photos, at, age_sec } } или { draft: null }.
  chatDraft: () => api({ a: 'chatdraft' }),

  chatDraftPhotoUrl: (i) => (MOCK ? mockDraftPhotoUrl(i) : apiUrl({ a: 'chatdraft', id: i })),

  // Фото черновика как blob — дальше то же сжатие, что и у выбранных фото.
  async chatDraftPhoto(i) {
    const res = await fetchWithTimeout(Api.chatDraftPhotoUrl(i), 30000);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.indexOf('json') !== -1) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* не JSON */ }
      if (isAuth(res.status, data)) throw new ApiError('auth');
      throw new ApiError((data && data.error) || 'http_' + res.status, data);
    }
    return res.blob();
  },

  // Файл или картинка с сервера: отдаёт Response, если пришёл файл, иначе бросает ApiError.
  async download(params, timeoutMs, signal) {
    const res = MOCK ? await mockDownload(params) : await fetchWithTimeout(apiUrl(params), timeoutMs, signal);
    const type = res.headers.get('content-type') || '';
    if (res.status === 401 || !res.ok || type.indexOf('json') !== -1) {
      let data = null;
      try { data = await res.json(); } catch (e) { /* не JSON */ }
      if (isAuth(res.status, data)) throw new ApiError('auth');
      throw new ApiError((data && data.error) || 'http_' + res.status, data);
    }
    return res;
  },

  // Редактор картинок: правка нейронкой или «как есть».
  edit: (params, timeoutMs) => postForm(EDIT_API, params, timeoutMs),

  // Конструктор деталей и сборщик шарниров: файл в чат, починка, «открыта эта деталь».
  cadPost: (params, timeoutMs) => postForm(CAD_API, params, timeoutMs),

  isAuth: (r) => isAuth(r.status, r.data),
};

/* ---------- ?mock=1: сервер-понарошку ---------- */

const MOCK_KEY = 'grava.mock';
const MOCK_ORDER_KIND = {
  laser_new: 'laser', laser_photo: 'laser', laser_edit: 'laser', laser_resize: 'laser',
  sketch: 'sketch', sketch_photo: 'sketch', sketch_edit: 'sketch',
  model: 'model', model_format: 'model', scan: 'model',
  cad: 'cad', cad_edit: 'cad',
};
const MOCK_IMAGE_KINDS = ['laser_new', 'laser_photo', 'laser_edit', 'sketch', 'sketch_photo', 'sketch_edit'];

let mockDb = null;

function mockState() {
  if (mockDb) return mockDb;
  try { mockDb = JSON.parse(sessionStorage.getItem(MOCK_KEY)); } catch (e) { mockDb = null; }
  if (!mockDb) {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
    mockDb = {
      seq: 100,
      jobs: {},
      // ?mockphotos=0|1|… — сколько фото в черновике из чата (по умолчанию 2)
      chatdraft: {
        text: 'Дракон сидит на скале, крылья раскрыты, хвост свисает вниз. Хочу на полку, примерно 15 см, чтобы было видно чешую на спине и шипы на хвосте',
        photos: mockDraftPhotos(),
        at: new Date(Date.now() - 40000).toISOString(),
        age_sec: 40,
      },
      me: {
        ok: true, balance: 7, free_left: 2, free_per_day: 3, free_3d: true, free_cad: true, models_left: 0,
        prices: { image: 1, model: 5, cad: 2, cad_edit: 1 },
        packs: [{ id: 'p10', credits: 10, stars: 200 }, { id: 'p30', credits: 30, stars: 500 }],
        one_model: { id: 'one', stars: 100 },
        drafts: { sketch: 'v1', drawing: 'v1' },
        orders: [
          { id: 'o5', kind: 'sketch', sketch: true, mode: '3d_flexi', '3d_flexi': true, title: 'Ящерица', date: day(0), has_preview: true, has_file: false, editable: true },
          { id: 'o4', kind: 'model', mode: '3d', title: 'Котик', format: 'stl', size_mm: 80, date: day(1), has_file: true, has_preview: true, editable: true },
          { id: 'o3', kind: 'laser', mode: 'laser', title: 'Волк воет на луну', size_mm: 150, date: day(2), has_file: true, has_preview: true, editable: true },
          { id: 'o2', kind: 'cad', mode: 'cad', title: 'Пластина 50×30×3', date: day(3), has_file: false, has_preview: false },
        ],
      },
    };
    mockSave(); // сервер-понарошку живёт всю сессию: после перезагрузки тот же черновик и те же работы
  }
  return mockDb;
}

function mockSave() {
  try { sessionStorage.setItem(MOCK_KEY, JSON.stringify(mockDb)); } catch (e) { /* ок */ }
}

const mockWait = (ms) => new Promise((r) => setTimeout(r, ms));
const mockCopy = (x) => JSON.parse(JSON.stringify(x));

async function mockGet(params) {
  await mockWait(250);
  const db = mockState();
  if (params.a === 'me') return mockCopy(db.me);
  if (params.a === 'chatdraft') return { ok: true, draft: db.chatdraft ? mockCopy(db.chatdraft) : null };
  if (params.a === 'job') return mockStatus(params.id);
  if (params.a === 'send') return { ok: true };
  if (params.a === 'cad') {
    const o = db.me.orders.find((x) => x.id === params.id);
    if (!o) throw new ApiError('not_found');
    return {
      ok: true, id: o.id, title: o.title, format: 'stl', fixes_left: 2,
      scad: '/* [Размеры] */\n// Длина, мм\nlength = 50; // [10:200]\n// Ширина, мм\nwidth = 30; // [10:200]\n// Толщина, мм\nthick = 3; // [1:20]\n\ncube([length, width, thick]);\n',
    };
  }
  throw new ApiError(params.a === 'buy' ? 'mock' : 'not_found');
}

async function mockPost() {
  await mockWait(400);
  return { status: 200, data: { ok: true } };
}

async function mockCreate(data) {
  await mockWait(350);
  const db = mockState();
  if (!MOCK_ORDER_KIND[data.kind]) throw new ApiError('kind');
  const job = 'j' + (++db.seq);
  db.jobs[job] = { data: Object.assign({}, data, { images: (data.images || []).length }), polls: 0, started: Date.now() };
  mockSave();
  return { ok: true, job_id: job };
}

// Списываем, как настоящий сервер: бесплатные → подарки → кредиты. false — не хватило.
function mockCharge(me, kind) {
  const p = me.prices;
  if (kind === 'laser_resize' || kind === 'model_format') return true;
  let cost = 0;
  if (MOCK_IMAGE_KINDS.indexOf(kind) !== -1) {
    if (me.free_left > 0) { me.free_left--; return true; }
    cost = p.image;
  } else if (kind === 'model' || kind === 'scan') {
    if (me.free_3d) { me.free_3d = false; return true; }
    if (me.models_left > 0) { me.models_left--; return true; }
    cost = p.model;
  } else if (kind === 'cad') {
    if (me.free_cad) { me.free_cad = false; return true; }
    cost = p.cad;
  } else if (kind === 'cad_edit') {
    cost = p.cad_edit;
  }
  if (me.balance < cost) return false;
  me.balance -= cost;
  return true;
}

function mockStatus(id) {
  const db = mockState();
  const j = db.jobs[id];
  if (!j) throw new ApiError('not_found');
  const d = j.data;
  const seconds = Math.round((Date.now() - j.started) / 1000);
  const base = { ok: true, job_id: id, kind: d.kind, seconds };
  j.polls++;
  mockSave();
  if (j.polls < 3) return Object.assign(base, { status: 'running', text: '' });
  if (j.result) return j.result;

  const prompt = String(d.prompt || '').toLowerCase();
  if (prompt.indexOf('ошибк') !== -1) {
    j.result = Object.assign(base, { status: 'error', text: 'Нейронка не справилась. Кредиты вернул — попробуй ещё раз.' });
  } else if (prompt.indexOf('вопрос') !== -1) {
    j.result = Object.assign(base, { status: 'reply', text: 'Уточни, пожалуйста: какого размера нужна деталь?' });
  } else if (prompt.indexOf('кредит') !== -1 || !mockCharge(db.me, d.kind)) {
    j.result = Object.assign(base, { status: 'no_credits', text: 'Не хватает кредитов. Пополни баланс — и я сразу начну.' });
  } else {
    const order = mockOrder(db, d);
    db.me.orders.unshift(order);
    db.me.orders = db.me.orders.slice(0, 100);
    j.result = Object.assign(base, { status: 'done', text: 'Готово', order: mockCopy(order) });
  }
  mockSave();
  return j.result;
}

function mockOrder(db, d) {
  const kind = MOCK_ORDER_KIND[d.kind];
  const baseOrder = d.base_order ? db.me.orders.find((x) => x.id === d.base_order) : null;
  const latestModel = db.me.orders.find((x) => x.kind === 'model');
  const from = baseOrder || (d.kind === 'model_format' ? latestModel : null);
  const o = {
    id: 'o' + (++db.seq),
    kind,
    title: d.title || (from && from.title) || (d.kind === 'scan' ? 'Скан по фото' : 'Новая работа'),
    date: new Date().toISOString(),
    has_preview: kind !== 'cad',
    has_file: kind === 'laser' || kind === 'model',
    editable: kind === 'laser' || kind === 'sketch',
  };
  if (kind === 'sketch') {
    o.sketch = true;
    o.mode = d.flexi || (from && from.mode === '3d_flexi') ? '3d_flexi' : '3d';
    if (o.mode === '3d_flexi') o['3d_flexi'] = true;
  } else if (kind === 'laser') {
    o.mode = 'laser';
    o.size_mm = d.size_mm || (from && from.size_mm) || 150;
  } else if (kind === 'model') {
    o.mode = from && from.mode === '3d_flexi' ? '3d_flexi' : '3d';
    o.format = d.format || (from && from.format) || 'stl';
    o.size_mm = 100;
    o.flexi = o.mode === '3d_flexi' || d.flexi === true;
  } else {
    o.mode = 'cad';
  }
  return o;
}

const MOCK_COLORS = { sketch: '#f3e3c3', model: '#d7e6f5', laser: '#f5dcd0', cad: '#dfeedd' };
const MOCK_EMOJI = { sketch: '✏️', model: '🧊', laser: '🔥', cad: '📐' };

function mockFileUrl(id) {
  const o = mockState().me.orders.find((x) => x.id === String(id)) || { kind: 'laser', title: '?' };
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">'
    + '<rect width="512" height="512" fill="' + (MOCK_COLORS[o.kind] || '#eee') + '"/>'
    + '<circle cx="256" cy="220" r="130" fill="none" stroke="#333" stroke-width="10"/>'
    + '<text x="256" y="262" font-size="110" text-anchor="middle">' + (MOCK_EMOJI[o.kind] || '🔥') + '</text>'
    + '<text x="256" y="450" font-size="40" font-family="sans-serif" text-anchor="middle" fill="#333">' + esc(o.title) + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function mockDraftPhotos() {
  const m = location.search.match(/[?&]mockphotos=(\d+)/);
  return m ? Number(m[1]) : 2;
}

// Фото черновика — JPEG, нарисованный тут же: у каждого свой цвет.
const mockDraftPhotoCache = {};
function mockDraftPhotoUrl(i) {
  if (!mockDraftPhotoCache[i]) {
    const colors = ['#c9a27e', '#8fb3c9', '#a8c98f', '#c98fb3', '#c9c38f', '#8fc9c0'];
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 1200;
    const x = c.getContext('2d');
    x.fillStyle = colors[i % colors.length];
    x.fillRect(0, 0, 900, 1200);
    x.fillStyle = '#3a3a3a';
    x.beginPath();
    x.ellipse(450, 640, 260 - i * 30, 320, 0, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#ffffff';
    x.font = 'bold 90px sans-serif';
    x.textAlign = 'center';
    x.fillText('фото ' + (i + 1), 450, 200);
    mockDraftPhotoCache[i] = c.toDataURL('image/jpeg', 0.9);
  }
  return mockDraftPhotoCache[i];
}

// Кубик 40 мм в двоичном STL — чтобы «Покрутить в 3D» было что крутить.
function mockCubeStl() {
  const v = [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], [0, 0, 40], [40, 0, 40], [40, 40, 40], [0, 40, 40]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = new ArrayBuffer(84 + f.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, f.length, true);
  f.forEach((t, i) => {
    let o = 84 + i * 50 + 12;
    t.forEach((k) => v[k].forEach((c) => { dv.setFloat32(o, c, true); o += 4; }));
  });
  return buf;
}

async function mockDownload(params) {
  await mockWait(300);
  if (params.a === 'file' && params.what !== 'preview') {
    return new Response(mockCubeStl(), { headers: { 'content-type': 'application/octet-stream' } });
  }
  // картинка для редактора
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 768;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 768, 768);
  x.strokeStyle = '#333333';
  x.lineWidth = 14;
  x.beginPath();
  x.arc(384, 384, 220, 0, Math.PI * 2);
  x.stroke();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Response(blob, { headers: { 'content-type': 'image/png' } });
}
