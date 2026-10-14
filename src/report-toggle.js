(function initializeKworkReportToggle() {
  'use strict';

  if (!/^\/track\/?$/.test(window.location.pathname) || !globalThis.chrome?.storage?.local) {
    return;
  }

  /* Свёрнутость одна на все заказы: напоминание о промежуточном отчёте
     одинаковое везде, и раз скрытое не должно всплывать на каждом заказе. */
  const STORAGE_KEY = 'reportCollapsed';
  const FORM_SELECTOR = 'form.js-track-send-progress-report';
  const ITEM_SELECTOR = '.track--item';
  const TITLE_SELECTOR = '.track--item__title';
  const CONTENT_SELECTOR = '.track--item__content';
  const ITEM_CLASS = 'kph-report-item';
  const COLLAPSED_CLASS = 'kph-report-collapsed';
  const BUTTON_CLASS = 'kph-report-toggle';

  let collapsed = false;
  let scanScheduled = false;
  let contentCounter = 0;

  function createChevron() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('kph-hide-icon', 'kph-report-toggle__icon');

    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', 'm6 9 6 6 6-6');
    svg.append(path);
    return svg;
  }

  function findReportItems() {
    const items = new Set();
    for (const form of document.querySelectorAll(FORM_SELECTOR)) {
      const item = form.closest(ITEM_SELECTOR);
      if (item?.querySelector(TITLE_SELECTOR)) {
        items.add(item);
      }
    }
    return items;
  }

  function renderButton(button) {
    button.setAttribute('aria-expanded', String(!collapsed));
    // Запись даже той же строки заменяет текстовый узел, а это мутация, на
    // которую снова сработает наблюдатель страницы — получился бы вечный цикл.
    const label = button.querySelector('.kph-report-toggle__label');
    const text = collapsed ? 'Открыть' : 'Скрыть';
    if (label.textContent !== text) {
      label.textContent = text;
    }
  }

  function applyState(item) {
    item.classList.toggle(COLLAPSED_CLASS, collapsed);
    const button = item.querySelector(`.${BUTTON_CLASS}`);
    if (button) {
      renderButton(button);
    }
  }

  function setCollapsed(value) {
    collapsed = value;
    for (const item of document.querySelectorAll(`.${ITEM_CLASS}`)) {
      applyState(item);
    }
  }

  function createButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `kph-hide-button ${BUTTON_CLASS}`;

    const content = item.querySelector(CONTENT_SELECTOR);
    if (content) {
      if (!content.id) {
        contentCounter += 1;
        content.id = `kph-report-content-${contentCounter}`;
      }
      button.setAttribute('aria-controls', content.id);
    }

    const label = document.createElement('span');
    label.className = 'kph-report-toggle__label';
    button.append(createChevron(), label);

    button.addEventListener('click', () => {
      setCollapsed(!collapsed);
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: collapsed }, () => void chrome.runtime?.lastError);
      } catch {
        // Контекст расширения мог смениться после перезагрузки: состояние
        // на странице уже переключено, теряется только запоминание.
      }
    });

    return button;
  }

  function scan() {
    scanScheduled = false;
    for (const item of findReportItems()) {
      item.classList.add(ITEM_CLASS);
      const title = item.querySelector(TITLE_SELECTOR);
      if (!title.querySelector(`.${BUTTON_CLASS}`)) {
        title.append(createButton(item));
      }
      applyState(item);
    }
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    requestAnimationFrame(scan);
  }

  function start() {
    scan();
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.storage.local.get([STORAGE_KEY], (result) => {
    void chrome.runtime?.lastError;
    collapsed = result?.[STORAGE_KEY] === true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && STORAGE_KEY in changes) {
      setCollapsed(changes[STORAGE_KEY].newValue === true);
    }
  });
})();
