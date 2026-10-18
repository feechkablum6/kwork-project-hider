const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodeFrame, decodeFrames } = require('../native_host/frames.js');
const { handleCommand } = require('../native_host/store.js');

function createTargetDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kph-inbox-'));
}

function buildDialog(messages, extra = {}) {
  return {
    key: 'ivan_petrov',
    title: 'Иван Петров',
    url: 'https://kwork.ru/inbox/ivan_petrov',
    updatedAt: '2026-07-26T09:00:00.000Z',
    messages,
    ...extra,
  };
}

test('кадр протокола собирается и разбирается обратно', () => {
  const frame = encodeFrame({ command: 'save-dialog', dialog: { key: 'ivan' } });
  const { messages, rest } = decodeFrames(frame);

  assert.deepEqual(messages, [{ command: 'save-dialog', dialog: { key: 'ivan' } }]);
  assert.equal(rest.length, 0);
});

test('неполный кадр дожидается остатка данных', () => {
  const frame = encodeFrame({ command: 'known-dialogs', dialogKeys: ['ivan'] });
  const head = decodeFrames(frame.subarray(0, 6));

  assert.deepEqual(head.messages, []);

  const full = decodeFrames(Buffer.concat([head.rest, frame.subarray(6)]));

  assert.deepEqual(full.messages, [{ command: 'known-dialogs', dialogKeys: ['ivan'] }]);
});

test('несколько кадров в одном потоке разбираются по очереди', () => {
  const stream = Buffer.concat([encodeFrame({ command: 'a' }), encodeFrame({ command: 'b' })]);

  assert.deepEqual(decodeFrames(stream).messages, [{ command: 'a' }, { command: 'b' }]);
});

test('переписка сохраняется в markdown и json', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Нужен лендинг', attachments: [] },
    ]),
  });

  assert.equal(result.messages, 1);
  assert.equal(fs.existsSync(path.join(targetDir, 'ivan_petrov', 'переписка.md')), true);

  const record = JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan_petrov', 'данные.json'), 'utf8'));

  assert.equal(record.messages.length, 1);
  assert.match(fs.readFileSync(result.path, 'utf8'), /Нужен лендинг/);
});

test('повторное сохранение дополняет историю, а не затирает её', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Первое', attachments: [] },
    ]),
  });

  const result = handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '2', time: '2026-07-26T08:00:00.000Z', authorId: '777', recipientName: 'ivan_petrov', text: 'Второе', attachments: [] },
    ]),
  });

  assert.equal(result.messages, 2);

  const record = JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan_petrov', 'данные.json'), 'utf8'));

  assert.deepEqual(record.messages.map((message) => message.text), ['Первое', 'Второе']);
});

test('сырой ответ биржи сохраняется рядом для разбора формата', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([{ id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Привет', attachments: [] }]),
    sample: { requestUrl: 'https://kwork.ru/inbox/data', payload: { data: [{ message: 'Привет' }] } },
  });

  const record = JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan_petrov', 'данные.json'), 'utf8'));

  assert.equal(record.samples.length, 1);
  assert.equal(record.samples[0].requestUrl, 'https://kwork.ru/inbox/data');
});

test('имя диалога не выводит файл за пределы папки переписок', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog(
      [{ id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Привет', attachments: [] }],
      { key: '../../secrets' },
    ),
  });

  assert.equal(path.dirname(path.dirname(result.path)), targetDir);
});

test('вложение собирается из кусков и ложится в папку диалога', () => {
  const targetDir = createTargetDir();
  const content = Buffer.from('первый кусок и второй кусок', 'utf8');
  const half = Math.ceil(content.length / 2);

  const first = handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: 'макет.png',
    part: 0,
    final: false,
    chunk: content.subarray(0, half).toString('base64'),
  });

  assert.equal(first.saved, false);

  const second = handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: 'макет.png',
    part: 1,
    final: true,
    chunk: content.subarray(half).toString('base64'),
  });

  const filePath = path.join(targetDir, 'ivan_petrov', 'файлы', 'макет.png');

  assert.equal(second.saved, true);
  assert.equal(second.size, content.length);
  assert.equal(fs.readFileSync(filePath, 'utf8'), content.toString('utf8'));
  assert.equal(fs.existsSync(`${filePath}.part`), false);
});

test('имя вложения не выводит запись за пределы папки диалога', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: '../../../secrets.txt',
    chunk: Buffer.from('данные', 'utf8').toString('base64'),
  });

  assert.equal(path.dirname(result.path), path.join(targetDir, 'ivan_petrov', 'файлы'));
});

test('мост отдаёт уже сохранённые вложения с размерами', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: 'смета.pdf',
    chunk: Buffer.from('12345', 'utf8').toString('base64'),
  });

  const result = handleCommand(targetDir, { command: 'list-attachments', dialogKey: 'ivan_petrov' });

  assert.deepEqual(result.files, [{ file: 'смета.pdf', size: 5 }]);
  assert.deepEqual(handleCommand(targetDir, { command: 'list-attachments', dialogKey: 'maria' }).files, []);
});

test('переписки старой раскладки переезжают в папки диалогов', () => {
  const targetDir = createTargetDir();
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'ivan_petrov.md'), '# Переписка с ivan_petrov\n', 'utf8');
  fs.writeFileSync(
    path.join(targetDir, 'data', 'ivan_petrov.json'),
    JSON.stringify({ key: 'ivan_petrov', messages: [] }),
    'utf8',
  );

  const result = handleCommand(targetDir, { command: 'migrate-layout' });

  assert.equal(result.migrated, 1);
  assert.equal(fs.existsSync(path.join(targetDir, 'ivan_petrov', 'переписка.md')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'ivan_petrov', 'данные.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'ivan_petrov.md')), false);
});

test('сохранение переписки подхватывает старый файл вместо второй копии', () => {
  const targetDir = createTargetDir();
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'data', 'ivan_petrov.json'),
    JSON.stringify({
      key: 'ivan_petrov',
      messages: [{ id: '1', time: '2026-07-26T07:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Старое', attachments: [] }],
    }),
    'utf8',
  );

  const result = handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '2', time: '2026-07-26T08:00:00.000Z', authorId: '501', authorName: 'ivan_petrov', text: 'Новое', attachments: [] },
    ]),
  });

  assert.equal(result.messages, 2);
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'ivan_petrov.json')), false);
});

test('список известных диалогов накапливается без дублей', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, { command: 'known-dialogs', dialogKeys: ['maria', 'ivan'] });
  const result = handleCommand(targetDir, { command: 'known-dialogs', dialogKeys: ['ivan', 'petr'] });

  assert.equal(result.dialogs, 3);

  const record = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  assert.deepEqual(record.dialogKeys, ['ivan', 'maria', 'petr']);
});

test('переписка со службой поддержки на диск не попадает', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog(
      [{ id: '1', time: '2026-05-16T21:11:07.000Z', authorId: '71232', authorName: 'Support', text: 'Статус подтверждён', attachments: [] }],
      { key: 'Support', title: 'Support', url: 'https://kwork.ru/inbox/Support' },
    ),
  });

  assert.equal(result.skipped, true);
  assert.equal(result.path, null);
  assert.equal(fs.existsSync(path.join(targetDir, 'support.md')), false);
});

test('служебные диалоги не попадают в список известных переписок', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, { command: 'known-dialogs', dialogKeys: ['Support', 'ivan'] });
  const result = handleCommand(targetDir, { command: 'known-dialogs', dialogKeys: ['kwork', 'petr'] });

  const record = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  assert.deepEqual(record.dialogKeys, ['ivan', 'petr']);
});

test('неизвестная команда отклоняется с понятной ошибкой', () => {
  const targetDir = createTargetDir();

  assert.throws(() => handleCommand(targetDir, { command: 'drop-everything' }), /неизвестная команда/);
});

test('диагностика страницы переписок сохраняется отдельным файлом', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'save-diagnostics',
    diagnostics: { pageUrl: 'https://kwork.ru/inbox', linksFound: 0, hrefSample: ['/inbox/support'] },
  });

  const record = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  assert.equal(record.pageUrl, 'https://kwork.ru/inbox');
  assert.equal(record.linksFound, 0);
  assert.ok(record.at);
});

test('мост отдаёт последнее сохранённое сообщение запрошенных диалогов', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '1', time: '2026-07-26T08:00:00.000Z', authorName: 'ivan_petrov', text: 'Старое' },
      { id: '2', time: '2026-07-26T09:00:00.000Z', authorName: 'ivan_petrov', text: 'Новое' },
    ]),
  });

  const result = handleCommand(targetDir, { command: 'dialog-index', dialogKeys: ['Ivan_Petrov', 'nobody', '../evil'] });

  assert.deepEqual(result.dialogs, {
    ivan_petrov: { lastTime: '2026-07-26T09:00:00.000Z', lastId: '2', count: 2, complete: null },
  });
});

// Тихая запись (getnewmessages) не видит сообщений заказа между старым и новым:
// полнота истории остаётся прежней, а сверка первой страницы идёт от последнего
// сообщения до тихой записи — иначе длинный диалог перечитывался бы целиком.
test('сверку истории двигает только подтверждённая выгрузка, не тихая запись и не вкладка', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '1', time: '2026-07-26T08:00:00.000Z', authorName: 'ivan_petrov', text: 'Старое' },
      { id: '2', time: '2026-07-26T09:00:00.000Z', authorName: 'ivan_petrov', text: 'Новое' },
    ], { complete: true }),
  });
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '5', time: '2026-07-26T10:00:00.000Z', authorName: 'ivan_petrov', text: 'Тихое' },
    ]),
  });
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '6', time: '2026-07-26T10:30:00.000Z', authorName: 'ivan_petrov', text: 'Ещё тихое' },
    ]),
  });

  const quiet = handleCommand(targetDir, { command: 'dialog-index', dialogKeys: ['ivan_petrov'] });
  assert.deepEqual(quiet.dialogs.ivan_petrov, { lastTime: '2026-07-26T09:00:00.000Z', lastId: '6', count: 4, complete: true });

  // Вкладка Kwork сохранила последние сообщения без подтверждения, что пропуск закрыт:
  // точка сверки стоит на месте, иначе сообщение заказа в пропуске потерялось бы.
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '6', time: '2026-07-26T10:30:00.000Z', authorName: 'ivan_petrov', text: 'Ещё тихое' },
    ]),
  });
  const tab = handleCommand(targetDir, { command: 'dialog-index', dialogKeys: ['ivan_petrov'] });
  assert.equal(tab.dialogs.ivan_petrov.lastTime, '2026-07-26T09:00:00.000Z');

  // Обычная выгрузка первой страницей закрыла пропуск — сверка до конца этой страницы.
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '3', time: '2026-07-26T09:30:00.000Z', authorName: 'ivan_petrov', text: 'В заказе' },
      { id: '6', time: '2026-07-26T10:30:00.000Z', authorName: 'ivan_petrov', text: 'Ещё тихое' },
    ], { verified: true }),
  });

  const full = handleCommand(targetDir, { command: 'dialog-index', dialogKeys: ['ivan_petrov'] });
  assert.deepEqual(full.dialogs.ivan_petrov, { lastTime: '2026-07-26T10:30:00.000Z', lastId: '6', count: 5, complete: true });
});

test('состояние автовыгрузки ложится служебным файлом', () => {
  const targetDir = createTargetDir();
  const result = handleCommand(targetDir, {
    command: 'sync-status',
    status: { ok: true, changed: ['ivan_petrov'], error: null },
  });

  const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.equal(path.basename(result.path), '_sync.json');
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.changed, ['ivan_petrov']);
  assert.match(saved.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('две одновременные передачи одного вложения не смешивают куски', () => {
  const targetDir = createTargetDir();
  const content = Buffer.from('0123456789A', 'utf8');
  const send = (transferId, part, final, bytes) => handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: 'архив.zip',
    transferId,
    part,
    final,
    chunk: bytes.toString('base64'),
  });

  send('a', 0, false, content.subarray(0, 6));
  send('b', 0, false, content.subarray(0, 6));
  send('a', 1, true, content.subarray(6));
  const late = send('b', 1, true, content.subarray(6));

  const filePath = path.join(targetDir, 'ivan_petrov', 'файлы', 'архив.zip');
  assert.equal(late.saved, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '0123456789A');
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['архив.zip']);
});

test('кусок не по порядку отменяет передачу, а не портит файл', () => {
  const targetDir = createTargetDir();
  const send = (part, final, text) => handleCommand(targetDir, {
    command: 'save-attachment',
    dialogKey: 'ivan_petrov',
    file: 'док.txt',
    transferId: 't1',
    part,
    final,
    chunk: Buffer.from(text).toString('base64'),
  });

  send(0, false, 'начало');
  assert.throws(() => send(2, true, 'конец'), /кусок/);
  assert.equal(fs.existsSync(path.join(targetDir, 'ivan_petrov', 'файлы', 'док.txt')), false);
});

test('отклики копятся без дублей, новые сверху', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, { command: 'save-offers', offers: [{ offerId: '1', projectId: '10', price: 5000 }] });
  const result = handleCommand(targetDir, { command: 'save-offers', offers: [{ offerId: '2', projectId: '20', price: 7000 }, { offerId: '1', projectId: '10', price: 4500 }] });

  const saved = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.deepEqual(saved.offers.map((item) => [item.offerId, item.price]), [['2', 7000], ['1', 4500]]);
});

test('мост называет недокачанные вложения по всей сохранённой переписке', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, {
    command: 'save-dialog',
    dialog: buildDialog([
      { id: '1', time: '2026-07-26T08:00:00.000Z', authorName: 'ivan_petrov', text: 'Старый файл', attachments: [{ id: 'a', name: 'old.png', url: 'https://kwork.ru/files/uploaded/1/old.png', size: 3 }] },
      { id: '2', time: '2026-07-26T09:00:00.000Z', authorName: 'ivan_petrov', text: 'Новый файл', attachments: [{ id: 'b', name: 'new.png', url: 'https://kwork.ru/files/uploaded/2/new.png', size: 3 }] },
    ]),
  });

  const listed = handleCommand(targetDir, { command: 'missing-attachments', dialogKey: 'ivan_petrov' });
  assert.deepEqual(listed.files.map((item) => item.url), ['https://kwork.ru/files/uploaded/1/old.png', 'https://kwork.ru/files/uploaded/2/new.png']);

  const [newFile] = listed.files.filter((item) => item.url.endsWith('new.png'));
  handleCommand(targetDir, { command: 'save-attachment', dialogKey: 'ivan_petrov', file: newFile.file, part: 0, final: true, chunk: Buffer.from('png').toString('base64') });

  assert.deepEqual(handleCommand(targetDir, { command: 'missing-attachments', dialogKey: 'ivan_petrov' }).files.map((item) => item.url), ['https://kwork.ru/files/uploaded/1/old.png']);
  assert.deepEqual(handleCommand(targetDir, { command: 'dialogs-missing-files' }).dialogs, { ivan_petrov: 1 });
});

test('успешная передача убирает брошенные куски прошлых попыток', () => {
  const targetDir = createTargetDir();
  const dir = path.join(targetDir, 'ivan_petrov', 'файлы');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'архив.zip.old1.part');
  fs.writeFileSync(stale, 'брошено');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);

  handleCommand(targetDir, { command: 'save-attachment', dialogKey: 'ivan_petrov', file: 'архив.zip', transferId: 'new1', part: 0, final: true, chunk: Buffer.from('zip').toString('base64') });

  assert.deepEqual(fs.readdirSync(dir), ['архив.zip']);
});

test('мост отдаёт ключи сохранённых сообщений диалога для галочки', () => {
  const targetDir = createTargetDir();
  handleCommand(targetDir, { command: 'save-dialog', dialog: buildDialog([
    { id: '1', time: '2026-10-13T13:19:34.000Z', authorId: '5840', authorName: 'ivan_petrov', text: 'Привет', attachments: [] },
  ]) });

  assert.deepEqual(handleCommand(targetDir, { command: 'message-keys', dialogKey: 'Ivan_Petrov' }).keys, ['5840:1791897574']);
  assert.deepEqual(handleCommand(targetDir, { command: 'message-keys', dialogKey: 'nobody' }).keys, []);
});
