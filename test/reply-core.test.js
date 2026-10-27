const test = require('node:test');
const assert = require('node:assert/strict');

const reply = require('../src/reply-core.js');

const DRAFT = `Клиент спросил про срок и форму оплаты.

**1. Ответить на** «А сколько по срокам?»
Сообщение клиенту:
\`\`\`
3 дня.
\`\`\`

**2. Цитировать** «можно ли добавить форму оплаты»
Сообщение клиенту:
\`\`\`
Да, добавлю.
Это отдельная опция.
\`\`\`

**3. Опция**
Опция клиенту:
\`\`\`
Название: Форма оплаты
Цена: 2 000 ₽
Срок: 1 день
\`\`\`

**4. Обычным сообщением**
Сообщение клиенту:
\`\`\`
Подтвердите, пожалуйста, и начну.
\`\`\`

Подготовил ответ из четырёх частей.`;

test('ответ агента режется на части с режимом, целью и текстом', () => {
  const parts = reply.parseDraftParts(DRAFT);
  assert.deepEqual(parts.map((part) => [part.n, part.mode, part.target, part.text]), [
    [1, 'reply', 'А сколько по срокам?', '3 дня.'],
    [2, 'quote', 'можно ли добавить форму оплаты', 'Да, добавлю.\nЭто отдельная опция.'],
    [3, 'option', null, 'Форма оплаты'],
    [4, 'plain', null, 'Подтвердите, пожалуйста, и начну.'],
  ]);
  assert.deepEqual(parts[2].fields, { description: null, name: 'Форма оплаты', price: 2000, days: 1 });
});

test('одиночное «Сообщение клиенту:» без заголовков — одна часть обычным сообщением', () => {
  assert.deepEqual(reply.parseDraftParts('Сообщение клиенту:\n```\nГотово, проверьте.\n```').map((part) => [part.mode, part.text]), [['plain', 'Готово, проверьте.']]);
  assert.deepEqual(reply.parseDraftParts('Сообщение клиенту: Готово.').map((part) => part.text), ['Готово.']);
  assert.deepEqual(reply.parseDraftParts('Просто рассуждение без черновика.'), []);
});

test('предложение индивидуального кворка: описание, цена и срок', () => {
  const [part] = reply.parseDraftParts(`**1. Предложение**
Предложение клиенту:
\`\`\`
Описание: Починю расчёт доставки СДЭК.
Проверю настройки модуля и ключи.
Цена: 3 500 ₽
Срок: 2 дня
\`\`\``);
  assert.equal(part.mode, 'offer');
  assert.deepEqual(part.fields, { description: 'Починю расчёт доставки СДЭК.\nПроверю настройки модуля и ключи.', name: null, price: 3500, days: 2 });
});

test('предложение без цены не становится частью: выставить его нельзя', () => {
  assert.deepEqual(reply.parseDraftParts('Предложение клиенту:\nОписание: Сделаю.\nСрок: 2 дня'), []);
});

test('сообщение клиента для ответа находится по тексту, даже с другими пробелами и регистром', () => {
  const messages = [
    { id: '1', authorId: '2', text: 'А сколько по срокам?', time: '2026-10-20T10:00:00Z' },
    { id: '2', authorId: '1', text: 'А сколько по срокам?', time: '2026-10-20T10:01:00Z' },
    { id: '3', authorId: '2', text: 'И ещё,  можно ли\nдобавить форму оплаты? И цена ок.', time: '2026-10-20T10:02:00Z' },
  ];
  assert.equal(reply.findTargetMessage(messages, 'а сколько по срокам', { clientId: '2' }).id, '1');
  assert.equal(reply.findTargetMessage(messages, 'Можно ли добавить форму оплаты', { clientId: '2' }).id, '3');
  assert.equal(reply.findTargetMessage(messages, 'чего нет', { clientId: '2' }), null);
});

test('кусок для цитаты находится в настоящем тексте с его пробелами и переносами', () => {
  const text = 'И ещё,  можно ли\nдобавить форму оплаты? И цена ок.';
  const range = reply.locateFragment(text, 'можно ли добавить Форму оплаты');
  assert.equal(text.slice(range.start, range.end), 'можно ли\nдобавить форму оплаты');
  assert.deepEqual(reply.locateFragment('Привет', 'Пока'), null);
});

test('сверка отправленного: дословно, с правками или своё', () => {
  assert.equal(reply.compareSent('3 дня.', '3 дня'), 'exact');
  assert.equal(reply.compareSent('Да, добавлю. Это отдельная опция за 2000 ₽.', 'Да, добавлю — это отдельная опция за 2000 ₽, выставлю сейчас.'), 'edited');
  assert.equal(reply.compareSent('Да, добавлю. Это отдельная опция.', 'Завтра пришлю макет.'), null);
});

test('черновик устаревает, когда клиент написал после него; отправленные части отмечаются', () => {
  const draft = { at: '2026-10-20T10:05:00Z', basedOn: '2026-10-20T10:02:00Z', parts: reply.parseDraftParts(DRAFT) };
  const base = [{ id: '3', authorId: '2', text: 'вопрос', time: '2026-10-20T10:02:00Z' }];
  let progress = reply.draftProgress(draft, base, { clientId: '2' });
  assert.deepEqual([progress.stale, progress.done, progress.current.n], [false, [], 1]);

  progress = reply.draftProgress(draft, [...base, { id: '4', authorId: '1', text: '3 дня', time: '2026-10-20T10:06:00Z' }], { clientId: '2' });
  assert.deepEqual([progress.stale, progress.done, progress.current.n], [false, [1], 2]);

  progress = reply.draftProgress(draft, [...base, { id: '5', authorId: '2', text: 'А ещё?', time: '2026-10-20T10:07:00Z' }], { clientId: '2' });
  assert.equal(progress.stale, true);

  // «Заказ создан» от клиента — служебное, черновик не устаревает.
  progress = reply.draftProgress(draft, [...base, { id: '6', authorId: '2', text: 'Заказ создан', event: { type: 'offer_kwork_done' }, time: '2026-10-20T10:07:00Z' }], { clientId: '2' });
  assert.equal(progress.stale, false);
});

test('опция считается выставленной по треку заказа: Kwork показывает доход без комиссии', () => {
  const draft = { at: '2026-10-20T10:05:00Z', parts: reply.parseDraftParts(DRAFT), skipped: [1, 2] };
  const events = [{ type: 13, status: 'new', time: '2026-10-20T10:08:00Z', options: [{ name: 'Форма оплаты', price: 1600 }] }];
  const progress = reply.draftProgress(draft, [], { clientId: '2', events });
  assert.deepEqual(progress.done, [1, 2, 3]);
  assert.equal(progress.current.n, 4);
});

test('печать «как человек»: по знаку, темп быстрого набора, паузы после точки и переноса', () => {
  const text = 'Да, готово.\nПроверьте 🙂 ок';
  const steps = reply.typingSteps(text, () => 0.5);
  // Шаг на каждый знак, эмодзи не рвётся пополам, последний шаг — весь текст.
  assert.equal(steps.length, Array.from(text).length);
  assert.equal(steps.at(-1)[0], text.length);
  assert.ok(steps.every(([length], i) => i === 0 || length > steps[i - 1][0]));
  const delayAfter = (prefix) => steps.find(([length]) => length === prefix.length + 1)[1];
  assert.ok(delayAfter('Да, готово.') > delayAfter('Да'));
  assert.ok(delayAfter('Да, готово.\n') > delayAfter('Да, готово.'));
  // Обычный знак — от 22 до 55 мс: около 1300 знаков в минуту.
  const plainDelays = reply.typingSteps('абвгдежзик').map(([, delay]) => delay);
  assert.ok(plainDelays.every((delay) => delay >= 22 && delay <= 55));
  const sample = 'Обычный ответ клиенту, две фразы. Вторая строка с ценой и сроком.\n'.repeat(15);
  const total = reply.typingSteps(sample).reduce((sum, [, delay]) => sum + delay, 0);
  const perMinute = (sample.length / total) * 60000;
  assert.ok(perMinute > 1000 && perMinute < 1600, String(perMinute));
});

test('страница потеряла связь с расширением: пусто в полях — обновляется сама, набран текст или файл — только подсказка; обновление не чаще раза в минуту', () => {
  const now = 10_000_000;
  assert.equal(reply.orphanAction({ fields: ['', ' \n​'], files: 0, lastReloadAt: 0, now }), 'reload');
  assert.equal(reply.orphanAction({ fields: ['', 'Добрый день'], files: 0, lastReloadAt: 0, now }), 'notice');
  // Пустой редактор Kwork хранит в скрытом поле разметку пустой строки.
  assert.equal(reply.orphanAction({ fields: ['<div><br></div>', '<p>&nbsp;</p>'], files: 0, lastReloadAt: 0, now }), 'reload');
  assert.equal(reply.orphanAction({ fields: ['<div>Добрый день</div>'], files: 0, lastReloadAt: 0, now }), 'notice');
  assert.equal(reply.orphanAction({ fields: [], files: 1, lastReloadAt: 0, now }), 'notice');
  // Только что обновлялись, а связи снова нет — по кругу не обновляем.
  assert.equal(reply.orphanAction({ fields: [], files: 0, lastReloadAt: now - 30_000, now }), 'notice');
  assert.equal(reply.orphanAction({ fields: [], files: 0, lastReloadAt: now - 60_000, now }), 'reload');
});
