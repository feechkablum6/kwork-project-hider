const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const css = fs.readFileSync(path.resolve(__dirname, '../src/content.css'), 'utf8');
const contentScript = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
const feedContentScript = fs.readFileSync(path.resolve(__dirname, '../src/feed-content.js'), 'utf8');

function getRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  return match?.[1] || '';
}

function createFakeElement(className = '') {
  const element = {
    className,
    hidden: false,
    children: [],
    classList: {
      add(name) {
        element.className = `${element.className} ${name}`.trim();
      },
      remove(name) {
        element.className = element.className
          .split(' ')
          .filter((current) => current && current !== name)
          .join(' ');
      },
      contains(name) {
        return element.className.split(' ').includes(name);
      },
    },
    setAttribute() {},
    append(child) {
      element.children.push(child);
      child.parent = element;
    },
    remove() {
      const parent = element.parent;
      if (!parent) {
        return;
      }

      parent.children = parent.children.filter((child) => child !== element);
      element.parent = null;
    },
    querySelector(selector) {
      const name = selector.replace('.', '');
      return element.children.find((child) => child.classList.contains(name)) || null;
    },
  };

  return element;
}

function runFeedContentScript({ projectCards = [], documentAttributes = new Map() } = {}) {
  const listeners = new Map();
  const paginationClasses = new Set();
  const pagination = {
    classList: {
      add(name) {
        paginationClasses.add(name);
      },
      remove(name) {
        paginationClasses.delete(name);
      },
    },
  };
  const projectList = createFakeElement('project-list');
  const document = {
    createElement(tagName) {
      return createFakeElement(tagName === 'div' ? '' : tagName);
    },
    documentElement: {
      getAttribute(name) {
        if (name === 'data-kph-feed-ready') {
          return 'true';
        }

        return documentAttributes.has(name) ? documentAttributes.get(name) : null;
      },
      removeAttribute(name) {
        documentAttributes.delete(name);
      },
      setAttribute(name, value) {
        documentAttributes.set(name, String(value));
      },
    },
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) || [];
      typeListeners.push(listener);
      listeners.set(type, typeListeners);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) {
        listener.call(this, event);
      }
    },
    querySelector(selector) {
      if (selector === '.project-list') {
        return projectList;
      }
      if (selector === '.pagination') {
        return pagination;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.pagination') {
        return [pagination];
      }
      if (selector === '.want-card') {
        return projectCards;
      }
      return [];
    },
  };
  class FakeMutationObserver {
    observe() {}
  }
  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const window = {
    history: {
      replaceState() {},
    },
    location: {
      href: 'https://kwork.ru/projects',
    },
    requestAnimationFrame(callback) {
      callback();
    },
  };
  const context = {
    URL,
    Event: FakeEvent,
    MutationObserver: FakeMutationObserver,
    document,
    globalThis: {
      KworkProjectHiderCore: {
        clickPreservingScroll() {},
        isProjectsListPage() {
          return true;
        },
      },
    },
    queueMicrotask(callback) {
      callback();
    },
    requestAnimationFrame(callback) {
      callback();
    },
    window,
  };
  window.document = document;
  vm.runInNewContext(feedContentScript, context);

  return {
    dispatch(type) {
      document.dispatchEvent(new FakeEvent(type));
    },
    documentAttributes,
    paginationClasses,
    projectList,
    getSkeleton() {
      return projectList.children.find((child) => child.className === 'kph-feed-skeleton') || null;
    },
  };
}

test('слот в строке действий занимает место только своей кнопки', () => {
  const slotRule = getRule('.kph-hide-slot');

  assert.match(slotRule, /justify-content:\s*flex-end/);
  assert.match(slotRule, /width:\s*auto/);
  assert.match(slotRule, /padding:\s*0/);
  assert.match(slotRule, /margin-inline-start:\s*8px/);
  assert.match(slotRule, /pointer-events:\s*none/);
  assert.doesNotMatch(slotRule, /flex-basis:\s*100%/);
  assert.doesNotMatch(slotRule, /grid-column/);
});

test('на узком экране кнопка имеет удобную область касания', () => {
  const mobileSection = css.match(/@media\s*\(max-width:\s*520px\)\s*\{([\s\S]+?)\n\}/)?.[1] || '';
  const buttonRule = mobileSection.match(/\.kph-hide-button\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(buttonRule, /width:\s*44px/);
  assert.match(buttonRule, /min-height:\s*44px/);
});

test('кнопка скрытия размещается в штатной области действий карточки', () => {
  assert.match(contentScript, /'\.want-card'/);
  assert.match(contentScript, /card\.querySelector\('\.want-card__buttons'\)/);
  assert.match(contentScript, /\(actionsContainer \|\| card\)\.append\(slot\)/);
  assert.doesNotMatch(contentScript, /findBudgetContainer\(card\)/);
});

test('пагинация заменяется одним тихим запуском фоновой сборки', () => {
  const paginationRule = getRule('.kph-feed-pagination');

  assert.match(feedContentScript, /\.pagination__arrow--next/);
  assert.match(feedContentScript, /kph-feed-start/);
  assert.match(feedContentScript, /function renderCollectedFeed\(\)[\s\S]+core\.clickPreservingScroll/);
  assert.match(
    feedContentScript,
    /kph-feed-render[\s\S]{0,200}core\.clickPreservingScroll/,
  );
  assert.match(
    feedContentScript,
    /getAttribute\(RENDER_DECISION_ATTRIBUTE\) !== 'allowed'[\s\S]{0,120}core\.clickPreservingScroll/,
  );
  assert.match(feedContentScript, /getAttribute\(COLLECTED_ATTRIBUTE\) === 'true'/);
  assert.match(feedContentScript, /kph-feed-collected[\s\S]+renderCollectedFeed\(\)/);
  assert.doesNotMatch(feedContentScript, /IntersectionObserver/);
  assert.match(paginationRule, /display:\s*none\s*!important/);
});

test('расширение не создаёт отдельный статус или индикатор загрузки ленты', () => {
  assert.doesNotMatch(feedContentScript, /kph-feed-status/);
  assert.doesNotMatch(feedContentScript, /Загружаю|Ищу нескрытые проекты/);
  assert.doesNotMatch(css, /\.kph-feed-status/);
});

test('пока лента собирается, вместо пустого списка стоят контуры карточек', () => {
  const hiddenCard = createFakeElement('want-card kph-is-hidden');
  hiddenCard.hidden = true;
  const feed = runFeedContentScript({
    projectCards: [hiddenCard],
    documentAttributes: new Map([['data-kph-feed-collecting', 'true']]),
  });

  feed.dispatch('kph-feed-collecting');
  const skeleton = feed.getSkeleton();

  assert.notEqual(skeleton, null);
  assert.equal(skeleton.children.length, 3);
  assert.equal(skeleton.children[0].children.length, 5);
});

test('контуры карточек не появляются, когда в ленте есть видимые проекты', () => {
  const visibleCard = createFakeElement('want-card');
  const feed = runFeedContentScript({
    projectCards: [visibleCard],
    documentAttributes: new Map([['data-kph-feed-collecting', 'true']]),
  });

  feed.dispatch('kph-feed-collecting');

  assert.equal(feed.getSkeleton(), null);
});

test('контуры карточек исчезают после отрисовки собранной ленты', () => {
  const hiddenCard = createFakeElement('want-card kph-is-hidden');
  hiddenCard.hidden = true;
  const documentAttributes = new Map([['data-kph-feed-collecting', 'true']]);
  const feed = runFeedContentScript({ projectCards: [hiddenCard], documentAttributes });

  feed.dispatch('kph-feed-collecting');
  assert.notEqual(feed.getSkeleton(), null);

  documentAttributes.delete('data-kph-feed-collecting');
  feed.dispatch('kph-feed-loaded');

  assert.equal(feed.getSkeleton(), null);
});

test('контуры карточек повторяют геометрию карточки Kwork и уважают reduced-motion', () => {
  const cardRule = getRule('.kph-feed-skeleton__card');
  const barRule = getRule('.kph-feed-skeleton__bar');

  assert.match(cardRule, /padding:\s*15px/);
  assert.match(cardRule, /margin-bottom:\s*16px/);
  assert.match(cardRule, /border:\s*1px solid var\(--kph-card-border\)/);
  assert.match(barRule, /background:\s*var\(--kph-skeleton\)/);
  assert.match(css, /@keyframes kph-feed-skeleton-pulse/);

  const reducedMotionSection = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]+?)\n\}/)?.[1] || '';
  assert.match(reducedMotionSection, /\.kph-feed-skeleton__bar\s*\{\s*animation:\s*none/);
});

test('итоговая отрисовка скрывает штатный прелоадер Kwork', () => {
  assert.match(feedContentScript, /data-kph-feed-rendering/);
  assert.match(css, /\[data-kph-feed-rendering=['"]true['"]\]/);
  assert.match(css, /projects-filter__preloader|preloader__ico/);
});

test('при ошибке фоновой сборки возвращается штатная пагинация Kwork', () => {
  const feed = runFeedContentScript();

  assert.equal(feed.paginationClasses.has('kph-feed-pagination'), true);
  feed.dispatch('kph-feed-error');
  assert.equal(feed.paginationClasses.has('kph-feed-pagination'), false);
});

test('для слишком большой ленты возвращается штатная пагинация Kwork', () => {
  const feed = runFeedContentScript();

  assert.equal(feed.paginationClasses.has('kph-feed-pagination'), true);
  feed.dispatch('kph-feed-limited');
  assert.equal(feed.paginationClasses.has('kph-feed-pagination'), false);
});

test('прямой вход на позднюю страницу возвращается к началу единой ленты', () => {
  assert.match(feedContentScript, /searchParams\.delete\('page'\)/);
  assert.match(feedContentScript, /location\.replace/);
});
