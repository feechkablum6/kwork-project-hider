const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = require('../src/core.js');
const contentScript = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');

function createCard(projectId) {
  const card = {
    className: 'want-card',
    dataset: {},
    hidden: false,
    classes: new Set(),
    attributes: new Map(),
    children: [],
    classList: {
      add(...names) {
        for (const name of names) {
          card.classes.add(name);
        }
      },
      remove(...names) {
        for (const name of names) {
          card.classes.delete(name);
        }
      },
      contains(name) {
        return card.classes.has(name);
      },
    },
    setAttribute(name, value) {
      card.attributes.set(name, value);
    },
    removeAttribute(name) {
      card.attributes.delete(name);
    },
    append(child) {
      card.children.push(child);
    },
    matches() {
      return true;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [{ href: `https://kwork.ru/projects/${projectId}` }];
    },
  };

  return card;
}

function runContentScript({ cards = [], storage = { hiddenProjectIds: [] }, storageError = null, hasBody = false } = {}) {
  const observers = [];
  const storageRequests = [];
  const links = cards.map((card) => ({
    href: `https://kwork.ru/projects/${card.projectId}`,
    closest: () => card.element,
    parentElement: null,
  }));

  const documentStub = {
    body: hasBody ? { append() {} } : null,
    documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null },
    createElement(tagName) {
      return {
        tagName,
        className: '',
        dataset: {},
        classList: { add() {}, remove() {}, contains: () => false },
        setAttribute() {},
        addEventListener() {},
        append() {},
        remove() {},
      };
    },
    createElementNS() {
      return { setAttribute() {}, classList: { add() {} }, append() {} };
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href*="/projects/"]') {
        return links;
      }

      if (selector === '[data-kph-project-id]') {
        return cards
          .map(({ element }) => element)
          .filter((element) => element.dataset.kphProjectId);
      }

      return [];
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(target) {
      this.target = target;
    }
  }

  const context = {
    URL,
    MutationObserver: FakeMutationObserver,
    document: documentStub,
    queueMicrotask(callback) {
      callback();
    },
    requestAnimationFrame(callback) {
      callback();
    },
    window: {
      location: { href: 'https://kwork.ru/projects' },
      clearTimeout() {},
      setTimeout() {
        return 1;
      },
    },
    globalThis: {
      KworkProjectHiderCore: core,
      chrome: {
        storage: {
          local: {
            get(keys, callback) {
              storageRequests.push(callback);
            },
            set(values, callback) {
              callback();
            },
          },
          onChanged: { addListener() {} },
        },
        runtime: { lastError: storageError },
      },
    },
  };
  context.chrome = context.globalThis.chrome;

  vm.runInNewContext(contentScript, context);

  return {
    observers,
    resolveStorage() {
      for (const callback of storageRequests.splice(0)) {
        callback(storage);
      }
    },
  };
}

test('наблюдение за лентой начинается до ответа хранилища', () => {
  const card = createCard('123');
  const feed = runContentScript({ cards: [{ projectId: '123', element: card }] });

  assert.equal(feed.observers.length, 1);
  assert.notEqual(feed.observers[0].target, undefined);
});

test('карточка, появившаяся раньше ответа хранилища, всё равно скрывается', async () => {
  const card = createCard('123');
  const feed = runContentScript({
    cards: [{ projectId: '123', element: card }],
    storage: { hiddenProjectIds: ['123'] },
  });

  feed.observers[0].callback();
  assert.equal(card.hidden, false);

  feed.resolveStorage();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(card.hidden, true);
  assert.equal(card.classes.has('kph-is-hidden'), true);
});

test('ошибка хранилища без готовой страницы не ломает скрытие', async () => {
  const card = createCard('321');
  const feed = runContentScript({
    cards: [{ projectId: '321', element: card }],
    storageError: { message: 'storage недоступен' },
  });

  feed.resolveStorage();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(feed.observers.length, 1);
  assert.equal(card.dataset.kphEnhanced, 'true');
});
