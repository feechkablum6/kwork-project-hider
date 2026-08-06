(function initializeSilentProjectFeed() {
  'use strict';

  const core = globalThis.KworkProjectHiderCore;
  if (!core?.isProjectsListPage?.(window.location.href)
    || typeof core?.clickPreservingScroll !== 'function') {
    return;
  }

  if (document.documentElement.getAttribute('data-kph-feed-ready') === 'true') {
    startSilentProjectFeed();
  } else {
    document.addEventListener('kph-feed-ready', startSilentProjectFeed, { once: true });
  }

  function startSilentProjectFeed() {
    const initialUrl = new URL(window.location.href);
    if (Number(initialUrl.searchParams.get('page')) > 1) {
      initialUrl.searchParams.delete('page');
      window.location.replace(initialUrl.href);
      return;
    }

    const PROJECT_LIST_SELECTOR = '.project-list';
    const PAGINATION_SELECTOR = '.pagination';
    const NEXT_PAGE_SELECTOR = '.pagination__arrow--next';
    const RENDERING_ATTRIBUTE = 'data-kph-feed-rendering';
    const COLLECTED_ATTRIBUTE = 'data-kph-feed-collected';
    const COLLECTING_ATTRIBUTE = 'data-kph-feed-collecting';
    const RENDER_DECISION_ATTRIBUTE = 'data-kph-feed-render';
    const PROJECT_CARD_SELECTOR = '.want-card';
    const SKELETON_CLASS = 'kph-feed-skeleton';
    const SKELETON_CARD_COUNT = 3;
    const SKELETON_BARS = ['title', 'text', 'text-short', 'stats', 'meta'];

    let collectedFeedReady = false;
    let hasStarted = false;
    let isRendering = false;
    let useNativePagination = false;
    let syncScheduled = false;

    function getNextPageButton() {
      const button = document.querySelector(NEXT_PAGE_SELECTOR);
      if (!button || button.matches(
        ':disabled, [aria-disabled="true"], .disabled, .pagination__arrow--disabled, [class*="--disabled"]',
      )) {
        return null;
      }

      return button;
    }

    function hidePagination() {
      if (!useNativePagination) {
        document.querySelector(PAGINATION_SELECTOR)?.classList.add('kph-feed-pagination');
      }
    }

    function restorePagination() {
      for (const pagination of document.querySelectorAll(PAGINATION_SELECTOR)) {
        pagination.classList.remove('kph-feed-pagination');
      }
    }

    function setRendering(active) {
      isRendering = active;
      if (active) {
        document.documentElement.setAttribute(RENDERING_ATTRIBUTE, 'true');
      } else {
        document.documentElement.removeAttribute(RENDERING_ATTRIBUTE);
      }
    }

    function restoreListUrl() {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('page')) {
        return;
      }

      url.searchParams.delete('page');
      if (typeof window.history?.replaceState === 'function') {
        window.history.replaceState(window.history.state, '', url.href);
      }
    }

    function startSilentCollection() {
      if (hasStarted || !document.querySelector(PROJECT_LIST_SELECTOR)) {
        return;
      }

      const pagination = document.querySelector(PAGINATION_SELECTOR);
      if (!pagination) {
        return;
      }

      hasStarted = true;
      hidePagination();
      document.dispatchEvent(new Event('kph-feed-start'));
    }

    function renderCollectedFeed() {
      if (!collectedFeedReady || isRendering || useNativePagination) {
        return;
      }

      const nextPageButton = getNextPageButton();
      if (!nextPageButton) {
        collectedFeedReady = false;
        return;
      }

      collectedFeedReady = false;
      document.dispatchEvent(new Event('kph-feed-render'));
      if (document.documentElement.getAttribute(RENDER_DECISION_ATTRIBUTE) !== 'allowed') {
        return;
      }

      setRendering(true);
      core.clickPreservingScroll(nextPageButton, window);
      queueMicrotask(restoreListUrl);
    }

    function hasVisibleProjects() {
      for (const card of document.querySelectorAll(PROJECT_CARD_SELECTOR)) {
        if (!card.hidden && !card.classList.contains('kph-is-hidden')) {
          return true;
        }
      }

      return false;
    }

    function createSkeleton() {
      const skeleton = document.createElement('div');
      skeleton.className = SKELETON_CLASS;
      skeleton.setAttribute('aria-hidden', 'true');

      for (let index = 0; index < SKELETON_CARD_COUNT; index += 1) {
        const card = document.createElement('div');
        card.className = 'kph-feed-skeleton__card';

        for (const bar of SKELETON_BARS) {
          const line = document.createElement('div');
          line.className = `kph-feed-skeleton__bar kph-feed-skeleton__bar--${bar}`;
          card.append(line);
        }

        skeleton.append(card);
      }

      return skeleton;
    }

    function syncSkeleton() {
      const list = document.querySelector(PROJECT_LIST_SELECTOR);
      if (!list) {
        return;
      }

      const isBusy = document.documentElement.getAttribute(COLLECTING_ATTRIBUTE) === 'true'
        || isRendering;
      const existingSkeleton = list.querySelector(`.${SKELETON_CLASS}`);
      const shouldShow = isBusy && !hasVisibleProjects();

      if (shouldShow && !existingSkeleton) {
        list.append(createSkeleton());
        return;
      }

      if (!shouldShow && existingSkeleton) {
        existingSkeleton.remove();
      }
    }

    function syncFeed() {
      hidePagination();
      startSilentCollection();
      if (document.documentElement.getAttribute(COLLECTED_ATTRIBUTE) === 'true') {
        collectedFeedReady = true;
      }
      renderCollectedFeed();
      syncSkeleton();
    }

    function scheduleSync() {
      if (syncScheduled) {
        return;
      }

      syncScheduled = true;
      queueMicrotask(() => {
        syncScheduled = false;
        syncFeed();
      });
    }

    function useNativeFeed() {
      collectedFeedReady = false;
      setRendering(false);
      useNativePagination = true;
      restorePagination();
      syncSkeleton();
    }

    const mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('kph-feed-collecting', () => {
      collectedFeedReady = false;
      setRendering(false);
      useNativePagination = false;
      hidePagination();
      syncSkeleton();
      queueMicrotask(restoreListUrl);
    });
    document.addEventListener('kph-feed-collected', () => {
      collectedFeedReady = true;
      renderCollectedFeed();
    });
    document.addEventListener('kph-feed-loaded', () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setRendering(false);
          useNativePagination = false;
          hidePagination();
          syncSkeleton();
          restoreListUrl();
        });
      });
    });
    document.addEventListener('kph-feed-error', useNativeFeed);
    document.addEventListener('kph-feed-limited', useNativeFeed);

    syncFeed();
  }
})();
