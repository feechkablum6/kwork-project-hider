const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isFreshCache,
  readOperationsPage,
  shouldLoadNextPage,
  loadOperations,
} = require('../src/payout-source.js');

function createStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    get(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of list) {
        result[key] = store[key];
      }

      if (typeof callback === 'function') {
        callback(result);
      }

      return Promise.resolve(result);
    },
    set(items, callback) {
      Object.assign(store, items);
      if (typeof callback === 'function') {
        callback();
      }

      return Promise.resolve();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete store[key];
      }

      if (typeof callback === 'function') {
        callback();
      }

      return Promise.resolve();
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function htmlResponse() {
  return {
    status: 200,
    headers: {
      get() {
        return 'text/html; charset=UTF-8';
      },
    },
    async text() {
      return '<!DOCTYPE html><html><body>login</body></html>';
    },
  };
}

function pagePayload({ operations, page = 1, total = 12, dateWithdraw = 'четверг 3 сентября до 23:00 по МСК' }) {
  return {
    success: true,
    data: {
      operations,
      pagingdata: {
        total,
        paging: { cur_page: page, items_per_page: '12' },
      },
      dateWithdraw,
    },
  };
}

function withdraw(status = 'new') {
  return { type: 'withdraw', operation_status: status };
}

test('свежий кеш годен, протухший — нет', () => {
  assert.equal(isFreshCache({ fetchedAt: 1000 }, 1000, 600000), true);
  assert.equal(isFreshCache({ fetchedAt: 1000 }, 1000 + 599999, 600000), true);
  assert.equal(isFreshCache({ fetchedAt: 1000 }, 1000 + 600000, 600000), false);
  assert.equal(isFreshCache(null, 1000, 600000), false);
  assert.equal(isFreshCache({ fetchedAt: '1000' }, 1000, 600000), false);
});

test('кеш с fetchedAt в будущем негоден', () => {
  assert.equal(isFreshCache({ fetchedAt: 5000 }, 1000, 600000), false);
});

test('разбирает страницу операций и приводит total к числу', () => {
  const parsed = readOperationsPage(pagePayload({
    operations: [{ type: 'refill' }],
    total: '65',
  }));

  assert.deepEqual(parsed, {
    operations: [{ type: 'refill' }],
    total: 65,
    dateWithdraw: 'четверг 3 сентября до 23:00 по МСК',
  });
});

test('неверный ответ страницы — null, а не пустые данные', () => {
  assert.equal(readOperationsPage(null), null);
  assert.equal(readOperationsPage({ success: false, data: { operations: [] } }), null);
  assert.equal(readOperationsPage({ success: true, data: { operations: 'нет' } }), null);
});

test('следующую страницу тянем пока страница непуста, есть остаток и не упёрлись в потолок', () => {
  assert.equal(shouldLoadNextPage({
    pageOperations: [withdraw('new')],
    loadedCount: 12,
    total: 65,
    pageIndex: 1,
    maxPages: 3,
  }), true);

  assert.equal(shouldLoadNextPage({
    pageOperations: [{ type: 'order_in' }],
    loadedCount: 12,
    total: 24,
    pageIndex: 1,
    maxPages: 3,
  }), true);

  assert.equal(shouldLoadNextPage({
    pageOperations: [],
    loadedCount: 0,
    total: 65,
    pageIndex: 1,
    maxPages: 3,
  }), false);

  assert.equal(shouldLoadNextPage({
    pageOperations: [withdraw('new')],
    loadedCount: 12,
    total: 12,
    pageIndex: 1,
    maxPages: 3,
  }), false);

  assert.equal(shouldLoadNextPage({
    pageOperations: [withdraw('new')],
    loadedCount: 12,
    total: 65,
    pageIndex: 3,
    maxPages: 3,
  }), false);
});

test('свежий кеш отдаётся без запросов', async () => {
  const operations = [{ type: 'refill' }];
  const storage = createStorage({
    payoutCache: {
      operations,
      dateWithdraw: 'четверг',
      fetchedAt: 1000,
    },
  });
  let calls = 0;
  const result = await loadOperations({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('не должны ходить в сеть');
    },
    storage,
    now: 1000 + 1000,
    ttlMs: 600000,
  });

  assert.equal(calls, 0);
  assert.equal(result.fromCache, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.operations, operations);
  assert.equal(result.dateWithdraw, 'четверг');
});

test('протухший кеш игнорируется и данные запрашиваются', async () => {
  const storage = createStorage({
    payoutCache: {
      operations: [{ old: true }],
      dateWithdraw: 'вчера',
      fetchedAt: 1,
    },
  });
  let calls = 0;
  const result = await loadOperations({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(pagePayload({ operations: [{ type: 'refill' }], total: 1, dateWithdraw: 'сегодня' }));
    },
    storage,
    now: 1 + 600000,
    ttlMs: 600000,
  });

  assert.equal(calls, 1);
  assert.equal(result.fromCache, false);
  assert.equal(result.dateWithdraw, 'сегодня');
  assert.equal(storage.store.payoutCache.fetchedAt, 1 + 600000);
});

test('force игнорирует свежий кеш', async () => {
  const storage = createStorage({
    payoutCache: {
      operations: [{ cached: true }],
      dateWithdraw: 'кеш',
      fetchedAt: 1000,
    },
  });
  let calls = 0;
  const result = await loadOperations({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(pagePayload({ operations: [{ fresh: true }], total: 1, dateWithdraw: 'сеть' }));
    },
    storage,
    now: 1000,
    force: true,
  });

  assert.equal(calls, 1);
  assert.equal(result.fromCache, false);
  assert.deepEqual(result.operations, [{ fresh: true }]);
});

test('если все записи уже на первой странице, вторую не просим', async () => {
  const storage = createStorage();
  const pages = [];
  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      return jsonResponse(pagePayload({
        operations: [{ type: 'refill' }],
        page: body.page,
        total: 1,
      }));
    },
    storage,
    now: 10,
  });

  assert.deepEqual(pages, [1]);
  assert.equal(result.error, null);
  assert.equal(result.operations.length, 1);
});

test('заявка на второй странице попадает в результат', async () => {
  const storage = createStorage();
  const pages = [];
  const page1 = Array.from({ length: 12 }, (_, index) => ({
    id: `order-${index}`,
    type: 'order_in',
  }));
  const pending = {
    id: 'wd-2800',
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -2800,
  };
  const page2 = [
    pending,
    ...Array.from({ length: 11 }, (_, index) => ({
      id: `later-${index}`,
      type: 'order_in',
    })),
  ];

  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      if (body.page === 1) {
        return jsonResponse(pagePayload({
          operations: page1,
          page: 1,
          total: 24,
        }));
      }

      return jsonResponse(pagePayload({
        operations: page2,
        page: 2,
        total: 24,
      }));
    },
    storage,
    now: 10,
  });

  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.error, null);
  assert.equal(result.operations.length, 24);
  assert.equal(result.operations.some((item) => item.id === 'wd-2800'), true);
});

test('повтор операции на стыке страниц отбрасывается', async () => {
  const storage = createStorage();
  const shared = {
    id: 42,
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -2800,
    time: '2 сентября, 16:50',
  };
  const withoutId = {
    type: 'order_in',
    operationAmount: 500,
    time: '2 сентября, 16:40',
  };

  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.page === 1) {
        return jsonResponse(pagePayload({
          operations: [shared, withoutId, { id: 1, type: 'order_in' }],
          page: 1,
          total: 24,
        }));
      }

      return jsonResponse(pagePayload({
        operations: [shared, withoutId, { id: 2, type: 'order_in' }],
        page: 2,
        total: 24,
      }));
    },
    storage,
    now: 10,
  });

  assert.equal(result.operations.length, 4);
  assert.deepEqual(result.operations.map((item) => item.id), [42, undefined, 1, 2]);
});

test('заявка на первой странице тянет вторую', async () => {
  const storage = createStorage();
  const pages = [];
  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      if (body.page === 1) {
        return jsonResponse(pagePayload({
          operations: [{ ...withdraw('new'), id: 'wd-new' }],
          page: 1,
          total: 2,
        }));
      }

      return jsonResponse(pagePayload({
        operations: [{ ...withdraw('done'), id: 'wd-done' }],
        page: 2,
        total: 2,
        dateWithdraw: '',
      }));
    },
    storage,
    now: 10,
  });

  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.operations.length, 2);
  assert.equal(result.dateWithdraw, 'четверг 3 сентября до 23:00 по МСК');
});

test('потолок maxPages соблюдается', async () => {
  const storage = createStorage();
  const pages = [];
  await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      return jsonResponse(pagePayload({
        operations: [withdraw('new')],
        page: body.page,
        total: 100,
      }));
    },
    storage,
    now: 10,
    maxPages: 2,
  });

  assert.deepEqual(pages, [1, 2]);
});

function orderInPage(prefix, count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    type: 'order_in',
  }));
}

test('закрытый вывод done на первой странице не тянет вторую, заявки new остаются', async () => {
  const storage = createStorage();
  let calls = 0;
  const pending = {
    id: 'wd-new-1',
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -2800,
  };
  const closed = {
    id: 'wd-done-1',
    type: 'withdraw',
    operation_status: 'done',
    operationAmount: -500,
  };

  const result = await loadOperations({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(pagePayload({
        operations: [pending, closed, ...orderInPage('p1', 10)],
        page: 1,
        total: 48,
      }));
    },
    storage,
    now: 10,
  });

  assert.equal(calls, 1);
  assert.equal(result.error, null);
  assert.equal(result.operations.some((item) => item.id === 'wd-new-1'), true);
  assert.equal(result.operations.some((item) => item.id === 'wd-done-1'), true);
});

test('закрытый вывод cancel на первой странице не тянет вторую', async () => {
  const storage = createStorage();
  let calls = 0;
  const pending = {
    id: 'wd-new-cancel',
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -900,
  };

  const result = await loadOperations({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(pagePayload({
        operations: [
          pending,
          { id: 'wd-cancel-1', type: 'withdraw', operation_status: 'cancel' },
        ],
        page: 1,
        total: 48,
      }));
    },
    storage,
    now: 10,
  });

  assert.equal(calls, 1);
  assert.equal(result.operations.some((item) => item.id === 'wd-new-cancel'), true);
});

test('без закрытых выводов листание идёт до потолка 5 страниц и не дальше', async () => {
  const storage = createStorage();
  const pages = [];
  await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      return jsonResponse(pagePayload({
        operations: orderInPage(`p${body.page}`),
        page: body.page,
        total: 120,
      }));
    },
    storage,
    now: 10,
  });

  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
});

test('заявка new на четвёртой странице попадает в сумму', async () => {
  const storage = createStorage();
  const pages = [];
  const pending = {
    id: 'wd-page4',
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -1500,
  };

  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      pages.push(body.page);
      if (body.page === 4) {
        return jsonResponse(pagePayload({
          operations: [pending, ...orderInPage('p4', 11)],
          page: 4,
          total: 120,
        }));
      }

      return jsonResponse(pagePayload({
        operations: orderInPage(`p${body.page}`),
        page: body.page,
        total: 120,
      }));
    },
    storage,
    now: 10,
  });

  assert.equal(result.error, null);
  assert.ok(pages.includes(4));
  assert.equal(result.operations.some((item) => item.id === 'wd-page4'), true);
});

test('непустая страница без закрытых выводов не грузится дальше, если loadedCount равен total', () => {
  assert.equal(shouldLoadNextPage({
    pageOperations: [{ type: 'order_in' }],
    loadedCount: 12,
    total: 12,
    pageIndex: 1,
    maxPages: 5,
  }), false);
});

test('HTML вместо JSON — ошибка и кеш не записан', async () => {
  const storage = createStorage();
  const result = await loadOperations({
    fetchImpl: async () => htmlResponse(),
    storage,
    now: 10,
  });

  assert.equal(result.operations, null);
  assert.equal(result.dateWithdraw, null);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.equal(storage.store.payoutCache, undefined);
});

test('сеть упала на первой странице — ошибка', async () => {
  const storage = createStorage();
  const result = await loadOperations({
    fetchImpl: async () => {
      throw new Error('offline');
    },
    storage,
    now: 10,
  });

  assert.equal(result.operations, null);
  assert.match(result.error, /сеть/i);
  assert.equal(storage.store.payoutCache, undefined);
});

test('сеть упала на второй странице — частичный успех', async () => {
  const storage = createStorage({
    payoutCache: {
      operations: [{ old: true }],
      dateWithdraw: 'старый',
      fetchedAt: 1,
    },
  });
  const first = [withdraw('new'), { type: 'refill' }];
  const result = await loadOperations({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.page === 1) {
        return jsonResponse(pagePayload({ operations: first, total: 24 }));
      }

      throw new Error('offline');
    },
    storage,
    now: 1 + 600000,
    ttlMs: 600000,
  });

  assert.equal(result.error, null);
  assert.deepEqual(result.operations, first);
  assert.equal(result.fromCache, false);
  assert.equal(storage.store.payoutCache.dateWithdraw, 'старый');
});

test('ошибка после успешной загрузки удаляет кеш', async () => {
  const storage = createStorage();
  await loadOperations({
    fetchImpl: async () => jsonResponse(pagePayload({ operations: [{ type: 'refill' }], total: 1 })),
    storage,
    now: 10,
  });
  assert.ok(storage.store.payoutCache);

  const result = await loadOperations({
    fetchImpl: async () => htmlResponse(),
    storage,
    now: 20,
    force: true,
  });

  assert.equal(result.operations, null);
  assert.equal(typeof result.error, 'string');
  assert.equal(storage.store.payoutCache, undefined);
});

test('заглушка storage без remove не падает на ошибке загрузки', async () => {
  const storage = createStorage();
  delete storage.remove;

  const result = await loadOperations({
    fetchImpl: async () => htmlResponse(),
    storage,
    now: 10,
  });

  assert.equal(result.operations, null);
  assert.equal(typeof result.error, 'string');
});

test('success:false — ошибка', async () => {
  const storage = createStorage();
  const result = await loadOperations({
    fetchImpl: async () => jsonResponse({ success: false, data: { operations: [] } }),
    storage,
    now: 10,
  });

  assert.equal(result.operations, null);
  assert.equal(typeof result.error, 'string');
  assert.equal(storage.store.payoutCache, undefined);
});
