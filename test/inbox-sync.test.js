const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/inbox-core.js');

function chatListPage(list) {
  return `<html><script>window.actorId="900";window.chatList=${JSON.stringify(list)};window.other=1;</script></html>`;
}

test('список диалогов читается из window.chatList страницы /inbox', () => {
  const html = chatListPage([
    { username: 'Vikka93', USERID: 24601858, time: 1791953021, MID: 439000001, MSGFROM: '24601858', unread_count: 2, message: 'текст со скобкой ] и "кавычкой"' },
    { username: 'support', USERID: 1, time: 1791953000, MID: 5, MSGFROM: 1, unread_count: 0 },
    { username: 'stroisnab2007', USERID: 16961627, time: 1791958003, MID: 439373327, MSGFROM: '900', unread_count: 0, type: 'track' },
  ]);

  assert.deepEqual(core.parseChatList(html), [
    { key: 'Vikka93', userId: '24601858', lastTime: '2026-10-14T04:43:41.000Z', lastId: '439000001', lastFromId: '24601858', unread: 2, order: false },
    { key: 'stroisnab2007', userId: '16961627', lastTime: '2026-10-14T06:06:43.000Z', lastId: '439373327', lastFromId: '900', unread: 0, order: true },
  ]);
});

test('страница без списка или с битым списком даёт пустой результат', () => {
  assert.deepEqual(core.parseChatList('<html>Вход</html>'), []);
  assert.deepEqual(core.parseChatList('<script>window.chatList=[{"username":</script>'), []);
  assert.deepEqual(core.parseChatList(null), []);
});

test('к выгрузке идут только диалоги с новым последним сообщением', () => {
  const list = [
    { key: 'Vikka93', userId: '1', lastId: '10' },
    { key: 'sobolevs', userId: '2', lastId: '20' },
    { key: 'tvoe21', userId: '3', lastId: '30' },
  ];

  const changed = core.selectChangedDialogs(list, { vikka93: '10', sobolevs: '19' });
  assert.deepEqual(changed.map((item) => item.key), ['sobolevs', 'tvoe21']);
});

test('полная история нужна новому диалогу и диалогу с разрывом', () => {
  const incoming = [
    { id: '5', time: '2026-10-14T05:00:00.000Z', text: 'a' },
    { id: '6', time: '2026-10-14T06:00:00.000Z', text: 'b' },
  ];

  assert.equal(core.needsFullHistory(null, incoming), true);
  assert.equal(core.needsFullHistory({ lastTime: '2026-10-14T05:00:00.000Z', complete: true }, incoming), false);
  assert.equal(core.needsFullHistory({ lastTime: '2026-10-14T05:30:00.000Z', complete: true }, incoming), false);
  assert.equal(core.needsFullHistory({ lastTime: '2026-10-13T05:00:00.000Z' }, incoming), true);
  assert.equal(core.needsFullHistory({ lastTime: '2026-10-13T05:00:00.000Z', complete: true }, []), false);
});

function historyMessage(id, time, from = '501') {
  return {
    MID: id,
    time,
    MSGFROM: from,
    MSGTO: from === '501' ? '900' : '501',
    mfrom: from === '501' ? 'client' : 'me',
    mto: from === '501' ? 'me' : 'client',
    message: `сообщение ${id}`,
  };
}

test('история диалога листается, пока приходят новые сообщения', async () => {
  const all = Array.from({ length: 120 }, (_, index) => historyMessage(1000 + index, 1791900000 + index * 60, index % 2 ? '900' : '501'));
  const calls = [];

  async function postForm(url, params) {
    calls.push({ url, params });
    const offset = Number(params.offset || 0);
    const limit = Number(params.limit);
    const end = all.length - offset;
    return { success: true, data: { messages: all.slice(Math.max(0, end - limit), Math.max(0, end)) } };
  }

  const result = await core.loadDialogHistory({
    postForm,
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 120);
  assert.equal(result.complete, true);
  assert.ok(result.strategy);
  assert.ok(calls.every((call) => call.url === '/inbox_more_messages'));
});

test('отменённая до старта выгрузка истории не делает запросов и неполна', async () => {
  const page = Array.from({ length: 50 }, (_, index) => historyMessage(2000 + index, 1791900000 + index));

  const result = await core.loadDialogHistory({
    postForm: async () => ({ data: { messages: page } }),
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
    isCancelled: () => true,
  });

  // Отмена до старта — ни одного запроса: после 429 соседа биржу не трогаем.
  assert.equal(result.messages.length, 0);
  assert.equal(result.complete, false);
});

test('копия без идентификатора с чужим именем автора склеивается с оригиналом', () => {
  const merged = core.mergeMessages([
    { id: null, time: '2026-10-13T17:28:36.000Z', authorId: '23848034', authorName: 'qtjrussia', recipientId: '5840', text: '7500Р за все' },
    { id: '543542767', time: '2026-10-13T17:28:36.000Z', authorId: '23848034', authorName: 'AkashiDevelop', recipientId: '5840', text: '7500Р за все' },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '543542767');
  assert.equal(merged[0].authorName, 'AkashiDevelop');
});

test('сбой запросов при листании не выдаётся за конец истории', async () => {
  const page = Array.from({ length: 50 }, (_, index) => historyMessage(3000 + index, 1791900000 + index));
  let calls = 0;

  const result = await core.loadDialogHistory({
    postForm: async () => {
      calls += 1;
      if (calls === 1) {
        return { data: { messages: page } };
      }

      throw new Error('/inbox_more_messages вернул 429');
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 50);
  assert.equal(result.complete, false);
});

test('сохранённый диалог с неподтверждённой полнотой дочитывается целиком', () => {
  const incoming = [{ id: '6', time: '2026-10-14T06:00:00.000Z', text: 'b' }];

  assert.equal(core.needsFullHistory({ lastTime: '2026-10-14T06:00:00.000Z', complete: null }, incoming), true);
  assert.equal(core.needsFullHistory({ lastTime: '2026-10-14T06:00:00.000Z', complete: true }, incoming), false);
});

test('отклики читаются со страницы «Мои предложения»', () => {
  const html = `<script>window.stateData={"user":1,"offers":[{"id":40685415,"wantId":"3266878","comment":"Сделаю &laquo;лендинг&raquo;\\r\\nза 5 дней","status":"active","order":{"price":"10000.00","duration":"432000","initialOfferPrice":"12000.00"},"want":{"name":"Лендинг [EN]"}}],"x":2};</script>`;

  assert.deepEqual(core.parseOffers(html), [{
    offerId: '40685415',
    projectId: '3266878',
    title: 'Лендинг [EN]',
    price: 10000,
    initialPrice: 12000,
    days: 5,
    status: 'active',
    text: 'Сделаю «лендинг»\nза 5 дней',
  }]);
  assert.deepEqual(core.parseOffers('<html></html>'), []);
});

function httpError(status) {
  const error = new Error(`/inbox_more_messages вернул ${status}`);
  error.status = status;
  return error;
}

function offsetServer(all, failOffsets = new Set()) {
  const calls = [];
  async function postForm(url, params) {
    calls.push(params);
    if (params.limit && Number(params.limit) > 50) {
      throw httpError(400);
    }

    const offset = Number(params.offset || 0);
    if (!('offset' in params) && Object.keys(params).some((key) => !['userId', 'allUnread', 'limit'].includes(key))) {
      throw httpError(400);
    }

    if (failOffsets.has(offset)) {
      throw httpError(429);
    }

    const end = all.length - offset;
    return { data: { messages: all.slice(Math.max(0, end - 50), Math.max(0, end)) } };
  }

  return { postForm, calls };
}

test('сбой одной страницы в пачке делает историю неполной, даже если соседние принесли новое', async () => {
  const all = Array.from({ length: 400 }, (_, index) => historyMessage(5000 + index, 1791000000 + index * 60));
  const server = offsetServer(all, new Set([150]));

  const result = await core.loadDialogHistory({ postForm: server.postForm, pause: async () => {}, dialogKey: 'client', userId: '501' });

  assert.equal(result.complete, false);
});

test('после 429 листание останавливается сразу', async () => {
  const page = Array.from({ length: 50 }, (_, index) => historyMessage(6000 + index, 1791000000 + index));
  let calls = 0;

  const result = await core.loadDialogHistory({
    postForm: async () => {
      calls += 1;
      if (calls === 1) {
        return { data: { messages: page } };
      }

      throw httpError(429);
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.complete, false);
  assert.equal(result.throttled, true);
  assert.equal(calls, 2);
});

test('потолок limit в 300 сообщений не выдаётся за конец истории', async () => {
  const all = Array.from({ length: 500 }, (_, index) => historyMessage(7000 + index, 1791000000 + index * 60));

  // Сервер понимает только limit (до 300): старше 300 последних сообщений ему не достать.
  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      if (Object.keys(params).some((key) => !['userId', 'allUnread', 'limit'].includes(key))) {
        throw httpError(400);
      }

      const limit = Math.min(Number(params.limit), 300);
      return { data: { messages: all.slice(-limit) } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 300);
  assert.equal(result.complete, false);
});

test('после потолка limit история дочитывается смещением', async () => {
  const all = Array.from({ length: 500 }, (_, index) => historyMessage(8000 + index, 1791000000 + index * 60));

  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      const offset = Number(params.offset || 0);
      if (Object.keys(params).some((key) => !['userId', 'allUnread', 'limit', 'offset'].includes(key))) {
        throw httpError(400);
      }

      const limit = Math.min(Number(params.limit), 300);
      const end = all.length - offset;
      return { data: { messages: all.slice(Math.max(0, end - limit), Math.max(0, end)) } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 500);
  assert.equal(result.complete, true);
});

test('ключ сообщения одинаков у страницы Kwork и сохранённой переписки', () => {
  const core = require('../src/inbox-core.js');

  assert.equal(core.messageKey(23848034, 1791959259), '23848034:1791959259');
  assert.equal(core.messageKey('23848034', '2026-10-14T06:27:39.000Z'), core.messageKey(23848034, 1791959259));
  assert.equal(core.messageKey(null, 1791959259), null);
  assert.deepEqual(core.savedMessageKeys([
    { authorId: '5840', time: '2026-10-13T13:19:34.000Z' },
    { authorId: '5840', time: 'не время' },
  ]), ['5840:1791897574']);
});

test('короткий ответ limit до потолка — это конец истории, а не потолок', async () => {
  const all = Array.from({ length: 250 }, (_, index) => historyMessage(8000 + index, 1791000000 + index * 60));

  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      const offset = Number(params.offset || 0);
      if (Object.keys(params).some((key) => !['userId', 'allUnread', 'limit', 'offset'].includes(key))) {
        throw httpError(400);
      }

      const limit = Math.min(Number(params.limit), 300);
      const end = all.length - offset;
      return { data: { messages: all.slice(Math.max(0, end - limit), Math.max(0, end)) } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 250);
  assert.equal(result.complete, true);
});

test('пустая служебная запись не делает полную страницу limit «короткой»', async () => {
  const all = Array.from({ length: 500 }, (_, index) => historyMessage(8000 + index, 1791000000 + index * 60));
  all[450] = { ...all[450], message: '' };

  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      const offset = Number(params.offset || 0);
      if (Object.keys(params).some((key) => !['userId', 'allUnread', 'limit', 'offset'].includes(key))) {
        throw httpError(400);
      }

      const limit = Math.min(Number(params.limit), 300);
      const end = all.length - offset;
      return { data: { messages: all.slice(Math.max(0, end - limit), Math.max(0, end)) } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 499);
  assert.equal(result.complete, true);
});

test('полный ответ limit без новых сообщений не считается концом истории', async () => {
  const unique = Array.from({ length: 100 }, (_, index) => historyMessage(8000 + index, 1791000000 + index * 60));

  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      if (Object.keys(params).some((key) => !['userId', 'allUnread', 'limit'].includes(key))) {
        throw httpError(400);
      }

      const limit = Math.min(Number(params.limit), 300);
      const padding = Array.from({ length: Math.max(0, limit - unique.length) }, () => unique[0]);
      return { data: { messages: [...padding, ...unique.slice(-limit)] } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.complete, false);
});

test('отмена посреди подбора листания останавливает запросы сразу', async () => {
  let calls = 0;
  let cancelled = false;
  const result = await core.loadDialogHistory({
    postForm: async () => {
      calls += 1;
      if (calls === 2) {
        cancelled = true;
        throw httpError(400);
      }

      return { data: { messages: [historyMessage(9000, 1791000000)] } };
    },
    pause: async () => {},
    isCancelled: () => cancelled,
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.complete, false);
  assert.equal(calls, 2);

  let early = 0;
  const skipped = await core.loadDialogHistory({ postForm: async () => { early += 1; return {}; }, isCancelled: () => true, dialogKey: 'client', userId: '501' });
  assert.equal(early, 0);
  assert.equal(skipped.complete, false);
});

test('после потолка limit история, дочитанная курсором до пустой страницы, полная', async () => {
  const all = Array.from({ length: 350 }, (_, index) => ({ ...historyMessage(8000 + index, 1791000000 + index * 60), id: 8000 + index }));

  const result = await core.loadDialogHistory({
    postForm: async (url, params) => {
      const keys = Object.keys(params).filter((key) => !['userId', 'allUnread', 'limit'].includes(key));
      if (keys.length === 0) {
        return { data: { messages: all.slice(-Math.min(Number(params.limit), 300)) } };
      }

      if (keys[0] !== 'last_id') {
        return { data: { messages: all.slice(-50) } };
      }

      const end = all.findIndex((message) => String(message.id) === params.last_id);
      return { data: { messages: all.slice(Math.max(0, end - 50), Math.max(0, end)) } };
    },
    pause: async () => {},
    dialogKey: 'client',
    userId: '501',
  });

  assert.equal(result.messages.length, 350);
  assert.equal(result.complete, true);
});

test('диалог, который читает агент, выгружается первым', () => {
  const items = [{ key: 'Other' }, { key: 'Ivan' }, { key: 'read' }];
  const { forced, rest } = core.splitForced(items, new Set(['ivan']));
  assert.deepEqual(forced.map((item) => item.key), ['Ivan']);
  assert.deepEqual(rest.map((item) => item.key), ['Other', 'read']);
});

test('отказ биржи — 429, 5xx и обрыв сети; ошибки разбора и 400 касаются одного диалога', () => {
  const refusal = (status) => Object.assign(new Error('x'), { status });
  assert.equal(core.isKworkRefusal(refusal(429)), true);
  assert.equal(core.isKworkRefusal(refusal(502)), true);
  assert.equal(core.isKworkRefusal(new TypeError('Failed to fetch')), true);
  assert.equal(core.isKworkRefusal(refusal(400)), false);
  assert.equal(core.isKworkRefusal(new SyntaxError('bad json')), false);
  assert.equal(core.isKworkRefusal(new Error('мост не сохранил переписку')), false);
});

test('живой канал Kwork: адрес берётся со страницы /inbox, чужой хост не принимается', () => {
  const page = `<script>PullModule.start({\n\t\t\t\t\thost: 'notice.kwork.ru',\n\t\t\t\t\tchannelId: 'cnl_Ab-9_x',\n\t\t\t\t\tuserId: 23848034\n\t\t\t\t});var pullModuleSettings = {\n\t\t\t\t\thost: 'notice.kwork.ru',\n\t\t\t\t\tchannelId: 'cnl_Ab-9_x',\n\t\t\t\t\tuserId: 23848034\n\t\t\t\t};</script>`;
  assert.deepEqual(core.parsePullSettings(page), { url: 'wss://notice.kwork.ru/ws/public/cnl_Ab-9_x' });
  assert.equal(core.parsePullSettings(page.replaceAll('notice.kwork.ru', 'evil.example')), null);
  assert.equal(core.parsePullSettings(page.replaceAll("'cnl_Ab-9_x'", "'cnl_/../x'")), null);
  assert.equal(core.parsePullSettings('<html>Вход</html>'), null);
});

test('кадр живого канала: событие и данные, мусор не роняет', () => {
  const frame = JSON.stringify({ id: 7, channel: 'cnl_x', text: JSON.stringify({ event: 'new_inbox', data: { from: 16961627 } }), tag: 1, time: 'x' });
  assert.deepEqual(core.parsePullFrame(frame), { event: 'new_inbox', data: { from: 16961627 } });
  assert.deepEqual(core.parsePullFrame(JSON.stringify({ text: { event: 'inbox_sent', data: {} } })), { event: 'inbox_sent', data: {} });
  // Так приходит на самом деле: text закодирован как часть адреса.
  const encoded = JSON.stringify({ id: 560, channel: 'cnl_x', text: encodeURIComponent(JSON.stringify({ event: 'new_inbox', data: { from: 3970516 } })) });
  assert.deepEqual(core.parsePullFrame(encoded), { event: 'new_inbox', data: { from: 3970516 } });
  assert.equal(core.parsePullFrame(JSON.stringify({ text: '%E0%A4%A' })), null);
  assert.equal(core.parsePullFrame('не json'), null);
  assert.equal(core.parsePullFrame(JSON.stringify({ text: 'тоже не json' })), null);
  assert.equal(core.isInboxPullEvent('new_inbox'), true);
  assert.equal(core.isInboxPullEvent('is_online'), false);
  // Сообщение внутри заказа приходит своим событием, без from (бандл order_*.js, 18.10.2026).
  assert.equal(core.isInboxPullEvent('new_order_track'), true);
});

// Непрочитанное у клиента читается через /api/inbox/getnewmessages: так сайт Kwork
// сам берёт новые сообщения, а прочитанными их отмечает отдельный запрос.
test('диалог с непрочитанным читается тихо', () => {
  assert.equal(core.isQuietRead({ key: 'a', unread: 2 }), true);
  assert.equal(core.isQuietRead({ key: 'a', unread: 0 }), false);
  assert.equal(core.isQuietRead({ key: 'a' }), false);
});

test('тихо прочитанный диалог не перечитывается, пока клиент не написал ещё или вы не прочитали', () => {
  const seen = { vikka93: core.quietSeenMark('10') };
  assert.deepEqual(core.selectChangedDialogs([{ key: 'Vikka93', lastId: '10', unread: 1 }], seen), []);
  assert.deepEqual(core.selectChangedDialogs([{ key: 'Vikka93', lastId: '11', unread: 2 }], seen).map((item) => item.key), ['Vikka93']);
  // Прочитали на Kwork — диалог дочитывается обычным путём: там и сообщения внутри заказа.
  assert.deepEqual(core.selectChangedDialogs([{ key: 'Vikka93', lastId: '10', unread: 0 }], seen).map((item) => item.key), ['Vikka93']);
});

function newMessagesPayload() {
  return {
    success: true,
    data: {
      messagesData: [
        { MID: 411553744, MSGTO: 900, MSGFROM: 16961627, message: '', time: 1792068860, type: 'offer_kwork_done', unread: 0, mto: 'AkashiDevelop', mfrom: 'stroisnab2007', files: [] },
        { MID: 411561872, MSGTO: 900, MSGFROM: 16961627, message: 'Прайс во вложении', time: 1792080137, unread: 1, mto: 'AkashiDevelop', mfrom: 'stroisnab2007', inbox_message_id: 404401397,
          files: { 403371432: { FID: 403371432, fname: 'Прайс.xlsx', size: 8599217, url: 'https://kwork.ru/files/uploaded/fc/3b/e3/7cc450d55f/price.xlsx', entity: { MID: 411561872, MSGFROM: 16961627, time: 1792080137, message: null } } } },
        { MID: 411561900, MSGTO: 16961627, MSGFROM: 900, message: 'Принял', time: 1792080200, unread: 1, mto: 'stroisnab2007', mfrom: 'AkashiDevelop', files: [] },
      ],
    },
  };
}

test('ответ getnewmessages: номер сообщения — MID, «Заказ создан» сохраняется, вложения на месте', () => {
  const parsed = core.parseNewMessages(newMessagesPayload(), { dialogKey: 'stroisnab2007', clientId: '16961627' });
  // Курсор не уходит за первое непрочитанное клиента: следующий запрос снова его вернёт
  // и снова покажет, прочитано ли оно, — иначе пустой ответ сняли бы защиту.
  assert.equal(parsed.maxMid, '411553744');
  // Непрочитанное от клиента есть — обычной выгрузкой этот диалог не трогать.
  assert.equal(parsed.clientUnread, true);
  // Служебное «Заказ создан» без текста — оплата предложения: агенту оно нужно.
  assert.deepEqual(parsed.messages.map((message) => [message.id, message.authorId, message.text]), [
    ['411553744', '16961627', 'Заказ создан'],
    ['411561872', '16961627', 'Прайс во вложении'],
    ['411561900', '900', 'Принял'],
  ]);
  assert.equal(parsed.messages[1].attachments[0].url, 'https://kwork.ru/files/uploaded/fc/3b/e3/7cc450d55f/price.xlsx');
  assert.equal(core.parseNewMessages({ success: false }, { dialogKey: 'x' }), null);
  assert.equal(core.parseNewMessages({ success: true, data: {} }, { dialogKey: 'x' }), null);
});

test('тихая копия и копия из обычной выгрузки склеиваются, номер тихой остаётся', () => {
  const quiet = core.parseNewMessages(newMessagesPayload(), { dialogKey: 'stroisnab2007', clientId: '16961627' }).messages;
  const full = core.collectMessages({ data: { messages: [
    { id: 543639600, MID: 411561872, MSGFROM: 16961627, MSGTO: 900, mfrom: 'stroisnab2007', mto: 'AkashiDevelop', time: 1792080137, message: 'Прайс во вложении', source_type: 9 },
    { id: 543639700, MID: 411561900, MSGFROM: 900, MSGTO: 16961627, mfrom: 'AkashiDevelop', mto: 'stroisnab2007', time: 1792080200, message: 'Принял', source_type: 9 },
  ] } });
  const merged = core.mergeMessages(quiet, full);
  assert.deepEqual(merged.map((message) => message.id), ['411553744', '411561872', '411561900']);
  assert.equal(merged[1].attachments.length, 1);
});

test('непрочитанное считается только от клиента', () => {
  const payload = newMessagesPayload();
  payload.data.messagesData[1].unread = 0;
  const parsed = core.parseNewMessages(payload, { dialogKey: 'stroisnab2007', clientId: '16961627' });
  assert.equal(parsed.clientUnread, false);
  assert.equal(parsed.maxMid, '411561900');
});

test('непрочитанное клиента первым в ответе — курсор не двигается', () => {
  const payload = newMessagesPayload();
  payload.data.messagesData.shift();
  const parsed = core.parseNewMessages(payload, { dialogKey: 'stroisnab2007', clientId: '16961627' });
  assert.equal(parsed.clientUnread, true);
  assert.equal(parsed.maxMid, null);
});
