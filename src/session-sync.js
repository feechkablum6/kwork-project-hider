// Передаёт вход в Kwork (куки браузера) роботу kwork-hunter, чтобы тот читал переписку и
// присылал сообщения заказчиков в Telegram, пока мак спит. Расширение отдаёт куки только
// своему мосту на этом маке; мост кладёт их по ssh на сервер робота (native_host/session-push.js).
// Мост сам сравнивает с прошлой отправкой, поэтому звать его на каждое событие не страшно.

(() => {
  const HOST_NAME = 'ru.kwork.hider.host';
  const DEBOUNCE_MS = 3000;
  const NOISE = /^(_ym|_ga|_gid|_gcl|_fbp|tmr_|__ddg|cto_)/i;
  let timer = null;

  const isKworkDomain = (domain) => {
    const d = String(domain || '').replace(/^\./, '');
    return d === 'kwork.ru' || d.endsWith('.kwork.ru');
  };

  async function push() {
    timer = null;
    const all = await chrome.cookies.getAll({ domain: 'kwork.ru' });
    const cookies = all
      .filter((c) => isKworkDomain(c.domain))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
    if (!cookies.some((c) => !NOISE.test(c.name))) return;
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      { command: 'syncSession', cookies, userAgent: navigator.userAgent },
      () => void chrome.runtime.lastError,
    );
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => push().catch(() => {}), DEBOUNCE_MS);
  }

  chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (isKworkDomain(cookie.domain) && !NOISE.test(cookie.name)) schedule();
  });
  chrome.runtime.onStartup.addListener(schedule);
  chrome.runtime.onInstalled.addListener(schedule);
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === 'complete' && /^https:\/\/kwork\.ru\//.test(tab?.url || '')) schedule();
  });

  globalThis.KworkSessionSync = { push, schedule, isKworkDomain };
})();
