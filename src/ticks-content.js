// Третья галочка у сообщений Kwork: сообщение уже лежит на диске и его видит
// Claude. Ключи блоков ставит ticks-main.js, список сохранённых отдаёт мост.
(function initKworkTicks() {
  'use strict';

  const core = globalThis.KworkInboxCore;
  if (!/^\/(?:(?:new_)?inbox\/[^/]+|track)/.test(window.location.pathname) || !globalThis.chrome?.runtime?.sendMessage) {
    return;
  }

  const TICK_CLASS = 'kph-tick';
  const TICK_TITLE = 'Есть у Claude: сообщение сохранено на диск';
  const REFRESH_MS = 10 * 1000;
  const saved = new Map();
  let timer = null;
  let loading = false;

  function currentDialogKey() {
    if (window.location.pathname !== '/track') {
      return core?.extractDialogKey?.(window.location.href) || null;
    }

    return document.documentElement.dataset.kphPeer
      || document.querySelector('.js-message-block[data-kph-peer]')?.dataset.kphPeer
      || null;
  }

  function loadKeys(dialogKey) {
    loading = true;
    try {
      chrome.runtime.sendMessage({ type: 'kph-saved-keys', dialogKey }, (response) => {
        void chrome.runtime.lastError;
        loading = false;
        saved.set(dialogKey, { keys: new Set(response?.keys || []), at: Date.now() });
        schedule();
      });
    } catch {
      // Расширение перезагружено — галочки вернутся после обновления страницы.
      loading = false;
    }
  }

  function mark() {
    timer = null;
    const dialogKey = currentDialogKey();
    if (!dialogKey) {
      return;
    }

    const entry = saved.get(dialogKey);
    let waiting = false;
    for (const block of document.querySelectorAll('.js-message-block[data-kph-key]')) {
      const icon = block.querySelector('.cm-message-status__icon');
      if (!icon || icon.querySelector(`.${TICK_CLASS}`)) {
        continue;
      }

      if (!entry?.keys.has(block.dataset.kphKey)) {
        waiting = true;
        continue;
      }

      const tick = document.createElement('span');
      tick.className = TICK_CLASS;
      tick.title = TICK_TITLE;
      icon.append(tick);
    }

    // Новое сообщение ложится на диск через секунду-другую после появления,
    // поэтому неотмеченные блоки перепроверяются, но не чаще раза в 10 секунд.
    if (waiting && !loading && (!entry || Date.now() - entry.at >= REFRESH_MS)) {
      loadKeys(dialogKey);
    } else if (waiting) {
      setTimeout(schedule, REFRESH_MS);
    }
  }

  function schedule() {
    if (!timer) {
      timer = setTimeout(mark, 400);
    }
  }

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-kph-key'] });
    schedule();
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
