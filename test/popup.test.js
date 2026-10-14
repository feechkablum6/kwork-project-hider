const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/popup-view.js');

test('до первой выгрузки попап предлагает извлечь переписки', () => {
  const model = view.describeCrawlState({});

  assert.equal(model.status, 'Переписки Kwork на диске');
  assert.equal(model.actionLabel, 'Извлечь все переписки');
  assert.equal(model.showProgress, false);
});

test('сбор списка переписок показывает неопределённый прогресс', () => {
  const model = view.describeCrawlState({ running: true, stage: 'dialogs', total: 0, done: 0, messages: 0 });

  assert.equal(model.pending, true);
  assert.equal(model.counter, 'Собираю список переписок');
  assert.equal(model.actionMode, 'stop');
});

test('во время выгрузки видно номер диалога и число сообщений', () => {
  const model = view.describeCrawlState({ running: true, stage: 'dialog', done: 2, total: 17, messages: 240 });

  assert.equal(model.counter, 'Диалог 3 из 17 · 240 сообщений');
  assert.equal(model.ratio, 2 / 17);
  assert.equal(model.actionLabel, 'Остановить выгрузку');
});

test('во время выгрузки виден счётчик скачанных файлов', () => {
  const model = view.describeCrawlState({ running: true, stage: 'dialog', done: 2, total: 10, messages: 140, files: { done: 3, total: 8 } });

  assert.match(model.counter, /файлы 3 из 8/);
});

test('в итоге выгрузки видно число сохранённых файлов', () => {
  const model = view.describeCrawlState({ finished: true, total: 10, messages: 140, files: { done: 8, total: 8 } });

  assert.match(model.hint, /сохранено 8 файлов/);
});

test('после завершения показан итог и предложение повторить', () => {
  const model = view.describeCrawlState({ finished: true, total: 17, messages: 1240, done: 17 });

  assert.equal(model.status, 'Переписки выгружены');
  assert.equal(model.hint, 'Обработано 17 переписок, добавлено 1240 сообщений.');
  assert.equal(model.actionLabel, 'Выгрузить заново');
});

test('ошибка выгрузки показывает, что успело сохраниться', () => {
  const model = view.describeCrawlState({ finished: true, total: 3, messages: 120, error: 'На странице переписок не нашлось ни одного диалога' });

  assert.equal(model.status, 'Выгрузка прервалась');
  assert.equal(model.error, 'На странице переписок не нашлось ни одного диалога');
  assert.equal(model.hint, 'Обработано 3 переписки, добавлено 120 сообщений.');
});

test('отсутствие входа определяется само и ведёт на Kwork', () => {
  const model = view.describeCrawlState({ authRequired: true, error: 'Kwork не пускает к перепискам: вход не выполнен' });

  assert.equal(model.status, 'Вход в Kwork не выполнен');
  assert.equal(model.actionLabel, 'Открыть Kwork для входа');
  assert.equal(model.actionMode, 'open');
  assert.equal(model.showProgress, false);
});

test('проверка доступа показана отдельным шагом', () => {
  const model = view.describeCrawlState({ running: true, stage: 'auth' });

  assert.equal(model.counter, 'Проверяю доступ к переписке');
  assert.equal(model.pending, true);
});

test('остановленная выгрузка предлагает продолжить', () => {
  const model = view.describeCrawlState({ cancelled: true, done: 4, messages: 300 });

  assert.equal(model.actionLabel, 'Продолжить выгрузку');
  assert.equal(model.hint, 'Обработано 4 переписки, добавлено 300 сообщений.');
});

test('числительные согласованы с числом', () => {
  assert.equal(view.describeTotals(1, 1), '1 переписка, 1 сообщение');
  assert.equal(view.describeTotals(2, 3), '2 переписки, 3 сообщения');
  assert.equal(view.describeTotals(11, 15), '11 переписок, 15 сообщений');
  assert.equal(view.describeTotals(21, 102), '21 переписка, 102 сообщения');
});

test('строка автосохранения показывает время последнего прохода', () => {
  const at = new Date(2026, 9, 14, 12, 41).toISOString();
  const model = view.describeAutoSync({ ok: true, at }, Date.parse(at) + 60 * 1000);

  assert.equal(model.text, 'Новые сообщения сохраняются сами, последний раз в 12:41.');
  assert.equal(model.problem, false);
});

test('строка автосохранения предупреждает о выходе, сбое и простое', () => {
  const at = new Date(2026, 9, 14, 12, 41).toISOString();

  assert.equal(view.describeAutoSync({ ok: false, signedOut: true, at }).text, 'Автосохранение ждёт входа в Kwork.');
  assert.equal(view.describeAutoSync({ ok: false, error: 'мост на диск не отвечает', at }, Date.parse(at)).text, 'Автосохранение в 12:41 не удалось: мост на диск не отвечает.');
  assert.equal(view.describeAutoSync({ ok: true, at }, Date.parse(at) + 30 * 60 * 1000).text, 'Автосохранение не шло с 12:41.');
  assert.equal(view.describeAutoSync(null).problem, false);
});
