/* Грава — литофания и барельеф по картинке. Без нейросети и бесплатно: STL считается прямо в телефоне.
   Литофания — тонкая пластина: светлое место тонкое, тёмное толстое, на просвет видна картинка.
   Барельеф — пластина-основа, а картинка на ней выпуклая, как на медали.
   Сетку считает litho-core.js в фоновом потоке litho-worker.js (не запустился — здесь же, тем же кодом).
   Использует помощники из app.js (state, $, loadThree…), cadPost/cadIsAuth/cadMm из cad.js. */
'use strict';

const LITHO_CORE_URL = './litho-core.js?v=1';
const LITHO_WORKER_URL = './litho-worker.js?v=1';
const LITHO_MAX_SIDE = 800;          // картинка → яркость: длинная сторона до 800 px
const LITHO_DEBOUNCE = 250;
const LITHO_MAX_FILE = 12 * 1024 * 1024;
const LITHO_SAVE_TIMEOUT = 90000;
const LITHO_NAMES = { litho: 'Литофания', relief: 'Барельеф' };
// толщина литофании, мм: в самом светлом месте — в самом тёмном
const LITHO_THICK = { thin: [0.6, 2.4], normal: [0.8, 3.0], dense: [1.0, 3.6] };
const LITHO_ABOUT = {
  litho: 'Тонкая пластина: светлое место тонкое, тёмное толстое. На просвет — у лампы или окна — видна картинка, как фотография',
  relief: 'Пластина-основа, а картинка на ней выпуклая, как на медали',
};
const LITHO_PRINT = {
  litho: 'Белый PLA, заполнение 100 %, слой 0,12–0,16 мм. Плоскую печатай стоя: в программе для печати поставь пластину на нижний край. Изогнутая уже стоит как надо.',
  relief: 'Печатай плашмя, рельефом вверх, слой 0,12 мм.',
};

function lithoDefaults() {
  return {
    mode: 'litho', width: 100, curve: 0, stand: false, thick: 'normal',
    lightUp: false, depth: 2.5, blur: 1, contrast: 1, gamma: 1, frame: true,
  };
}

/* ---------- Открыть / закрыть ---------- */

// opts.base — работа, по превью которой собираем; opts.src — фото из композера (data URL); opts.name — его подпись.
function openLitho(opts) {
  opts = opts || {};
  haptic();
  if (state.viewer) closeViewer();
  if (state.litho) lithoTeardown();
  const base = opts.base || null;
  const kind = base ? lithoKind(base) : '';
  const l = state.litho = {
    base,
    src: opts.src || null,
    from: viewKey(),            // экран «Создать», откуда открыли (новый проект — идём за сохранённой работой)
    name: lithoBaseName(base ? base.title : opts.name),
    title: '',
    titleEdited: false,
    set: Object.assign(lithoDefaults(), { mode: kind || 'litho' }),
    view: kind === 'relief' ? '3d' : 'light',
    img: null,                  // { luma, w, h } — яркость картинки 0..1
    res: null,                  // последний расчёт
    busy: false,
    again: false,
    running: null,
    timer: 0,
    scroll: window.scrollY,
  };
  l.title = lithoAutoTitle(l);
  $('litho-missing').hidden = true;
  $('litho-main').hidden = false;
  $('litho-saved').hidden = true;
  $('litho-name').value = l.title;
  $('litho-print').open = false;
  lithoRenderSettings();
  lithoStatus('loading', 'Загружаю картинку…');
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  lithoUpdateMainButton();

  lithoSource(l)
    .then((img) => {
      if (state.litho !== l) return;
      l.img = img;
      lithoRenderSettings();
      lithoStatus('loading', 'Считаю…');
      lithoRun(l);
    })
    .catch((err) => {
      if (state.litho !== l) return;
      const code = err && err.code;
      if (code === 'auth') {
        lithoShowMissing('Сессия устарела — перезапусти приложение', 'close');
        sessionExpired();
      } else if (code === 'network') {
        lithoShowMissing('Не получилось загрузить картинку. Проверь интернет и попробуй ещё раз', 'retry');
      } else {
        lithoShowMissing('Не получилось открыть картинку — выбери другую', 'back');
      }
    });
}

function lithoShowMissing(text, action) {
  $('litho-main').hidden = true;
  $('litho-missing').hidden = false;
  $('litho-missing-text').textContent = text;
  const btn = $('litho-missing-btn');
  btn.dataset.action = action;
  btn.textContent = action === 'retry' ? 'Попробовать ещё раз' : action === 'close' ? 'Закрыть' : 'Назад';
  lithoUpdateMainButton();
}

function closeLitho() {
  const l = state.litho;
  if (!l) return;
  lithoTeardown();
  state.litho = null;
  tg.MainButton.hideProgress();
  tg.MainButton.setParams(Object.assign({ is_active: true }, mainButtonColors(true)));
  tg.MainButton.hide();
  tg.BackButton.hide();
  $('busy').hidden = true;
  renderView();
  window.scrollTo(0, l.scroll || 0);
}

function lithoTeardown() {
  const l = state.litho;
  if (l) clearTimeout(l.timer);
  lithoDestroy3d();
}

/* ---------- Работы-литофании ---------- */

// 'litho' | 'relief' | '' — сделана ли работа здесь (в ?a=me у неё поле litho).
function lithoKind(o) {
  const v = o && (o.litho || (o.mode === 'litho' || o.mode === 'relief' ? o.mode : ''));
  return v === 'relief' ? 'relief' : v ? 'litho' : '';
}

// «Литофания: Котик» → «Котик»: собираем заново из литофании — без двойной приставки.
function lithoBaseName(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/^(литофания|барельеф)(\s*:\s*|$)/i, '').slice(0, 80);
}

function lithoAutoTitle(l) {
  const kind = LITHO_NAMES[l.set.mode];
  return l.name ? kind + ': ' + l.name : kind;
}

function lithoTitle(l) {
  const t = $('litho-name').value.replace(/\s+/g, ' ').trim();
  return (l.titleEdited && t ? t : lithoAutoTitle(l)).slice(0, 80);
}

/* ---------- Картинка → яркость ---------- */

async function lithoSource(l) {
  let blob;
  if (l.src) {
    blob = await (await fetch(l.src)).blob(); // фото из композера уже сжато и повёрнуто
  } else {
    const o = l.base;
    if (isSketch(o)) {
      // у эскиза картинка — сам файл; не открылся — берём превью
      try {
        const file = await (await Api.download({ a: 'file', what: 'file', id: o.id }, 60000)).blob();
        return lithoLuma(await lithoDecode(file));
      } catch (e) {
        if (e && e.code === 'auth') throw e;
      }
    }
    blob = await (await Api.download({ a: 'file', what: 'preview', id: o.id }, 60000)).blob();
  }
  return lithoLuma(await lithoDecode(blob));
}

// Фото с телефона — по EXIF, чтобы не лежало боком.
async function lithoDecode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* попробуем через <img> */ }
  }
  return loadImageFile(blob); // <img> сам поворачивает по EXIF
}

// Длинная сторона до 800 px, яркость 0.299r + 0.587g + 0.114b. Прозрачное — белое.
function lithoLuma(src) {
  const w0 = src.naturalWidth || src.width;
  const h0 = src.naturalHeight || src.height;
  if (!w0 || !h0) throw new Error('decode');
  const k = Math.min(1, LITHO_MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) luma[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
  return { luma, w, h };
}

// «Повернуть 90°» — по часовой, до расчёта.
function lithoRotate() {
  const l = state.litho;
  if (!l || !l.img) return;
  haptic();
  const { luma, w, h } = l.img;
  const out = new Float32Array(w * h);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) out[y * h + x] = luma[(h - 1 - x) * w + y];
  }
  l.img = { luma: out, w: h, h: w };
  lithoChanged(l);
}

/* ---------- Расчёт ---------- */

const lithoEngine = { worker: null, failed: false, core: null, seq: 0, wait: {} };

function lithoOpts(s) {
  const t = LITHO_THICK[s.thick] || LITHO_THICK.normal;
  return {
    mode: s.mode, width: s.width, minT: t[0], maxT: t[1], curve: s.curve, stand: s.stand && s.curve === 0,
    lightUp: s.lightUp, depth: s.depth, blur: s.blur, contrast: s.contrast, gamma: s.gamma, frame: s.frame ? 3 : 0,
  };
}

function lithoWorker() {
  if (lithoEngine.worker || lithoEngine.failed) return lithoEngine.worker;
  try {
    const w = new Worker(LITHO_WORKER_URL, { type: 'module' });
    w.onmessage = (e) => {
      const d = e.data;
      const p = lithoEngine.wait[d.seq];
      if (!p) return;
      delete lithoEngine.wait[d.seq];
      if (d.ok) p.resolve(d);
      else p.reject(new Error(d.error));
    };
    // поток не запустился (старый телефон) — дальше считаем здесь
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      lithoEngine.failed = true;
      lithoEngine.worker = null;
      w.terminate();
      const wait = lithoEngine.wait;
      lithoEngine.wait = {};
      Object.values(wait).forEach((p) => p.reject(Object.assign(new Error('worker'), { code: 'worker' })));
    };
    lithoEngine.worker = w;
  } catch (e) {
    lithoEngine.failed = true;
  }
  return lithoEngine.worker;
}

async function lithoMakeHere(img, opts) {
  if (!lithoEngine.core) lithoEngine.core = import(LITHO_CORE_URL).catch((e) => { lithoEngine.core = null; throw e; });
  const core = await lithoEngine.core;
  const t0 = performance.now();
  const r = core.makeLitho(img.luma, img.w, img.h, opts);
  const light = opts.mode === 'litho' ? core.backlitPreview(r.hf) : null;
  return { stl: r.stl, tris: r.tris, size: r.size, grid: r.grid, light, ms: Math.round(performance.now() - t0) };
}

function lithoMake(img, opts) {
  const w = lithoWorker();
  if (!w) return lithoMakeHere(img, opts);
  const seq = ++lithoEngine.seq;
  return new Promise((resolve, reject) => {
    lithoEngine.wait[seq] = { resolve, reject };
    w.postMessage({ seq, luma: img.luma, w: img.w, h: img.h, opts });
  }).catch((e) => {
    if (e && e.code === 'worker') return lithoMakeHere(img, opts);
    throw e;
  });
}

// Настройки или картинка поменялись: пересчёт через 250 мс, сохранённая карточка — уже про старое.
function lithoChanged(l) {
  $('litho-saved').hidden = true;
  lithoRenderSettings();
  lithoSchedule(l, LITHO_DEBOUNCE);
}

function lithoSchedule(l, ms) {
  clearTimeout(l.timer);
  l.timer = setTimeout(() => {
    l.timer = 0;
    if (state.litho === l) lithoRun(l);
  }, ms);
}

// Один расчёт за раз: поменяли настройки, пока считали, — после него ещё один, с последними.
function lithoRun(l) {
  if (!l.img) return Promise.resolve();
  if (l.busy) {
    l.again = true;
    return l.running;
  }
  l.busy = true;
  l.again = false;
  $('litho-busy').hidden = !l.res;
  const set = Object.assign({}, l.set);
  l.running = lithoMake(l.img, lithoOpts(set))
    .then((r) => {
      if (state.litho !== l) return;
      r.set = set;
      l.res = r;
      lithoShowResult(l);
    }, () => {
      if (state.litho !== l) return;
      if (!l.res) lithoStatus('error', 'Не получилось посчитать модель. Попробуй другую картинку');
      else toast('Не получилось посчитать, попробуй другие настройки');
    })
    .then(() => {
      if (state.litho !== l) return;
      l.busy = false;
      if (l.again) return lithoRun(l);
      $('litho-busy').hidden = true;
      lithoUpdateMainButton();
    });
  return l.running;
}

// Дождаться расчёта с последними настройками (перед сохранением).
async function lithoSettle(l) {
  while (state.litho === l && (l.timer || l.busy)) {
    if (l.timer) {
      clearTimeout(l.timer);
      l.timer = 0;
      lithoRun(l);
    }
    await l.running;
  }
}

/* ---------- Превью ---------- */

function lithoStatus(mode, text) {
  $('litho-status').hidden = mode === 'none';
  $('litho-status-spinner').hidden = mode !== 'loading';
  $('litho-status-text').textContent = text || '';
}

function lithoShowResult(l) {
  const r = l.res;
  lithoStatus('none');
  $('litho-dims').textContent = lithoSize(r.size[0], r.size[1], r.size[2]);
  if (r.light) lithoDrawLight(r);
  lithoSyncView(l);
}

function lithoSize(w, h, t) {
  return cadMm(Math.round(w)) + ' × ' + cadMm(Math.round(h)) + (t != null ? ' × ' + cadMm(t) : '') + ' мм';
}

// «На просвет»: тёплый свет лампы сквозь пластину.
function lithoDrawLight(r) {
  const gx = r.grid[0];
  const gy = r.grid[1];
  const c = $('litho-light');
  c.width = gx;
  c.height = gy;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(gx, gy);
  const d = im.data;
  const v = r.light;
  for (let i = 0, p = 0; i < v.length; i++, p += 4) {
    const x = v[i] * 255;
    d[p] = x;
    d[p + 1] = x * 0.88;
    d[p + 2] = x * 0.67;
    d[p + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

// Литофания — вкладки «На просвет» и «3D»; барельеф — сразу 3D.
function lithoSyncView(l) {
  const relief = l.set.mode === 'relief';
  const view = relief ? '3d' : l.view;
  const ready = !!(l.res && l.res.set.mode === l.set.mode);
  $('litho-tabs').hidden = relief;
  $('litho-bar').classList.toggle('is-solo', relief);
  document.querySelectorAll('#litho-tabs button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.v === view);
    b.setAttribute('aria-pressed', b.dataset.v === view ? 'true' : 'false');
  });
  $('litho-light').hidden = view !== 'light' || !ready;
  $('litho-stage').hidden = view !== '3d';
  $('litho-preview').classList.toggle('is-3d', view === '3d');
  if (view === '3d' && ready) lithoShow3d(l).catch(() => { if (state.litho === l) lithoStatus('error', 'Не получилось показать 3D. Попробуй «На просвет»'); });
}

/* ---------- 3D (three.js) ---------- */

const lithoView = { v: null, raf: 0, ro: null, shown: null };

// Направление взгляда по умолчанию: плоскую — чуть сверху (верх картинки — дальний край), изогнутую — спереди.
function lithoViewDir(set) {
  return set.mode === 'litho' && set.curve > 0 ? [0.25, -1, 0.3] : [0, -0.75, 1];
}

async function lithoShow3d(l) {
  const r = l.res;
  if (!r || lithoView.shown === r) return;
  const T = await loadThree();
  if (state.litho !== l || l.res !== r) return;
  const v = lithoEnsure3d(T);
  const geometry = new T.STLLoader().parse(r.stl);
  geometry.center();
  geometry.computeBoundingSphere();
  if (v.mesh.geometry) v.mesh.geometry.dispose();
  v.mesh.geometry = geometry;

  // барельеф — сильный боковой свет: рельеф читается тенями; у литофании рельеф тонкий — свет мягче, больше от камеры
  const relief = r.set.mode === 'relief';
  v.side.intensity = relief ? 2.6 : 1.6;
  v.key.intensity = relief ? 0 : 1.1;
  v.hemi.intensity = relief ? 0.7 : 1.1;

  const radius = Math.max(geometry.boundingSphere.radius, 1);
  v.radius = radius;
  const layout = r.set.mode + ':' + r.set.curve + ':' + (r.set.stand ? 1 : 0);
  const dir = v.camera.position.clone();
  if (layout !== v.layout || dir.lengthSq() < 1e-9) dir.set(...lithoViewDir(r.set));
  v.layout = layout;
  dir.normalize();
  v.camera.position.copy(dir.multiplyScalar(cadFitDistance(radius) * 0.85)); // пластина плоская — шар вокруг неё с запасом
  v.camera.near = radius / 100;
  v.camera.far = radius * 100;
  v.camera.updateProjectionMatrix();
  v.controls.target.set(0, 0, 0);
  v.controls.minDistance = radius * 0.5;
  v.controls.maxDistance = radius * 8;
  v.controls.update();
  lithoView.shown = r;
}

function lithoEnsure3d(T) {
  if (lithoView.v) return lithoView.v;
  const stage = $('litho-stage');
  stage.textContent = '';
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1); // в STL «вверх» — это Z
  scene.add(camera);
  const hemi = new T.HemisphereLight(0xffffff, 0x8a8a8a, 1.5);
  scene.add(hemi);
  const key = new T.DirectionalLight(0xffffff, 1.9);
  key.position.set(1, 1.5, 2);
  camera.add(key);
  const side = new T.DirectionalLight(0xffffff, 2.6);
  side.position.set(-1, 0.45, 0.55); // низко сбоку
  scene.add(side);

  const mesh = new T.Mesh(undefined, new T.MeshStandardMaterial({ color: 0xebe6de, roughness: 0.8, metalness: 0 }));
  scene.add(mesh);

  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.rotateSpeed = 0.8;

  const v = { T, renderer, scene, camera, controls, mesh, hemi, key, side, radius: 1, layout: '' };
  const resize = () => {
    const w = stage.clientWidth || 300;
    const h = stage.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  if (window.ResizeObserver) {
    lithoView.ro = new ResizeObserver(resize);
    lithoView.ro.observe(stage);
  }
  const loop = () => {
    lithoView.raf = requestAnimationFrame(loop);
    if (stage.hidden) return; // вкладка «На просвет» — не рисуем зря
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
  lithoView.v = v;
  return v;
}

function lithoDestroy3d() {
  const v = lithoView.v;
  lithoView.v = null;
  lithoView.shown = null;
  cancelAnimationFrame(lithoView.raf);
  if (lithoView.ro) lithoView.ro.disconnect();
  lithoView.ro = null;
  if (!v) return;
  v.controls.dispose();
  if (v.mesh.geometry) v.mesh.geometry.dispose();
  v.mesh.material.dispose();
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

/* ---------- Снимок для «Моих работ» ---------- */

// Литофания — вид «на просвет» на тёмном фоне, барельеф — 3D-кадр. 800×800, как у остальных работ.
async function lithoSnapshot(l) {
  const S = 800;
  const out = document.createElement('canvas');
  out.width = S;
  out.height = S;
  const ctx = out.getContext('2d');
  if (l.res.light) {
    const src = $('litho-light');
    ctx.fillStyle = '#1f1b17';
    ctx.fillRect(0, 0, S, S);
    const k = Math.min((S - 80) / src.width, (S - 80) / src.height);
    const w = src.width * k;
    const h = src.height * k;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (S - w) / 2, (S - h) / 2, w, h);
    return out.toDataURL('image/jpeg', 0.85);
  }
  await lithoShow3d(l);
  const v = lithoView.v;
  const r = v.renderer;
  const cam = v.camera;
  const savedPos = cam.position.clone();
  const savedAspect = cam.aspect;
  const savedRatio = r.getPixelRatio();
  const stage = $('litho-stage');
  r.setPixelRatio(1);
  r.setSize(S, S, false);
  cam.aspect = 1;
  cam.position.set(...lithoViewDir(l.res.set)).normalize().multiplyScalar(cadFitDistance(v.radius) * 0.9);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  r.setClearColor(0xf4f4f4, 1);
  r.render(v.scene, cam);
  ctx.drawImage(r.domElement, 0, 0);
  r.setClearColor(0x000000, 0);
  r.setPixelRatio(savedRatio);
  r.setSize(stage.clientWidth || 300, stage.clientHeight || 300, false);
  cam.aspect = savedAspect;
  cam.position.copy(savedPos);
  cam.lookAt(v.controls.target);
  cam.updateProjectionMatrix();
  return out.toDataURL('image/jpeg', 0.85);
}

/* ---------- Сохранение ---------- */

function lithoUpdateMainButton() {
  const l = state.litho;
  if (!l) return;
  if (!$('litho-missing').hidden) {
    tg.MainButton.hide();
    return;
  }
  const ready = !!l.res;
  tg.MainButton.setParams(Object.assign({
    text: 'Сохранить STL · бесплатно',
    is_visible: true,
    is_active: ready,
  }, mainButtonColors(ready)));
}

function lithoStlDataUrl(stl) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(new Blob([stl], { type: 'model/stl' }));
  });
}

// В проект исходной работы; из композера — в открытый проект («Новый проект» — без него).
function lithoProject(l) {
  return l.base ? String(l.base.project || '') : realProject(proj.current);
}

// '100×133×3.5' — ширина и высота картинки, самое толстое место
function lithoDims(r) {
  return Math.round(r.size[0]) + '×' + Math.round(r.size[1]) + '×' + Math.round(r.size[2] * 10) / 10;
}

async function lithoSave() {
  const l = state.litho;
  if (!l || !l.res || state.lithoBusy) return;
  haptic();
  state.lithoBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Сохраняю…';
  let resp;
  let title = '';
  let mode = l.set.mode;
  await lithoSettle(l); // файл — с последними настройками
  if (state.litho !== l) { // закрыли, пока досчитывалось, — не сохраняем
    state.lithoBusy = false;
    $('busy').hidden = true;
    return;
  }
  try {
    const r = l.res;
    mode = r.set.mode;
    if (r.stl.byteLength > LITHO_MAX_FILE) throw new Error('too_big');
    title = lithoTitle(l);
    resp = await cadPost({
      a: 'litho',
      litho: mode,
      title,
      id: l.base ? String(l.base.id) : '',
      project: lithoProject(l),
      file: await lithoStlDataUrl(r.stl),
      snapshot: await lithoSnapshot(l),
      dims: lithoDims(r),
    }, LITHO_SAVE_TIMEOUT);
  } catch (e) {
    resp = { status: 0, data: null };
  }
  state.lithoBusy = false;
  $('busy').hidden = true;

  if (cadIsAuth(resp)) {
    sessionExpired();
  } else if (resp.data && resp.data.ok === true) {
    hapticNotify('success');
    lithoAfterSave(l, resp.data.id != null ? String(resp.data.id) : null);
    if (state.litho === l && resp.data.id != null) {
      showSavedWork($('litho-saved'), String(resp.data.id), {
        kind: 'model', mode, litho: mode, format: 'stl', title, has_file: true, has_preview: true, editable: false,
        size_mm: Math.round(l.res.size[0]), project: lithoProject(l),
      });
    } else {
      toast('Сохранено в «Мои работы»');
    }
  } else {
    hapticNotify('error');
    toast('Не получилось сохранить, попробуй ещё раз'); // настройки остаются как были
  }
}

// Сохранили: фото из композера больше не нужно; первая работа нового проекта — открываем её проект.
function lithoAfterSave(l, id) {
  if (l.src && comp.photos[0] === l.src) {
    $('composer-input').value = '';
    comp.photos = [];
    comp.manual = false;
    guessMode();
    renderComposer();
  }
  loadMe(false).then(() => {
    const o = id && findOrder(id);
    if (l.src && o && o.project && viewKey() === l.from && String(o.project) !== proj.current) {
      projOpen(String(o.project), { follow: true });
    }
  });
}

/* ---------- Настройки ---------- */

function lithoNum(x) {
  return Number(x).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function lithoRenderSettings() {
  const l = state.litho;
  if (!l) return;
  const s = l.set;
  const relief = s.mode === 'relief';
  const seg = (id, v) => document.querySelectorAll('#' + id + ' button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.v === String(v));
    b.setAttribute('aria-pressed', b.dataset.v === String(v) ? 'true' : 'false');
  });
  seg('litho-mode', s.mode);
  seg('litho-curve', s.curve);
  seg('litho-thick', s.thick);
  seg('litho-up', s.lightUp ? 'light' : 'dark');
  $('litho-head').textContent = LITHO_NAMES[s.mode];
  $('litho-about').textContent = LITHO_ABOUT[s.mode];
  $('litho-print-text').textContent = LITHO_PRINT[s.mode];
  document.querySelectorAll('#litho-settings [data-for]').forEach((row) => {
    const f = row.dataset.for;
    row.hidden = f === 'litho' ? relief : f === 'flat' ? relief || s.curve > 0 : f === 'relief' ? !relief : false;
  });

  $('litho-width').value = s.width;
  $('litho-width-val').textContent = l.img ? lithoSize(s.width, s.width * l.img.h / l.img.w) : cadMm(s.width) + ' мм';
  $('litho-stand').checked = s.stand;
  $('litho-depth').value = s.depth;
  $('litho-depth-val').textContent = lithoNum(s.depth) + ' мм';
  $('litho-blur').value = s.blur;
  $('litho-blur-val').textContent = s.blur ? String(s.blur) : 'нет';
  $('litho-contrast').value = s.contrast;
  $('litho-contrast-val').textContent = lithoNum(s.contrast);
  $('litho-gamma').value = s.gamma;
  $('litho-gamma-val').textContent = lithoNum(s.gamma);
  $('litho-frame').checked = s.frame;
  if (!l.titleEdited) $('litho-name').value = lithoAutoTitle(l);
  $('litho-rotate').disabled = !l.img;
  lithoSyncView(l);
}

/* ---------- Кнопки ---------- */

function bindLitho() {
  bindSavedWork($('litho-saved'), closeLitho);
  const withL = (fn) => (e) => { const l = state.litho; if (l) fn(l, e); };
  const segment = (id, apply) => document.querySelectorAll('#' + id + ' button').forEach((b) => b.addEventListener('click', withL((l) => {
    haptic();
    apply(l, b.dataset.v);
    lithoChanged(l);
  })));
  segment('litho-mode', (l, v) => {
    l.set.mode = v;
    if (v === 'litho') l.view = 'light';
  });
  segment('litho-curve', (l, v) => { l.set.curve = Number(v); });
  segment('litho-thick', (l, v) => { l.set.thick = v; });
  segment('litho-up', (l, v) => { l.set.lightUp = v === 'light'; });
  const slider = (id, key) => $(id).addEventListener('input', withL((l) => {
    l.set[key] = Number($(id).value);
    lithoChanged(l);
  }));
  slider('litho-width', 'width');
  slider('litho-depth', 'depth');
  slider('litho-blur', 'blur');
  slider('litho-contrast', 'contrast');
  slider('litho-gamma', 'gamma');
  const toggle = (id, key) => $(id).addEventListener('change', withL((l) => {
    haptic();
    l.set[key] = $(id).checked;
    lithoChanged(l);
  }));
  toggle('litho-stand', 'stand');
  toggle('litho-frame', 'frame');
  $('litho-name').addEventListener('input', withL((l) => {
    l.titleEdited = $('litho-name').value.trim() !== lithoAutoTitle(l);
  }));
  document.querySelectorAll('#litho-tabs button').forEach((b) => b.addEventListener('click', withL((l) => {
    if (l.view === b.dataset.v) return;
    haptic();
    l.view = b.dataset.v;
    lithoSyncView(l);
  })));
  $('litho-rotate').addEventListener('click', lithoRotate);
  $('litho-missing-btn').addEventListener('click', () => {
    haptic();
    const l = state.litho;
    const action = $('litho-missing-btn').dataset.action;
    if (action === 'close') tg.close();
    else if (action === 'retry' && l) openLitho({ base: l.base, src: l.src, name: l.name });
    else closeLitho();
  });
}
