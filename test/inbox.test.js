const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../src/inbox-core.js');

test('страница переписки распознаётся по адресу', () => {
  assert.equal(core.isInboxPage('https://kwork.ru/inbox'), true);
  assert.equal(core.isInboxPage('https://kwork.ru/inbox/client_name'), true);
  assert.equal(core.isInboxPage('https://www.kwork.ru/new_inbox/client_name'), true);
  assert.equal(core.isInboxPage('https://kwork.ru/projects'), false);
  assert.equal(core.isInboxPage('https://example.com/inbox'), false);
});

test('ключ диалога берётся из адреса переписки', () => {
  assert.equal(core.extractDialogKey('https://kwork.ru/inbox/ivan_petrov'), 'ivan_petrov');
  assert.equal(core.extractDialogKey('https://kwork.ru/inbox/ivan_petrov?page=2'), 'ivan_petrov');
  assert.equal(core.extractDialogKey('https://kwork.ru/inbox?user=ivan_petrov'), 'ivan_petrov');
  assert.equal(core.extractDialogKey('https://kwork.ru/inbox'), null);
  assert.equal(core.extractDialogKey('https://kwork.ru/projects/123'), null);
});

test('вложения читаются и из списка filesArray, и из словаря files', () => {
  const [message] = core.collectMessages({
    data: {
      messages: [{
        id: '1',
        time: 1785917699,
        MSGFROM: '501',
        message: 'Скриншоты',
        files: {
          397034317: { FID: 397034317, fname: 'image.png', size: 735709, url: 'https://kwork.ru/files/uploaded/20/dd/58/x/image.png' },
          397034353: { FID: 397034353, fname: 'схема.png', size: 211168, url: 'https://kwork.ru/files/uploaded/21/bb/65/y/image.png' },
        },
        filesArray: [
          { id: 397034317, name: 'image.png', size: 735709, path: 'https://kwork.ru/files/uploaded/20/dd/58/x/image.png', miniature: { url: 'https://kwork.ru/files/uploaded/mini/image.png?ver=1' } },
        ],
        fileContainer: { file_path: '/files/uploaded/zip/t/1/archive.zip', fname: 'archive.zip' },
      }],
    },
  });

  assert.equal(message.attachments.length, 2);
  assert.deepEqual(message.attachments.map((item) => item.name), ['image.png', 'схема.png']);
  assert.equal(message.attachments[0].size, 735709);
  assert.equal(message.attachments[0].id, '397034317');
});

test('имя вложения берётся из адреса, когда поля имени нет', () => {
  const [message] = core.collectMessages({
    messages: [{
      id: '2',
      time: 1785917699,
      MSGFROM: '501',
      message: 'Документ',
      attachments: ['https://kwork.ru/files/uploaded/f4/98/%D0%B0%D1%83%D0%B4%D0%B8%D1%82.docx?ver=17'],
    }],
  });

  assert.equal(message.attachments[0].name, 'аудит.docx');
});

test('имя файла начинается с даты и времени сообщения по Москве', () => {
  const files = core.resolveAttachmentFiles([
    { id: '1', time: '2026-08-05T08:26:50.000Z', attachments: [{ name: 'image.png', url: 'https://kwork.ru/a/image.png', size: 10 }] },
    { id: '2', time: '2026-08-06T21:05:00.000Z', attachments: [{ name: '1778937291207.mp3', url: 'https://kwork.ru/b/x.mp3', size: 20 }] },
  ]);

  assert.deepEqual(files.map((item) => item.file), [
    '2026-08-05 11-26-50 image.png',
    '2026-08-07 00-05-00 1778937291207.mp3',
  ]);
});

test('тёзки в одном сообщении разводятся номером, а повтор адреса не плодит копий', () => {
  const files = core.resolveAttachmentFiles([
    {
      id: '1',
      time: '2026-08-05T08:26:50.000Z',
      attachments: [
        { name: 'image.png', url: 'https://kwork.ru/a/image.png', size: 10 },
        { name: 'image.png', url: 'https://kwork.ru/b/image.png', size: 20 },
      ],
    },
    { id: '2', time: '2026-08-05T09:00:00.000Z', attachments: [{ name: 'image.png', url: 'https://kwork.ru/a/image.png', size: 10 }] },
  ]);

  assert.deepEqual(files.map((item) => item.file), [
    '2026-08-05 11-26-50 image.png',
    '2026-08-05 11-26-50 image (2).png',
  ]);
  assert.equal(files[1].messageId, '1');
});

test('сообщение без даты сохраняет вложение под своим именем', () => {
  const files = core.resolveAttachmentFiles([
    { id: '1', time: null, attachments: [{ name: 'смета.pdf', url: 'https://kwork.ru/a/смета.pdf', size: 10 }] },
  ]);

  assert.deepEqual(files.map((item) => item.file), ['смета.pdf']);
});

test('сообщение соседнего диалога не попадает в переписку по идентификатору из того же ответа', () => {
  const foreign = {
    id: '9',
    authorId: '777',
    authorName: 'maria',
    recipientId: '888',
    recipientName: 'AkashiDevelop',
    text: 'Чужое сообщение',
    attachments: [],
  };

  assert.equal(core.belongsToDialog(foreign, { dialogKey: 'ivan_petrov', clientId: '777' }), false);
  assert.equal(core.belongsToDialog(foreign, { dialogKey: 'maria', clientId: '777' }), true);
  assert.equal(
    core.belongsToDialog({ id: '10', authorId: '777', text: 'Без имён', attachments: [] }, { dialogKey: 'ivan_petrov', clientId: '777' }),
    true,
  );
});

test('имя вложения не уводит запись за пределы папки', () => {
  assert.equal(core.sanitizeFileName('../../secrets.txt'), '_.._secrets.txt');
  assert.equal(core.sanitizeFileName('C:\\Windows\\system.ini'), 'C__Windows_system.ini');
  assert.equal(core.sanitizeFileName('  '), null);
});

test('в markdown вложения ведут на скачанные файлы', () => {
  const markdown = core.renderDialogMarkdown({
    key: 'ivan',
    title: 'ivan',
    clientId: '501',
    updatedAt: '2026-08-06T09:00:00.000Z',
    messages: [{
      id: '1',
      time: '2026-08-06T08:00:00.000Z',
      authorId: '501',
      authorName: 'ivan',
      text: 'Смотрите макет',
      attachments: [{ id: '7', name: 'макет 1.png', url: 'https://kwork.ru/a/image.png', size: 10 }],
    }],
  });

  assert.match(markdown, /- Файлов: 1 \(папка «файлы»\)/);
  assert.match(markdown, /- \[макет 1\.png\]\(файлы\/2026-08-06%2011-00-00%20%D0%BC%D0%B0%D0%BA%D0%B5%D1%82%201\.png\)/);
});

test('диалоги биржи отличаются от переписок с клиентами', () => {
  assert.equal(core.isServiceDialogKey('Support'), true);
  assert.equal(core.isServiceDialogKey('support'), true);
  assert.equal(core.isServiceDialogKey('kwork'), true);
  assert.equal(core.isServiceDialogKey('supportnn'), false);
  assert.equal(core.isServiceDialogKey('ivan_petrov'), false);
  assert.equal(core.isServiceDialogKey(''), false);
  assert.equal(core.isServiceDialogKey(null), false);
});

test('имя файла переписки не содержит опасных символов', () => {
  assert.equal(core.buildDialogSlug('Ivan Petrov'), 'ivan-petrov');
  assert.equal(core.buildDialogSlug('../../etc/passwd'), 'etc-passwd');
  assert.equal(core.buildDialogSlug('  '), null);
});

test('время приводится к ISO из секунд, миллисекунд и строки', () => {
  assert.equal(core.normalizeTime(1753000000), '2025-07-20T08:26:40.000Z');
  assert.equal(core.normalizeTime(1753000000000), '2025-07-20T08:26:40.000Z');
  assert.equal(core.normalizeTime('2026-07-26T10:00:00Z'), '2026-07-26T10:00:00.000Z');
  assert.equal(core.normalizeTime(''), null);
});

test('html сообщения превращается в читаемый текст', () => {
  const html = '<p>Здравствуйте!<br>Нужен <b>лендинг</b> &laquo;под ключ&raquo;</p><p>Бюджет 30&nbsp;000</p>';

  assert.equal(
    core.htmlToText(html),
    'Здравствуйте!\nНужен лендинг «под ключ»\n\nБюджет 30 000',
  );
});

test('сообщения находятся в произвольной обёртке ответа', () => {
  const payload = {
    success: true,
    data: {
      pagination: {
        data: [
          { message_id: 12, from_id: 501, message: 'Привет', time: 1753000000 },
          { message_id: 13, from_id: 777, message: 'Здравствуйте', time: 1753000060 },
        ],
      },
      user: { id: 777, username: 'ivan_petrov' },
    },
  };

  const messages = core.collectMessages(payload);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    id: '12',
    time: '2025-07-20T08:26:40.000Z',
    authorId: '501',
    authorName: null,
    recipientId: null,
    recipientName: null,
    text: 'Привет',
    attachments: [],
    replyTo: null,
  });
});

test('ответ на сообщение разбирается из цитаты нового формата', () => {
  const payload = {
    messages: [
      {
        id: 535722713,
        MSGFROM: 23848034,
        time: 1785938396,
        message: 'Шесть комплектов опубликованы',
        quote: {
          reply_conversation_id: 535705352,
          MSGFROM: '6371073',
          time: 1785919166,
          message: '17450 все комплекты стоимость',
          author: { USERID: 6371073, username: 'Hr_pro' },
          files: [],
          isQuote: false,
        },
      },
    ],
  };

  const [message] = core.collectMessages(payload);

  assert.deepEqual(message.replyTo, {
    id: '535705352',
    time: '2026-08-05T08:39:26.000Z',
    authorId: '6371073',
    authorName: 'Hr_pro',
    text: '17450 все комплекты стоимость',
    kind: 'reply',
  });
});

test('цитата старого формата берёт идентификатор из id или conversation', () => {
  const [withId, withConversation] = core.collectMessages({
    messages: [
      {
        id: 535244184,
        MSGFROM: 23848034,
        time: 1785572100,
        message: 'Да, растягивать не надо',
        quote: {
          id: 535243917,
          MSGFROM: 5053,
          time: 1785572025,
          message: 'Форма сама не растягивалась?',
          author: { USERID: 5053, username: 'gustav' },
        },
      },
      {
        id: 535244740,
        MSGFROM: 23848034,
        time: 1785572400,
        message: 'админка',
        quote: {
          MSGFROM: 5053,
          time: 1785572333,
          message: 'доступы',
          author: { USERID: 5053, username: 'gustav' },
          conversation: { id: 535244437, user_from_id: 5053 },
        },
      },
    ],
  });

  assert.equal(withId.replyTo.id, '535243917');
  assert.equal(withConversation.replyTo.id, '535244437');
});

test('пустая цитата не считается ответом', () => {
  const [message] = core.collectMessages({
    messages: [
      { id: 1, MSGFROM: 501, time: 1753000000, message: 'Обычное сообщение', quote: {} },
    ],
  });

  assert.equal(message.replyTo, null);
});

test('склейка не теряет ответ, когда старая запись сохранена без него', () => {
  const saved = [
    { id: '2', time: '2026-07-01T11:00:00.000Z', authorId: '777', authorName: null, text: 'удалил', attachments: [] },
  ];
  const incoming = [
    {
      id: '2',
      time: '2026-07-01T11:00:00.000Z',
      authorId: '777',
      authorName: null,
      text: 'удалил',
      attachments: [],
      replyTo: { id: '1', time: '2026-07-01T10:00:00.000Z', authorId: '501', authorName: 'sobolevs', text: 'Удалите пжс клон' },
    },
  ];

  assert.equal(core.mergeMessages(saved, incoming)[0].replyTo.id, '1');
  assert.equal(core.mergeMessages(incoming, saved)[0].replyTo.id, '1');
});

test('markdown показывает, на какое сообщение нажат ответ', () => {
  const markdown = core.renderDialogMarkdown({
    key: 'sobolevs',
    title: 'sobolevs',
    clientId: '3970516',
    messages: [
      {
        id: '1',
        time: '2026-08-13T10:00:00.000Z',
        authorId: '3970516',
        authorName: 'sobolevs',
        text: 'Удалите пжс клон\n# и проверьте сайт',
        attachments: [],
        replyTo: null,
      },
      {
        id: '2',
        time: '2026-08-13T10:05:00.000Z',
        authorId: '23848034',
        authorName: 'AkashiDevelop',
        text: 'удалил',
        attachments: [],
        replyTo: {
          id: '1',
          time: '2026-08-13T10:00:00.000Z',
          authorId: '3970516',
          authorName: 'sobolevs',
          text: 'Удалите пжс клон\n# и проверьте сайт',
        },
      },
    ],
  });

  assert.match(markdown, /## sobolevs — 13\.08\.2026, 13:00 МСК/);
  assert.match(
    markdown,
    /## Я — [^\n]+\n\n> В ответ на сообщение «sobolevs — 13\.08\.2026, 13:00 МСК»:\n> Удалите пжс клон\n> \\# и проверьте сайт\n\nудалил/,
  );
});

test('профили и служебные объекты не принимаются за сообщения', () => {
  const payload = {
    user: { id: 777, username: 'ivan_petrov', name: 'Иван' },
    counters: { unread: 3 },
    settings: { theme: 'dark' },
  };

  assert.deepEqual(core.collectMessages(payload), []);
});

test('вложения собираются вместе с текстом', () => {
  const payload = {
    messages: [
      {
        id: 5,
        from_id: 501,
        time: 1753000000,
        message: 'Файлы во вложении',
        attachments: [
          { name: 'tz.pdf', url: 'https://kwork.ru/files/tz.pdf', size: '2048' },
          'https://kwork.ru/files/screen.png',
        ],
      },
    ],
  };

  const [message] = core.collectMessages(payload);

  assert.deepEqual(message.attachments, [
    { id: null, name: 'tz.pdf', url: 'https://kwork.ru/files/tz.pdf', size: 2048 },
    { id: null, name: 'screen.png', url: 'https://kwork.ru/files/screen.png', size: null },
  ]);
});

test('сообщение без текста, но с вложением сохраняется', () => {
  const payload = {
    messages: [
      { id: 6, from_id: 501, time: 1753000000, message: '', files: [{ name: 'макет.psd', url: 'https://kwork.ru/f/1' }] },
    ],
  };

  const messages = core.collectMessages(payload);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachments[0].name, 'макет.psd');
});

test('страницы истории склеиваются без дублей и по времени', () => {
  const older = [
    { id: '1', time: '2026-07-01T10:00:00.000Z', authorId: '501', authorName: null, text: 'Первое', attachments: [] },
    { id: '2', time: '2026-07-01T11:00:00.000Z', authorId: '777', authorName: null, text: 'Второе', attachments: [] },
  ];
  const newer = [
    { id: '2', time: '2026-07-01T11:00:00.000Z', authorId: '777', authorName: null, text: 'Второе', attachments: [] },
    { id: '3', time: '2026-07-01T12:00:00.000Z', authorId: '501', authorName: null, text: 'Третье', attachments: [] },
  ];

  const merged = core.mergeMessages(newer, older);

  assert.deepEqual(merged.map((message) => message.text), ['Первое', 'Второе', 'Третье']);
});

test('склейка не теряет вложения из более полной копии сообщения', () => {
  const withoutFiles = [{ id: '9', time: '2026-07-01T10:00:00.000Z', authorId: '501', text: 'Смотрите', attachments: [] }];
  const withFiles = [{
    id: '9',
    time: '2026-07-01T10:00:00.000Z',
    authorId: '501',
    text: 'Смотрите',
    attachments: [{ name: 'tz.pdf', url: 'https://kwork.ru/f/2', size: null }],
  }];

  const merged = core.mergeMessages(withFiles, withoutFiles);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].attachments.length, 1);
});

test('ключи диалогов вытаскиваются из списка переписок', () => {
  const payload = {
    data: [
      { username: 'ivan_petrov', last_message: 'Привет', time: 1753000000, unread: 1 },
      { username: 'maria', last_message: 'Спасибо', time: 1753000600, unread: 0 },
      { id: 3, title: 'Не диалог' },
    ],
  };

  assert.deepEqual(core.findDialogKeys(payload), ['ivan_petrov', 'maria']);
});

test('реальный ответ Kwork разбирается вместе с автором и цитатой', () => {
  const payload = {
    success: true,
    data: {
      messages: [
        {
          id: 535622139,
          MID: 433430595,
          MSGFROM: 23848034,
          MSGTO: 3970516,
          mfrom: 'AkashiDevelop',
          mto: 'sobolevs',
          time: 1785938396,
          message: 'Здравствуйте!<br>Готов взяться',
          author: { USERID: 23848034, username: 'AkashiDevelop' },
          recipient: { USERID: 3970516, username: 'sobolevs' },
          quote: {},
          voiceMessage: {},
        },
      ],
      params: {
        conversationUserId: 3970516,
        u: { username: 'sobolevs', fullname: '' },
      },
    },
  };

  const [message] = core.collectMessages(payload);

  assert.equal(message.authorId, '23848034');
  assert.equal(message.authorName, 'AkashiDevelop');
  assert.equal(message.text, 'Здравствуйте!\nГотов взяться');
  assert.equal(core.findParticipantId(payload, 'sobolevs'), '3970516');
});

test('вложенный объект автора не подставляется вместо имени', () => {
  const [message] = core.collectMessages({
    messages: [{ id: 1, time: 1753000000, message: 'Текст', author: { username: 'ivan' } }],
  });

  assert.equal(message.authorName, null);
});

test('роль определяется по нику отправителя, когда идентификаторы неизвестны', () => {
  const markdown = core.renderDialogMarkdown({
    key: 'sobolevs',
    title: 'sobolevs',
    messages: [
      { id: '1', time: '2026-08-04T13:59:56.000Z', authorId: null, authorName: 'sobolevs', text: 'Нужна доработка', attachments: [] },
      { id: '2', time: '2026-08-04T14:10:00.000Z', authorId: null, authorName: 'AkashiDevelop', text: 'Принял', attachments: [] },
    ],
  });

  assert.match(markdown, /## sobolevs — [^\n]+\n\nНужна доработка/);
  assert.match(markdown, /## Я — [^\n]+\n\nПринял/);
});

test('идентификатор клиента определяется по нику диалога', () => {
  const payload = {
    data: {
      user: { id: 501, username: 'ivan_petrov', name: 'Иван' },
      messages: [{ message_id: 1, from_id: 501, message: 'Привет', time: 1753000000 }],
    },
  };

  assert.equal(core.findParticipantId(payload, 'ivan_petrov'), '501');
  assert.equal(core.findParticipantId(payload, 'maria'), null);
  assert.equal(core.findParticipantId(payload, ''), null);
});

test('мои сообщения подписаны «Я», когда клиент известен', () => {
  const markdown = core.renderDialogMarkdown({
    key: 'ivan_petrov',
    title: 'Иван Петров',
    clientId: '501',
    messages: [
      { id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', text: 'Нужен лендинг', attachments: [] },
      { id: '2', time: '2026-07-26T08:00:00.000Z', authorId: '777', text: 'Готов взяться', attachments: [] },
    ],
  });

  assert.match(markdown, /## Иван Петров — [^\n]+\n\nНужен лендинг/);
  assert.match(markdown, /## Я — [^\n]+\n\nГотов взяться/);
});

test('переписка рендерится в markdown с ролями и вложениями', () => {
  const dialog = {
    key: 'ivan_petrov',
    title: 'Иван Петров',
    ownerId: '777',
    url: 'https://kwork.ru/inbox/ivan_petrov',
    updatedAt: '2026-07-26T09:00:00.000Z',
    messages: [
      { id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'Иван', text: 'Нужен лендинг', attachments: [] },
      {
        id: '2',
        time: '2026-07-26T08:00:00.000Z',
        authorId: '777',
        authorName: null,
        text: 'Готов взяться',
        attachments: [{ name: 'смета.pdf', url: 'https://kwork.ru/f/3', size: null }],
      },
    ],
  };

  const markdown = core.renderDialogMarkdown(dialog);

  assert.match(markdown, /^# Переписка с Иван Петров/);
  assert.match(markdown, /- Сообщений: 2/);
  assert.match(markdown, /## Иван Петров — 26\.07\.2026, 10:00 МСК/);
  assert.match(markdown, /## Я — 26\.07\.2026, 11:00 МСК/);
  assert.match(markdown, /- \[смета\.pdf\]\(файлы\/2026-07-26%2011-00-00%20%D1%81%D0%BC%D0%B5%D1%82%D0%B0\.pdf\)/);
});

test('подбор листания истории начинается с увеличенного лимита', () => {
  const probes = core.buildHistoryProbes(
    [['userId', '3970516'], ['allUnread', 'true'], ['limit', '50']],
    { loaded: 50, oldestId: '535622139' },
  );

  assert.equal(probes[0].strategy, 'limit');
  assert.equal(probes[0].params.limit, '150');
  assert.equal(probes[0].params.userId, '3970516');

  const strategies = probes.map((probe) => probe.strategy);

  assert.ok(strategies.includes('offset'));
  assert.ok(strategies.includes('page'));
  assert.ok(strategies.includes('lastMessageId'));

  const offset = probes.find((probe) => probe.strategy === 'offset');
  const page = probes.find((probe) => probe.strategy === 'page');
  const cursor = probes.find((probe) => probe.strategy === 'lastMessageId');

  assert.equal(offset.params.offset, '50');
  assert.equal(page.params.page, '2');
  assert.equal(cursor.params.lastMessageId, '535622139');
});

test('курсорные пробы не строятся без известного старого сообщения', () => {
  const probes = core.buildHistoryProbes({ userId: '1', limit: '50' }, { loaded: 50 });

  assert.equal(probes.some((probe) => probe.strategy === 'lastMessageId'), false);
});

test('сработавшая стратегия воспроизводится по имени', () => {
  const request = core.buildHistoryRequest({ userId: '1', limit: '50' }, 'offset', { loaded: 100 });

  assert.equal(request.params.offset, '100');
});

test('новые сообщения считаются без учёта уже известных', () => {
  const known = [{ id: '1', time: '2026-07-01T10:00:00.000Z', text: 'Первое', attachments: [] }];
  const incoming = [
    { id: '1', time: '2026-07-01T10:00:00.000Z', text: 'Первое', attachments: [] },
    { id: '0', time: '2026-06-30T10:00:00.000Z', text: 'Старое', attachments: [] },
  ];

  assert.equal(core.countNewMessages(known, incoming), 1);
  assert.equal(core.countNewMessages(known, known), 0);
  assert.equal(core.getOldestMessage(incoming).id, '0');
});

test('идентификатор клиента читается со страницы профиля', () => {
  const markup = '{"isSameUser":false,"userProfileId":3970516,"userProfileName":"sobolevs","userProfileFullName":""}';

  assert.equal(core.extractProfileUserId(markup, 'sobolevs'), '3970516');
  assert.equal(core.extractProfileUserId(markup, 'SOBOLEVS'), '3970516');
  assert.equal(core.extractProfileUserId('нет данных', 'sobolevs'), null);
});

test('чужой профиль в разметке не выдаётся за нужного клиента', () => {
  const markup = '"userProfileId":111,"userProfileName":"other","userProfileId":222,"userProfileName":"target"';

  assert.equal(core.extractProfileUserId(markup, 'target'), '222');
});

test('пачками листаются только смещения, курсоры остаются последовательными', () => {
  assert.equal(core.isParallelStrategy('offset'), true);
  assert.equal(core.isParallelStrategy('page'), true);
  assert.equal(core.isParallelStrategy('lastMessageId'), false);
  assert.equal(core.isParallelStrategy('limit'), false);
  assert.equal(core.isParallelStrategy(null), false);
});

test('в диалог попадают только сообщения между его участниками', () => {
  const context = { dialogKey: 'sobolevs', clientId: '3970516' };

  assert.equal(core.belongsToDialog({ authorName: 'sobolevs', recipientName: 'AkashiDevelop' }, context), true);
  assert.equal(core.belongsToDialog({ authorName: 'AkashiDevelop', recipientName: 'sobolevs' }, context), true);
  assert.equal(core.belongsToDialog({ authorId: '23848034', recipientId: '3970516' }, context), true);
  assert.equal(core.belongsToDialog({ authorName: 'AkashiDevelop', recipientName: 'hod-2023' }, context), false);
  assert.equal(core.belongsToDialog({ authorName: 'club2525', recipientName: 'AkashiDevelop' }, context), false);
});

test('сводная лента биржи очищается до одной переписки', () => {
  const messages = [
    { id: '1', authorName: 'sobolevs', recipientName: 'AkashiDevelop', text: 'Своё', attachments: [] },
    { id: '2', authorName: 'AkashiDevelop', recipientName: 'club2525', text: 'Чужое', attachments: [] },
    { id: '3', authorName: 'dv72', recipientName: 'AkashiDevelop', text: 'Тоже чужое', attachments: [] },
    { id: '4', authorName: 'AkashiDevelop', recipientName: 'sobolevs', text: 'Ответ', attachments: [] },
  ];

  const filtered = core.filterDialogMessages(messages, { dialogKey: 'sobolevs', clientId: '3970516' });

  assert.deepEqual(filtered.map((message) => message.text), ['Своё', 'Ответ']);
});

test('рост лимита истории ограничен, чтобы биржа не отдавала общую ленту', () => {
  const probe = core.buildHistoryProbes({ userId: '1', limit: '50' }, { loaded: 5000 })[0];

  assert.equal(probe.strategy, 'limit');
  assert.equal(Number(probe.params.limit) <= 300, true);
});

test('одно сообщение не хранится дважды: с идентификатором и без', () => {
  const withId = [{ id: '535', time: '2026-07-03T04:16:11.000Z', authorName: 'sobolevs', text: 'Добрый день', attachments: [] }];
  const withoutId = [{ id: null, time: '2026-07-03T04:16:11.000Z', authorName: 'sobolevs', text: 'Добрый день', attachments: [] }];

  const merged = core.mergeMessages(withoutId, withId);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '535');
});

test('разные сообщения с одинаковым временем не схлопываются', () => {
  const messages = [
    { id: null, time: '2026-07-03T04:16:11.000Z', authorName: 'sobolevs', text: 'Первое', attachments: [] },
    { id: null, time: '2026-07-03T04:16:11.000Z', authorName: 'sobolevs', text: 'Второе', attachments: [] },
  ];

  assert.equal(core.mergeMessages(messages).length, 2);
});

test('собственный ник определяется по второму участнику переписки', () => {
  const messages = [{ authorName: 'sobolevs', recipientName: 'AkashiDevelop', text: 'Привет', attachments: [] }];

  assert.equal(core.findOwnerName(messages, 'sobolevs'), 'AkashiDevelop');
  assert.equal(core.findOwnerName([], 'sobolevs'), null);
});

test('решётка в тексте сообщения не превращается в заголовок', () => {
  const markdown = core.renderDialogMarkdown({
    key: 'client',
    title: 'client',
    messages: [{ id: '1', time: '2026-07-03T04:16:11.000Z', authorName: 'client', text: '## Важно\nи ещё', attachments: [] }],
  });

  assert.equal((markdown.match(/^## /gm) || []).length, 1);
  assert.match(markdown, /\## Важно/);
});
