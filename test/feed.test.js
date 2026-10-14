const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/core.js');
const { installProjectFeedInterceptor } = require('../src/feed-main.js');

function createProjectResponse(page, projects, lastPage = 3) {
  return {
    success: true,
    data: {
      wants: projects,
      pagination: {
        current_page: page,
        data: projects,
        from: (page - 1) * 12 + 1,
        last_page: lastPage,
        next_page_url: page < lastPage ? `https://kwork.ru/projects?page=${page + 1}` : null,
        per_page: 12,
        to: page * 12,
        total: lastPage * 12,
      },
    },
  };
}

function createFakeRoot(responses, deferredKeys = new Set(), renderedProjectIds = null) {
  const pendingRequests = new Map();
  const documentAttributes = new Map();
  const sentKeys = [];
  const abortedKeys = [];
  const documentListeners = new Map();
  const timers = new Map();
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let nextTimerId = 1;
  let timerClock = 0;

  class FakeXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseType = '';
      this.listeners = new Map();
      this._rawResponse = '';
      this._completed = false;
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader() {}

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(body) {
      this.body = body;
      const page = Number(body?.get?.('page') || 1);
      const category = String(body?.get?.('category') || 'all');
      const key = `${category}:${page}`;
      this._key = key;
      sentKeys.push(key);
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      if (deferredKeys.has(key)) {
        const requests = pendingRequests.get(key) || [];
        requests.push(this);
        pendingRequests.set(key, requests);
        return;
      }

      this.complete(responses.get(key) ?? responses.get(page));
    }

    complete(responseConfig) {
      if (this._completed) {
        return;
      }

      this._completed = true;
      activeRequests -= 1;
      const config = responseConfig?.payload
        ? responseConfig
        : { payload: responseConfig, status: 200 };
      this._rawResponse = JSON.stringify(config.payload);
      this.readyState = 4;
      this.status = config.status;
      this.onload?.();
      for (const listener of this.listeners.get('loadend') || []) {
        listener.call(this);
      }
    }

    abort() {
      if (this._completed) {
        return;
      }

      this._completed = true;
      activeRequests -= 1;
      this.readyState = 4;
      this.status = 0;
      abortedKeys.push(this._key);
      for (const listener of this.listeners.get('loadend') || []) {
        listener.call(this);
      }
    }

    get responseText() {
      return this._rawResponse;
    }

    get response() {
      return this._rawResponse;
    }
  }

  const events = [];
  const root = {
    XMLHttpRequest: FakeXMLHttpRequest,
    FormData,
    KworkProjectHiderCore: core,
    document: {
      addEventListener(type, listener) {
        const listeners = documentListeners.get(type) || [];
        listeners.push(listener);
        documentListeners.set(type, listeners);
      },
      dispatchEvent(event) {
        events.push(event.type);
        for (const listener of documentListeners.get(event.type) || []) {
          listener.call(this, event);
        }
      },
      documentElement: {
        setAttribute(name, value) {
          documentAttributes.set(name, String(value));
        },
        removeAttribute(name) {
          documentAttributes.delete(name);
        },
        getAttribute(name) {
          return documentAttributes.has(name) ? documentAttributes.get(name) : null;
        },
      },
      querySelectorAll() {
        if (!renderedProjectIds) {
          return [];
        }

        return renderedProjectIds.map((id) => ({ href: `https://kwork.ru/projects/${id}` }));
      },
    },
    Event,
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    location: {
      href: 'https://kwork.ru/projects',
      origin: 'https://kwork.ru',
    },
    setTimeout(callback, delay = 0) {
      if (delay === 0) {
        callback();
        return 0;
      }

      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, dueAt: timerClock + delay });
      return timerId;
    },
    events,
    sentKeys,
    getDocumentAttribute(name) {
      return documentAttributes.has(name) ? documentAttributes.get(name) : null;
    },
    complete(key) {
      const requests = pendingRequests.get(key) || [];
      const request = requests.shift();
      if (requests.length === 0) {
        pendingRequests.delete(key);
      }
      const page = Number(String(key).split(':').at(-1));
      request?.complete(responses.get(key) ?? responses.get(page));
    },
    getPendingKeys() {
      return [...pendingRequests.keys()];
    },
    getMaxActiveRequests() {
      return maxActiveRequests;
    },
    getAbortedKeys() {
      return [...abortedKeys];
    },
    advanceTimers(elapsedMs) {
      timerClock += elapsedMs;
      const readyTimers = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= timerClock);
      for (const [timerId, timer] of readyTimers) {
        timers.delete(timerId);
        timer.callback();
      }
    },
    runTimers() {
      if (timers.size === 0) {
        return;
      }

      timerClock = Math.max(...[...timers.values()].map(({ dueAt }) => dueAt));
      this.advanceTimers(0);
    },
  };

  return root;
}

function createPageRequest(page, category = null) {
  const body = new FormData();
  body.set('page', String(page));
  if (category) {
    body.set('category', category);
  }
  return body;
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Условие теста не выполнилось вовремя');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('фоновая сборка стартует без штатного клика и прелоадера Kwork', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  assert.deepEqual(root.sentKeys, ['all:1', 'all:2', 'all:3']);
  assert.deepEqual(
    root.events.filter((event) => event !== 'kph-feed-ready' && event !== 'kph-feed-start'),
    ['kph-feed-collecting', 'kph-feed-collected'],
  );
});

test('штатный запрос Kwork отправляется сразу и не ждёт фоновой сборки', () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses, new Set(['all:2']));
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(2));

  assert.equal(root.sentKeys[0], 'all:2');
  assert.deepEqual(root.getPendingKeys(), ['all:2']);
});

test('перехватчик собирает все страницы до единственной отрисовки Kwork', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses, new Set(['all:3']));
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.getPendingKeys().includes('all:3'));
  assert.equal(root.events.includes('kph-feed-loaded'), false);

  root.complete('all:3');
  await waitFor(() => root.events.includes('kph-feed-collected'));

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(2));
  await waitFor(() => request.readyState === 4);

  const projects = JSON.parse(request.responseText).data.pagination.data;
  assert.deepEqual(projects.map(({ id }) => id), [3, 2, 1]);
  const renderedProjects = JSON.parse(request.responseText).data.wants;
  assert.deepEqual(renderedProjects.map(({ id }) => id), [3, 2, 1]);
  assert.deepEqual(
    root.events.filter((event) => event !== 'kph-feed-ready' && event !== 'kph-feed-start'),
    ['kph-feed-collecting', 'kph-feed-collected', 'kph-feed-loaded'],
  );
});

test('перехватчик ограничивает фоновую сборку пятью одновременными запросами', async () => {
  const responses = new Map(
    Array.from({ length: 9 }, (unused, index) => [
      index + 1,
      createProjectResponse(index + 1, [{ id: 9 - index }], 9),
    ]),
  );
  const deferredKeys = new Set(['all:3', 'all:4', 'all:5', 'all:6', 'all:7', 'all:8', 'all:9']);
  const root = createFakeRoot(responses, deferredKeys);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.getPendingKeys().length === 5);
  assert.equal(root.getMaxActiveRequests(), 5);
  root.complete('all:3');
  await waitFor(() => root.getPendingKeys().includes('all:8'));
  assert.equal(root.getMaxActiveRequests(), 5);

  for (const key of ['all:4', 'all:5', 'all:6', 'all:7', 'all:8', 'all:9']) {
    await waitFor(() => root.getPendingKeys().includes(key));
    root.complete(key);
  }
  await waitFor(() => root.events.includes('kph-feed-collected'));
});

test('перехватчик начинает новую полную ленту после смены фильтра', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 2)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 2)],
    ['development:1', createProjectResponse(1, [{ id: 5 }], 2)],
    ['development:2', createProjectResponse(2, [{ id: 4 }], 2)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const firstRequest = new root.XMLHttpRequest();
  firstRequest.open('POST', '/projects');
  firstRequest.send(createPageRequest(1, 'design'));
  await waitFor(() => firstRequest.readyState === 4);
  root.runTimers();
  assert.deepEqual(
    JSON.parse(firstRequest.responseText).data.wants.map(({ id }) => id),
    [9],
  );

  await waitFor(() => root.events.filter((event) => event === 'kph-feed-collected').length === 1);
  const firstRenderRequest = new root.XMLHttpRequest();
  firstRenderRequest.open('POST', '/projects');
  firstRenderRequest.send(createPageRequest(2, 'design'));
  assert.deepEqual(
    JSON.parse(firstRenderRequest.responseText).data.pagination.data.map(({ id }) => id),
    [9, 8],
  );
  assert.deepEqual(
    JSON.parse(firstRenderRequest.responseText).data.wants.map(({ id }) => id),
    [9, 8],
  );

  const filteredRequest = new root.XMLHttpRequest();
  filteredRequest.open('POST', '/projects');
  filteredRequest.send(createPageRequest(1, 'development'));
  await waitFor(() => filteredRequest.readyState === 4);
  root.runTimers();
  assert.deepEqual(
    JSON.parse(filteredRequest.responseText).data.wants.map(({ id }) => id),
    [5],
  );

  await waitFor(() => root.events.filter((event) => event === 'kph-feed-collected').length === 2);
  const filteredRenderRequest = new root.XMLHttpRequest();
  filteredRenderRequest.open('POST', '/projects');
  filteredRenderRequest.send(createPageRequest(2, 'development'));
  assert.deepEqual(
    JSON.parse(filteredRenderRequest.responseText).data.pagination.data.map(({ id }) => id),
    [5, 4],
  );
  assert.deepEqual(
    JSON.parse(filteredRenderRequest.responseText).data.wants.map(({ id }) => id),
    [5, 4],
  );
});

test('поздний ответ старого фильтра не попадает в новую ленту', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 3)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 3)],
    ['design:3', createProjectResponse(3, [{ id: 7 }], 3)],
    ['development:1', createProjectResponse(1, [{ id: 5 }], 2)],
    ['development:2', createProjectResponse(2, [{ id: 4 }], 2)],
  ]);
  const root = createFakeRoot(responses, new Set(['design:3']));
  installProjectFeedInterceptor(root);

  const staleRequest = new root.XMLHttpRequest();
  staleRequest.open('POST', '/projects');
  staleRequest.send(createPageRequest(1, 'design'));
  root.runTimers();
  await waitFor(() => root.getPendingKeys().includes('design:3'));
  assert.deepEqual(JSON.parse(staleRequest.responseText).data.wants.map(({ id }) => id), [9]);

  const filterRequest = new root.XMLHttpRequest();
  filterRequest.open('POST', '/projects');
  filterRequest.send(createPageRequest(1, 'development'));
  await waitFor(() => filterRequest.readyState === 4);
  root.runTimers();
  assert.deepEqual(JSON.parse(filterRequest.responseText).data.wants.map(({ id }) => id), [5]);
  await waitFor(() => root.events.filter((event) => event === 'kph-feed-collected').length === 1);

  root.complete('design:3');

  const nextRequest = new root.XMLHttpRequest();
  nextRequest.open('POST', '/projects');
  nextRequest.send(createPageRequest(2, 'development'));
  await waitFor(() => nextRequest.readyState === 4);
  assert.deepEqual(JSON.parse(nextRequest.responseText).data.wants.map(({ id }) => id), [5, 4]);
});

test('ошибка фоновой страницы возвращает штатный ответ и пагинацию Kwork', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, { payload: createProjectResponse(3, []), status: 500 }],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(2));
  await waitFor(() => request.readyState === 4);
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-error'));

  assert.deepEqual(JSON.parse(request.responseText).data.wants.map(({ id }) => id), [2]);
  assert.equal(root.events.includes('kph-feed-error'), true);
  assert.equal(root.events.includes('kph-feed-loaded'), false);
});

test('ошибка одной фоновой страницы отменяет соседние запросы и останавливает очередь', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 10 }], 10)],
    [2, { payload: createProjectResponse(2, []), status: 500 }],
    [3, createProjectResponse(3, [{ id: 8 }], 10)],
    [4, createProjectResponse(4, [{ id: 7 }], 10)],
    [5, createProjectResponse(5, [{ id: 6 }], 10)],
    [6, createProjectResponse(6, [{ id: 5 }], 10)],
  ]);
  const root = createFakeRoot(responses, new Set(['all:3', 'all:4', 'all:5', 'all:6']));
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-error'));

  assert.deepEqual(root.sentKeys, ['all:1', 'all:2', 'all:3', 'all:4', 'all:5', 'all:6']);
  assert.deepEqual(root.getAbortedKeys().sort(), ['all:3', 'all:4', 'all:5', 'all:6']);
});

test('HTTP-ошибка штатного запроса отменяет запланированную фоновую сборку', () => {
  const responses = new Map([
    ['design:1', {
      payload: createProjectResponse(1, []),
      status: 500,
    }],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(1, 'design'));
  root.runTimers();

  assert.deepEqual(root.sentKeys, ['design:1']);
  assert.equal(root.events.includes('kph-feed-error'), true);
  assert.equal(root.events.includes('kph-feed-collecting'), false);
});

test('отмена текущего штатного запроса снимает таймер фоновой сборки', () => {
  const responses = new Map([
    ['design:1', {
      payload: createProjectResponse(1, []),
      status: 0,
    }],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(1, 'design'));
  root.runTimers();

  assert.deepEqual(root.sentKeys, ['design:1']);
  assert.equal(root.events.includes('kph-feed-error'), true);
  assert.equal(root.events.includes('kph-feed-collecting'), false);
});

test('быстрая смена фильтра запускает фоновую сборку только для последнего выбора', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 2)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 2)],
    ['development:1', createProjectResponse(1, [{ id: 5 }], 2)],
    ['development:2', createProjectResponse(2, [{ id: 4 }], 2)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const designRequest = new root.XMLHttpRequest();
  designRequest.open('POST', '/projects');
  designRequest.send(createPageRequest(1, 'design'));

  const developmentRequest = new root.XMLHttpRequest();
  developmentRequest.open('POST', '/projects');
  developmentRequest.send(createPageRequest(1, 'development'));

  assert.deepEqual(root.sentKeys, ['design:1', 'development:1']);

  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  assert.deepEqual(root.sentKeys, [
    'design:1',
    'development:1',
    'development:1',
    'development:2',
  ]);
});

test('переход по страницам заново отсчитывает паузу перед фоновой сборкой', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 2)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 2)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const firstPageRequest = new root.XMLHttpRequest();
  firstPageRequest.open('POST', '/projects');
  firstPageRequest.send(createPageRequest(1, 'design'));
  root.advanceTimers(600);

  const secondPageRequest = new root.XMLHttpRequest();
  secondPageRequest.open('POST', '/projects');
  secondPageRequest.send(createPageRequest(2, 'design'));
  root.advanceTimers(500);

  assert.deepEqual(root.sentKeys, ['design:1', 'design:2']);

  root.advanceTimers(500);
  await waitFor(() => root.events.includes('kph-feed-collected'));
  assert.deepEqual(root.sentKeys, [
    'design:1',
    'design:2',
    'design:1',
    'design:2',
  ]);
});

test('смена фильтра отменяет уже начавшиеся фоновые запросы старой ленты', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 3)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 3)],
    ['design:3', createProjectResponse(3, [{ id: 7 }], 3)],
    ['development:1', createProjectResponse(1, [{ id: 5 }], 2)],
    ['development:2', createProjectResponse(2, [{ id: 4 }], 2)],
  ]);
  const root = createFakeRoot(responses, new Set(['design:2', 'design:3']));
  installProjectFeedInterceptor(root);

  const designRequest = new root.XMLHttpRequest();
  designRequest.open('POST', '/projects');
  designRequest.send(createPageRequest(1, 'design'));
  root.runTimers();
  await waitFor(() => root.getPendingKeys().includes('design:3'));

  const developmentRequest = new root.XMLHttpRequest();
  developmentRequest.open('POST', '/projects');
  developmentRequest.send(createPageRequest(1, 'development'));

  assert.deepEqual(
    root.getAbortedKeys().sort(),
    ['design:2', 'design:3'],
  );

  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));
  assert.equal(root.getMaxActiveRequests() <= 3, true);
});

test('переход по страницам отменяет активную сборку того же фильтра', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }], 3)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 3)],
    ['design:3', createProjectResponse(3, [{ id: 7 }], 3)],
  ]);
  const root = createFakeRoot(responses, new Set(['design:3']));
  installProjectFeedInterceptor(root);

  const firstPageRequest = new root.XMLHttpRequest();
  firstPageRequest.open('POST', '/projects');
  firstPageRequest.send(createPageRequest(1, 'design'));
  root.runTimers();
  await waitFor(() => root.getPendingKeys().includes('design:3'));

  const secondPageRequest = new root.XMLHttpRequest();
  secondPageRequest.open('POST', '/projects');
  secondPageRequest.send(createPageRequest(2, 'design'));

  assert.deepEqual(root.getAbortedKeys(), ['design:3']);
});

test('рендер-клик расширения получает объединённую ленту при другом наборе полей Kwork', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
    ['design:2', createProjectResponse(2, [{ id: 2 }])],
  ]);
  const root = createFakeRoot(responses, new Set(), ['3']);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  root.document.dispatchEvent(new Event('kph-feed-render'));
  const renderRequest = new root.XMLHttpRequest();
  renderRequest.open('POST', '/projects');
  renderRequest.send(createPageRequest(2, 'design'));
  await waitFor(() => renderRequest.readyState === 4);
  root.runTimers();

  assert.deepEqual(
    JSON.parse(renderRequest.responseText).data.wants.map(({ id }) => id),
    [3, 2, 1],
  );
  assert.deepEqual(root.sentKeys, ['all:1', 'all:2', 'all:3', 'design:2']);
  assert.equal(
    root.events.filter((event) => event === 'kph-feed-collecting').length,
    1,
  );
});

test('лента чужого фильтра не подменяет показанные проекты', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
    ['design:2', createProjectResponse(2, [{ id: 8 }])],
  ]);
  const root = createFakeRoot(responses, new Set(), ['777', '778']);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  root.document.dispatchEvent(new Event('kph-feed-render'));

  assert.equal(root.getDocumentAttribute('data-kph-feed-render'), 'denied');
  assert.equal(root.events.includes('kph-feed-limited'), true);
  assert.equal(root.getDocumentAttribute('data-kph-feed-collected'), null);

  const renderRequest = new root.XMLHttpRequest();
  renderRequest.open('POST', '/projects');
  renderRequest.send(createPageRequest(2, 'design'));
  await waitFor(() => renderRequest.readyState === 4);

  assert.deepEqual(
    JSON.parse(renderRequest.responseText).data.wants.map(({ id }) => id),
    [8],
  );
});

test('собранная лента ждёт отрисовки в атрибуте страницы', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses, new Set(), ['3']);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  assert.equal(root.getDocumentAttribute('data-kph-feed-collected'), 'true');
  assert.equal(root.getDocumentAttribute('data-kph-feed-collecting'), null);

  root.document.dispatchEvent(new Event('kph-feed-render'));
  assert.equal(root.getDocumentAttribute('data-kph-feed-render'), 'allowed');

  const renderRequest = new root.XMLHttpRequest();
  renderRequest.open('POST', '/projects');
  renderRequest.send(createPageRequest(2));
  await waitFor(() => renderRequest.readyState === 4);

  assert.equal(root.getDocumentAttribute('data-kph-feed-collected'), null);
});

test('фоновая сборка начинается сразу после установки перехватчика', () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses, new Set(['all:1']));
  installProjectFeedInterceptor(root, { autoStart: true });

  assert.deepEqual(root.sentKeys, ['all:1']);
  assert.equal(root.getDocumentAttribute('data-kph-feed-collecting'), 'true');
});

test('устаревший рендер-клик не подменяет ленту нового фильтра', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
    ['design:1', createProjectResponse(1, [{ id: 9 }], 2)],
    ['design:2', createProjectResponse(2, [{ id: 8 }], 2)],
  ]);
  const root = createFakeRoot(responses, new Set(), ['3']);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  const filterRequest = new root.XMLHttpRequest();
  filterRequest.open('POST', '/projects');
  filterRequest.send(createPageRequest(1, 'design'));
  await waitFor(() => filterRequest.readyState === 4);

  assert.deepEqual(
    JSON.parse(filterRequest.responseText).data.wants.map(({ id }) => id),
    [9],
  );
});

test('заказ из собранной ленты отдаётся изолированному миру по номеру', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3, name: 'Свежий заказ', description: 'Полное описание' }])],
    [2, createProjectResponse(2, [{ id: 2 }])],
    [3, createProjectResponse(3, [{ id: 1 }])],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  root.document.documentElement.setAttribute('data-kph-project-request', '3');
  root.document.dispatchEvent(new Event('kph-project-request'));

  const project = JSON.parse(root.getDocumentAttribute('data-kph-project-payload'));
  assert.equal(project.name, 'Свежий заказ');
  assert.equal(project.description, 'Полное описание');
});

test('штатный ответ ленты запоминает заказы без фоновой сборки', async () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9, name: 'Заказ из штатного ответа' }], 1)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(1, 'design'));
  await waitFor(() => request.readyState === 4);

  root.document.documentElement.setAttribute('data-kph-project-request', '9');
  root.document.dispatchEvent(new Event('kph-project-request'));

  assert.equal(
    JSON.parse(root.getDocumentAttribute('data-kph-project-payload')).name,
    'Заказ из штатного ответа',
  );
});

test('незнакомый номер заказа не отдаёт чужой ответ ленты', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3, name: 'Свежий заказ' }], 1)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-collected'));

  root.document.documentElement.setAttribute('data-kph-project-request', '3');
  root.document.dispatchEvent(new Event('kph-project-request'));
  root.document.documentElement.setAttribute('data-kph-project-request', '404');
  root.document.dispatchEvent(new Event('kph-project-request'));

  assert.equal(root.getDocumentAttribute('data-kph-project-payload'), null);
});

test('слишком большая лента остаётся на штатной пагинации без десятков запросов', async () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 500 }], 43)],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  root.document.dispatchEvent(new Event('kph-feed-start'));
  root.runTimers();
  await waitFor(() => root.events.includes('kph-feed-limited'));

  assert.deepEqual(root.sentKeys, ['all:1']);

  const pageRequest = new root.XMLHttpRequest();
  pageRequest.open('POST', '/projects');
  pageRequest.send(createPageRequest(2));
  root.runTimers();

  assert.deepEqual(root.sentKeys, ['all:1', 'all:2']);
});
