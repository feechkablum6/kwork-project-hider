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

function createFakeRoot(responses, deferredKeys = new Set()) {
  const pendingRequests = new Map();

  class FakeXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseType = '';
      this.listeners = new Map();
      this._rawResponse = '';
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
      if (deferredKeys.has(key)) {
        pendingRequests.set(key, this);
        return;
      }

      this.complete(responses.get(key) ?? responses.get(page));
    }

    complete(responseConfig) {
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
      dispatchEvent(event) {
        events.push(event.type);
      },
    },
    Event,
    location: {
      href: 'https://kwork.ru/projects',
      origin: 'https://kwork.ru',
    },
    events,
    complete(key) {
      const request = pendingRequests.get(key);
      pendingRequests.delete(key);
      request.complete(responses.get(key));
    },
  };

  return root;
}

function createPageRequest(page, category = 'all') {
  const body = new FormData();
  body.set('page', String(page));
  body.set('category', category);
  return body;
}

test('перехватчик добавляет следующую страницу к первой до отрисовки Kwork', () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }, { id: 2 }])],
    [2, createProjectResponse(2, [{ id: 2 }, { id: 1 }])],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(2));

  const projects = JSON.parse(request.responseText).data.pagination.data;
  assert.deepEqual(projects.map(({ id }) => id), [3, 2, 1]);
  const renderedProjects = JSON.parse(request.responseText).data.wants;
  assert.deepEqual(renderedProjects.map(({ id }) => id), [3, 2, 1]);
});

test('перехватчик начинает новую ленту после смены фильтра', () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 9 }])],
    [2, createProjectResponse(2, [{ id: 8 }])],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const firstRequest = new root.XMLHttpRequest();
  firstRequest.open('POST', '/projects');
  firstRequest.send(createPageRequest(2, 'design'));
  assert.deepEqual(
    JSON.parse(firstRequest.responseText).data.pagination.data.map(({ id }) => id),
    [9, 8],
  );
  assert.deepEqual(
    JSON.parse(firstRequest.responseText).data.wants.map(({ id }) => id),
    [9, 8],
  );

  responses.set(1, createProjectResponse(1, [{ id: 5 }]));
  const filteredRequest = new root.XMLHttpRequest();
  filteredRequest.open('POST', '/projects');
  filteredRequest.send(createPageRequest(1, 'development'));

  assert.deepEqual(
    JSON.parse(filteredRequest.responseText).data.pagination.data.map(({ id }) => id),
    [5],
  );
  assert.deepEqual(
    JSON.parse(filteredRequest.responseText).data.wants.map(({ id }) => id),
    [5],
  );
});

test('поздний ответ старого фильтра не попадает в новую ленту', () => {
  const responses = new Map([
    ['design:1', createProjectResponse(1, [{ id: 9 }])],
    ['design:2', createProjectResponse(2, [{ id: 8 }])],
    ['development:1', createProjectResponse(1, [{ id: 5 }])],
    ['development:2', createProjectResponse(2, [{ id: 4 }])],
  ]);
  const root = createFakeRoot(responses, new Set(['design:2']));
  installProjectFeedInterceptor(root);

  const staleRequest = new root.XMLHttpRequest();
  staleRequest.open('POST', '/projects');
  staleRequest.send(createPageRequest(2, 'design'));

  const filterRequest = new root.XMLHttpRequest();
  filterRequest.open('POST', '/projects');
  filterRequest.send(createPageRequest(1, 'development'));
  assert.deepEqual(JSON.parse(filterRequest.responseText).data.wants.map(({ id }) => id), [5]);

  root.complete('design:2');
  assert.deepEqual(JSON.parse(staleRequest.responseText).data.wants.map(({ id }) => id), [8]);

  const nextRequest = new root.XMLHttpRequest();
  nextRequest.open('POST', '/projects');
  nextRequest.send(createPageRequest(2, 'development'));
  assert.deepEqual(JSON.parse(nextRequest.responseText).data.wants.map(({ id }) => id), [5, 4]);
});

test('ошибка загрузки сообщает об ошибке и не выдаёт событие успешной подгрузки', () => {
  const responses = new Map([
    [1, createProjectResponse(1, [{ id: 3 }])],
    [2, { payload: createProjectResponse(2, []), status: 500 }],
  ]);
  const root = createFakeRoot(responses);
  installProjectFeedInterceptor(root);

  const request = new root.XMLHttpRequest();
  request.open('POST', '/projects');
  request.send(createPageRequest(2));

  assert.equal(root.events.includes('kph-feed-error'), true);
  assert.equal(root.events.includes('kph-feed-loaded'), false);
});
