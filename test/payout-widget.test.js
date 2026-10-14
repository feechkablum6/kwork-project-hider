const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const payoutCore = require('../src/payout-core.js');
const contentScript = fs.readFileSync(path.resolve(__dirname, '../src/payout-content.js'), 'utf8');

const NBSP = '\u00A0';
const PAYOUT_DATE = 'четверг 3 сентября до 23:00 по МСК';
const AMOUNT_TEXT = `6${NBSP}400 ₽`;

function pendingOperation(overrides = {}) {
  return {
    type: 'withdraw',
    operation_status: 'new',
    operationAmount: -6400,
    time: '2 сентября, 16:50',
    getDateWithdrawByDate: PAYOUT_DATE,
    ...overrides,
  };
}

function matchesSimple(element, simple) {
  if (!simple) {
    return false;
  }

  let rest = simple;
  const attr = {};
  rest = rest.replace(/\[([^\]]+)=["']?([^"'\]]+)["']?\]/g, (_, name, value) => {
    attr[name] = value;
    return '';
  });

  let tag = '*';
  let id = null;
  const classes = [];
  const token = rest.trim();
  if (token) {
    const idSplit = token.split('#');
    const head = idSplit[0];
    if (idSplit[1]) {
      id = idSplit[1].split('.')[0];
    }
    const classParts = head.split('.');
    tag = classParts[0] || '*';
    for (const name of classParts.slice(1)) {
      if (name) {
        classes.push(name);
      }
    }
    if (!id && token.includes('#')) {
      id = token.slice(token.indexOf('#') + 1).split('.')[0];
    }
  }

  if (tag && tag !== '*' && (element.tagName || '').toLowerCase() !== tag.toLowerCase()) {
    return false;
  }
  if (id && element.id !== id) {
    return false;
  }
  for (const name of classes) {
    if (!element.classList.contains(name)) {
      return false;
    }
  }
  for (const [name, value] of Object.entries(attr)) {
    const actual = name === 'href' ? element.href : element.getAttribute(name);
    if (actual !== value) {
      return false;
    }
  }
  return true;
}

function walk(element, visit) {
  visit(element);
  for (const child of element.children || []) {
    walk(child, visit);
  }
}

function querySelectorDeep(root, selector) {
  const parts = selector.trim().split(/\s+/);
  let current = [root];

  for (const part of parts) {
    const next = [];
    for (const node of current) {
      const start = node === root && parts.length === 1 ? [root, ...(node.children || [])] : (node.children || []);
      const stack = [...start];
      const seen = new Set();
      while (stack.length) {
        const candidate = stack.shift();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        if (matchesSimple(candidate, part) && candidate !== root) {
          next.push(candidate);
        }
        stack.push(...(candidate.children || []));
      }
    }
    current = next;
    if (current.length === 0) {
      return null;
    }
  }

  return current[0] || null;
}

function createFakeElement(tagName = 'div', className = '') {
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    tagName: String(tagName).toUpperCase(),
    className,
    id: '',
    href: '',
    hidden: false,
    children: [],
    parentNode: null,
    textContent: '',
    style: {},
    dataset: {},
    get isConnected() {
      let node = element;
      while (node) {
        if (node.isDocumentRoot) {
          return true;
        }
        node = node.parentNode;
      }
      return false;
    },
    get nextElementSibling() {
      const parent = element.parentNode;
      if (!parent) {
        return null;
      }
      const index = parent.children.indexOf(element);
      return index >= 0 ? parent.children[index + 1] || null : null;
    },
    classList: {
      add(...names) {
        const current = new Set(element.className.split(/\s+/).filter(Boolean));
        for (const name of names) {
          current.add(name);
        }
        element.className = [...current].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        element.className = element.className
          .split(/\s+/)
          .filter((name) => name && !drop.has(name))
          .join(' ');
      },
      contains(name) {
        return element.className.split(/\s+/).includes(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'id') {
        element.id = String(value);
      }
      if (name === 'class') {
        element.className = String(value);
      }
      if (name === 'href') {
        element.href = String(value);
      }
    },
    getAttribute(name) {
      if (name === 'id') {
        return element.id || null;
      }
      if (name === 'class') {
        return element.className || null;
      }
      if (name === 'href') {
        return element.href || attributes.get('href') || null;
      }
      return attributes.has(name) ? attributes.get(name) : null;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) {
        listener.call(element, event);
      }
    },
    appendChild(child) {
      if (child.parentNode) {
        child.remove();
      }
      element.children.push(child);
      child.parentNode = element;
      child.parent = element;
      return child;
    },
    append(child) {
      return element.appendChild(child);
    },
    insertBefore(child, reference) {
      if (child.parentNode) {
        child.remove();
      }
      const index = element.children.indexOf(reference);
      if (index === -1) {
        element.children.push(child);
      } else {
        element.children.splice(index, 0, child);
      }
      child.parentNode = element;
      child.parent = element;
      return child;
    },
    remove() {
      const parent = element.parentNode;
      if (!parent) {
        return;
      }
      parent.children = parent.children.filter((child) => child !== element);
      element.parentNode = null;
      element.parent = null;
    },
    querySelector(selector) {
      return querySelectorDeep(element, selector);
    },
    querySelectorAll(selector) {
      const found = [];
      walk(element, (node) => {
        if (node !== element && matchesSimple(node, selector.split(/\s+/).at(-1))) {
          if (querySelectorDeep(node.parentNode || element, selector) === node || matchesSimple(node, selector)) {
            found.push(node);
          }
        }
      });
      return found;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };

  if (className) {
    element.className = className;
  }

  return element;
}

function countById(root, id) {
  let count = 0;
  walk(root, (node) => {
    if (node.id === id) {
      count += 1;
    }
  });
  return count;
}

function runPayoutContent({
  anchors = 'funds-dropdown',
  loadResult,
  loadOperations,
  pathname = '/projects',
} = {}) {
  const header = createFakeElement('header');
  const logoutheader = createFakeElement('div', 'logoutheader');
  const fundsDropdown = createFakeElement('div', 'header-funds header-dropdown');
  const fundsOnly = createFakeElement('div', 'header-funds');
  const balanceLink = createFakeElement('a');
  balanceLink.href = '/balance';
  balanceLink.setAttribute('href', '/balance');

  const body = createFakeElement('body');
  body.isDocumentRoot = false;
  const documentElement = createFakeElement('html');
  documentElement.clientWidth = 1280;
  documentElement.clientHeight = 800;

  if (anchors === 'funds-dropdown') {
    header.appendChild(fundsDropdown);
    body.appendChild(header);
  } else if (anchors === 'funds') {
    header.appendChild(fundsOnly);
    body.appendChild(header);
  } else if (anchors === 'logout-link') {
    logoutheader.appendChild(balanceLink);
    body.appendChild(logoutheader);
  } else if (anchors === 'header-link') {
    header.appendChild(balanceLink);
    body.appendChild(header);
  } else if (anchors === 'none') {
    body.appendChild(header);
  }

  documentElement.appendChild(body);

  const documentListeners = new Map();
  const windowListeners = new Map();
  const storageListeners = [];
  const mutationObservers = [];
  let currentLoad = loadResult;
  const loadFn = loadOperations || (async () => currentLoad);

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body,
    documentElement,
    createElement(tagName) {
      return createFakeElement(tagName);
    },
    createElementNS(_ns, tagName) {
      return createFakeElement(tagName);
    },
    getElementById(id) {
      let found = null;
      walk(documentElement, (node) => {
        if (!found && node.id === id) {
          found = node;
        }
      });
      return found;
    },
    querySelector(selector) {
      if (selector === 'body') {
        return body;
      }
      return querySelectorDeep(documentElement, selector) || querySelectorDeep(body, selector);
    },
    querySelectorAll(selector) {
      const first = document.querySelector(selector);
      return first ? [first] : [];
    },
    addEventListener(type, listener) {
      const list = documentListeners.get(type) || [];
      list.push(listener);
      documentListeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of documentListeners.get(event.type) || []) {
        listener.call(document, event);
      }
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutationObservers.push(this);
    }

    observe() {}
  }

  const chrome = {
    storage: {
      local: {},
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
  };

  const window = {
    location: {
      href: `https://kwork.ru${pathname}`,
      pathname,
    },
    addEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      list.push(listener);
      windowListeners.set(type, list);
    },
  };

  // Host Date keeps instanceof checks in payoutCore valid across the VM boundary.
  // The fixture expects a same-day payout regardless of the actual test date.
  class FixtureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-09-03T12:00:00+03:00']));
    }

    static now() {
      return new FixtureDate().getTime();
    }
  }

  const context = {
    Date: FixtureDate,
    URL,
    MutationObserver: FakeMutationObserver,
    document,
    window,
    requestAnimationFrame(callback) {
      callback();
    },
    setInterval() {
      return 1;
    },
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    chrome,
    globalThis: {
      KworkPayoutCore: payoutCore,
      KworkPayoutSource: {
        loadOperations: loadFn,
      },
      chrome,
    },
  };

  vm.runInNewContext(contentScript, context);

  return {
    document,
    body,
    header,
    fundsDropdown,
    fundsOnly,
    balanceLink,
    logoutheader,
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
    setLoadResult(next) {
      currentLoad = next;
    },
    fireCacheChange() {
      for (const listener of storageListeners) {
        listener({ payoutCache: { newValue: {} } }, 'local');
      }
    },
    fireMutations() {
      for (const observer of mutationObservers) {
        observer.callback([]);
      }
    },
    widget() {
      return document.getElementById('kph-payout-widget');
    },
  };
}

test('виджет стоит в шапке непосредственно перед контейнером баланса', async () => {
  const page = runPayoutContent({
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.nextElementSibling, page.fundsDropdown);
  assert.equal(widget.parentNode, page.fundsDropdown.parentNode);
});

test('запасной якорь .header-funds, если нет связки с dropdown', async () => {
  const page = runPayoutContent({
    anchors: 'funds',
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.nextElementSibling, page.fundsOnly);
});

test('запасной якорь — ссылка на /balance в шапке', async () => {
  const page = runPayoutContent({
    anchors: 'header-link',
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.nextElementSibling, page.balanceLink);
});

test('без якоря виджет не вставляется и скрипт не падает', async () => {
  const page = runPayoutContent({
    anchors: 'none',
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();

  assert.equal(page.widget(), null);
  assert.equal(countById(page.document.documentElement, 'kph-payout-widget'), 0);
});

test('повторный рендер с тем же состоянием не создаёт второй узел', async () => {
  const page = runPayoutContent({
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();
  assert.equal(countById(page.document.documentElement, 'kph-payout-widget'), 1);

  page.fireCacheChange();
  await page.flush();

  assert.equal(countById(page.document.documentElement, 'kph-payout-widget'), 1);
  assert.equal(page.widget().nextElementSibling, page.fundsDropdown);
});

test('пустое состояние: узла нет; прежний узел удаляется', async () => {
  const page = runPayoutContent({
    loadResult: { operations: [] },
  });
  await page.flush();
  assert.equal(page.widget(), null);

  const filled = runPayoutContent({
    loadResult: { operations: [pendingOperation()] },
  });
  await filled.flush();
  assert.ok(filled.widget());

  filled.setLoadResult({ operations: [] });
  filled.fireCacheChange();
  await filled.flush();
  assert.equal(filled.widget(), null);
});

test('ошибка источника не рисует виджет и не бросает исключение', async () => {
  const page = runPayoutContent({
    loadResult: { error: 'сеть недоступна', operations: [pendingOperation()] },
  });
  await page.flush();
  assert.equal(page.widget(), null);
});

test('сумма, срок, ссылка на баланс и aria-label', async () => {
  const page = runPayoutContent({
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.href, '/balance');
  assert.equal(widget.querySelector('.kph-payout__amount').textContent, AMOUNT_TEXT);
  assert.equal(widget.querySelector('.kph-payout__delay').textContent, 'сегодня');

  const label = widget.getAttribute('aria-label') || '';
  assert.ok(label.length > 0);
  assert.ok(label.includes(AMOUNT_TEXT));
  assert.ok(label.includes('сегодня'));
});

test('без срока разделитель и элемент срока не создаются', async () => {
  const page = runPayoutContent({
    loadResult: {
      operations: [pendingOperation({ getDateWithdrawByDate: 'когда-нибудь потом' })],
    },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.querySelector('.kph-payout__amount').textContent, AMOUNT_TEXT);
  assert.equal(widget.querySelector('.kph-payout__delay'), null);
  assert.equal(widget.querySelector('.kph-payout__separator'), null);
});

test('дата ближайшей выплаты из корня ответа попадает в подсказку', async () => {
  const page = runPayoutContent({
    loadResult: {
      dateWithdraw: PAYOUT_DATE,
      operations: [pendingOperation({ getDateWithdrawByDate: undefined })],
    },
  });
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  widget.dispatchEvent({ type: 'mouseenter' });

  const tip = page.document.getElementById('kph-payout-tip');
  assert.ok(tip);
  assert.ok(String(tip.textContent).includes('Четверг 3 сентября до 23:00 по МСК'));
});

test('ошибка повторной загрузки снимает уже показанный виджет', async () => {
  const page = runPayoutContent({
    loadResult: { operations: [pendingOperation()] },
  });
  await page.flush();
  assert.ok(page.widget());

  page.setLoadResult({ operations: null, error: 'нужен вход на Kwork' });
  page.fireCacheChange();
  await page.flush();

  assert.equal(page.widget(), null);
  assert.equal(countById(page.document.documentElement, 'kph-payout-widget'), 0);
});

test('виджет вставляется, когда шапка появляется после данных', async () => {
  let loadCount = 0;
  const page = runPayoutContent({
    anchors: 'none',
    loadOperations: async () => {
      loadCount += 1;
      return { operations: [pendingOperation()] };
    },
  });
  await page.flush();

  assert.equal(page.document.querySelector('.header-funds.header-dropdown'), null);
  assert.equal(page.document.querySelector('.header-funds'), null);
  assert.equal(page.widget(), null);
  assert.equal(loadCount, 1);

  page.header.appendChild(page.fundsDropdown);
  page.fireMutations();
  await page.flush();

  const widget = page.widget();
  assert.ok(widget);
  assert.equal(widget.nextElementSibling, page.fundsDropdown);
  assert.equal(loadCount, 1);
});
