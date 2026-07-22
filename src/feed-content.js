(function initializeInfiniteProjectFeed() {
  'use strict';

  const core = globalThis.KworkProjectHiderCore;
  if (!core?.isProjectsListPage?.(window.location.href)
    || document.documentElement.getAttribute('data-kph-feed-ready') !== 'true'
    || typeof IntersectionObserver !== 'function'
    || typeof core?.clickPreservingScroll !== 'function') {
    return;
  }

  const initialUrl = new URL(window.location.href);
  if (Number(initialUrl.searchParams.get('page')) > 1) {
    initialUrl.searchParams.delete('page');
    window.location.replace(initialUrl.href);
    return;
  }

  const PROJECT_LIST_SELECTOR = '.project-list';
  const PAGINATION_SELECTOR = '.pagination';
  const NEXT_PAGE_SELECTOR = '.pagination__arrow--next';
  const STATUS_CLASS = 'kph-feed-status';
  const STATUS_VISIBLE_CLASS = 'kph-feed-status--visible';

  let status = null;
  let statusAnchor = null;
  let isIntersecting = false;
  let isLoading = false;
  let isFinished = false;
  let isObserved = false;
  let loadTimeout = null;
  let syncScheduled = false;

  function setStatus(message = '') {
    if (!status) {
      return;
    }

    status.textContent = message;
    status.classList.toggle(STATUS_VISIBLE_CLASS, Boolean(message));
  }

  function getNextPageButton() {
    const button = document.querySelector(NEXT_PAGE_SELECTOR);
    if (!button || button.matches(
      ':disabled, [aria-disabled="true"], .disabled, .pagination__arrow--disabled, [class*="--disabled"]',
    )) {
      return null;
    }

    return button;
  }

  function ensureStatus() {
    const projectList = document.querySelector(PROJECT_LIST_SELECTOR);
    if (!projectList?.parentElement) {
      return false;
    }

    document.querySelector(PAGINATION_SELECTOR)?.classList.add('kph-feed-pagination');

    if (!status) {
      status = document.createElement('div');
      status.className = STATUS_CLASS;
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
    }

    if (statusAnchor !== projectList || status.parentElement !== projectList.parentElement) {
      projectList.insertAdjacentElement('afterend', status);
      statusAnchor = projectList;
    }

    if (!isObserved) {
      intersectionObserver.observe(status);
      isObserved = true;
    }

    return true;
  }

  function loadNextPage() {
    if (!isIntersecting || isLoading || isFinished || !ensureStatus()) {
      return;
    }

    const nextPageButton = getNextPageButton();
    if (!nextPageButton) {
      isFinished = true;
      setStatus('Все доступные проекты загружены');
      return;
    }

    isLoading = true;
    setStatus('Загружаю следующие проекты…');
    core.clickPreservingScroll(nextPageButton, window);
    window.clearTimeout(loadTimeout);
    loadTimeout = window.setTimeout(() => {
      isLoading = false;
      isFinished = true;
      setStatus('Не удалось загрузить следующие проекты. Обновите страницу.');
    }, 15000);
  }

  function syncAfterRender() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ensureStatus();
        window.clearTimeout(loadTimeout);
        isLoading = false;

        if (!getNextPageButton()) {
          isFinished = true;
          setStatus('Все доступные проекты загружены');
          return;
        }

        isFinished = false;
        setStatus();
        loadNextPage();
      });
    });
  }

  function scheduleSync() {
    if (syncScheduled) {
      return;
    }

    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      ensureStatus();
    });
  }

  const intersectionObserver = new IntersectionObserver((entries) => {
    isIntersecting = entries.some((entry) => entry.target === status && entry.isIntersecting);
    loadNextPage();
  }, {
    rootMargin: '600px 0px',
  });

  const mutationObserver = new MutationObserver(scheduleSync);
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('kph-feed-loading', () => {
    isLoading = true;
    setStatus('Загружаю следующие проекты…');
  });
  document.addEventListener('kph-feed-loaded', syncAfterRender);
  document.addEventListener('kph-feed-error', () => {
    window.clearTimeout(loadTimeout);
    isLoading = false;
    isFinished = true;
    setStatus('Не удалось загрузить следующие проекты. Обновите страницу.');
  });

  ensureStatus();
})();
