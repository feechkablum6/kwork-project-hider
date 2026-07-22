# Kwork Project Hider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Создать минимальное Chrome-расширение, которое навсегда скрывает выбранные проекты на странице биржи Kwork и позволяет отменить последнее скрытие в течение шести секунд.

**Architecture:** Manifest V3 запускает два content script: тестируемое ядро с чистыми функциями и DOM-адаптер страницы. Числовые ID проектов хранятся в `chrome.storage.local`; `MutationObserver` обрабатывает динамически добавленные карточки.

**Tech Stack:** JavaScript без зависимостей, Chrome Extensions Manifest V3, CSS, Node.js built-in test runner.

### Task 1: Тестируемое ядро

**Files:**
- Create: `test/core.test.js`
- Create: `src/core.js`

**Steps:**
1. Написать тесты разбора URL и операций с ID.
2. Запустить `npm test` и подтвердить падение из-за отсутствующего ядра.
3. Реализовать минимальные чистые функции.
4. Повторно запустить `npm test` и получить успешный результат.

### Task 2: Интеграция со страницей Kwork

**Files:**
- Create: `manifest.json`
- Create: `src/content.js`
- Create: `src/content.css`
- Create: `test/manifest.test.js`

**Steps:**
1. Написать тест требований к manifest.
2. Подтвердить ожидаемое падение.
3. Добавить Manifest V3 без попапа и content script с безопасным поиском карточек.
4. Реализовать кнопку, постоянное скрытие, отмену и обработку динамической ленты.
5. Запустить все тесты.

### Task 3: Иконки и документация

**Files:**
- Create: `icons/icon-16.png`
- Create: `icons/icon-32.png`
- Create: `icons/icon-48.png`
- Create: `icons/icon-128.png`
- Create: `README.md`

**Steps:**
1. Создать детерминированный зелёно-белый знак карточки со скрытым глазом.
2. Проверить размеры и формат PNG.
3. Описать установку и использование на русском языке.
4. Запустить полную финальную проверку.

Примечание: работа выполняется прямо в текущей папке по правилу пользователя; Git worktree не создаётся. Родительская папка не является Git-репозиторием, поэтому шаги commit неприменимы.
