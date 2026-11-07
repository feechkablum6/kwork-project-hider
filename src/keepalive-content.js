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

  if (document.body) check();
  else document.addEventListener('DOMContentLoaded', check, { once: true });
  setInterval(check, CHECK_MS);
})();

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
