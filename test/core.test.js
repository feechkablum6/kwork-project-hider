const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isProjectsListPage,
  extractProjectId,
  normalizeProjectIds,
  addProjectId,
  removeProjectId,
  findBudgetContainer,
  mergeProjectPages,
  getProjectRequestSignature,
  clickPreservingScroll,
} = require('../src/core.js');

test('распознаёт точную страницу списка проектов с параметрами и без них', () => {
  assert.equal(isProjectsListPage('https://kwork.ru/projects'), true);
  assert.equal(isProjectsListPage('https://kwork.ru/projects?page=2&a=1'), true);
});

test('не принимает карточку проекта и другие страницы Kwork за список', () => {
  assert.equal(isProjectsListPage('https://kwork.ru/projects/3217113'), false);
  assert.equal(isProjectsListPage('https://kwork.ru/projects/list/newsolutions'), false);
  assert.equal(isProjectsListPage('https://kwork.ru/'), false);
});

test('извлекает ID из обычной ссылки проекта', () => {
  assert.equal(extractProjectId('https://kwork.ru/projects/3151203/view'), '3151203');
});

test('извлекает ID из ссылки без /view и игнорирует параметры', () => {
  assert.equal(extractProjectId('/projects/3211388?ref=224521'), '3211388');
});

test('не принимает страницу списка и посторонние адреса', () => {
  assert.equal(extractProjectId('https://kwork.ru/projects'), null);
  assert.equal(extractProjectId('https://example.com/projects/3151203/view'), null);
  assert.equal(extractProjectId('javascript:void(0)'), null);
});

test('нормализует сохранённые ID и удаляет дубликаты', () => {
  assert.deepEqual(normalizeProjectIds(['12', 12, '003', 'abc', null, 7]), ['12', '3', '7']);
});

test('добавляет ID без дубликатов', () => {
  assert.deepEqual(addProjectId(['12', '7'], '12'), ['12', '7']);
  assert.deepEqual(addProjectId(['12'], '7'), ['12', '7']);
});

test('удаляет выбранный ID', () => {
  assert.deepEqual(removeProjectId(['12', '7'], '12'), ['7']);
});

test('выбирает минимальный блок, содержащий обе строки бюджета', () => {
  const wholeCard = { textContent: 'Заголовок Желаемый бюджет: до 3 000 ₽ Допустимый: до 9 000 ₽ Описание проекта' };
  const budgetColumn = { textContent: 'Желаемый бюджет: до 3 000 ₽ Допустимый: до 9 000 ₽' };
  const mainBudget = { textContent: 'Желаемый бюджет: до 3 000 ₽' };
  const card = {
    querySelectorAll() {
      return [wholeCard, budgetColumn, mainBudget];
    },
  };

  assert.equal(findBudgetContainer(card), budgetColumn);
});

test('использует основной блок бюджета, если допустимый бюджет отсутствует', () => {
  const mainBudget = { textContent: 'Желаемый бюджет: до 3 000 ₽' };
  const card = {
    querySelectorAll() {
      return [{ textContent: 'Заголовок и описание проекта' }, mainBudget];
    },
  };

  assert.equal(findBudgetContainer(card), mainBudget);
});

test('объединяет страницы проектов в одну ленту и удаляет дубликаты', () => {
  const firstPage = [{ id: 30 }, { id: 20 }];
  const secondPage = [{ id: 20 }, { id: 10 }];

  assert.deepEqual(mergeProjectPages(firstPage, secondPage), [
    { id: 30 },
    { id: 20 },
    { id: 10 },
  ]);
});

test('строит одинаковую подпись запроса независимо от страницы и порядка полей', () => {
  const firstRequest = new FormData();
  firstRequest.append('page', '1');
  firstRequest.append('category', '15');
  firstRequest.append('price_from', '500');

  const nextRequest = new FormData();
  nextRequest.append('price_from', '500');
  nextRequest.append('page', '2');
  nextRequest.append('category', '15');

  assert.equal(
    getProjectRequestSignature(firstRequest),
    getProjectRequestSignature(nextRequest),
  );
});

test('меняет подпись запроса при смене фильтра', () => {
  const design = new FormData();
  design.append('page', '2');
  design.append('category', '15');

  const development = new FormData();
  development.append('page', '2');
  development.append('category', '11');

  assert.notEqual(
    getProjectRequestSignature(design),
    getProjectRequestSignature(development),
  );
});

test('после штатного перехода Kwork восстанавливает позицию прокрутки', () => {
  const viewport = {
    scrollX: 12,
    scrollY: 840,
    scrollTo(options) {
      this.scrollX = options.left;
      this.scrollY = options.top;
      this.lastScrollOptions = options;
    },
  };
  const nextPageButton = {
    click() {
      viewport.scrollY = 0;
    },
  };

  clickPreservingScroll(nextPageButton, viewport);

  assert.deepEqual(viewport.lastScrollOptions, {
    behavior: 'instant',
    left: 12,
    top: 840,
  });
});
