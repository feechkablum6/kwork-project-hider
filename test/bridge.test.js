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
