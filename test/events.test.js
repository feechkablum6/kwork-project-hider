const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/inbox-core.js');

// Форма сообщений — как в ответах /inbox_more_messages (образцы данные.json, 22.10.2026).
function offerMessage(overrides = {}) {
  return {
    id: 541388084,
    MID: 410088878,
    MSGFROM: 23848034,
    MSGTO: 6371073,
    mfrom: 'AkashiDevelop',
    mto: 'Hr_pro',
    time: 1790071208,
    type: 'offer_kwork_new',
    typeTitle: 'Предложение индивидуального кворка',
    message: '',
    quote: null,
    offerOrderData: {
      status: 'new',
      orderData: { OID: 65145284, price: '2000.00', kwork_title: 'Починю расчёт доставки СДЭК', kwork_days: '2', duration: '172800' },
    },
    ...overrides,
  };
}

test('предложение индивидуального кворка сохраняется с названием, ценой, сроком и статусом', () => {
  const message = core.normalizeMessage(offerMessage());
  assert.equal(message.text, 'Предложение индивидуального кворка');
  assert.deepEqual(message.event, {
    type: 'offer_kwork_new',
    title: 'Предложение индивидуального кворка',
    name: 'Починю расчёт доставки СДЭК',
    price: 2000,
    days: 2,
    status: 'new',
  });
  assert.match(core.describeInboxEvent(message.event), /«Починю расчёт доставки СДЭК», 2\s000 ₽, 2 дня — ждёт оплаты клиентом/);
});

test('«Заказ создан» без текста не отбрасывается: это оплата предложения', () => {
  const message = core.normalizeMessage({ MID: 411553744, MSGFROM: 16961627, MSGTO: 900, mfrom: 'stroisnab2007', message: '', time: 1792068860, type: 'offer_kwork_done', created_order_id: 65411454, files: [] });
  assert.equal(message.text, 'Заказ создан');
  assert.equal(message.event.orderId, '65411454');
  assert.match(core.describeInboxEvent(message.event), /Заказ создан №65411454 — клиент принял и оплатил/);
});

test('пустое сообщение без известного типа по-прежнему отбрасывается', () => {
  assert.equal(core.normalizeMessage({ id: 1, MSGFROM: 2, time: 1792068860, message: '' }), null);
  assert.equal(core.normalizeMessage({ id: 1, MSGFROM: 2, time: 1792068860, message: '', type: 'something_new' }), null);
});

test('старая запись предложения без номера склеивается с новой, событие остаётся', () => {
  const legacy = { id: null, time: '2026-08-18T12:33:24.000Z', authorId: '23848034', authorName: 'Hr_pro', recipientId: '6371073', recipientName: null, text: 'Предложение индивидуального кворка', attachments: [] };
  const fresh = core.normalizeMessage(offerMessage({ time: Date.parse('2026-08-18T12:33:24.000Z') / 1000 }));
  const merged = core.mergeMessages([legacy], [fresh]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].event.price, 2000);
});

test('копия без события не затирает событие сохранённой', () => {
  const full = core.normalizeMessage(offerMessage());
  const bare = { ...full };
  delete bare.event;
  assert.equal(core.mergeMessages([full], [bare])[0].event.status, 'new');
});

test('сообщение заказа помнит номер заказа', () => {
  const message = core.normalizeMessage({ id: 541557498, MID: 437869407, MSGFROM: 23848034, message: 'Поправил', time: 1790169700, order_id: '65145322', track_type: 24 });
  assert.equal(message.orderId, '65145322');
});

test('«Цитировать» отличается от «Ответить» и в переписке подписан как цитата', () => {
  const quoted = core.normalizeMessage({
    id: 10, MSGFROM: 1, mfrom: 'me', time: 1792000000, message: 'Да, добавлю',
    quote: { reply_conversation_id: 9, MSGFROM: 2, time: 1791999000, message: 'форму оплаты', author: { USERID: 2, username: 'client' }, isQuote: true },
  });
  const replied = core.normalizeMessage({
    id: 11, MSGFROM: 1, mfrom: 'me', time: 1792000100, message: '3 дня',
    quote: { reply_conversation_id: 8, MSGFROM: 2, time: 1791998000, message: 'Сколько по срокам?', author: { USERID: 2, username: 'client' }, isQuote: false },
  });
  assert.equal(quoted.replyTo.kind, 'quote');
  assert.equal(replied.replyTo.kind, 'reply');
  const markdown = core.renderDialogMarkdown({ key: 'client', clientId: '2', messages: [replied, quoted] });
  assert.match(markdown, /> В ответ на сообщение «client — /);
  assert.match(markdown, /> Цитата из сообщения «client — /);
});

function optionsTrack(id, title, { days = '2 дня', price = '5 280&nbsp; ₽', time = 1792598787 } = {}) {
  return {
    id,
    type: 13,
    time,
    message: '',
    author: { id: 23848034, username: 'AkashiDevelop' },
    html: `<div class="track--item"><div class="track--item__title"><h3 class="f15">${title}</h3></div>`
      + '<div class="track-extra-table-wrapper"><table class="mt10 track-extra-table"><col width="67%"><colgroup width="5%">'
      + '<thead><tr><th>Опция</th><th>Кол-во</th><th>Срок</th><th>Стоимость</th></tr></thead>'
      + `<tbody><tr><td>Доработки</td><td>1</td><td>${days}</td><td>${price}</td></tr></tbody></table></div></div>`,
  };
}

test('опции заказа: предложены вами, ждут оплаты', () => {
  const [event] = core.parseTrackEvents([optionsTrack(439629173, 'Вы предложили опции')], 65505240);
  assert.equal(event.id, 'track:439629173');
  assert.equal(event.status, 'new');
  assert.equal(event.actor, 'me');
  assert.deepEqual(event.options, [{ name: 'Доработки', count: 1, days: 2, price: 5280 }]);
  assert.equal(event.wake, true);
  assert.match(core.describeTrackEvent(event), /Заказ №65505240: Вы предложили опции — «Доработки», вам 5\s280 ₽, \+2 дня\. Ждёт оплаты клиентом/);
});

test('опции заказа: клиент оплатил или отказался — будит агента', () => {
  const [paid, declined] = core.parseTrackEvents([
    optionsTrack(1, 'К заказу добавлены дополнительные опции', { time: 100 }),
    optionsTrack(2, 'Покупатель отказался от опций', { time: 200 }),
  ], 7);
  assert.deepEqual([paid.status, paid.actor, paid.wake], ['done', 'client', true]);
  assert.deepEqual([declined.status, declined.actor, declined.wake], ['close', 'client', true]);
});

test('трек меняет статус на месте: свежая копия заменяет сохранённую', () => {
  const [proposed] = core.parseTrackEvents([optionsTrack(5, 'Вы предложили опции')], 7);
  const [paid] = core.parseTrackEvents([optionsTrack(5, 'К заказу добавлены дополнительные опции')], 7);
  const merged = core.mergeEvents([proposed], [paid]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'done');
});

test('обычные сообщения заказа не дублируются событиями, своё начало работы молчит', () => {
  const events = core.parseTrackEvents([
    { id: 1, type: 24, time: 10, message: 'Привет', html: '' },
    { id: 2, type: 33, time: 20, message: '', html: '<h3 class="f15">В работе</h3>' },
    { id: 3, type: 16, time: 30, message: '', html: '' },
    { id: 4, type: 22, time: 40, message: 'Не нужно уже', html: '' },
  ], 9);
  assert.deepEqual(events.map((event) => [event.id, event.wake]), [
    ['track:2', false],
    ['track:3', true],
    ['track:4', true],
  ]);
  assert.equal(events[1].title, 'Покупатель принял работу');
  assert.equal(events[2].comment, 'Не нужно уже');
});

test('клиент нового заказа берётся из трека «создал заказ»', () => {
  assert.deepEqual(core.findTrackClient([{ id: 1, type: 23, author: { id: 9446206, username: 'Valeriy999' } }]), { key: 'Valeriy999', clientId: '9446206' });
  assert.equal(core.findTrackClient([{ id: 1, type: 24, author: { id: 1, username: 'x' } }]), null);
});

test('события заказа встают в переписку по времени', () => {
  const messages = [
    { id: '1', time: '2026-10-20T10:00:00.000Z', authorId: '2', authorName: 'client', text: 'Нужна доработка', attachments: [] },
    { id: '2', time: '2026-10-20T12:00:00.000Z', authorId: '1', authorName: 'me', text: 'Выставил опцию', attachments: [] },
  ];
  const [event] = core.parseTrackEvents([optionsTrack(5, 'Вы предложили опции', { time: Date.parse('2026-10-20T11:00:00.000Z') / 1000 })], 7);
  const markdown = core.renderDialogMarkdown({ key: 'client', clientId: '2', messages, events: [event] });
  const order = ['Нужна доработка', 'Вы предложили опции', 'Выставил опцию'].map((needle) => markdown.indexOf(needle));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((index) => index > 0));
});

test('список заказов Kwork: живые вкладки и клиент каждого заказа', () => {
  const parsed = core.parseManageOrders({
    success: true,
    data: {
      s: 'active',
      ordersItems: { active: { count: 1 }, delivered: { count: 1 }, completed: { count: 57 }, cancelled: { count: 1 }, all: { count: 60 }, arbitrage: { count: 0 } },
      orderListData: [
        { id: 65505240, status: 'inprogress', user: { id: '16961627', login: 'stroisnab2007', url: 'https://kwork.ru/user/stroisnab2007' } },
        { id: 65525397, status: 'check', user: { id: '9446206', url: 'https://kwork.ru/user/valeriy999' } },
        { id: 'x', user: { login: 'bad' } },
      ],
    },
  });
  assert.equal(parsed.tab, 'active');
  assert.deepEqual(parsed.tabs, ['active', 'delivered']);
  assert.deepEqual(parsed.orders, [
    { orderId: '65505240', key: 'stroisnab2007', clientId: '16961627', status: 'inprogress' },
    { orderId: '65525397', key: 'valeriy999', clientId: '9446206', status: 'check' },
  ]);
  assert.equal(core.parseManageOrders({ success: false }), null);
});

test('строка-заголовок таблицы опций в <thead> из <td> — не опция (разметка Kwork 22.10.2026)', () => {
  const html = '<h3 class="f15">Вы предложили опции</h3><table class="mt10 track-extra-table"><col width="67%"><colgroup width="5%"><thead class="fw600"><tr><td>Опция</td><td class="t-align-c nowrap">Кол-во</td><td class="t-align-c nowrap">Срок</td><td class="t-align-c nowrap"><span class="hidden-500">Стоимость</span><span class="visible-500">Цена</span></td></tr>\n</thead><tbody><tr class="option"><td><span class="extra-option tooltipster cur" data-tooltip-text="">Доработки</span></td><td class="t-align-c nowrap">1</td><td class="t-align-c nowrap">2 дня</td><td class="t-align-c nowrap" data-price="5280.00">5 280&nbsp;<span class="rouble">₽</span></td></tr></tbody></table>';
  const [event] = core.parseTrackEvents([{ id: 1, type: 13, time: 100, message: '', html }], 7);
  assert.deepEqual(event.options, [{ name: 'Доработки', count: 1, days: 2, price: 5280 }]);
});

test('запрос индивидуального заказа от клиента хранит статус Kwork', () => {
  const message = core.normalizeMessage({ MID: 409491897, MSGFROM: 1395099, mfrom: 'client', time: 1789380335, type: 'custom_request_new', typeTitle: 'Предложение индивидуального заказа', message: 'Установка капчи', data: { budget: '1000.00', duration: '172800', status: 1 } });
  assert.deepEqual([message.event.price, message.event.days, message.event.status], [1000, 2, '1']);
  assert.match(core.describeInboxEvent(message.event), /Предложение индивидуального заказа: 1\s000 ₽, 2 дня — статус Kwork 1/);
});
