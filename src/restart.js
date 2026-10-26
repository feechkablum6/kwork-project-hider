// Служебная страница перезапуска: keepalive-content.js подгружает её скрытой рамкой на каждой
// странице Kwork сразу и раз в минуту. Фоновый скрипт не отвечает так, как Chrome отвечает при его
// отсутствии, 50 секунд подряд (промахи помнятся между страницами и вкладками) — расширение
// перезапускается, не чаще раза в 10 минут. Живой, но промолчавший получатель (открытый попап)
// отвечает иначе и сбрасывает счёт.
const DEAD = /Receiving end does not exist/i;
const MISS_KEY = 'autoRestartMissSince';
const RESTART_KEY = 'autoRestartAt';
const DEAD_FOR_MS = 50 * 1000;
const STREAK_GAP_MS = 3 * 60 * 1000;
const MIN_GAP_MS = 10 * 60 * 1000;

chrome.runtime.sendMessage({ type: 'kph-ping' }, () => {
  const dead = DEAD.test(chrome.runtime.lastError?.message || '');
  chrome.storage.local.get([MISS_KEY, RESTART_KEY], (stored) => {
    const now = Date.now();
    if (!dead) {
      if (stored?.[MISS_KEY]) chrome.storage.local.remove(MISS_KEY);
      return;
    }

    // Промахи — одна полоса, пока между ними не больше трёх минут (страницы Kwork не открывали).
    const missSince = stored?.[MISS_KEY];
    const since = missSince && now - missSince.last < STREAK_GAP_MS ? missSince.first : now;
    // Часы могли перевести назад: время из будущего не держит перезапуск.
    const lastRestart = stored?.[RESTART_KEY] || 0;
    if (now - since >= DEAD_FOR_MS && (now - lastRestart >= MIN_GAP_MS || lastRestart > now)) {
      chrome.storage.local.remove(MISS_KEY);
      chrome.storage.local.set({ [RESTART_KEY]: now }, () => chrome.runtime.reload());
      return;
    }

    chrome.storage.local.set({ [MISS_KEY]: { first: since, last: now } });
  });
});
