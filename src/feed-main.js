(function initKworkProjectFeed(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root?.document
    && root.XMLHttpRequest
    && root.KworkProjectHiderCore?.isProjectsListPage?.(root.location?.href)) {
    api.installProjectFeedInterceptor(root, { autoStart: true });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProjectFeedApi() {
  const INSTALL_KEY = '__kphProjectFeedInstalled';
  const COLLECTION_IDLE_DELAY_MS = 1000;
  const MAX_MERGED_PAGES = 10;
  const PRELOAD_CONCURRENCY = 5;
  const RENDER_REQUEST_TTL_MS = 3000;
  const RENDERED_FEED_MATCH_RATIO = 0.5;
  const COLLECTED_ATTRIBUTE = 'data-kph-feed-collected';
  const COLLECTING_ATTRIBUTE = 'data-kph-feed-collecting';
  const RENDER_DECISION_ATTRIBUTE = 'data-kph-feed-render';

  function installProjectFeedInterceptor(root, options = {}) {
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
    const activePreloadRequests = new Set();
    const state = {
      collectionTimer: null,
      collecting: false,
      complete: false,
      generation: 0,
      pages: new Map(),
      renderRequestedAt: 0,
      signature: null,
      suppressed: false,
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

    function isCurrentCollection(metadata) {
      return metadata?.signature === state.signature
        && metadata?.generation === state.generation;
    }

    function clearCollectionTimer() {
      if (state.collectionTimer === null) {
        return;
      }

      root.clearTimeout?.(state.collectionTimer);
      state.collectionTimer = null;
    }

    function abortActivePreloads() {
      const requestsToAbort = [...activePreloadRequests];
      activePreloadRequests.clear();
      for (const request of requestsToAbort) {
        request.abort?.();
      }
    }

    function setFeedFlag(attribute, active) {
      const documentElement = root.document?.documentElement;
      if (active) {
        documentElement?.setAttribute?.(attribute, 'true');
      } else {
        documentElement?.removeAttribute?.(attribute);
      }
    }

    function setCollectedFlag(collected) {
      setFeedFlag(COLLECTED_ATTRIBUTE, collected);
    }

    function setCollectingFlag(collecting) {
      setFeedFlag(COLLECTING_ATTRIBUTE, collecting);
    }

    function stopCurrentCollection(eventName) {
      clearCollectionTimer();
      state.collecting = false;
      state.complete = false;
      state.pages = new Map();
      state.renderRequestedAt = 0;
      state.suppressed = true;
      setCollectedFlag(false);
      setCollectingFlag(false);
      abortActivePreloads();
      dispatch(eventName);
    }

    function resetState(signature) {
      state.generation += 1;
      clearCollectionTimer();
      abortActivePreloads();
      state.collecting = false;
      state.complete = false;
      state.pages = new Map();
      state.renderRequestedAt = 0;
      state.signature = signature;
      state.suppressed = false;
      setCollectedFlag(false);
    }

    function getRenderedProjectIds() {
      const renderedIds = new Set();
      const links = root.document?.querySelectorAll?.('a[href*="/projects/"]') || [];
      for (const link of links) {
        const projectId = core.extractProjectId?.(link.href);
        if (projectId) {
          renderedIds.add(projectId);
        }
      }

      return renderedIds;
    }

    function matchesRenderedFeed(projects) {
      const renderedIds = getRenderedProjectIds();
      if (renderedIds.size === 0) {
        return true;
      }

      const collectedIds = (projects || [])
        .map((project) => String(project?.id ?? '').trim())
        .filter(Boolean);
      if (collectedIds.length === 0) {
        return false;
      }

      const matchedCount = collectedIds.filter((id) => renderedIds.has(id)).length;
      return matchedCount >= collectedIds.length * RENDERED_FEED_MATCH_RATIO;
    }

    function isRenderRequestPending() {
      return state.renderRequestedAt > 0
        && Date.now() - state.renderRequestedAt <= RENDER_REQUEST_TTL_MS;
    }

    function storePage(metadata, page, payload) {
      const projects = getPageProjects(payload);
      if (!metadata.mergeEnabled
        || !isCurrentCollection(metadata)
        || !Array.isArray(projects)) {
        return false;
      }

      state.pages.set(page, projects);
      return true;
    }

    function getMergedProjects() {
      const orderedPages = [...state.pages.entries()]
        .sort(([leftPage], [rightPage]) => leftPage - rightPage)
        .map(([, projects]) => projects);
      return core.mergeProjectPages(...orderedPages);
    }

    function mergePayload(request, payload) {
      const metadata = requests.get(request);
      const pagination = getPagination(payload);
      const pageProjects = getPageProjects(payload);
      if (!metadata?.mergeEnabled
        || !metadata.renderMerged
        || !state.complete
        || !isCurrentCollection(metadata)
        || !pagination
        || !Array.isArray(pageProjects)) {
        return payload;
      }

      state.pages.set(metadata.page, pageProjects);
      const mergedProjects = getMergedProjects();
      payload.data.wants = mergedProjects;
      pagination.data = mergedProjects;
      pagination.from = mergedProjects.length > 0 ? 1 : null;
      pagination.to = mergedProjects.length;
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
        const transformed = JSON.stringify(mergePayload(request, JSON.parse(rawText)));
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

      const transformed = mergePayload(request, rawValue);
      transformedResponse.set(request, transformed);
      return transformed;
    }

    function requestPage(metadata, body, page) {
      return new Promise((resolve, reject) => {
        const preloadRequest = new NativeXMLHttpRequest();
        const preloadBody = cloneFormData(body, page);

        originalOpen.call(preloadRequest, 'POST', metadata.url, true);
        for (const [name, value] of metadata.headers) {
          originalSetRequestHeader?.call(preloadRequest, name, value);
        }

        preloadRequest.timeout = 10000;
        preloadRequest.addEventListener('loadend', () => {
          activePreloadRequests.delete(preloadRequest);
          if (preloadRequest.status < 200 || preloadRequest.status >= 300) {
            reject(new Error(`Project page ${page} returned ${preloadRequest.status}`));
            return;
          }

          try {
            const rawText = responseTextDescriptor.get.call(preloadRequest);
            const payload = JSON.parse(rawText);
            if (!getPagination(payload) || !Array.isArray(getPageProjects(payload))) {
              reject(new Error(`Project page ${page} has an unexpected response`));
              return;
            }
            resolve(payload);
          } catch (error) {
            reject(error);
          }
        }, { once: true });

        try {
          activePreloadRequests.add(preloadRequest);
          originalSend.call(preloadRequest, preloadBody);
        } catch (error) {
          activePreloadRequests.delete(preloadRequest);
          reject(error);
        }
      });
    }

    async function runPageQueue(pages, worker) {
      let nextIndex = 0;
      const workers = Array.from(
        { length: Math.min(PRELOAD_CONCURRENCY, pages.length) },
        async () => {
          while (nextIndex < pages.length) {
            const page = pages[nextIndex];
            nextIndex += 1;
            await worker(page);
          }
        },
      );
      await Promise.all(workers);
    }

    async function collectFeed(metadata, body) {
      setCollectingFlag(true);
      dispatch('kph-feed-collecting');

      try {
        const firstPagePayload = await requestPage(metadata, body, 1);
        if (!storePage(metadata, 1, firstPagePayload)) {
          throw new Error('Project feed collection became stale');
        }

        const lastPage = Math.max(1, Number(getPagination(firstPagePayload)?.last_page) || 1);
        if (lastPage > MAX_MERGED_PAGES) {
          stopCurrentCollection('kph-feed-limited');
          return;
        }

        const pages = [];
        for (let page = 2; page <= lastPage; page += 1) {
          pages.push(page);
        }

        await runPageQueue(pages, async (page) => {
          const payload = await requestPage(metadata, body, page);
          if (!storePage(metadata, page, payload)) {
            throw new Error('Project feed collection became stale');
          }
        });

        if (!isCurrentCollection(metadata)) {
          throw new Error('Project feed collection became stale');
        }

        state.collecting = false;
        state.complete = true;
        setCollectingFlag(false);
        setCollectedFlag(true);
        dispatch('kph-feed-collected');
      } catch {
        if (!isCurrentCollection(metadata) || state.suppressed) {
          return;
        }

        stopCurrentCollection('kph-feed-error');
      }
    }

    function prepareCollection(metadata, restartPending = false) {
      const sameSignature = state.signature === metadata.signature;
      if (sameSignature
        && (state.complete
          || state.suppressed
          || (state.collecting && !restartPending))) {
        metadata.generation = state.generation;
        return false;
      }

      resetState(metadata.signature);
      state.collecting = true;
      metadata.generation = state.generation;
      metadata.mergeEnabled = true;
      return true;
    }

    function scheduleCollection(metadata, body) {
      const startCollection = () => {
        state.collectionTimer = null;
        if (isCurrentCollection(metadata)) {
          collectFeed(metadata, body);
        }
      };

      if (typeof root.setTimeout === 'function') {
        state.collectionTimer = root.setTimeout(
          startCollection,
          COLLECTION_IDLE_DELAY_MS,
        );
      } else {
        startCollection();
      }
    }

    function isLatePageEntry() {
      try {
        const url = new URL(root.location?.href || 'https://kwork.ru/projects');
        return Number(url.searchParams.get('page')) > 1;
      } catch {
        return false;
      }
    }

    function createLocationBody() {
      const body = new root.FormData();
      const url = new URL(root.location?.href || 'https://kwork.ru/projects');
      for (const [key, value] of url.searchParams) {
        if (key !== 'page') {
          body.append(key, value);
        }
      }
      body.set('page', '1');
      return body;
    }

    function createCollectionMetadata(body, url = '/projects', headers = []) {
      return {
        generation: 0,
        headers,
        mergeEnabled: true,
        page: 1,
        signature: core.getProjectRequestSignature(body),
        url,
      };
    }

    function startLocationCollection() {
      const body = createLocationBody();
      const metadata = createCollectionMetadata(body, '/projects', [
        ['Accept', 'application/json, text/plain, */*'],
        ['X-Requested-With', 'XMLHttpRequest'],
      ]);
      if (prepareCollection(metadata)) {
        collectFeed(metadata, body);
      }
    }

    function requestMergedRender() {
      const documentElement = root.document?.documentElement;
      const allowed = state.complete && matchesRenderedFeed(state.pages.get(1));
      documentElement?.setAttribute?.(
        RENDER_DECISION_ATTRIBUTE,
        allowed ? 'allowed' : 'denied',
      );

      if (!allowed) {
        if (state.complete) {
          stopCurrentCollection('kph-feed-limited');
        }
        return;
      }

      state.renderRequestedAt = Date.now();
    }

    prototype.open = function open(method, url, ...rest) {
      requests.set(this, {
        headers: [],
        isProjects: isProjectsRequest(method, url),
        method,
        page: 1,
        generation: 0,
        mergeEnabled: true,
        renderMerged: false,
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
      metadata.mergeEnabled = true;
      metadata.renderMerged = state.complete
        && (state.signature === metadata.signature || isRenderRequestPending());
      if (metadata.renderMerged) {
        state.renderRequestedAt = 0;
        state.signature = metadata.signature;
        setCollectedFlag(false);
      }

      const collectionBody = cloneFormData(body, 1);
      const collectionMetadata = createCollectionMetadata(
        collectionBody,
        metadata.url,
        [...metadata.headers],
      );
      const shouldCollect = !metadata.renderMerged
        && prepareCollection(collectionMetadata, true);
      metadata.generation = state.generation;

      this.addEventListener('loadend', () => {
        if (!isCurrentCollection(metadata)) {
          return;
        }

        const succeeded = this.status >= 200 && this.status < 300;
        if (succeeded && !metadata.renderMerged) {
          return;
        }

        const notifyLoaded = () => {
          if (!isCurrentCollection(metadata)) {
            return;
          }

          if (succeeded) {
            dispatch('kph-feed-loaded');
          } else {
            stopCurrentCollection('kph-feed-error');
          }
        };
        if (typeof root.setTimeout === 'function') {
          root.setTimeout(notifyLoaded, 0);
        } else {
          notifyLoaded();
        }
      }, { once: true });

      const result = originalSend.call(this, body);
      if (shouldCollect
        && isCurrentCollection(collectionMetadata)
        && !state.suppressed) {
        scheduleCollection(collectionMetadata, collectionBody);
      }
      return result;
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
    root.document.addEventListener?.('kph-feed-start', startLocationCollection);
    root.document.addEventListener?.('kph-feed-render', requestMergedRender);
    dispatch('kph-feed-ready');

    if (options.autoStart === true && !isLatePageEntry()) {
      startLocationCollection();
    }

    return true;
  }

  return {
    installProjectFeedInterceptor,
  };
});
