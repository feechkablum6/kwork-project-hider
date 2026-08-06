(function initKworkInboxCrawler(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root?.document && root.KworkInboxCore?.isInboxPage?.(root.location?.href)) {
    api.installInboxCrawler(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInboxCrawlerApi() {
  const INSTALL_KEY = '__kphInboxCrawlerInstalled';
  const MESSAGE_SOURCE = 'kph-inbox';
  const HISTORY_URL = '/inbox_more_messages';
  const DIALOG_LIST_URLS = ['/inbox_more_dialogs', '/inbox_dialogs', '/new_inbox_more_dialogs'];
  const PAGE_LIMIT = 50;
  const MAX_PAGES_PER_DIALOG = 200;
  const REQUEST_PAUSE_MS = 60;
  const DIALOG_CONCURRENCY = 4;
  const PROFILE_CONCURRENCY = 6;
  const HISTORY_BATCH = 4;

  function installInboxCrawler(root) {
    if (!root || root[INSTALL_KEY]) {
      return false;
    }

    const core = root.KworkInboxCore;
    if (!core?.collectMessages || typeof root.fetch !== 'function') {
      return false;
    }

    root[INSTALL_KEY] = true;
    let running = false;
    let cancelled = false;
    let lastSamplePayload = null;
    let ownerName = null;

    function publish(kind, detail) {
      root.postMessage({ source: MESSAGE_SOURCE, kind, ...detail }, root.location?.origin || '*');
    }

    function report(progress) {
      publish('crawl-progress', { progress });
    }

    function pause(ms) {
      return new Promise((resolve) => root.setTimeout(resolve, ms));
    }

    async function postForm(url, params) {
      const body = new root.URLSearchParams(params).toString();
      const response = await root.fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      });

      if (!response.ok) {
        throw new Error(`${url} вернул ${response.status}`);
      }

      return response.json();
    }

    // История приходит пачками, а параметр глубины Kwork не публикует:
    // рабочий вариант ищется один раз и дальше используется как есть.
    async function loadDialogHistory(dialogKey, userId, onProgress) {
      const baseParams = { userId: String(userId), allUnread: 'false', limit: String(PAGE_LIMIT) };
      const firstPayload = await postForm(HISTORY_URL, baseParams);
      const clientId = core.findParticipantId(firstPayload, dialogKey) || String(userId);
      const dialogContext = { dialogKey, clientId };
      let messages = core.filterDialogMessages(core.collectMessages(firstPayload), dialogContext);
      ownerName = ownerName || core.findOwnerName(messages, dialogKey);
      onProgress?.(messages.length);

      // Ранний выход по числу сообщений ошибается: биржа отдаёт пачку с повторами,
      // и после дедупа их всегда меньше лимита. Листание продолжается до тех пор,
      // пока хоть один вариант запроса приносит новые сообщения.
      let strategy = null;

      for (let page = 0; page < MAX_PAGES_PER_DIALOG; page += 1) {
        if (cancelled) {
          return { messages, clientId, complete: false };
        }

        const state = { loaded: messages.length, oldestId: core.getOldestMessage(messages)?.id };

        // Смещение не зависит от предыдущего ответа, поэтому такие страницы
        // забираются пачкой; курсорные варианты остаются последовательными.
        if (core.isParallelStrategy(strategy)) {
          const batch = Array.from({ length: HISTORY_BATCH }, (_, index) => core.buildHistoryRequest(
            baseParams,
            strategy,
            { ...state, loaded: state.loaded + index * PAGE_LIMIT },
          )).filter(Boolean);

          const payloads = await Promise.all(batch.map((attempt) => postForm(HISTORY_URL, attempt.params)
            .then((payload) => core.filterDialogMessages(core.collectMessages(payload), dialogContext))
            .catch(() => [])));
          const incoming = core.mergeMessages(...payloads);

          if (core.countNewMessages(messages, incoming) === 0) {
            return { messages, clientId, complete: true, strategy };
          }

          messages = core.mergeMessages(messages, incoming);
          onProgress?.(messages.length);
          await pause(REQUEST_PAUSE_MS);
          continue;
        }

        const attempts = strategy
          ? [core.buildHistoryRequest(baseParams, strategy, state)].filter(Boolean)
          : core.buildHistoryProbes(baseParams, state);

        let advanced = false;

        for (const attempt of attempts) {
          let payload;
          try {
            payload = await postForm(HISTORY_URL, attempt.params);
          } catch {
            continue;
          }

          const incoming = core.filterDialogMessages(core.collectMessages(payload), dialogContext);
          if (core.countNewMessages(messages, incoming) === 0) {
            continue;
          }

          messages = core.mergeMessages(messages, incoming);
          strategy = attempt.strategy;
          advanced = true;
          onProgress?.(messages.length);
          break;
        }

        if (!advanced) {
          return { messages, clientId, complete: true, strategy };
        }

        await pause(REQUEST_PAUSE_MS);
      }

      return { messages, clientId, complete: false, strategy };
    }

    async function runWithConcurrency(items, limit, worker) {
      let nextIndex = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length && !cancelled) {
          const index = nextIndex;
          nextIndex += 1;
          await worker(items[index], index);
        }
      });

      await Promise.all(workers);
    }

    async function resolveUserIdByProfile(dialogKey) {
      try {
        const response = await root.fetch(`/user/${encodeURIComponent(dialogKey)}`, { credentials: 'same-origin' });
        if (!response.ok) {
          return null;
        }

        const markup = await response.text();
        if (/"isSameUser"\s*:\s*true/.test(markup)) {
          return null;
        }

        return core.extractProfileUserId(markup, dialogKey);
      } catch {
        return null;
      }
    }

    function collectDialogLinks() {
      const keys = new Set();
      for (const link of root.document.querySelectorAll('a[href*="inbox/"]')) {
        const key = core.extractDialogKey(link.getAttribute('href') || '');
        if (key && !core.isServiceDialogKey(key)) {
          keys.add(key);
        }
      }

      return keys;
    }

    // Список переписок Kwork подгружается по мере прокрутки, поэтому список
    // сначала прокручивается до конца, а уже потом читается из разметки.
    async function scrollDialogListToEnd() {
      const containers = [...root.document.querySelectorAll('div, ul, section')]
        .filter((element) => element.scrollHeight > element.clientHeight + 40 && element.clientHeight > 200);
      const list = containers.find((element) => element.querySelector('a[href*="inbox/"]')) || root.document.scrollingElement;

      let previousCount = 0;

      if (!list || collectDialogLinks().size === 0) {
        return;
      }

      for (let step = 0; step < 20; step += 1) {
        if (cancelled) {
          break;
        }

        list?.scrollTo?.({ top: list.scrollHeight, behavior: 'instant' });
        if (list === root.document.scrollingElement) {
          root.scrollTo?.({ top: root.document.body.scrollHeight, behavior: 'instant' });
        }

        await pause(300);
        const count = collectDialogLinks().size;
        if (count === previousCount && step > 2) {
          break;
        }

        previousCount = count;
      }
    }

    async function waitForDialogLinks() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const keys = collectDialogLinks();
        if (keys.size > 0) {
          return keys;
        }

        await pause(400);
      }

      return collectDialogLinks();
    }

    // Список переписок на странице может рендериться скриптом, поэтому ключи
    // ищутся ещё и в разметке ответа /inbox, и в состоянии страницы.
    function collectKeysFromMarkup(markup) {
      const keys = new Set();
      const pattern = /\/(?:inbox|new_inbox)\/([A-Za-z0-9_.-]{2,40})/g;
      let match = pattern.exec(markup);

      while (match) {
        const key = match[1];
        if (!core.isServiceDialogKey(key) && !/^(more_messages|more_dialogs|dialogs)$/.test(key)) {
          keys.add(key);
        }

        match = pattern.exec(markup);
      }

      return keys;
    }

    async function loadKeysFromInboxPage() {
      try {
        const response = await root.fetch('/inbox', { credentials: 'same-origin' });
        if (!response.ok) {
          return { keys: new Set(), status: response.status };
        }

        const markup = await response.text();
        return { keys: collectKeysFromMarkup(markup), status: response.status, length: markup.length };
      } catch (error) {
        return { keys: new Set(), error: error?.message || 'ошибка запроса' };
      }
    }

    function collectKeysFromPageState() {
      const keys = new Set();

      for (const name of Object.getOwnPropertyNames(root)) {
        if (!/^(__|_|app|kwork|inbox|initial|state|store|nuxt|vue)/i.test(name)) {
          continue;
        }

        let value;
        try {
          value = root[name];
        } catch {
          continue;
        }

        if (!value || typeof value !== 'object') {
          continue;
        }

        for (const key of core.findDialogKeys(value)) {
          keys.add(key);
        }
      }

      return keys;
    }

    async function loadDialogList(knownUserIds = {}) {
      const found = new Map();
      const probeResults = [];

      for (const url of DIALOG_LIST_URLS) {
        try {
          const payload = await postForm(url, { page: '1', limit: '50' });
          const keys = core.findDialogKeys(payload);
          probeResults.push({ url, keys: keys.length });

          for (const key of keys) {
            found.set(key, core.findParticipantId(payload, key) || found.get(key) || null);
          }

          if (keys.length > 0) {
            for (let page = 2; page <= 20; page += 1) {
              const next = await postForm(url, { page: String(page), limit: '50' });
              const nextKeys = core.findDialogKeys(next);
              if (nextKeys.length === 0) {
                break;
              }

              for (const key of nextKeys) {
                found.set(key, core.findParticipantId(next, key) || found.get(key) || null);
              }
            }

            break;
          }
        } catch (error) {
          probeResults.push({ url, error: error?.message || 'ошибка' });
        }
      }

      const pageKeys = collectKeysFromPageState();
      for (const key of pageKeys) {
        if (!found.has(key)) {
          found.set(key, null);
        }
      }

      const inboxPage = await loadKeysFromInboxPage();
      for (const key of inboxPage.keys) {
        if (!found.has(key)) {
          found.set(key, null);
        }
      }

      if (found.size === 0) {
        await waitForDialogLinks();
      }

      await scrollDialogListToEnd();

      for (const key of collectDialogLinks()) {
        if (!found.has(key)) {
          found.set(key, null);
        }
      }

      for (const key of Object.keys(knownUserIds)) {
        if (!found.get(key)) {
          found.set(key, knownUserIds[key]);
        }
      }

      // Состояние страницы и запомненные идентификаторы приносят ещё и диалоги
      // самой биржи, поэтому служебные ключи отсекаются на итоговом списке.
      for (const key of [...found.keys()]) {
        if (core.isServiceDialogKey(key)) {
          found.delete(key);
        }
      }

      return {
        dialogs: [...found.entries()].map(([key, userId]) => ({ key, userId })),
        diagnostics: {
          pageUrl: root.location?.href || null,
          dialogsFound: found.size,
          linksFound: collectDialogLinks().size,
          keysFromPageState: pageKeys.size,
          inboxPage: { status: inboxPage.status || null, length: inboxPage.length || null, keys: inboxPage.keys.size, error: inboxPage.error || null },
          hrefSample: [...root.document.querySelectorAll('a[href*="inbox"]')]
            .slice(0, 25)
            .map((link) => link.getAttribute('href')),
          anchorCount: root.document.querySelectorAll('a').length,
          probeResults,
          knownUserIds: Object.keys(knownUserIds).length,
        },
      };
    }

    async function crawlAll(knownUserIds = {}) {
      if (running) {
        return;
      }

      running = true;
      cancelled = false;

      try {
        report({ stage: 'dialogs', done: 0, total: 0, messages: 0, dialogKey: null });
        const { dialogs, diagnostics } = await loadDialogList(knownUserIds);
        publish('crawl-diagnostics', { diagnostics });
        publish('crawl-dialog-keys', { dialogKeys: dialogs.map((dialog) => dialog.key) });
        const total = dialogs.length;
        const pending = [];
        let done = 0;
        let totalMessages = 0;

        if (total === 0) {
          publish('crawl-done', {
            total: 0,
            messages: 0,
            reason: 'На странице переписок не нашлось ни одного диалога',
            diagnostics,
          });
          return;
        }

        // Идентификаторы клиентов разрешаются заранее и параллельно: страница
        // профиля отдаёт их одним запросом, открывать диалоги не нужно.
        await runWithConcurrency(dialogs, PROFILE_CONCURRENCY, async (dialog) => {
          if (dialog.userId || knownUserIds[dialog.key]) {
            dialog.userId = dialog.userId || knownUserIds[dialog.key];
            return;
          }

          dialog.userId = await resolveUserIdByProfile(dialog.key);
        });

        await runWithConcurrency(dialogs, DIALOG_CONCURRENCY, async (dialog) => {
          if (cancelled) {
            return;
          }

          if (ownerName && dialog.key.toLowerCase() === ownerName.toLowerCase()) {
            done += 1;
            return;
          }

          if (!dialog.userId) {
            done += 1;
            pending.push(dialog.key);
            report({ stage: 'dialog', done, total, messages: totalMessages, dialogKey: dialog.key });
            return;
          }

          try {
            const result = await loadDialogHistory(dialog.key, dialog.userId, (count) => {
              report({ stage: 'dialog', done, total, messages: totalMessages + count, dialogKey: dialog.key });
            });

            if (result.messages.length === 0) {
              done += 1;
              report({ stage: 'dialog', done, total, messages: totalMessages, dialogKey: dialog.key });
              return;
            }

            totalMessages += result.messages.length;
            publish('crawl-dialog', {
              dialogKey: dialog.key,
              clientId: result.clientId,
              messages: result.messages,
              complete: result.complete,
              strategy: result.strategy || null,
            });
          } catch (error) {
            publish('crawl-skipped', { dialogKey: dialog.key, reason: error?.message || 'ошибка запроса' });
          }

          done += 1;
          report({ stage: 'dialog', done, total, messages: totalMessages, dialogKey: dialog.key });
        });

        publish('crawl-done', { total, messages: totalMessages, cancelled, pending });
      } catch (error) {
        publish('crawl-done', { total: 0, messages: 0, reason: error?.message || 'ошибка выгрузки' });
      } finally {
        running = false;
      }
    }

    // Диалог, который ещё не открывали, не имеет известного идентификатора клиента.
    // Страница диалога сама раскрывает его в ответе, поэтому расширение дожидается
    // перехваченного ответа и только после этого тянет историю целиком.
    async function crawlOpenedDialog() {
      const dialogKey = core.extractDialogKey(root.location?.href || '');
      if (!dialogKey) {
        publish('crawl-one-done', { dialogKey: null, reason: 'страница не является перепиской' });
        return;
      }

      const userId = await waitForUserId(dialogKey);
      if (!userId) {
        publish('crawl-one-done', { dialogKey, reason: 'не удалось определить клиента' });
        return;
      }

      try {
        const result = await loadDialogHistory(dialogKey, userId, (count) => {
          publish('crawl-progress', { progress: { stage: 'dialog', dialogKey, messages: count } });
        });

        publish('crawl-dialog', {
          dialogKey,
          clientId: result.clientId,
          messages: result.messages,
          complete: result.complete,
          strategy: result.strategy || null,
        });
        publish('crawl-one-done', { dialogKey, messages: result.messages.length });
      } catch (error) {
        publish('crawl-one-done', { dialogKey, reason: error?.message || 'ошибка запроса' });
      }
    }

    function waitForUserId(dialogKey) {
      const known = core.findParticipantId(lastSamplePayload, dialogKey);
      if (known) {
        return Promise.resolve(known);
      }

      return new Promise((resolve) => {
        const timer = root.setTimeout(() => {
          root.removeEventListener('message', onMessage);
          resolve(null);
        }, 12000);

        function onMessage(event) {
          if (event.source !== root || event.data?.source !== MESSAGE_SOURCE || event.data.kind !== 'sample') {
            return;
          }

          const userId = core.findParticipantId(event.data.payload, dialogKey);
          if (!userId) {
            return;
          }

          root.clearTimeout(timer);
          root.removeEventListener('message', onMessage);
          resolve(userId);
        }

        root.addEventListener('message', onMessage);
      });
    }

    root.addEventListener('message', (event) => {
      if (event.source !== root) {
        return;
      }

      if (event.data?.source === MESSAGE_SOURCE && event.data.kind === 'sample') {
        lastSamplePayload = event.data.payload;
        return;
      }

      if (event.data?.source !== `${MESSAGE_SOURCE}-command`) {
        return;
      }

      if (event.data.kind === 'crawl-all') {
        crawlAll(event.data.knownUserIds || {});
        return;
      }

      if (event.data.kind === 'crawl-one') {
        crawlOpenedDialog();
        return;
      }

      if (event.data.kind === 'crawl-cancel') {
        cancelled = true;
      }
    });

    root.document.documentElement?.setAttribute('data-kph-inbox-crawler', 'true');
    return true;
  }

  return {
    installInboxCrawler,
  };
});
