(function initKworkProjectHiderCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkProjectHiderCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCore() {
  function isProjectsListPage(href) {
    if (typeof href !== 'string' || !href.trim()) {
      return false;
    }

    try {
      const url = new URL(href, 'https://kwork.ru');
      const isKwork = url.hostname === 'kwork.ru' || url.hostname === 'www.kwork.ru';
      return isKwork && /^\/projects\/?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function extractProjectId(href) {
    if (typeof href !== 'string' || !href.trim()) {
      return null;
    }

    try {
      const url = new URL(href, 'https://kwork.ru');
      if (url.hostname !== 'kwork.ru' && url.hostname !== 'www.kwork.ru') {
        return null;
      }

      const match = url.pathname.match(/^\/projects\/(\d+)(?:\/view)?\/?$/);
      return match ? String(Number(match[1])) : null;
    } catch {
      return null;
    }
  }

  function normalizeProjectIds(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    const normalized = values
      .map((value) => String(value ?? '').trim())
      .filter((value) => /^\d+$/.test(value))
      .map((value) => String(Number(value)))
      .filter((value) => value !== '0');

    return [...new Set(normalized)];
  }

  function addProjectId(values, projectId) {
    return normalizeProjectIds([...normalizeProjectIds(values), projectId]);
  }

  function removeProjectId(values, projectId) {
    const normalizedProjectId = normalizeProjectIds([projectId])[0];
    return normalizeProjectIds(values).filter((value) => value !== normalizedProjectId);
  }

  function findBudgetContainer(card) {
    if (!card || typeof card.querySelectorAll !== 'function') {
      return null;
    }

    const candidates = [...card.querySelectorAll('div, section, aside, td, header')]
      .map((element) => ({
        element,
        text: String(element.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter(({ text }) => /желаемый\s+бюджет/i.test(text));

    const completeBudgetGroups = candidates.filter(({ text }) => /допустим/i.test(text));
    const suitableCandidates = completeBudgetGroups.length > 0 ? completeBudgetGroups : candidates;
    suitableCandidates.sort((left, right) => left.text.length - right.text.length);

    return suitableCandidates[0]?.element || null;
  }

  function mergeProjectPages(...pages) {
    const mergedProjects = [];
    const knownProjectIds = new Set();

    for (const page of pages) {
      if (!Array.isArray(page)) {
        continue;
      }

      for (const project of page) {
        const projectId = String(project?.id ?? '').trim();
        if (!projectId || knownProjectIds.has(projectId)) {
          continue;
        }

        knownProjectIds.add(projectId);
        mergedProjects.push(project);
      }
    }

    return mergedProjects;
  }

  function getProjectRequestSignature(formData) {
    if (!formData || typeof formData.entries !== 'function') {
      return '';
    }

    const entries = [...formData.entries()]
      .filter(([key]) => key !== 'page')
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return [key, value];
        }

        return [key, [value?.name, value?.size, value?.type, value?.lastModified].join(':')];
      })
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      ));

    return JSON.stringify(entries);
  }

  function clickPreservingScroll(button, viewport) {
    if (!button || typeof button.click !== 'function' || !viewport) {
      return false;
    }

    const left = Number(viewport.scrollX) || 0;
    const top = Number(viewport.scrollY) || 0;
    button.click();

    if (typeof viewport.scrollTo === 'function') {
      viewport.scrollTo({ behavior: 'instant', left, top });
    }

    return true;
  }

  return {
    isProjectsListPage,
    extractProjectId,
    normalizeProjectIds,
    addProjectId,
    removeProjectId,
    findBudgetContainer,
    mergeProjectPages,
    getProjectRequestSignature,
    clickPreservingScroll,
  };
});
