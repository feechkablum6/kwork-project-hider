(function initKworkProjectExtractor() {
  'use strict';

  const core = globalThis.KworkProjectExportCore;
  if (!core || !globalThis.chrome?.runtime?.sendMessage) {
    return;
  }

  function askBackground(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // Страницу заказа читает вкладка: запрос уходит с её адресом и куками,
  // поэтому биржа отдаёт заказ, а не страницу входа. Файлы дальше забирает
  // фоновый скрипт — их адреса переадресуются на CDN, недоступный со страницы.
  async function extract(projectId, onStage) {
    const url = core.buildProjectUrl(projectId);
    if (!url) {
      return { ok: false, error: 'неизвестный номер заказа' };
    }

    onStage?.('read');

    let markup = '';
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        return { ok: false, error: 'Kwork не отдал страницу заказа' };
      }

      markup = await response.text();
    } catch {
      return { ok: false, error: 'страница заказа не открылась' };
    }

    const project = core.extractProject(markup, { url });
    if (!project) {
      return { ok: false, error: 'данные заказа не распознаны' };
    }

    onStage?.(project.files.length > 0 ? 'files' : 'save', project.files.length);

    const saved = await askBackground({ type: 'kph-save-project', project });
    if (!saved?.ok) {
      return { ok: false, error: saved?.error || 'мост недоступен' };
    }

    return {
      ok: true,
      path: saved.path || null,
      dir: saved.dir || null,
      title: project.title,
      files: saved.files || 0,
      savedFiles: saved.savedFiles || 0,
    };
  }

  globalThis.KworkProjectExtractor = { extract };
})();
