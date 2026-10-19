/* Грава — «Разделить на части»: фигурка больше стола принтера режется на части, в срезах — отверстия
   под штыри, части раскладываются по столам. Всё считается в телефоне (manifold-3d в split-worker.js,
   режет split-core.js), бесплатно. Сохраняем по одному STL на стол — каждый станет работой в «Моих работах».
   Использует помощники из app.js (state, $, loadThree…), cadPost/cadIsAuth/cadMm/cadFitDistance/cadBlobToDataUrl из cad.js. */
'use strict';

const SPLIT_WORKER_URL = './split-worker.js?v=1';
const SPLIT_BED_KEY = 'grava.bed';
const SPLIT_DEBOUNCE = 400;
const SPLIT_MAX_FILE = 12 * 1024 * 1024;
const SPLIT_SAVE_TIMEOUT = 120000;
// пастельные цвета частей — по кругу; штыри серые
const SPLIT_COLORS = [0xf2b5a3, 0xa8d5ba, 0xa9c6f0, 0xf4d58d, 0xd3b5e5, 0x9fd9d6, 0xf2b6d2, 0xc9d99a];
const SPLIT_PIN = 0x9a9a9a;

/* ---------- Фоновый поток ---------- */

const splitEngine = { worker: null, seq: 0, wait: {} };

function splitCall(msg, transfer) {
  if (!splitEngine.worker) {
    const w = new Worker(SPLIT_WORKER_URL, { type: 'module' });
    w.onmessage = (e) => {
      const d = e.data;
      const p = splitEngine.wait[d.seq];
      if (!p) return;
      delete splitEngine.wait[d.seq];
      if (d.ok) p.resolve(d);
      else p.reject(Object.assign(new Error(d.error), { code: d.error }));
    };
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const wait = splitEngine.wait;
      splitEngine.wait = {};
      w.terminate();
      splitEngine.worker = null;
      Object.values(wait).forEach((p) => p.reject(Object.assign(new Error('worker'), { code: 'worker' })));
    };
    splitEngine.worker = w;
  }
  const seq = ++splitEngine.seq;
  return new Promise((resolve, reject) => {
    splitEngine.wait[seq] = { resolve, reject };
    splitEngine.worker.postMessage(Object.assign({ seq }, msg), transfer || []);
  });
}

/* ---------- Открыть / закрыть ---------- */

function canSplit(o) {
  return isStl(o) && hasFile(o) && o.jointed !== true && !lithoKind(o) && o.mode !== 'split' && o.mode !== 'color';
}

// Стол принтера запоминаем: по умолчанию 250 × 250 × 250 (Anycubic Kobra 3).
function splitBedLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(SPLIT_BED_KEY));
    if (Array.isArray(v) && v.length === 3 && v.every((x) => x >= 50 && x <= 1000)) return v.map(Number);
  } catch (e) { /* приватный режим или мусор */ }
  return [250, 250, 250];
}

function splitBedSave(bed) {
  try { localStorage.setItem(SPLIT_BED_KEY, JSON.stringify(bed)); } catch (e) { /* ок */ }
}

function openSplit(o) {
  haptic();
  if (state.viewer) closeViewer();
  if (state.split) splitTeardown();
  const s = state.split = {
    o,
    size: Math.max(100, Math.min(600, Math.round(Math.max(Number(o.size_mm) || 0, 260) / 5) * 5)),
    bed: splitBedLoad(),
    dims0: null,      // габариты модели до масштаба
    res: null,        // последний расчёт
    resKey: '',
    busy: false,
    again: false,
    running: null,
    timer: 0,
    exploded: false,
    saved: [],        // номера уже сохранённых столов этого расчёта — «ещё раз» продолжит с недосохранённого
    savedKey: '',
    scroll: window.scrollY,
  };
  $('split-missing').hidden = true;
  $('split-main').hidden = false;
  $('split-saved').hidden = true;
  $('split-title').textContent = o.title || 'Модель';
  $('split-info').textContent = '';
  $('split-warn').hidden = true;
  $('split-print').open = false;
  splitRenderSettings();
  splitStatus('loading', 'Загружаю модель…');
  renderView();
  window.scrollTo(0, 0);
  tg.BackButton.show();
  splitUpdateMainButton();
  splitLoad(s);
}

async function splitLoad(s) {
  try {
    let buffer;
    if (viewer.cache.id === s.o.id) buffer = viewer.cache.buffer;
    else {
      buffer = await (await Api.download({ a: 'file', id: s.o.id }, 120000)).arrayBuffer();
      viewer.cache = { id: s.o.id, buffer };
    }
    if (state.split !== s) return;
    splitStatus('loading', 'Готовлю модель…');
    const r = await splitCall({ type: 'load', buffer: buffer.slice(0) });
    if (state.split !== s) return;
    s.dims0 = r.dims;
    splitRenderSettings();
    splitRun(s);
  } catch (err) {
    if (state.split !== s) return;
    const code = err && err.code;
    if (code === 'auth') {
      splitShowMissing('Сессия устарела — перезапусти приложение', 'close');
      sessionExpired();
    } else if (code === 'network') {
      splitShowMissing('Не получилось скачать модель. Проверь интернет и попробуй ещё раз', 'retry');
    } else if (code === 'holes' || code === 'bad_stl') {
      splitShowMissing('В модели есть дыры — разрезать её не получится. Попробуй сделать модель заново', 'back');
    } else if (code === 'worker') {
      splitShowMissing('Деление не запустилось на этом телефоне. Обнови Telegram и попробуй ещё раз', 'back');
    } else {
      splitShowMissing('Не получилось открыть модель', 'back');
    }
  }
}

function splitShowMissing(text, action) {
  $('split-main').hidden = true;
  $('split-missing').hidden = false;
  $('split-missing-text').textContent = text;
  const btn = $('split-missing-btn');
  btn.dataset.action = action;
  btn.textContent = action === 'retry' ? 'Попробовать ещё раз' : action === 'close' ? 'Закрыть' : 'Назад';
  splitUpdateMainButton();
}

function closeSplit() {
  const s = state.split;
  if (!s) return;
  splitTeardown();
  state.split = null;
  tg.MainButton.hideProgress();
  tg.MainButton.setParams(Object.assign({ is_active: true }, mainButtonColors(true)));
  tg.MainButton.hide();
  tg.BackButton.hide();
  $('busy').hidden = true;
  renderView();
  window.scrollTo(0, s.scroll || 0);
}

function splitTeardown() {
  const s = state.split;
  if (s) clearTimeout(s.timer);
  splitDestroy3d();
  if (splitEngine.worker) splitCall({ type: 'free' }).catch(() => {});
}

/* ---------- Расчёт ---------- */

function splitKey(s) {
  return s.size + ':' + s.bed.join('x');
}

function splitChanged(s) {
  $('split-saved').hidden = true;
  splitRenderSettings();
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = 0;
    if (state.split === s) splitRun(s);
  }, SPLIT_DEBOUNCE);
}

// Один расчёт за раз: поменяли размер или стол, пока считали, — после него ещё один, с последними.
function splitRun(s) {
  if (!s.dims0) return Promise.resolve();
  if (s.busy) {
    s.again = true;
    return s.running;
  }
  s.busy = true;
  s.again = false;
  if (s.res) $('split-busy').hidden = false;
  else splitStatus('loading', 'Режу на части…');
  const key = splitKey(s);
  s.running = splitCall({ type: 'split', size: s.size, bed: s.bed.slice() })
    .then((r) => {
      if (state.split !== s) return;
      s.res = r;
      s.resKey = key;
      s.exploded = false;
      splitShowResult(s);
    }, () => {
      if (state.split !== s) return;
      if (!s.res) splitStatus('error', 'Не получилось разрезать модель. Попробуй другой размер');
      else toast('Не получилось разрезать, попробуй другой размер');
    })
    .then(() => {
      if (state.split !== s) return;
      s.busy = false;
      if (s.again) return splitRun(s);
      $('split-busy').hidden = true;
      splitUpdateMainButton();
    });
  return s.running;
}

async function splitSettle(s) {
  while (state.split === s && (s.timer || s.busy)) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = 0;
      splitRun(s);
    }
    await s.running;
  }
}

function splitStatus(mode, text) {
  $('split-status').hidden = mode === 'none';
  $('split-status-spinner').hidden = mode !== 'loading';
  $('split-status-text').textContent = text || '';
}

function splitPlural(n, one, few, many) {
  return n + ' ' + plural(n, one, few, many);
}

function splitShowResult(s) {
  const r = s.res;
  splitStatus('none');
  if (r.fits) {
    $('split-info').textContent = 'Модель целиком влезает на стол — делить не нужно';
    $('split-warn').hidden = true;
  } else {
    $('split-info').textContent = 'Частей: ' + r.parts + ' · штырей: ' + r.pins + ' · столов: ' + r.plates.length;
    $('split-warn').hidden = !(r.tooBig > 0);
  }
  $('split-explode').disabled = r.fits;
  setLabel($('split-explode'), 'Разнести');
  $('split-dims').textContent = 'Габариты: ' + r.dims.map((x) => cadMm(Math.round(x))).join(' × ') + ' мм';
  splitShow3d(s).catch(() => { if (state.split === s) splitStatus('error', 'Не получилось показать модель'); });
}

/* ---------- Превью (three.js) ---------- */

const splitView = { v: null, raf: 0, ro: null };

function splitGeometry(T, pos, idx) {
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(pos, 3));
  g.setIndex(new T.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

async function splitShow3d(s) {
  const r = s.res;
  const T = await loadThree();
  if (state.split !== s || s.res !== r) return;
  const v = splitEnsure3d(T);
  splitClearGroup(v);
  const group = new T.Group();
  const dims = r.dims;
  const center = new T.Vector3(dims[0] / 2, dims[1] / 2, dims[2] / 2);
  const maxDim = Math.max(dims[0], dims[1], dims[2]);
  const meshes = [];
  if (r.fits) {
    // делить не нужно — показываем модель целиком одним цветом
    const it = r.whole;
    if (it) meshes.push({ mesh: new T.Mesh(splitGeometry(T, it.apos || it.pos, it.idx), new T.MeshStandardMaterial({ color: SPLIT_COLORS[2], roughness: 0.8 })), out: new T.Vector3() });
  } else {
    let n = 0;
    const pins = [];
    r.plates.forEach((items) => items.forEach((it) => {
      if (it.pin) { pins.push(it); return; }
      const mat = new T.MeshStandardMaterial({ color: SPLIT_COLORS[n++ % SPLIT_COLORS.length], roughness: 0.8, metalness: 0 });
      const geom = splitGeometry(T, it.apos || it.pos, it.idx);
      geom.computeBoundingBox();
      const c = geom.boundingBox.getCenter(new T.Vector3());
      // «Разнести»: от центра модели наружу, дальние части — дальше
      const dir = c.clone().sub(center);
      const out = dir.clone().multiplyScalar(0.35);
      if (dir.lengthSq() > 1e-6) out.add(dir.normalize().multiplyScalar(maxDim * 0.06));
      meshes.push({ mesh: new T.Mesh(geom, mat), out });
    }));
    // штыри — серые, рядом с моделью спереди; видны, когда части разнесены
    const pinMat = new T.MeshStandardMaterial({ color: SPLIT_PIN, roughness: 0.6, metalness: 0 });
    pins.forEach((it, k) => {
      const geom = splitGeometry(T, it.pos, it.idx);
      const m = new T.Mesh(geom, pinMat);
      m.position.set(k * (it.w + 6) - it.w / 2, -maxDim * 0.18, 0);
      m.visible = false;
      m.userData.pin = true;
      group.add(m);
    });
    group.userData.pinMat = pinMat;
  }
  meshes.forEach((x) => {
    x.mesh.userData.out = x.out;
    group.add(x.mesh);
  });
  v.scene.add(group);
  v.group = group;
  v.anim = null;

  const radius = Math.max(Math.hypot(dims[0], dims[1], dims[2]) / 2, 1);
  v.radius = radius;
  v.center = center;
  const dir = v.camera.position.clone().sub(v.controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(1, -1.4, 1);
  dir.normalize();
  v.controls.target.copy(center);
  v.camera.position.copy(center).add(dir.multiplyScalar(cadFitDistance(radius) * 1.1));
  v.camera.near = radius / 100;
  v.camera.far = radius * 100;
  v.camera.updateProjectionMatrix();
  v.controls.minDistance = radius * 0.5;
  v.controls.maxDistance = radius * 8;
  v.controls.update();
}

function splitClearGroup(v) {
  if (!v.group) return;
  v.group.children.forEach((m) => {
    m.geometry.dispose();
    if (!m.userData.pin) m.material.dispose();
  });
  if (v.group.userData.pinMat) v.group.userData.pinMat.dispose();
  v.scene.remove(v.group);
  v.group = null;
}

// «Разнести» / «Собрать»: части плавно разъезжаются от центра, чтобы были видны разрезы.
function splitExplode() {
  const s = state.split;
  const v = splitView.v;
  if (!s || !s.res || s.res.fits || !v || !v.group) return;
  haptic();
  s.exploded = !s.exploded;
  setLabel($('split-explode'), s.exploded ? 'Собрать' : 'Разнести');
  v.anim = { from: s.exploded ? 0 : 1, to: s.exploded ? 1 : 0, t0: performance.now() };
  v.group.children.forEach((m) => { if (m.userData.pin) m.visible = s.exploded; });
}

function splitEnsure3d(T) {
  if (splitView.v) return splitView.v;
  const stage = $('split-stage');
  stage.textContent = '';
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1); // Z — вверх, как на столе принтера
  camera.position.set(0, 0, 0);
  scene.add(camera);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
  const key = new T.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 1.5, 2);
  camera.add(key);
  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.rotateSpeed = 0.8;
  const v = { T, renderer, scene, camera, controls, group: null, anim: null, radius: 1, center: null };
  const resize = () => {
    const w = stage.clientWidth || 300;
    const h = stage.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  if (window.ResizeObserver) {
    splitView.ro = new ResizeObserver(resize);
    splitView.ro.observe(stage);
  }
  const loop = (t) => {
    splitView.raf = requestAnimationFrame(loop);
    if (v.anim && v.group) {
      const k = Math.min(1, ((t || performance.now()) - v.anim.t0) / 350);
      const e = v.anim.from + (v.anim.to - v.anim.from) * (1 - Math.pow(1 - k, 3));
      v.group.children.forEach((m) => { if (m.userData.out) m.position.copy(m.userData.out).multiplyScalar(e); });
      if (k >= 1) v.anim = null;
    }
    controls.update();
    renderer.render(scene, camera);
  };
  loop();
  splitView.v = v;
  return v;
}

function splitDestroy3d() {
  const v = splitView.v;
  splitView.v = null;
  cancelAnimationFrame(splitView.raf);
  if (splitView.ro) splitView.ro.disconnect();
  splitView.ro = null;
  if (!v) return;
  splitClearGroup(v);
  v.controls.dispose();
  v.renderer.dispose();
  v.renderer.forceContextLoss();
  v.renderer.domElement.remove();
}

// Снимок стола i для «Моих работ»: детали как лежат на столе, вид 3/4 сверху, 800×800 на светлом фоне.
function splitSnapshot(s, i) {
  const v = splitView.v;
  if (!v) return '';
  const T = v.T;
  const items = s.res.plates[i];
  const group = new T.Group();
  const mats = [];
  let n = 0;
  const box = new T.Box3();
  items.forEach((it) => {
    const mat = new T.MeshStandardMaterial({ color: it.pin ? SPLIT_PIN : SPLIT_COLORS[n++ % SPLIT_COLORS.length], roughness: 0.8 });
    mats.push(mat);
    const m = new T.Mesh(splitGeometry(T, it.pos, it.idx), mat);
    group.add(m);
  });
  box.setFromObject(group);
  const center = box.getCenter(new T.Vector3());
  const radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 1);
  const r = v.renderer;
  const cam = v.camera;
  const saved = { pos: cam.position.clone(), aspect: cam.aspect, ratio: r.getPixelRatio(), near: cam.near, far: cam.far };
  if (v.group) v.group.visible = false;
  v.scene.add(group);
  r.setPixelRatio(1);
  r.setSize(800, 800, false);
  cam.aspect = 1;
  cam.near = radius / 100;
  cam.far = radius * 100;
  cam.position.copy(center).add(new T.Vector3(1, -1.4, 1.1).normalize().multiplyScalar(cadFitDistance(radius)));
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  r.setClearColor(0xf4f4f4, 1);
  r.render(v.scene, cam);
  const url = r.domElement.toDataURL('image/jpeg', 0.85);
  r.setClearColor(0x000000, 0);
  v.scene.remove(group);
  group.children.forEach((m) => m.geometry.dispose());
  mats.forEach((m) => m.dispose());
  if (v.group) v.group.visible = true;
  const stage = $('split-stage');
  r.setPixelRatio(saved.ratio);
  r.setSize(stage.clientWidth || 300, stage.clientHeight || 300, false);
  cam.aspect = saved.aspect;
  cam.near = saved.near;
  cam.far = saved.far;
  cam.position.copy(saved.pos);
  cam.lookAt(v.controls.target);
  cam.updateProjectionMatrix();
  return url;
}

/* ---------- Сохранение ---------- */

function splitUpdateMainButton() {
  const s = state.split;
  if (!s) return;
  if (!$('split-missing').hidden) {
    tg.MainButton.hide();
    return;
  }
  const ready = !!(s.res && !s.res.fits && s.res.plates.length);
  tg.MainButton.setParams(Object.assign({
    text: 'Сохранить части · бесплатно',
    is_visible: true,
    is_active: ready,
  }, mainButtonColors(ready)));
}

// По одному STL на стол, по очереди. Не вышло на каком-то столе — «ещё раз» продолжит с него.
async function splitSave() {
  const s = state.split;
  if (!s || !s.res || s.res.fits || state.splitBusy) return;
  haptic();
  state.splitBusy = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Готовлю столы…';
  await splitSettle(s);
  if (state.split !== s || !s.res || s.res.fits) {
    state.splitBusy = false;
    $('busy').hidden = true;
    return;
  }
  const K = s.res.plates.length;
  if (s.savedKey !== s.resKey) {
    s.saved = [];
    s.savedKey = s.resKey;
  }
  let fail = '';
  for (let i = s.saved.length; i < K; i++) {
    $('busy-text').textContent = 'Отправляю стол ' + (i + 1) + ' из ' + K + '…';
    let r;
    try {
      const { stl } = await splitCall({ type: 'plate', i });
      if (stl.byteLength > SPLIT_MAX_FILE) {
        fail = 'Стол ' + (i + 1) + ' получается больше 12 МБ — уменьши размер';
        break;
      }
      r = await cadPost({
        a: 'split',
        id: String(s.o.id),
        file: await cadBlobToDataUrl(stl),
        snapshot: splitSnapshot(s, i),
        plate: (i + 1) + '/' + K,
        project: String(s.o.project || ''),
      }, SPLIT_SAVE_TIMEOUT);
    } catch (e) {
      r = { status: 0, data: null };
    }
    if (state.split !== s) break;
    if (cadIsAuth(r)) {
      fail = 'auth';
      break;
    }
    if (!(r.data && r.data.ok === true)) {
      fail = 'Не получилось отправить стол ' + (i + 1) + ', попробуй ещё раз';
      break;
    }
    s.saved.push(r.data.id != null ? String(r.data.id) : null);
  }
  state.splitBusy = false;
  $('busy').hidden = true;
  if (s.saved.length) loadMe(false);
  if (fail === 'auth') {
    sessionExpired();
  } else if (fail) {
    hapticNotify('error');
    toast(fail);
  } else if (state.split === s && s.saved.length === K) {
    hapticNotify('success');
    $('split-saved-text').textContent = K === 1 ? 'Сохранено в «Мои работы»' : 'Сохранено в «Мои работы»: ' + splitPlural(K, 'стол', 'стола', 'столов');
    $('split-saved').hidden = false;
    setTimeout(() => $('split-saved').scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }
}

// «Отправить в Telegram»: каждый стол — своим файлом.
async function splitSendAll(btn) {
  const s = state.split;
  if (!s || state.sending) return;
  const ids = s.saved.filter(Boolean);
  for (const id of ids) {
    await sendWork(id, btn);
  }
}

/* ---------- Настройки ---------- */

function splitRenderSettings() {
  const s = state.split;
  if (!s) return;
  $('split-size').value = s.size;
  $('split-size-val').textContent = cadMm(s.size) + ' мм';
  const k = s.dims0 ? s.size / Math.max(s.dims0[0], s.dims0[1], s.dims0[2]) : 0;
  $('split-dims').textContent = s.dims0 ? 'Габариты: ' + s.dims0.map((x) => cadMm(Math.round(x * k))).join(' × ') + ' мм' : '';
  ['x', 'y', 'z'].forEach((a, i) => {
    const inp = $('split-bed-' + a);
    if (document.activeElement !== inp) inp.value = s.bed[i];
  });
}

function bindSplit() {
  $('split-size').addEventListener('input', () => {
    const s = state.split;
    if (!s) return;
    s.size = Number($('split-size').value);
    splitChanged(s);
  });
  ['x', 'y', 'z'].forEach((a, i) => {
    const inp = $('split-bed-' + a);
    inp.addEventListener('input', () => {
      const s = state.split;
      const v = Math.round(Number(inp.value));
      inp.classList.toggle('is-bad', !(v >= 50 && v <= 1000));
      if (!s || !(v >= 50 && v <= 1000)) return;
      s.bed[i] = v;
      splitBedSave(s.bed);
      splitChanged(s);
    });
    inp.addEventListener('blur', () => {
      const s = state.split;
      inp.classList.remove('is-bad');
      if (s) inp.value = s.bed[i];
    });
  });
  $('split-explode').addEventListener('click', splitExplode);
  $('split-saved-open').addEventListener('click', () => {
    haptic();
    closeSplit();
    state.detail = null;
    setTab('works');
  });
  $('split-saved-send').addEventListener('click', () => splitSendAll($('split-saved-send')));
  $('split-missing-btn').addEventListener('click', () => {
    haptic();
    const s = state.split;
    const action = $('split-missing-btn').dataset.action;
    if (action === 'close') tg.close();
    else if (action === 'retry' && s) openSplit(s.o);
    else closeSplit();
  });
}
