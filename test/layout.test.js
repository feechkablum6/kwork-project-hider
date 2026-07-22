const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.resolve(__dirname, '../src/content.css'), 'utf8');
const contentScript = fs.readFileSync(path.resolve(__dirname, '../src/content.js'), 'utf8');
const feedContentScript = fs.readFileSync(path.resolve(__dirname, '../src/feed-content.js'), 'utf8');

function getRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  return match?.[1] || '';
}

test('слот располагается в потоке бюджетной колонки и не создаёт полноширинную строку', () => {
  const slotRule = getRule('.kph-hide-slot');

  assert.match(slotRule, /justify-content:\s*flex-end/);
  assert.match(slotRule, /width:\s*auto/);
  assert.match(slotRule, /padding:\s*8px 0 0/);
  assert.doesNotMatch(slotRule, /flex-basis:\s*100%/);
  assert.doesNotMatch(slotRule, /grid-column/);
});

test('на узком экране кнопка имеет удобную область касания', () => {
  const mobileSection = css.match(/@media\s*\(max-width:\s*520px\)\s*\{([\s\S]+?)\n\}/)?.[1] || '';
  const buttonRule = mobileSection.match(/\.kph-hide-button\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(buttonRule, /width:\s*44px/);
  assert.match(buttonRule, /min-height:\s*44px/);
});

test('реальная карточка Kwork определяется по внешнему контейнеру want-card', () => {
  assert.match(contentScript, /'\.want-card'/);
  assert.match(contentScript, /\(budgetContainer \|\| card\)\.append\(slot\)/);
});

test('пагинация заменяется автоматической подгрузкой при достижении конца ленты', () => {
  const paginationRule = getRule('.kph-feed-pagination');

  assert.match(feedContentScript, /IntersectionObserver/);
  assert.match(feedContentScript, /\.pagination__arrow--next/);
  assert.match(paginationRule, /display:\s*none\s*!important/);
});

test('наблюдение запускается и при отложенном появлении списка Kwork', () => {
  assert.match(feedContentScript, /if\s*\(!isObserved\)[\s\S]+intersectionObserver\.observe\(status\)/);
});

test('прямой вход на позднюю страницу возвращается к началу единой ленты', () => {
  assert.match(feedContentScript, /searchParams\.delete\('page'\)/);
  assert.match(feedContentScript, /location\.replace/);
});
