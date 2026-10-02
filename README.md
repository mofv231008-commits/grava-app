# Грава — Mini App для @grava_ai_bot

Витрина работ пользователя, 3D-просмотр моделей и покупка кредитов.
Обычная статичная страница: без сборщиков и npm, работает на GitHub Pages.

## Файлы

| Файл | Что внутри |
|---|---|
| `index.html` | разметка всех экранов |
| `style.css` | оформление (цвета берутся из темы Telegram) |
| `app.js` | логика: запросы к API, вкладки, экран работы, оплата, 3D |
| `vendor/three-viewer.min.js` | three.js + STLLoader + OrbitControls одним файлом (лежит прямо здесь, без внешних CDN) |
| `.nojekyll` | чтобы GitHub Pages отдавал файлы как есть |

API: `https://engrave.app.n8n.cloud/webhook/grava-app` (адрес в начале `app.js`).

## Публикация

1. GitHub → репозиторий → **Settings → Pages**.
2. **Source:** Deploy from a branch → **main** → **/ (root)** → Save.
3. Через 1–2 минуты страница будет тут: https://mofv231008-commits.github.io/grava-app/

Если открыть ссылку в обычном браузере, будет надпись «Открой приложение из бота @grava_ai_bot». Так и задумано: приложение работает только внутри Telegram.

## Как обновлять

Меняешь файлы в ветке `main`, GitHub Pages обновится сам за пару минут.
Если Telegram показывает старую версию, увеличь число в `?v=1` у `style.css` и `app.js` в `index.html`.

<details>
<summary>Как пересобрать vendor/three-viewer.min.js (нужно только для обновления three.js)</summary>

```sh
npm i three esbuild
npx esbuild vendor/three-viewer.entry.js --bundle --minify --format=esm \
  --target=es2019 --legal-comments=none --outfile=vendor/three-viewer.min.js
```
</details>
