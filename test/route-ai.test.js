process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const routeAi = require('../native_host/route-ai.js');

const at = (minute) => new Date(Date.UTC(2026, 10, 16, 9, minute)).toISOString();
const record = {
  key: 'ivan',
  clientId: '501',
  messages: [
    { id: '1', time: at(0), authorId: '501', text: 'по парковке: шлагбаум' },
    { id: '2', time: at(1), authorId: '900', recipientId: '501', text: 'посмотрю' },
    { id: '3', time: at(5), authorId: '501', text: 'а по ломбарду когда?', replyTo: { kind: 'quote', text: 'отчёт по займам' } },
  ],
};
const news = { messages: [record.messages[2]], events: [{ time: at(4), orderId: 77, title: 'CRM ломбарда' }] };

function ordersIn(home) {
  const lombard = path.join(home, 'lombard');
  const park = path.join(home, 'park');
  fs.mkdirSync(lombard);
  fs.mkdirSync(park);
  fs.writeFileSync(path.join(lombard, 'CLAUDE.md'), '@AGENTS.md\n');
  fs.writeFileSync(path.join(lombard, 'AGENTS.md'), '# CRM ломбарда\nзаймы и залоги');
  fs.writeFileSync(path.join(lombard, 'STATE.md'), 'сейчас: отчёт по займам');
  fs.writeFileSync(path.join(park, 'README.md'), '# Парковка\nшлагбаум и тарифы');
  return [{ name: 'lombard', dir: lombard }, { name: 'park', dir: park }];
}

test('запрос: заказы с описанием из папки, ранняя переписка отдельно от новых сообщений, ответ — только из списка заказов', () => {
  const orders = ordersIn(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-route-')));
  const body = routeAi.buildRouteRequest({ orders, record, news, last: orders[1] });
  const text = body.messages[0].content;
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.deepEqual(body.output_config.format.schema.properties.order.enum, ['lombard', 'park', 'неясно']);
  assert.match(text, /<order name="lombard">\n# CRM ломбарда\nзаймы и залоги\n…\nсейчас: отчёт по займам\n<\/order>/);
  assert.doesNotMatch(text, /@AGENTS/);
  assert.match(text, /<order name="park">\n# Парковка/);
  assert.match(text, /Прошлая побудка этого клиента разобрана в заказе park\./);
  const [early, fresh] = text.split('Новые сообщения');
  assert.match(early, /Клиент: по парковке: шлагбаум\n\[16\.11 12:01\] Вы: посмотрю/);
  assert.doesNotMatch(early, /по ломбарду/);
  // Событие раньше сообщения — и в тексте раньше; цитата видна.
  assert.match(fresh, /Событие: Заказ №77: CRM ломбарда\n\[16\.11 12:05\] Клиент: а по ломбарду когда\? \(в ответ на: «отчёт по займам»\)/);
});

test('ответ модели: заказ из списка; «неясно» и обрыв — без заказа; ошибка API — исключение с причиной', async () => {
  const orders = [{ name: 'lombard', dir: '/l', brief: '' }, { name: 'park', dir: '/p', brief: '' }];
  const reply = (status, data) => async (url, init) => {
    reply.last = { url, init };
    return { ok: status === 200, status, json: async () => data };
  };
  const answer = (order, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ order, why: 'про займы' }) }] });

  const got = await routeAi.classifyRoute({ apiKey: 'sk-test', orders, record, news, fetchImpl: reply(200, answer('lombard')) });
  assert.deepEqual(got, { order: orders[0], why: 'про займы' });
  assert.equal(reply.last.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(reply.last.init.headers['x-api-key'], 'sk-test');
  assert.equal(JSON.parse(reply.last.init.body).fallbacks, 'default');

  assert.equal((await routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: reply(200, answer('неясно')) })).order, null);
  assert.deepEqual(await routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: reply(200, answer('lombard', 'refusal')) }), { order: null, why: 'ответ оборван (refusal)' });
  await assert.rejects(
    routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: reply(401, { error: { message: 'invalid x-api-key' } }) }),
    /API 401: invalid x-api-key/,
  );
});

test('перегрузка API или обрыв сети — ещё одна попытка; ключ или баланс (4xx) — сразу ошибка с кодом', async () => {
  const orders = [{ name: 'lombard', dir: '/l', brief: '' }, { name: 'park', dir: '/p', brief: '' }];
  const ok = { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"order":"park","why":"шлагбаум"}' }] }) };
  const replies = (...queue) => {
    const fetchImpl = async () => {
      fetchImpl.calls += 1;
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    fetchImpl.calls = 0;
    return fetchImpl;
  };
  const fail = (status) => ({ ok: false, status, json: async () => ({ error: { message: status === 400 ? 'credit balance is too low' : 'Overloaded' } }) });
  const pauses = [];
  const pause = async (ms) => { pauses.push(ms); };

  const overloaded = replies(fail(529), ok);
  assert.equal((await routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: overloaded, pause })).order, orders[1]);
  assert.deepEqual([overloaded.calls, pauses.length], [2, 1]);
  const offline = replies(new TypeError('fetch failed'), ok);
  assert.equal((await routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: offline, pause })).order, orders[1]);
  const twice = replies(fail(529), fail(503));
  await assert.rejects(routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: twice, pause }), (error) => error.status === 503);
  const broke = replies(fail(400), ok);
  await assert.rejects(routeAi.classifyRoute({ apiKey: 'k', orders, record, news, fetchImpl: broke, pause }), (error) => error.status === 400 && /credit balance/.test(error.message));
  assert.equal(broke.calls, 1);
});
