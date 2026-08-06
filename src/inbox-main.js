(function initKworkInboxCollector(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root?.document
    && root.XMLHttpRequest
    && root.KworkInboxCore?.isInboxPage?.(root.location?.href)) {
    api.installInboxCollector(root, { autoStart: true });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInboxCollectorApi() {
  const INSTALL_KEY = '__kphInboxCollectorInstalled';
  const MESSAGE_SOURCE = 'kph-inbox';
  const BACKFILL_IDLE_DELAY_MS = 800;
  const MAX_BACKFILL_PAGES = 40;
  const BACKFILL_TIMEOUT_MS = 10000;
  const PAGE_KEYS = ['page', 'offset', 'skip', 'p'];

  function installInboxCollector(root, options = {}) {
    if (!root || root[INSTALL_KEY]) {
      return false;
    }

    const core = root.KworkInboxCore;
    const NativeXMLHttpRequest = root.XMLHttpRequest;
    const prototype = NativeXMLHttpRequest?.prototype;
    if (!core?.collectMessages || !prototype?.open || !prototype?.send) {
      return false;
    }

    root[INSTALL_KEY] = true;

    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetRequestHeader = prototype.setRequestHeader;
    const originalFetch = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    const requests = new WeakMap();
    const publishedKeys = new Set();
    const state = {
      backfillTimer: null,
      backfilling: false,
      template: null,
    };

    function getDialogKeyFromLocation() {
      return core.extractDialogKey(root.location?.href || '');
    }

    function publish(kind, detail) {
      root.postMessage({
        source: MESSAGE_SOURCE,
        kind,
        ...detail,
      }, root.location?.origin || '*');
    }

    function getPublicationKey(kind, messages) {
      const ids = messages.map((message) => message.id || `${message.time}|${message.text.slice(0, 40)}`);
      return `${kind}:${ids.join(',')}`;
    }

    function publishMessages(messages, requestUrl, clientId = null) {
      if (messages.length === 0) {
        return false;
      }

      const key = getPublicationKey('messages', messages);
      if (publishedKeys.has(key)) {
        return false;
      }

      publishedKeys.add(key);
      publish('messages', {
        clientId,
        dialogKey: getDialogKeyFromLocation(),
        pageUrl: root.location?.href || null,
        requestUrl: requestUrl || null,
        messages,
      });
      return true;
    }

    function publishDialogs(dialogKeys) {
      if (dialogKeys.length === 0) {
        return;
      }

      const key = `dialogs:${dialogKeys.join(',')}`;
      if (publishedKeys.has(key)) {
        return;
      }

      publishedKeys.add(key);
      publish('dialogs', { dialogKeys });
    }

    function describeRequestBody(body) {
      if (body && typeof body.entries === 'function') {
        return [...body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : '(файл)']);
      }

      if (typeof body === 'string') {
        return [...new root.URLSearchParams(body).entries()];
      }

      return null;
    }

    function publishSample(requestUrl, payload, body) {
      publish('sample', {
        dialogKey: getDialogKeyFromLocation(),
        requestUrl: requestUrl || null,
        requestBody: describeRequestBody(body),
        payload,
      });
    }

    function parseJson(text) {
      if (typeof text !== 'string' || !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    function readPageValue(source) {
      for (const key of PAGE_KEYS) {
        const value = source?.get?.(key);
        if (value !== null && value !== undefined && /^\d+$/.test(String(value))) {
          return { key, value: Number(value) };
        }
      }

      return null;
    }

    function describeBody(body) {
      if (body && typeof body.entries === 'function' && typeof body.set === 'function') {
        return { type: 'formData', body };
      }

      if (typeof body === 'string' && body.includes('=')) {
        return { type: 'urlencoded', body: new root.URLSearchParams(body) };
      }

      return null;
    }

    function cloneBodyWithPage(description, pageKey, pageValue) {
      if (description.type === 'formData') {
        const clone = new root.FormData();
        for (const [key, value] of description.body.entries()) {
          if (key !== pageKey) {
            clone.append(key, value);
          }
        }
        clone.set(pageKey, String(pageValue));
        return clone;
      }

      const clone = new root.URLSearchParams(description.body.toString());
      clone.set(pageKey, String(pageValue));
      return clone.toString();
    }

    function rememberTemplate(metadata, body) {
      const description = describeBody(body);
      if (!description) {
        return;
      }

      const page = readPageValue(description.body);
      if (!page) {
        return;
      }

      state.template = {
        description,
        headers: [...(metadata?.headers || [])],
        method: metadata?.method || 'POST',
        page,
        url: metadata?.url || root.location?.href,
      };
    }

    function requestBackfillPage(template, page) {
      return new Promise((resolve, reject) => {
        const request = new NativeXMLHttpRequest();
        originalOpen.call(request, template.method, template.url, true);
        for (const [name, value] of template.headers) {
          originalSetRequestHeader?.call(request, name, value);
        }

        request.timeout = BACKFILL_TIMEOUT_MS;
        request.addEventListener('loadend', () => {
          if (request.status < 200 || request.status >= 300) {
            reject(new Error(`Страница переписки ${page} вернула ${request.status}`));
            return;
          }

          const payload = parseJson(request.responseText);
          if (!payload) {
            reject(new Error(`Страница переписки ${page} вернула не JSON`));
            return;
          }

          resolve(payload);
        }, { once: true });

        try {
          originalSend.call(request, cloneBodyWithPage(template.description, template.page.key, page));
        } catch (error) {
          reject(error);
        }
      });
    }

    async function runBackfill() {
      const template = state.template;
      if (!template || state.backfilling) {
        return;
      }

      state.backfilling = true;

      try {
        for (let step = 1; step <= MAX_BACKFILL_PAGES; step += 1) {
          const page = template.page.value + step;
          const payload = await requestBackfillPage(template, page);
          const messages = core.collectMessages(payload);
          if (messages.length === 0) {
            break;
          }

          const clientId = core.findParticipantId(payload, getDialogKeyFromLocation());
          if (!publishMessages(messages, template.url, clientId)) {
            break;
          }
        }
      } catch {
        publish('error', { reason: 'backfill' });
      } finally {
        state.backfilling = false;
      }
    }

    function scheduleBackfill() {
      if (typeof root.setTimeout !== 'function') {
        return;
      }

      root.clearTimeout?.(state.backfillTimer);
      state.backfillTimer = root.setTimeout(() => {
        state.backfillTimer = null;
        runBackfill();
      }, BACKFILL_IDLE_DELAY_MS);
    }

    function handlePayload(payload, requestUrl, metadata, body) {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const dialogKey = getDialogKeyFromLocation();
      const clientId = core.findParticipantId(payload, dialogKey);
      const messages = core.filterDialogMessages(core.collectMessages(payload), { dialogKey, clientId });
      if (messages.length > 0) {
        const published = publishMessages(messages, requestUrl, clientId);
        if (published) {
          publishSample(requestUrl, payload, body);
        }

        rememberTemplate(metadata, body);
        scheduleBackfill();
      }

      publishDialogs(core.findDialogKeys(payload));
    }

    prototype.open = function open(method, url, ...rest) {
      requests.set(this, { headers: [], method, url });
      return originalOpen.call(this, method, url, ...rest);
    };

    if (originalSetRequestHeader) {
      prototype.setRequestHeader = function setRequestHeader(name, value) {
        requests.get(this)?.headers.push([name, value]);
        return originalSetRequestHeader.call(this, name, value);
      };
    }

    prototype.send = function send(body) {
      const metadata = requests.get(this);
      this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) {
          return;
        }

        handlePayload(parseJson(this.responseText), metadata?.url, metadata, body);
      }, { once: true });

      return originalSend.call(this, body);
    };

    if (originalFetch) {
      root.fetch = function fetch(input, init) {
        const result = originalFetch(input, init);
        return result.then((response) => {
          const url = typeof input === 'string' ? input : input?.url;
          response.clone().text().then((text) => {
            handlePayload(
              parseJson(text),
              url,
              { headers: [], method: init?.method || 'GET', url },
              init?.body,
            );
          }).catch(() => undefined);
          return response;
        });
      };
    }

    root.document.documentElement?.setAttribute('data-kph-inbox-ready', 'true');

    if (options.autoStart === true) {
      publish('ready', { dialogKey: getDialogKeyFromLocation() });
    }

    return true;
  }

  return {
    installInboxCollector,
  };
});
