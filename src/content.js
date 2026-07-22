(function initializeKworkProjectHider() {
  'use strict';

  const core = globalThis.KworkProjectHiderCore;
  if (!core?.isProjectsListPage?.(window.location.href)
    || !globalThis.chrome?.storage?.local) {
    return;
  }

  const STORAGE_KEY = 'hiddenProjectIds';
  const UNDO_TIMEOUT_MS = 6000;
  const HIDE_ANIMATION_MS = 180;
  const PROJECT_LINK_SELECTOR = 'a[href*="/projects/"]';
  const CARD_SELECTORS = [
    '[data-project-id]',
    '.want-card',
    '.js-project-card',
    '.project-card',
    '.project-card__wrapper',
    '.project-item',
    '.project-list__item',
    '.project-list-item',
    '.projects-list__item',
    '.wants-card',
    '.wants-card__item',
    'article',
    'li',
  ];

  let hiddenProjectIds = new Set();
  let writeQueue = Promise.resolve();
  let scanScheduled = false;
  let toastTimer = null;
  let undoState = null;

  function getStorage() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(result?.[STORAGE_KEY]);
      });
    });
  }

  function setStorage(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: values }, () => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  function persistHiddenProjects() {
    const snapshot = [...hiddenProjectIds];
    writeQueue = writeQueue.catch(() => undefined).then(() => setStorage(snapshot));
    return writeQueue;
  }

  function getProjectIdsInside(element) {
    const ids = new Set();
    for (const link of element.querySelectorAll(PROJECT_LINK_SELECTOR)) {
      const projectId = core.extractProjectId(link.href);
      if (projectId) {
        ids.add(projectId);
      }
    }
    return ids;
  }

  function findProjectCard(link, projectId) {
    const selector = CARD_SELECTORS.join(',');
    const matchedCard = link.closest(selector);

    if (matchedCard && getProjectIdsInside(matchedCard).size === 1) {
      return matchedCard;
    }

    let candidate = link.parentElement;
    for (let depth = 0; candidate && candidate !== document.body && depth < 7; depth += 1) {
      const ids = getProjectIdsInside(candidate);
      const className = typeof candidate.className === 'string' ? candidate.className : '';
      const hasCardShape = /project|want|card|item/i.test(className)
        || candidate.matches('article, li, section');

      if (hasCardShape && ids.size === 1 && ids.has(projectId)) {
        return candidate;
      }

      candidate = candidate.parentElement;
    }

    return null;
  }

  function createHideIcon() {
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('kph-hide-icon');

    const eye = document.createElementNS(namespace, 'path');
    eye.setAttribute('d', 'M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z');

    const pupil = document.createElementNS(namespace, 'circle');
    pupil.setAttribute('cx', '12');
    pupil.setAttribute('cy', '12');
    pupil.setAttribute('r', '2.5');

    const slash = document.createElementNS(namespace, 'path');
    slash.setAttribute('d', 'm4 4 16 16');

    svg.append(eye, pupil, slash);
    return svg;
  }

  function createHideButton(projectId, card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kph-hide-button';
    button.setAttribute('aria-label', 'Скрыть проект');
    button.title = 'Скрыть проект';
    button.append(createHideIcon());

    const label = document.createElement('span');
    label.className = 'kph-hide-label';
    label.textContent = 'Скрыть';
    button.append(label);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideProject(projectId, card);
    });

    return button;
  }

  function setCardHidden(card, hidden, animate = false) {
    const pendingTimer = Number(card.dataset.kphHideTimer || 0);
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      delete card.dataset.kphHideTimer;
    }

    if (!hidden) {
      card.hidden = false;
      card.classList.remove('kph-is-hidden', 'kph-is-hiding');
      card.removeAttribute('aria-hidden');
      return;
    }

    card.setAttribute('aria-hidden', 'true');
    if (!animate) {
      card.classList.add('kph-is-hidden');
      card.hidden = true;
      return;
    }

    card.classList.add('kph-is-hiding');
    const timer = window.setTimeout(() => {
      card.classList.remove('kph-is-hiding');
      card.classList.add('kph-is-hidden');
      card.hidden = true;
      delete card.dataset.kphHideTimer;
    }, HIDE_ANIMATION_MS);
    card.dataset.kphHideTimer = String(timer);
  }

  function removeToast() {
    window.clearTimeout(toastTimer);
    toastTimer = null;
    document.querySelector('.kph-toast')?.remove();
  }

  function showToast(message, actionLabel, onAction) {
    removeToast();

    const toast = document.createElement('div');
    toast.className = 'kph-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);

    if (actionLabel && onAction) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'kph-toast-action';
      action.textContent = actionLabel;
      action.addEventListener('click', onAction, { once: true });
      toast.append(action);
    }

    document.body.append(toast);
    requestAnimationFrame(() => toast.classList.add('kph-toast-visible'));
    toastTimer = window.setTimeout(removeToast, UNDO_TIMEOUT_MS);
  }

  async function undoLastHide() {
    const currentUndo = undoState;
    undoState = null;
    removeToast();

    if (!currentUndo) {
      return;
    }

    hiddenProjectIds.delete(currentUndo.projectId);
    setCardHidden(currentUndo.card, false);

    try {
      await persistHiddenProjects();
    } catch {
      hiddenProjectIds.add(currentUndo.projectId);
      setCardHidden(currentUndo.card, true);
      showToast('Не удалось вернуть проект. Проверьте доступ к хранилищу.');
    }
  }

  async function hideProject(projectId, card) {
    if (hiddenProjectIds.has(projectId)) {
      return;
    }

    hiddenProjectIds.add(projectId);
    setCardHidden(card, true, true);
    undoState = { projectId, card };
    showToast('Проект скрыт', 'Отменить', undoLastHide);

    try {
      await persistHiddenProjects();
    } catch {
      if (undoState?.projectId === projectId) {
        undoState = null;
      }
      hiddenProjectIds.delete(projectId);
      setCardHidden(card, false);
      showToast('Не удалось сохранить скрытие. Проверьте доступ к хранилищу.');
    }
  }

  function enhanceProjectLink(link) {
    const projectId = core.extractProjectId(link.href);
    if (!projectId) {
      return;
    }

    const card = findProjectCard(link, projectId);
    if (!card || card.dataset.kphEnhanced === 'true') {
      return;
    }

    card.dataset.kphEnhanced = 'true';
    card.dataset.kphProjectId = projectId;
    card.classList.add('kph-project-card');

    const slot = document.createElement('div');
    slot.className = 'kph-hide-slot';
    slot.append(createHideButton(projectId, card));
    const budgetContainer = core.findBudgetContainer(card);
    (budgetContainer || card).append(slot);

    if (hiddenProjectIds.has(projectId)) {
      setCardHidden(card, true);
    }
  }

  function scanProjects() {
    for (const link of document.querySelectorAll(PROJECT_LINK_SELECTOR)) {
      enhanceProjectLink(link);
    }
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      scanProjects();
    });
  }

  async function start() {
    try {
      hiddenProjectIds = new Set(core.normalizeProjectIds(await getStorage()));
    } catch {
      hiddenProjectIds = new Set();
      showToast('Не удалось прочитать список скрытых проектов.');
    }

    scanProjects();

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[STORAGE_KEY]) {
        return;
      }

      hiddenProjectIds = new Set(core.normalizeProjectIds(changes[STORAGE_KEY].newValue));
      for (const card of document.querySelectorAll('[data-kph-project-id]')) {
        setCardHidden(card, hiddenProjectIds.has(card.dataset.kphProjectId));
      }
    });
  }

  start();
})();
