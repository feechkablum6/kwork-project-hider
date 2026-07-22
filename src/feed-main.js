(function initKworkProjectFeed(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root?.document
    && root.XMLHttpRequest
    && root.KworkProjectHiderCore?.isProjectsListPage?.(root.location?.href)) {
    api.installProjectFeedInterceptor(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProjectFeedApi() {
  const INSTALL_KEY = '__kphProjectFeedInstalled';

  function installProjectFeedInterceptor(root) {
    if (!root || root[INSTALL_KEY]) {
      return false;
    }

    const core = root.KworkProjectHiderCore;
    const NativeXMLHttpRequest = root.XMLHttpRequest;
    const prototype = NativeXMLHttpRequest?.prototype;
    const responseTextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'responseText');
    const responseDescriptor = Object.getOwnPropertyDescriptor(prototype, 'response');

    if (!core?.mergeProjectPages
      || !core?.getProjectRequestSignature
      || !prototype?.open
      || !prototype?.send
      || !responseTextDescriptor?.get) {
      return false;
    }

    root[INSTALL_KEY] = true;

    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetRequestHeader = prototype.setRequestHeader;
    const requests = new WeakMap();
    const transformedText = new WeakMap();
    const transformedResponse = new WeakMap();
    const state = {
      projects: [],
      signature: null,
    };

    function dispatch(name) {
      if (!root.document?.dispatchEvent || typeof root.Event !== 'function') {
        return;
      }

      root.document.dispatchEvent(new root.Event(name));
    }

    function isProjectsRequest(method, url) {
      if (String(method || '').toUpperCase() !== 'POST') {
        return false;
      }

      try {
        const baseUrl = new URL(root.location?.href || 'https://kwork.ru');
        const requestUrl = new URL(String(url || ''), baseUrl);
        return requestUrl.origin === baseUrl.origin && requestUrl.pathname === '/projects';
      } catch {
        return false;
      }
    }

    function cloneFormData(source, page) {
      const clone = new root.FormData();
      for (const [key, value] of source.entries()) {
        if (key !== 'page') {
          clone.append(key, value);
        }
      }
      clone.set('page', String(page));
      return clone;
    }

    function getPagination(payload) {
      return payload?.data?.pagination;
    }

    function getPageProjects(payload) {
      if (Array.isArray(payload?.data?.wants)) {
        return payload.data.wants;
      }

      return getPagination(payload)?.data;
    }

    function mergePayload(payload) {
      const pagination = getPagination(payload);
      const pageProjects = getPageProjects(payload);
      if (!pagination || !Array.isArray(pageProjects)) {
        return payload;
      }

      state.projects = core.mergeProjectPages(state.projects, pageProjects);
      payload.data.wants = state.projects;
      pagination.data = state.projects;
      pagination.from = state.projects.length > 0 ? 1 : null;
      pagination.to = state.projects.length;
      return payload;
    }

    function transformText(request, rawText) {
      const metadata = requests.get(request);
      if (!metadata?.isProjects
        || metadata.signature !== state.signature
        || request.readyState !== 4
        || request.status < 200
        || request.status >= 300) {
        return rawText;
      }

      const cached = transformedText.get(request);
      if (cached?.source === rawText) {
        return cached.value;
      }

      try {
        const transformed = JSON.stringify(mergePayload(JSON.parse(rawText)));
        transformedText.set(request, { source: rawText, value: transformed });
        return transformed;
      } catch {
        return rawText;
      }
    }

    function transformResponseValue(request, rawValue) {
      if (typeof rawValue === 'string') {
        return transformText(request, rawValue);
      }

      const metadata = requests.get(request);
      if (!metadata?.isProjects
        || metadata.signature !== state.signature
        || request.readyState !== 4
        || request.status < 200
        || request.status >= 300
        || !rawValue
        || typeof rawValue !== 'object') {
        return rawValue;
      }

      if (transformedResponse.has(request)) {
        return transformedResponse.get(request);
      }

      const transformed = mergePayload(rawValue);
      transformedResponse.set(request, transformed);
      return transformed;
    }

    function sendOriginal(request, body) {
      try {
        originalSend.call(request, body);
      } catch {
        dispatch('kph-feed-error');
      }
    }

    function preloadVisiblePage(request, metadata, body) {
      const preloadRequest = new NativeXMLHttpRequest();
      const visiblePage = Math.max(1, metadata.page - 1);
      const preloadBody = cloneFormData(body, visiblePage);

      originalOpen.call(preloadRequest, 'POST', metadata.url, true);
      for (const [name, value] of metadata.headers) {
        originalSetRequestHeader?.call(preloadRequest, name, value);
      }

      let preloadFinished = false;
      const finishPreload = () => {
        if (preloadFinished) {
          return;
        }

        preloadFinished = true;
        if (preloadRequest.status >= 200
          && preloadRequest.status < 300
          && state.signature === metadata.signature) {
          try {
            const rawText = responseTextDescriptor.get.call(preloadRequest);
            state.projects = core.mergeProjectPages(getPageProjects(JSON.parse(rawText)));
          } catch {
            state.projects = [];
          }
        }
        sendOriginal(request, body);
      };

      preloadRequest.timeout = 10000;
      preloadRequest.addEventListener('loadend', finishPreload, { once: true });
      originalSend.call(preloadRequest, preloadBody);
    }

    prototype.open = function open(method, url, ...rest) {
      requests.set(this, {
        headers: [],
        isProjects: isProjectsRequest(method, url),
        method,
        page: 1,
        signature: '',
        url,
      });
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
      if (!metadata?.isProjects || !body || typeof body.entries !== 'function') {
        return originalSend.call(this, body);
      }

      metadata.page = Math.max(1, Number(body.get?.('page')) || 1);
      metadata.signature = core.getProjectRequestSignature(body);

      if (state.signature !== metadata.signature || metadata.page === 1) {
        state.projects = [];
        state.signature = metadata.signature;
      }

      dispatch('kph-feed-loading');
      this.addEventListener('loadend', () => {
        const eventName = this.status >= 200 && this.status < 300
          ? 'kph-feed-loaded'
          : 'kph-feed-error';
        const notifyLoaded = () => dispatch(eventName);
        if (typeof root.setTimeout === 'function') {
          root.setTimeout(notifyLoaded, 0);
        } else {
          notifyLoaded();
        }
      }, { once: true });

      if (metadata.page > 1 && state.projects.length === 0) {
        preloadVisiblePage(this, metadata, body);
        return undefined;
      }

      return originalSend.call(this, body);
    };

    Object.defineProperty(prototype, 'responseText', {
      configurable: responseTextDescriptor.configurable,
      enumerable: responseTextDescriptor.enumerable,
      get() {
        return transformText(this, responseTextDescriptor.get.call(this));
      },
    });

    if (responseDescriptor?.get) {
      Object.defineProperty(prototype, 'response', {
        configurable: responseDescriptor.configurable,
        enumerable: responseDescriptor.enumerable,
        get() {
          return transformResponseValue(this, responseDescriptor.get.call(this));
        },
      });
    }

    root.document.documentElement?.setAttribute('data-kph-feed-ready', 'true');
    dispatch('kph-feed-ready');

    return true;
  }

  return {
    installProjectFeedInterceptor,
  };
});
