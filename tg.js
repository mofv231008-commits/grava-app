/* Грава — всё, что зависит от Телеги, живёт здесь.
   Вне Телеги (будущий сайт, ?mock=1 в браузере) — запасные варианты:
   своя кнопка внизу вместо MainButton, кнопка «‹ Назад» и history.back() вместо BackButton,
   alert/confirm вместо окошек Телеги.
   Подключается в <head>: тему (светлая/тёмная) ставит до первой отрисовки. */
'use strict';

const tg = (() => {
  const w = window.Telegram && window.Telegram.WebApp;
  const inside = !!(w && w.initData);

  function supports(version) {
    if (!inside) return false;
    try { return w.isVersionAtLeast(version); } catch (e) { return false; }
  }

  /* ---------- Тема: в Телеге — её colorScheme, в браузере — prefers-color-scheme ---------- */

  const themeListeners = [];
  let dark = null;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)'); } catch (e) { /* старый браузер */ }

  function scheme() {
    if (inside && (w.colorScheme === 'dark' || w.colorScheme === 'light')) return w.colorScheme;
    return dark && dark.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const s = scheme();
    if (document.documentElement.dataset.theme === s) return;
    document.documentElement.dataset.theme = s;
    themeListeners.forEach((fn) => fn(s));
  }
  applyTheme();
  if (inside) {
    try { w.onEvent('themeChanged', applyTheme); } catch (e) { /* старый клиент */ }
  }
  if (dark) {
    try { dark.addEventListener('change', applyTheme); } catch (e) { /* Safari < 14 */ }
  }

  /* ---------- Своя кнопка внизу вместо MainButton ---------- */

  function fallbackMainButton() {
    const s = { text: '', color: '', textColor: '', active: true, visible: false, progress: false };
    const handlers = [];
    let node = null;
    const get = () => {
      if (!node) {
        node = document.getElementById('mainbtn');
        node.addEventListener('click', () => {
          if (s.active && !s.progress) handlers.slice().forEach((fn) => fn());
        });
      }
      return node;
    };
    const sync = () => {
      const b = get();
      b.hidden = !s.visible;
      b.textContent = s.progress ? '' : s.text;
      b.classList.toggle('is-progress', s.progress);
      b.classList.toggle('is-inactive', !s.active);
      b.style.background = s.color || '';
      b.style.color = s.textColor || '';
      document.body.classList.toggle('has-mainbtn', s.visible);
    };
    const api = {
      setParams(p) {
        if ('text' in p) s.text = p.text;
        if ('color' in p) s.color = p.color || '';
        if ('text_color' in p) s.textColor = p.text_color || '';
        if ('is_active' in p) s.active = !!p.is_active;
        if ('is_visible' in p) s.visible = !!p.is_visible;
        sync();
        return api;
      },
      setText(t) { return api.setParams({ text: t }); },
      show() { return api.setParams({ is_visible: true }); },
      hide() { return api.setParams({ is_visible: false }); },
      enable() { return api.setParams({ is_active: true }); },
      disable() { return api.setParams({ is_active: false }); },
      showProgress() { s.progress = true; sync(); return api; },
      hideProgress() { s.progress = false; sync(); return api; },
      onClick(fn) { handlers.push(fn); return api; },
      offClick(fn) { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1); return api; },
    };
    return api;
  }

  /* ---------- «‹ Назад» и системная кнопка «назад» браузера вместо BackButton ---------- */

  function fallbackBackButton() {
    const handlers = [];
    let visible = false;
    let armed = false; // в истории лежит наша запись — «назад» браузера вернёт в приложение
    let node = null;
    const fire = () => handlers.slice().forEach((fn) => fn());
    const get = () => {
      if (!node) {
        node = document.getElementById('backbtn');
        node.addEventListener('click', fire);
        window.addEventListener('popstate', () => {
          armed = false;
          if (visible) fire();
        });
      }
      return node;
    };
    const sync = () => {
      get().hidden = !visible;
      document.body.classList.toggle('has-backbtn', visible);
    };
    const api = {
      show() {
        visible = true;
        if (!armed) {
          try { history.pushState({ grava: 'back' }, ''); armed = true; } catch (e) { /* ок */ }
        }
        sync();
        return api;
      },
      hide() { visible = false; sync(); return api; },
      onClick(fn) { get(); handlers.push(fn); return api; },
      offClick(fn) { const i = handlers.indexOf(fn); if (i !== -1) handlers.splice(i, 1); return api; },
    };
    return api;
  }

  const t = {
    inside,
    initData: inside ? w.initData : '',
    startParam: (inside && w.initDataUnsafe && w.initDataUnsafe.start_param) || '',
    userName: (inside && w.initDataUnsafe && w.initDataUnsafe.user && w.initDataUnsafe.user.first_name) || '',
    get theme() { return document.documentElement.dataset.theme || 'light'; },
    onTheme(fn) { themeListeners.push(fn); },
    get themeParams() { return (inside && w.themeParams) || {}; },
    MainButton: inside ? w.MainButton : fallbackMainButton(),
    BackButton: inside ? w.BackButton : fallbackBackButton(),
    supports,

    haptic(style) {
      if (!inside) return;
      try { w.HapticFeedback.impactOccurred(style || 'light'); } catch (e) { /* старый клиент */ }
    },
    notify(type) {
      if (!inside) return;
      try { w.HapticFeedback.notificationOccurred(type); } catch (e) { /* старый клиент */ }
    },

    alert(text, cb) {
      if (supports('6.2')) w.showAlert(text, cb);
      else {
        window.alert(text);
        if (cb) cb();
      }
    },
    confirm(text, cb) {
      if (supports('6.2')) w.showConfirm(text, cb);
      else cb(window.confirm(text));
    },
    // Окошко с кнопками: cb(id нажатой кнопки или null).
    popup(p, cb) {
      if (supports('6.2')) {
        w.showPopup(p, cb);
        return;
      }
      const main = (p.buttons || []).find((b) => b.type !== 'cancel' && b.type !== 'close' && b.id);
      const text = [p.title, p.message].filter(Boolean).join('\n\n');
      if (main) cb(window.confirm(text + '\n\n' + main.text + '?') ? main.id : null);
      else {
        window.alert(text);
        cb(null);
      }
    },

    openInvoice(link, cb) {
      if (inside) w.openInvoice(link, cb);
      else window.open(link, '_blank', 'noopener');
    },
    openLink(url) {
      try {
        if (inside) w.openLink(url);
        else window.open(url, '_blank', 'noopener');
      } catch (e) {
        window.open(url, '_blank', 'noopener');
      }
    },
    close() {
      if (inside) w.close();
    },

    ready() {
      if (!inside) return;
      w.ready();
      w.expand();
    },
    // Шапка и фон Телеги — цветом фона приложения, нижняя полоса — цветом нашей панели вкладок.
    paint(bg, bottom) {
      if (!inside) {
        let meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'theme-color';
          document.head.appendChild(meta);
        }
        meta.content = bg;
        return;
      }
      try {
        if (supports('6.9')) w.setHeaderColor(bg);
        else if (supports('6.1')) w.setHeaderColor('bg_color');
      } catch (e) { /* ок */ }
      try { if (supports('6.1')) w.setBackgroundColor(bg); } catch (e) { /* ок */ }
      try { if (supports('7.10') && w.setBottomBarColor) w.setBottomBarColor(bottom || bg); } catch (e) { /* ок */ }
    },
    // Видимая высота: в Телеге — viewportStableHeight, в браузере — visualViewport (клавиатура её уменьшает).
    visibleHeight() {
      let h = window.innerHeight;
      if (inside && w.viewportStableHeight > 0) h = Math.min(h, w.viewportStableHeight);
      const vv = window.visualViewport;
      if (vv) h = Math.min(h, vv.height + vv.offsetTop);
      return h;
    },
    onViewport(fn) {
      if (inside) {
        try { w.onEvent('viewportChanged', fn); } catch (e) { /* старый клиент */ }
      }
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', fn);
        window.visualViewport.addEventListener('scroll', fn);
      }
      window.addEventListener('resize', fn);
    },
    // Свайп вниз сворачивает приложение — в редакторе и 3D его выключаем.
    swipes(on) {
      if (!supports('7.7')) return;
      try {
        if (on) w.enableVerticalSwipes();
        else w.disableVerticalSwipes();
      } catch (e) { /* ок */ }
    },
    onActivated(fn) {
      if (!inside) return;
      try { w.onEvent('activated', fn); } catch (e) { /* старый клиент */ }
    },
  };
  return t;
})();

/* Короткие имена — ими пользуются все файлы приложения. */
function supports(version) { return tg.supports(version); }
function haptic(style) { tg.haptic(style); }
function hapticNotify(type) { tg.notify(type); }
function alertBox(text, cb) { tg.alert(text, cb); }
function confirmBox(text, cb) { tg.confirm(text, cb); }
