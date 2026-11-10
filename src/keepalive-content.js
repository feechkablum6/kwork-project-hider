// Фоновый скрипт расширения может остановиться так, что Chrome его больше не поднимает (26.10.2026:
// мост, побудки и панель черновика стояли, пока расширение не перезапустили вручную). Страница Kwork
// сразу и раз в минуту подгружает скрытую служебную страницу расширения (restart.html): та сама
// проверяет фоновый скрипт и при нужде перезапускает расширение. Адрес берётся один раз: после
// перезапуска этот скрипт осиротеет, а рамка по тому же адресу продолжит проверять уже новый запуск.
(() => {
  const CHECK_MS = 60 * 1000;
  const url = chrome.runtime.getURL('src/restart.html');
  let frame = null;

  function check() {
    frame?.remove();
    frame = document.createElement('iframe');
    frame.src = url;
    frame.style.display = 'none';
    (document.body || document.documentElement).append(frame);
  }

  // Расширение перезагрузилось — скрипты этой страницы осиротели (скрытие, виджеты, сохранение молчат), а новые
  // Chrome в открытую вкладку не ставит: страница обновляется сама. Начатое не теряем: вкладку с любым изменённым
  // полем оставляем, её назовёт живая проверка. Страницы с панелью черновика решает reply-content.js
  // (цитата, карусель файлов, плашка) — здесь их не трогаем.
  const REPLY_PAGE = /^\/(?:(?:new_)?inbox\/[^/]+|track)/;
  let idle = 0;

  function changed() {
    return [...document.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"]')].some((field) => {
      if (field.type === 'hidden') return false;
      if (field.files?.length > 0) return true;
      if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
      if (field.options) {
        const preset = [...field.options].findIndex((option) => option.defaultSelected);
        return field.selectedIndex !== Math.max(preset, 0);
      }

      if ('value' in field) return String(field.value ?? '').trim() !== String(field.defaultValue ?? '').trim();
      return String(field.textContent ?? '').trim() !== '';
    });
  }

  function tick() {
    if (!chrome.runtime?.id && !REPLY_PAGE.test(location.pathname)) {
      // Пусто на двух проверках подряд: первая могла застать человека за секунду до ввода.
      idle = changed() ? 0 : idle + 1;
      if (idle >= 2) {
        location.reload();
        return;
      }
    }

    check();
  }

  if (document.body) check();
  else document.addEventListener('DOMContentLoaded', check, { once: true });
  setInterval(tick, CHECK_MS);
})();

// Живая проверка цепочки побудки: фоновый скрипт спрашивает, работает ли во вкладке скрипт его версии.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'kph-health') sendResponse({ version: chrome.runtime.getManifest().version });
});

// За частые запросы Kwork уводит на страницу с капчей (not_access.php): расширение замолкает
// (пауза как после отказа биржи, дальше её растит фоновый скрипт), фон и вкладки узнают об этом
// через chrome.storage. Открылась обычная страница Kwork — доступ вернулся, пауза снимается.
(() => {
  const core = globalThis.KworkInboxCore;
  const key = core.KWORK_BLOCK_KEY;
  if (core.isKworkBlockedUrl(location.href)) {
    chrome.storage.local.set({ [key]: Date.now() + core.syncPauseMs(0) });
  } else {
    chrome.storage.local.remove(key);
  }

  // Опрос вкладки (live-main.js) живёт в MAIN world без chrome.storage: срок паузы ему — атрибутом.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[key]) {
      return;
    }

    const until = changes[key].newValue;
    if (until) document.documentElement.dataset.kphBlockedUntil = String(until);
    else delete document.documentElement.dataset.kphBlockedUntil;
  });
})();
