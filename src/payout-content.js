(function initializeKworkPayoutWidget() {
  'use strict';

  const core = globalThis.KworkPayoutCore;
  const source = globalThis.KworkPayoutSource;
  if (!core?.buildPayoutState || !source?.loadOperations || !globalThis.chrome?.storage?.local) {
    return;
  }

  const WIDGET_ID = 'kph-payout-widget';
  const TIP_ID = 'kph-payout-tip';
  const CACHE_KEY = 'payoutCache';
  const BALANCE_URL = '/balance';
  const TIP_GAP = 8;
  const TIP_EDGE = 12;
  const REFRESH_INTERVAL_MS = 600000;

  /* Шапка Kwork собрана Vue: сумма лежит в ссылке на баланс, а весь блок —
     в контейнере рядом с чатом и аватаром. Запасные селекторы нужны потому,
     что вёрстку шапки биржа меняет чаще, чем эндпоинты. */
  const ANCHOR_SELECTORS = [
    '.header-funds.header-dropdown',
    '.header-funds',
    '.logoutheader a[href="/balance"]',
    'header a[href="/balance"]',
  ];

  let lastRenderedLabel = null;
  let lastState = null;
  let tipElement = null;
  let refreshTimer = null;

  /* Виджет и сам ведёт на /balance, поэтому запасные якоря по этой ссылке
     находят его же: без проверки узел начал бы вставляться относительно
     самого себя. */
  function isOwnNode(node) {
    return node?.id === WIDGET_ID || node?.closest?.(`#${WIDGET_ID}`) != null;
  }

  function findAnchor() {
    for (const selector of ANCHOR_SELECTORS) {
      for (const found of document.querySelectorAll(selector)) {
        if (found?.parentNode && !isOwnNode(found)) {
          return found;
        }
      }
    }
    return null;
  }

  function createIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'kph-payout__icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 2.5v6.5m0 0 2.6-2.6M8 9 5.4 6.4M3 12.2h10');
    svg.appendChild(path);

    return svg;
  }

  function ensureTip() {
    if (tipElement?.isConnected) {
      return tipElement;
    }

    tipElement = document.createElement('div');
    tipElement.id = TIP_ID;
    tipElement.className = 'kph-payout-tip';
    tipElement.setAttribute('role', 'tooltip');
    tipElement.hidden = true;
    document.body.appendChild(tipElement);

    return tipElement;
  }

  function placeTip(widget, tip) {
    const anchor = widget.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const maxLeft = document.documentElement.clientWidth - box.width - TIP_EDGE;
    const left = Math.max(TIP_EDGE, Math.min(anchor.left, maxLeft));
    const belowTop = anchor.bottom + TIP_GAP;
    const fitsBelow = belowTop + box.height <= document.documentElement.clientHeight - TIP_EDGE;
    const top = fitsBelow ? belowTop : Math.max(TIP_EDGE, anchor.top - box.height - TIP_GAP);

    /* Координаты идут в left/top, а не в transform: transform занят анимацией
       появления, и инлайновое значение её бы отменило. */
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showTip(widget, text) {
    if (!text) {
      return;
    }

    const tip = ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    /* Позиция считается по фактическому размеру подсказки, поэтому её сначала
       показывают невидимой, а классом включают уже на месте. */
    placeTip(widget, tip);
    requestAnimationFrame(() => {
      if (!tip.hidden) {
        tip.classList.add('kph-payout-tip-visible');
      }
    });
  }

  function hideTip() {
    if (!tipElement) {
      return;
    }

    tipElement.classList.remove('kph-payout-tip-visible');
    tipElement.hidden = true;
  }

  function buildWidget(state) {
    const widget = document.createElement('a');
    widget.id = WIDGET_ID;
    widget.className = 'kph-payout kph-payout-appear';
    widget.href = BALANCE_URL;
    widget.setAttribute('aria-describedby', TIP_ID);

    const amount = document.createElement('span');
    amount.className = 'kph-payout__amount';
    amount.textContent = state.amountText;

    widget.appendChild(createIcon());
    widget.appendChild(amount);

    if (state.delayText) {
      const separator = document.createElement('span');
      separator.className = 'kph-payout__separator';
      separator.textContent = '·';

      const delay = document.createElement('span');
      delay.className = 'kph-payout__delay';
      delay.textContent = state.delayText;

      widget.appendChild(separator);
      widget.appendChild(delay);
    }

    widget.addEventListener('mouseenter', () => showTip(widget, state.tooltip));
    widget.addEventListener('mouseleave', hideTip);
    widget.addEventListener('focus', () => showTip(widget, state.tooltip));
    widget.addEventListener('blur', hideTip);

    return widget;
  }

  function describeForScreenReader(state) {
    const parts = [`Заявки на вывод: ${state.amountText}`];
    if (state.delayText) {
      parts.push(`выплата ${state.delayText}`);
    }
    parts.push('открыть баланс');
    return `${parts.join(', ')}.`;
  }

  function removeWidget() {
    document.getElementById(WIDGET_ID)?.remove();
    hideTip();
    lastRenderedLabel = null;
    lastState = null;
  }

  function renderWidget(state) {
    if (!state) {
      removeWidget();
      return;
    }

    /* Состояние запоминается до вставки: шапки может ещё не быть в DOM, и
       тогда виджет соберётся позже, когда её отрисует Vue. */
    lastState = state;

    const anchor = findAnchor();
    if (!anchor?.parentNode) {
      return;
    }

    const existing = document.getElementById(WIDGET_ID);
    if (existing && lastRenderedLabel === state.label && existing.nextElementSibling === anchor) {
      return;
    }

    existing?.remove();

    const widget = buildWidget(state);
    widget.setAttribute('aria-label', describeForScreenReader(state));
    anchor.parentNode.insertBefore(widget, anchor);
    lastRenderedLabel = state.label;
  }

  /* Дату ближайшей выплаты биржа кладёт и в корень ответа, и в саму операцию.
     Своими правилами «понедельник и четверг» её не пересчитываем: праздники и
     переносы биржа считает сама. */
  function applyFallbackDate(operations, dateWithdraw) {
    if (!Array.isArray(operations) || !dateWithdraw) {
      return operations;
    }

    return operations.map((operation) => (
      operation && !operation.getDateWithdrawByDate
        ? { ...operation, getDateWithdrawByDate: dateWithdraw }
        : operation
    ));
  }

  async function refresh(options = {}) {
    const result = await source.loadOperations({ force: options.force === true });
    if (!result || result.error || !Array.isArray(result.operations)) {
      /* Разлогин или сбой запроса: показанная сумма могла устареть или вовсе
         принадлежать другому аккаунту, поэтому её снимают, а не оставляют. */
      removeWidget();
      return;
    }

    const operations = applyFallbackDate(result.operations, result.dateWithdraw);
    renderWidget(core.buildPayoutState(operations, new Date()));
  }

  function watchHeader() {
    const observer = new MutationObserver(() => {
      if (!lastState || document.getElementById(WIDGET_ID)) {
        return;
      }
      /* Vue либо снёс виджет вместе с шапкой, либо только сейчас её отрисовал.
         Оба случая закрывает повторная вставка последнего состояния — без
         сетевого запроса. */
      renderWidget(lastState);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function watchCache() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[CACHE_KEY]) {
        refresh().catch(() => {});
      }
    });
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) {
      return;
    }

    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        refresh().catch(() => {});
      }
    }, REFRESH_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refresh().catch(() => {});
      }
    });
  }

  function start() {
    /* На самой странице баланса пользователь только что мог создать или
       отменить заявку, поэтому кеш там не в счёт. */
    const onBalancePage = window.location.pathname.replace(/\/+$/, '') === BALANCE_URL;

    refresh({ force: onBalancePage }).catch(() => {});
    watchHeader();
    watchCache();
    scheduleRefresh();

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideTip();
      }
    });

    window.addEventListener('scroll', hideTip, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
