# Грава — Mini App для @grava_ai_bot

Витрина работ пользователя, 3D-просмотр моделей и покупка кредитов.
Обычная статичная страница: без сборщиков и npm, работает на GitHub Pages.

## Файлы

| Файл | Что внутри |
|---|---|
| `index.html` | разметка всех экранов |
| `style.css` | оформление (цвета берутся из темы Telegram) |
| `app.js` | логика: запросы к API, вкладки, экран работы, оплата, 3D |
| `editor.js` | вкладка «Редактор»: рисование, обводка для ИИ, обрезка, отправка правки |
| `cad.js` | конструктор деталей по размерам: параметры, превью, отправка файла, починка |
| `cad-worker.js` | фоновый поток конструктора: считает деталь движком OpenSCAD |
| `flexi.js` | экран «🦴 Шарниры» (режим «⛓ Цепочка»): вид сверху со звеньями, настройки, превью, отправка |
| `flexi-worker.js`, `flexi-core.js` | сборщик шарниров: модель перепаивается (воксели → levelSet), позвоночник (от морды через тело до кончика хвоста) и лапы режутся на звенья «ушко в петле» (как у flexi happy lizard); лапы держатся на своих звеньях позвоночника. Размеры сустава — в мм с минимумами, не от масштаба (стойка ⌀ ≥ 3.2, перекладины ≥ 2.4, стенка ушка ≥ 2.0, зазор 0.45); при смене длины суставы пересчитываются. Сустав целиком лежит в коже, сжатой на 0.8 мм (skinIn), — иначе звено сдвигается на ±1…5 мм или его нет; по коже обрезается только шейка ушка. Если на хвосте < 3 звеньев или у лапы нет суставов — подсказка «сделай крупнее». Тест сустава — бруски 13×10.5 и 16×11, толщины меряются по готовой сетке. Автопроверка (manifold-3d) |
| `tests/flexi.test.mjs` | проверка сборщика: кот, осьминог, змея, ящерица, скелет и настоящий эублефар `tests/gecko.stl` (150 мм — уже порезанная модель, суставы не помещаются → подсказка); у всех — «ничего не выходит за кожу» и «сустав внутри skinIn» — `node tests/flexi.test.mjs`, STL в `tests/out/` |
| `vendor/manifold/` | движок manifold-3d (WebAssembly, Apache-2.0) |
| `vendor/openscad/` | движок OpenSCAD (WebAssembly, GPL-2.0), см. `vendor/openscad/README.md` |
| `vendor/three/three-viewer.min.js` | three.js + STLLoader + OrbitControls одним файлом (лежит прямо здесь, без внешних CDN) |
| `.nojekyll` | чтобы GitHub Pages отдавал файлы как есть |

API: `https://engrave.app.n8n.cloud/webhook/grava-app` (адрес в начале `app.js`).

## Публикация

1. GitHub → репозиторий → **Settings → Pages**.
2. **Source:** Deploy from a branch → **main** → **/ (root)** → Save.
3. Через 1–2 минуты страница будет тут: https://mofv231008-commits.github.io/grava-app/

Если открыть ссылку в обычном браузере, будет надпись «Открой приложение из бота @grava_ai_bot». Так и задумано: приложение работает только внутри Telegram.

## Как обновлять

Меняешь файлы в ветке `main`, GitHub Pages обновится сам за пару минут.
Если Telegram показывает старую версию, увеличь число в `?v=…` у `style.css`, `app.js`, `editor.js`, `cad.js` и `flexi.js` в `index.html`.

Ссылка `https://mofv231008-commits.github.io/grava-app/#editor` сразу открывает вкладку «Редактор»,
`https://mofv231008-commits.github.io/grava-app/?cad=<номер>` — конструктор детали,
`https://mofv231008-commits.github.io/grava-app/?flexi=<номер>` — сборщик шарниров.

<details>
<summary>Как пересобрать vendor/three/three-viewer.min.js (нужно только для обновления three.js)</summary>

```sh
npm i three esbuild
npx esbuild vendor/three/three-viewer.entry.js --bundle --minify --format=esm \
  --target=es2019 --legal-comments=none --outfile=vendor/three/three-viewer.min.js
```
</details>
