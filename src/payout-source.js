(function initKworkPayoutSource(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkPayoutSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPayoutSource() {
  const CACHE_KEY = 'payoutCache';
  const OPERATIONS_URL = '/balance/operations';

  function isFreshCache(cache, now, ttlMs) {
    if (!cache || typeof cache !== 'object') {
      return false;
    }

    if (typeof cache.fetchedAt !== 'number' || !Number.isFinite(cache.fetchedAt)) {
      return false;
    }

    if (typeof now !== 'number' || !Number.isFinite(now)) {
      return false;
    }

    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      return false;
    }

    const age = now - cache.fetchedAt;
    return age >= 0 && age < ttlMs;
  }

  function toNumberOrNull(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  function readOperationsPage(json) {
    if (!json || typeof json !== 'object' || json.success !== true) {
      return null;
    }

    const data = json.data && typeof json.data === 'object' ? json.data : json;
    if (!Array.isArray(data.operations)) {
      return null;
    }

    const pagingTotal = data.pagingdata && typeof data.pagingdata === 'object'
      ? data.pagingdata.total
      : undefined;
    const total = toNumberOrNull(data.total ?? pagingTotal);
    const dateWithdraw = typeof data.dateWithdraw === 'string' && data.dateWithdraw.trim()
      ? data.dateWithdraw
      : null;

    return {
      operations: data.operations,
      total,
      dateWithdraw,
    };
  }

  function operationDedupeKey(operation) {
    if (!operation || typeof operation !== 'object') {
      return null;
    }

    if (operation.id != null && String(operation.id) !== '') {
      return `id:${operation.id}`;
    }

    return `f:${String(operation.time ?? '')}\0${String(operation.operationAmount ?? '')}\0${String(operation.type ?? '')}`;
  }

  function appendUniqueOperations(target, incoming, seen) {
    if (!Array.isArray(incoming)) {
      return;
    }

    for (const operation of incoming) {
      const key = operationDedupeKey(operation);
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }

      target.push(operation);
    }
  }

  function isClosedWithdrawal(operation) {
    if (!operation || typeof operation !== 'object' || operation.type !== 'withdraw') {
      return false;
    }

    const status = operation.operation_status ?? operation.wd_status;
    return status === 'done' || status === 'cancel';
  }

  function shouldLoadNextPage({ pageOperations, loadedCount, total, pageIndex, maxPages } = {}) {
    if (!Array.isArray(pageOperations) || pageOperations.length === 0) {
      return false;
    }

    if (pageOperations.some(isClosedWithdrawal)) {
      return false;
    }

    if (typeof total === 'number' && Number.isFinite(total) && loadedCount >= total) {
      return false;
    }

    if (typeof maxPages === 'number' && Number.isFinite(maxPages) && pageIndex >= maxPages) {
      return false;
    }

    return true;
  }

  function looksLikeHtml(text, contentType) {
    if (typeof contentType === 'string' && /html/i.test(contentType)) {
      return true;
    }

    return typeof text === 'string' && /^\s*</.test(text);
  }

  function readStorageValue(storage, key) {
    return new Promise((resolve, reject) => {
      if (!storage || typeof storage.get !== 'function') {
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(value);
      };

      try {
        const maybe = storage.get([key], (result) => {
          finish(result && typeof result === 'object' ? result[key] ?? null : null);
        });

        if (maybe && typeof maybe.then === 'function') {
          maybe.then((result) => {
            if (result && typeof result === 'object' && key in result) {
              finish(result[key] ?? null);
              return;
            }

            finish(result ?? null);
          }, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  function removeStorageValue(storage, key) {
    return new Promise((resolve, reject) => {
      if (!storage || typeof storage.remove !== 'function') {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      try {
        const maybe = storage.remove(key, finish);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(finish, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  async function clearPayoutCache(storage) {
    try {
      await removeStorageValue(storage, CACHE_KEY);
    } catch {
      // Storage stubs may omit remove; a failed cleanup must not hide the load error.
    }
  }

  function writeStorageValue(storage, items) {
    return new Promise((resolve, reject) => {
      if (!storage || typeof storage.set !== 'function') {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      try {
        const maybe = storage.set(items, finish);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(finish, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  async function fetchOperationsPage(fetchImpl, page) {
    let response;

    try {
      response = await fetchImpl(OPERATIONS_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ page }),
      });
    } catch {
      return { error: 'сеть недоступна' };
    }

    const status = Number(response?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      return { error: 'сервер вернул ошибку' };
    }

    const contentType = typeof response.headers?.get === 'function'
      ? String(response.headers.get('content-type') || '')
      : '';

    let text = '';
    try {
      if (typeof response.text === 'function') {
        text = await response.text();
      } else if (typeof response.json === 'function') {
        const json = await response.json();
        const parsed = readOperationsPage(json);
        if (!parsed) {
          return { error: 'данные не получены' };
        }

        return parsed;
      } else {
        return { error: 'не удалось разобрать ответ' };
      }
    } catch {
      return { error: 'не удалось разобрать ответ' };
    }

    if (looksLikeHtml(text, contentType)) {
      return { error: 'нужен вход на Kwork' };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: 'не удалось разобрать ответ' };
    }

    const parsed = readOperationsPage(json);
    if (!parsed) {
      return { error: 'данные не получены' };
    }

    return parsed;
  }

  async function loadOperations(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const storage = options.storage || globalThis.chrome?.storage?.local;
    const now = options.now ?? Date.now();
    const force = options.force === true;
    const maxPages = options.maxPages ?? 5;
    const ttlMs = options.ttlMs ?? 600000;

    try {
      if (!force) {
        const cache = await readStorageValue(storage, CACHE_KEY);
        if (isFreshCache(cache, now, ttlMs) && Array.isArray(cache.operations)) {
          return {
            operations: cache.operations,
            dateWithdraw: cache.dateWithdraw ?? null,
            fromCache: true,
            error: null,
          };
        }
      }

      async function failLoad(error) {
        await clearPayoutCache(storage);
        return {
          operations: null,
          dateWithdraw: null,
          error,
        };
      }

      if (typeof fetchImpl !== 'function') {
        return failLoad('сеть недоступна');
      }

      const operations = [];
      const seenKeys = new Set();
      let dateWithdraw = null;
      let total = null;

      for (let page = 1; page <= maxPages; page += 1) {
        const pageResult = await fetchOperationsPage(fetchImpl, page);
        if (pageResult.error) {
          if (page === 1) {
            return failLoad(pageResult.error);
          }

          return {
            operations,
            dateWithdraw,
            fromCache: false,
            error: null,
          };
        }

        appendUniqueOperations(operations, pageResult.operations, seenKeys);
        if (!dateWithdraw && pageResult.dateWithdraw) {
          dateWithdraw = pageResult.dateWithdraw;
        }

        if (pageResult.total != null) {
          total = pageResult.total;
        }

        if (!shouldLoadNextPage({
          pageOperations: pageResult.operations,
          loadedCount: operations.length,
          total,
          pageIndex: page,
          maxPages,
        })) {
          break;
        }
      }

      await writeStorageValue(storage, {
        [CACHE_KEY]: {
          operations,
          dateWithdraw,
          fetchedAt: now,
        },
      });

      return {
        operations,
        dateWithdraw,
        fromCache: false,
        error: null,
      };
    } catch {
      await clearPayoutCache(storage);
      return {
        operations: null,
        dateWithdraw: null,
        error: 'не удалось загрузить выплаты',
      };
    }
  }

  return {
    isFreshCache,
    readOperationsPage,
    shouldLoadNextPage,
    loadOperations,
  };
});
