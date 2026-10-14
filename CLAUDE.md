﻿# CLAUDE.md

## Стек

- Chrome Extension Manifest V3.
- JavaScript без сборщика и внешних зависимостей.
- Node.js `node --test`.

## Команды

- `npm test` — полный набор тестов.
- `npm run sync-core` — пересоздание копий ядра для изолированного мира после правок `src/core.js` или `src/inbox-core.js`.
- `npm run chat -- <ссылка>` — печать сохранённой переписки с клиентом.
- `npm version patch|minor` — новая версия сразу в `package.json` и `manifest.json`.
- `install.bat` (Windows) или `install.command` (macOS) — установка моста, который пишет переписки и заказы на диск.
- `powershell -ExecutionPolicy Bypass -File .\scripts\generate-icons.ps1` — пересоздание иконок.

## Структура

- `src/core.js` — чистая тестируемая логика ленты, доступная в браузере и Node.js.
- `src/inbox-core.js` — чистая логика переписок: распознавание сообщений, склейка, рендер markdown.
- `src/project-core.js` — чистая логика заказов: разбор состояния страницы заказа, имя папки, рендер markdown.
- `src/project-content.js` — чтение страницы заказа в изолированном мире по кнопке «Извлечь».
- `src/payout-core.js` — чистая логика выплаты: отбор незакрытых заявок на вывод, сумма, разбор даты биржи, срок словами.
- `src/payout-source.js` — получение операций баланса с любой страницы Kwork, листание и кеш в `chrome.storage`.
- `src/payout-content.js` — виджет ближайшей выплаты в шапке рядом с балансом.
- `src/report-toggle.js` — кнопка «Скрыть/Открыть» у блока «Промежуточный отчет» на странице заказа; состояние одно на все заказы (`reportCollapsed` в `chrome.storage`).
- `src/core-isolated.js`, `src/inbox-core-isolated.js` — сгенерированные копии ядер для изолированного мира, вручную не править.
- `src/feed-main.js` — перехват запросов Kwork в MAIN world и объединение страниц.
- `src/inbox-main.js` — перехват ответов переписки и догрузка истории в MAIN world.
- `src/inbox-crawler.js` — массовая выгрузка всех переписок в MAIN world: список диалогов, подбор листания, полная история.
- `src/ticks-main.js` (MAIN world) и `src/ticks-content.js` — третья оранжевая галочка «есть у Claude» у сообщений, сохранённых на диск; ключ «автор:время» (`messageKey`), список от моста `message-keys`.
- `src/popup.html`, `src/popup.css`, `src/popup.js`, `src/popup-view.js` — попап с кнопкой выгрузки и прогрессом; тексты состояний считает `popup-view.js`.
- `src/content.js` — скрытие карточек и работа с `chrome.storage`.
- `src/feed-content.js` — DOM-адаптер автоподгрузки в isolated world.
- `src/inbox-content.js` — сбор переписки в isolated world, скачивание вложений и передача в фоновый скрипт.
- `src/session-sync.js` — передаёт куки входа kwork.ru мосту; `native_host/session-push.js` кладёт их по ssh на сервер робота kwork-hunter (сообщения заказчиков в Telegram). Значения кук не логировать и на маке не хранить, только отпечаток.
- `src/background.js` — service worker, единственная точка связи с native messaging хостом; раз в 2 минуты сам дописывает новые сообщения, вложения и отклики (`kwork.ru/offers`) без открытой вкладки Kwork.
- `native_host/` — мост на Node.js: протокол native messaging и запись файлов переписок.
- `scripts/install-bridge.mjs`, `scripts/kwork-chat.mjs` — установка моста и чтение переписок из терминала.
- `scripts/kwork-shared.mjs` — общее для сводки и сверки: папка переписок, связь заказ ↔ ник, рабочие копии T3, формат времени.
- `scripts/kwork-brief.mjs` — сводка переписки для агента Claude Code (хуки SessionStart/UserPromptSubmit через `~/.claude/scripts/kwork-chat-brief.sh`): новые сообщения клиента, кто ответил последним, пути к файлам. Связь заказа с клиентом — `~/Projects/Kwork/docs/заказы-клиенты.md`.
- `scripts/kwork-drafts.mjs` — сверка черновиков агента с отправленным: `capture` (Stop-хук `~/.claude/scripts/kwork-draft-capture.sh`) и `sync`; итог дописывает в `~/.claude/skills/estimate/data/sent.md`.
- `scripts/sync-version.mjs` — после `npm version …` переносит номер версии в `manifest.json`. Установщик знает Windows и macOS: реестр и `exe` против манифестов в папках браузеров и `sh`.
- `test/` — тесты ядра, перехватчика, моста, manifest и интеграционных контрактов DOM.

## Правила

- Сохранять двухслойную схему MAIN world / isolated world; `chrome.storage` доступен только isolated content script.
- Тестируемые вычисления и разбор DOM-состояния выносить в `src/core.js`, логику переписок — в `src/inbox-core.js`.
- Переписки и заказы писать на диск только через мост: расширение не хранит их в `chrome.storage` и никуда не отправляет.
- Раскладка папки заказов — папка на заказ: `<номер>-<заголовок>/заказ.md`, `данные.json`, `файлы/`. Папка заказов лежит рядом с папкой переписок, путь берётся из `projectsDir` настройки моста.
- Раскладка папки переписок — папка на диалог: `<ник>/переписка.md`, `<ник>/данные.json`, `<ник>/файлы/`. Имена держать в константах ядра, не дублировать строками.
- Пользовательские статусы и ошибки писать кратко на русском языке.
- Не добавлять сборщик или зависимости без реальной необходимости.

## Анти-паттерны

Свод DO NOT вынесен в [docs/do-not.md](docs/do-not.md): правила подаются в каждый ход целиком, поэтому здесь их нет. Перед работой над темой читать нужный раздел через grep, а новую находку дописывать туда же.
