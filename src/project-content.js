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

  // Свежий заказ биржа со страницы не отдаёт: она уводит запрос на общий список
  // проектов. Такой заказ берётся из ленты — там он приходит тем же объектом,
  // что и на своей странице, вместе с описанием и файлами.
  const PROJECT_REQUEST_ATTRIBUTE = 'data-kph-project-request';
  const PROJECT_PAYLOAD_ATTRIBUTE = 'data-kph-project-payload';

  function readFeedProject(projectId, url) {
    const documentElement = document.documentElement;
    if (!documentElement) {
      return null;
    }

    documentElement.setAttribute(PROJECT_REQUEST_ATTRIBUTE, String(projectId));
    document.dispatchEvent(new Event('kph-project-request'));

    const payload = documentElement.getAttribute(PROJECT_PAYLOAD_ATTRIBUTE);
    documentElement.removeAttribute(PROJECT_REQUEST_ATTRIBUTE);
    documentElement.removeAttribute(PROJECT_PAYLOAD_ATTRIBUTE);

    try {
      return payload ? core.normalizeProject(JSON.parse(payload), { url }) : null;
    } catch {
      return null;
    }
  }

  // Страницу заказа читает вкладка: запрос уходит с её адресом и куками,
  // поэтому биржа отдаёт заказ, а не страницу входа. Файлы дальше забирает
  // фоновый скрипт — их адреса переадресуются на CDN, недоступный со страницы.
  async function readProjectPage(url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      // Уведённый на список проектов запрос приходит с успешным кодом, поэтому
      // адрес ответа проверяется отдельно: разметка списка заказа не содержит.
      if (!response.ok || response.redirected) {
        return '';
      }

      return await response.text();
    } catch {
      return '';
    }
  }

  async function extract(projectId, onStage) {
    const url = core.buildProjectUrl(projectId);
    if (!url) {
      return { ok: false, error: 'неизвестный номер заказа' };
    }

    onStage?.('read');

    const markup = await readProjectPage(url);
    const project = (markup ? core.extractProject(markup, { url }) : null)
      || readFeedProject(projectId, url);
    if (!project) {
      return { ok: false, error: 'Kwork не открыл заказ, а в ленте его нет — обновите страницу' };
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
