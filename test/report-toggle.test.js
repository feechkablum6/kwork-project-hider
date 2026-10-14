const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.resolve(__dirname, '../src/report-toggle.js'), 'utf8');

/* Минимальный DOM: простые селекторы из одного класса или тега с классами,
   этого хватает разметке трека Kwork, которую трогает скрипт. */
class FakeElement {
  constructor(tagName, classes = []) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    let text = '';
    /* Как в браузере: любая запись textContent заменяет текстовый узел,
       даже той же строкой, и наблюдатель видит изменение детей. */
    Object.defineProperty(this, 'textContent', {
      get: () => text,
      set: (value) => {
        text = String(value);
        FakeElement.onChildList?.();
      },
    });
    this.type = '';
    const classSet = new Set(classes);
    this.classList = {
      add: (...names) => names.forEach((name) => classSet.add(name)),
      contains: (name) => classSet.has(name),
      toggle: (name, force) => (force ? classSet.add(name) : classSet.delete(name)),
    };
    Object.defineProperty(this, 'className', {
      get: () => [...classSet].join(' '),
      set: (value) => {
        classSet.clear();
        String(value).split(/\s+/).filter(Boolean).forEach((name) => classSet.add(name));
      },
    });
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  click() {
    this.listeners.get('click')?.();
  }

  matches(selector) {
    const [tag, ...classes] = selector.split('.');
    if (tag && this.tagName !== tag.toUpperCase()) {
      return false;
    }
    return classes.every((name) => this.classList.contains(name));
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) {
        return node;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function buildTrack({ withForm = true } = {}) {
  const root = new FakeElement('html');
  const wrapper = new FakeElement('div');
  const item = new FakeElement('div', ['track--item', 'new-report']);
  const main = new FakeElement('div', ['track--item__main']);
  const title = new FakeElement('div', ['track--item__title']);
  const content = new FakeElement('div', ['track--item__content']);
  root.append(wrapper);
  wrapper.append(item);
  item.append(main);
  main.append(title, content);
  if (withForm) {
    content.append(new FakeElement('form', ['js-track-report-form', 'js-track-send-progress-report']));
  }
  return { root, item, title, content };
}

function run({ pathname = '/track', stored, track = buildTrack() } = {}) {
  const frames = [];
  const observers = [];
  FakeElement.onChildList = () => observers.forEach((callback) => callback());
  const storage = { ...(stored === undefined ? {} : { reportCollapsed: stored }) };
  const changeListeners = [];
  const document = {
    readyState: 'complete',
    documentElement: track.root,
    querySelectorAll: (selector) => track.root.querySelectorAll(selector),
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_, tag) => new FakeElement(tag),
    addEventListener: () => {},
  };
  const context = {
    window: { location: { pathname } },
    document,
    requestAnimationFrame: (callback) => frames.push(callback),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }

      observe() {
        observers.push(this.callback);
      }
    },
    chrome: {
      runtime: {},
      storage: {
        local: {
          get: (_, callback) => callback({ ...storage }),
          set: (values, callback) => {
            Object.assign(storage, values);
            callback?.();
          },
        },
        onChanged: { addListener: (listener) => changeListeners.push(listener) },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(script, context);
  const flush = () => {
    let count = 0;
    while (frames.length > 0 && count < 50) {
      frames.shift()();
      count += 1;
    }
    return count;
  };
  flush();
  const button = track.title.querySelector('button.kph-report-toggle');
  return { ...track, button, storage, changeListeners, flush };
}

function label(button) {
  return button.querySelector('span.kph-report-toggle__label').textContent;
}

test('кнопка появляется в заголовке промежуточного отчёта и по умолчанию отчёт раскрыт', () => {
  const { button, item, content } = run();
  assert.ok(button);
  assert.equal(label(button), 'Скрыть');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(button.getAttribute('aria-controls'), content.id);
  assert.equal(item.classList.contains('kph-report-collapsed'), false);
});

test('нажатие сворачивает отчёт, запоминает это и повторное нажатие раскрывает', () => {
  const { button, item, storage } = run();
  button.click();
  assert.equal(item.classList.contains('kph-report-collapsed'), true);
  assert.equal(label(button), 'Открыть');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(storage.reportCollapsed, true);

  button.click();
  assert.equal(item.classList.contains('kph-report-collapsed'), false);
  assert.equal(storage.reportCollapsed, false);
});

test('запомненное свёрнутое состояние применяется при открытии заказа', () => {
  const { button, item } = run({ stored: true });
  assert.equal(item.classList.contains('kph-report-collapsed'), true);
  assert.equal(label(button), 'Открыть');
});

test('свёртка в другой вкладке доходит до открытой страницы', () => {
  const { item, changeListeners } = run();
  changeListeners.forEach((listener) => listener({ reportCollapsed: { newValue: true } }, 'local'));
  assert.equal(item.classList.contains('kph-report-collapsed'), true);
});

test('события трека без формы отчёта и другие страницы не трогаются', () => {
  assert.equal(run({ track: buildTrack({ withForm: false }) }).button, null);
  assert.equal(run({ pathname: '/projects' }).button, null);
});

test('собственная перерисовка кнопки не зацикливает наблюдатель страницы', () => {
  const { button, flush } = run();
  button.click();
  assert.ok(flush() < 3);
  button.click();
  assert.ok(flush() < 3);
});
