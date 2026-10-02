# OpenSCAD (WebAssembly)

Движок, которым конструктор деталей считает модели прямо в телефоне.

| | |
|---|---|
| Версия | OpenSCAD `2025.03.25.wasm24456` (git `ce5039f8a`), бэкенд Manifold |
| Откуда | npm-пакет [`openscad-playground@2.4.0`](https://www.npmjs.com/package/openscad-playground), папка `dist/wasm/` (официальную сборку с files.openscad.org скачать не удалось — сайт недоступен из среды сборки) |
| Файлы | `openscad.js` — ES-модуль, `export default` фабрика Emscripten; `openscad.wasm` — сам движок (~9,6 МБ) |
| Лицензия | GPL-2.0-or-later — https://github.com/openscad/openscad (текст: https://github.com/openscad/openscad/blob/master/COPYING) |

Файлы не изменялись.

Шрифтов и библиотек (MCAD, BOSL) в сборке нет: `text()` и `include <…>` в коде детали работать не будут.

Обновить: заменить оба файла свежими из `OpenSCAD-…-WebAssembly-web.zip` с https://files.openscad.org/snapshots/
и поправить `CAD_WASM_SIZE` и `?v=` в `cad.js`.
