(function initKworkPopup() {
  'use strict';

  const view = globalThis.KworkPopupView;
  const CRAWL_KEY = 'inboxCrawlState';
  const STATUS_KEY = 'inboxBridgeStatus';
  const SYNC_STATE_KEY = 'inboxSyncState';

  const elements = {
    status: document.getElementById('status'),
    hint: document.getElementById('hint'),
    progress: document.getElementById('progress'),
    fill: document.getElementById('fill'),
    counter: document.getElementById('counter'),
    action: document.getElementById('action'),
    error: document.getElementById('error'),
    auto: document.getElementById('auto'),
  };

  let actionMode = 'start';

  function renderAutoSync(syncState) {
    const model = view.describeAutoSync(syncState);
    elements.auto.textContent = model.text;
    elements.auto.classList.toggle('kph-popup__hint--problem', model.problem);
  }

  function render(state, bridgeStatus) {
    const model = view.describeCrawlState(state);
    actionMode = model.actionMode;

    elements.status.textContent = model.status;
    elements.hint.textContent = model.hint;
    elements.progress.hidden = !model.showProgress;
    elements.counter.textContent = model.counter;
    elements.action.textContent = model.actionLabel;
    elements.action.classList.toggle('kph-popup__action--stop', model.actionMode === 'stop');
    elements.fill.classList.toggle('kph-popup__fill--pending', model.pending);
    elements.fill.style.transform = model.pending ? '' : `scaleX(${model.ratio})`;

    const bridgeError = bridgeStatus && bridgeStatus.ok === false ? `Мост на диск не отвечает: ${bridgeStatus.error}` : null;
    const error = model.error || bridgeError;
    elements.error.hidden = !error;
    elements.error.textContent = error || '';
  }

  function refresh() {
    chrome.storage.local.get([CRAWL_KEY, STATUS_KEY, SYNC_STATE_KEY], (result) => {
      void chrome.runtime.lastError;
      render(result?.[CRAWL_KEY] || {}, result?.[STATUS_KEY] || null);
      renderAutoSync(result?.[SYNC_STATE_KEY] || null);
    });
  }

  const ACTION_MESSAGES = {
    stop: 'kph-cancel-crawl',
    open: 'kph-open-kwork',
    start: 'kph-start-crawl',
  };

  elements.action.addEventListener('click', () => {
    const type = ACTION_MESSAGES[actionMode] || ACTION_MESSAGES.start;
    chrome.runtime.sendMessage({ type }, () => {
      void chrome.runtime.lastError;
      refresh();
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'kph-crawl-state') {
      refresh();
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes[CRAWL_KEY] || changes[STATUS_KEY] || changes[SYNC_STATE_KEY])) {
      refresh();
    }
  });

  refresh();
})();
