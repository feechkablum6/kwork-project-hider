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
