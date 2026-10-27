const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { createClaudeRunner, elapsedMs, listProcesses, projectSlug } = require('../native_host/claude-runner.js');

const ID = '3b1f6c1e-5d0a-4b53-9f43-2f2b0f7b9a11';
const OTHER = '9a26a5ee-3cc0-4d60-9f61-0943c40e3d06';

function makeRunner(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-runner-'));
  const calls = [];
  const handlers = {};
  const opened = [];
  const spawn = (bin, args, spawnOptions) => {
    calls.push({ bin, args, options: spawnOptions });
    return { pid: options.noPid ? undefined : 4321, on: (name, handler) => { handlers[name] = handler; }, unref() { calls.at(-1).unref = true; } };
  };
  const runner = createClaudeRunner({ env: { PATH: '/usr/bin', ...options.env }, home, spawn, processes: () => options.processes || [], open: (url) => opened.push(url) });
  return { runner, home, calls, handlers, opened, logFile: path.join(home, 'logs', 'run.log') };
}

test('каталог журнала claude — путь, где каждый не буквенно-цифровой символ заменён на «-»', () => {
  assert.equal(projectSlug('/private/tmp/kph-wake-test.semx'), '-private-tmp-kph-wake-test-semx');
  // Как у настоящей папки в ~/.claude/projects: «Выполненные» — 11 символов, два слэша.
  assert.equal(projectSlug('/Users/test/Projects/Kwork/Выполненные/parkmanager'), '-Users-test-Projects-Kwork-------------parkmanager');
  assert.equal(projectSlug('/Users/test/Projects/Kwork/Активные/shop'), '-Users-test-Projects-Kwork----------shop');
});

test('список процессов читается из ps: pid и полные аргументы', () => {
  const mine = listProcesses().find((item) => item.pid === process.pid);
  assert.ok(mine, 'свой процесс в списке');
  assert.ok(mine.args.includes(path.basename(process.execPath)) || mine.args.includes('node'));
});

test('новый чат: --session-id, папка заказа, модель, режим разрешений, отвязанный запуск', () => {
  const { runner, home, calls, logFile } = makeRunner({ env: { PWD: '/somewhere/else' } });
  const result = runner.start({ dir: '/k/shop', text: 'привет', sessionId: ID, logFile });
  assert.deepEqual(result, { pid: 4321, logFrom: 0 });
  const [call] = calls;
  assert.equal(call.bin, path.join(home, '.local', 'bin', 'claude'));
  assert.deepEqual(call.args, ['-p', '--session-id', ID, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5-5', '--effort', 'high', 'привет']);
  assert.equal(call.options.cwd, '/k/shop');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.PATH, '/usr/bin:/opt/homebrew/bin:/usr/local/bin');
  // Stop-хук решает по "$PWD": от моста он достался бы чужой.
  assert.equal(call.options.env.PWD, '/k/shop');
  assert.equal(call.unref, true);
  assert.ok(fs.existsSync(logFile));
});

test('продолжение: --resume; лог дописывается, итог второго запуска ищется с его позиции', () => {
  const { runner, calls, logFile } = makeRunner();
  runner.start({ dir: '/k/shop', text: 'т', sessionId: ID, resume: true, logFile });
  assert.deepEqual(calls[0].args.slice(0, 3), ['-p', '--resume', ID]);
  assert.ok(!calls[0].args.includes('--session-id') && !calls[0].args.includes('--fork-session'));

  fs.appendFileSync(logFile, 'итог первого\n');
  const second = runner.start({ dir: '/k/shop', text: 'т', sessionId: ID, resume: true, logFile });
  assert.equal(second.logFrom, Buffer.byteLength('итог первого\n'));
});

test('бинарь, модель и уровень переопределяются переменными окружения', () => {
  const { runner, calls, logFile } = makeRunner({ env: { KPH_CLAUDE_BIN: '/x/claude', KPH_CLAUDE_MODEL: 'm1', KPH_CLAUDE_EFFORT: 'low' } });
  runner.start({ dir: '/k', text: 'т', sessionId: ID, logFile });
  assert.equal(calls[0].bin, '/x/claude');
  assert.deepEqual(calls[0].args.slice(7, 11), ['--model', 'm1', '--effort', 'low']);
});

test('claude не запустился: ошибка выбрасывается, а ошибка процесса не роняет мост', () => {
  const { runner, handlers, logFile } = makeRunner({ noPid: true });
  assert.throws(() => runner.start({ dir: '/k', text: 'т', sessionId: ID, logFile }), /claude не запустился/);
  assert.equal(typeof handlers.error, 'function');
  assert.doesNotThrow(() => handlers.error(new Error('ENOENT')));
});

test('чат держит чужой процесс (--resume id, --session-id id); процесс самого Desktop (--resume=id) не в счёт; Desktop запущен — по главному процессу', () => {
  const processes = [
    { pid: 1, args: `/Applications/Claude.app/Contents/MacOS/claude --output-format stream-json --resume=${ID}` },
    { pid: 2, args: `/opt/homebrew/bin/claude -p --resume ${ID} --model m текст` },
    { pid: 3, args: `/opt/homebrew/bin/claude -p --session-id ${ID} текст` },
    { pid: 4, args: `/opt/homebrew/bin/claude --resume=${OTHER}` },
    { pid: 5, args: `/usr/bin/vim notes-${ID}.md` },
  ];
  const { runner } = makeRunner({ processes });
  assert.deepEqual(runner.holders(ID).map((item) => item.pid), [2, 3]);
  assert.deepEqual(runner.holders(OTHER), []);
  assert.deepEqual(runner.holders('00000000-0000-4000-8000-000000000000'), []);
  assert.equal(runner.desktopAgeMs(), null);
  processes.push({ pid: 6, ageMs: 5000, args: '/Applications/Claude.app/Contents/MacOS/Claude' });
  assert.equal(runner.desktopAgeMs(), 5000);
  // Возраст процесса — по полю etime `ps`.
  assert.equal(elapsedMs('05:01'), 301000);
  assert.equal(elapsedMs('18:07:37'), (18 * 3600 + 7 * 60 + 37) * 1000);
  assert.equal(elapsedMs('03-00:22:05'), (3 * 86400 + 22 * 60 + 5) * 1000);
  assert.equal(elapsedMs('кривое'), null);
});

test('запуск жив только если pid совпал и это именно его чат', () => {
  const { runner } = makeRunner({ processes: [{ pid: 4321, args: `/bin/bash /x/run -p --session-id ${ID} т` }, { pid: 99, args: '/usr/bin/other' }] });
  assert.equal(runner.isRunning(4321, ID), true);
  assert.equal(runner.isRunning(4321, OTHER), false, 'pid занят чужим процессом');
  assert.equal(runner.isRunning(99, ID), false);
  assert.equal(runner.isRunning(1, ID), false);
});

test('журнал чата находится по папке заказа, в том числе при другой записи имени (NFC/NFD)', () => {
  const { runner, home } = makeRunner();
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-dir-'))), 'Йод');
  fs.mkdirSync(dir);
  assert.equal(runner.transcript(dir, ID), null);
  assert.equal(runner.transcript(dir, null), null);

  // claude мог записать каталог по имени в NFD — папка при этом названа в NFC.
  const file = path.join(home, '.claude', 'projects', projectSlug(dir.normalize('NFD')), `${ID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  const found = runner.transcript(dir.normalize('NFC'), ID);
  assert.equal(found.file, file);
  assert.equal(found.mtimeMs, fs.statSync(file).mtimeMs);
});

test('показ чата в Desktop — адрес claude://resume?session=<id>', () => {
  const { runner, opened } = makeRunner();
  runner.openInDesktop(ID);
  assert.deepEqual(opened, [`claude://resume?session=${ID}`]);
  assert.match(runner.newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('PWD запуска — папка заказа, остальное окружение моста как есть', () => {
  const { runner, calls, logFile } = makeRunner({ env: { PWD: '/Applications/Chrome', HOME: '/h', FOO: '1' } });
  runner.start({ dir: '/k/Активные/shop', text: 'т', sessionId: ID, logFile });
  const { env } = calls[0].options;
  assert.deepEqual([env.PWD, env.HOME, env.FOO], ['/k/Активные/shop', '/h', '1']);
});

const record = (type, at, extra = {}) => `${JSON.stringify({ type, ...(at ? { timestamp: new Date(at).toISOString() } : {}), ...extra })}\n`;

test('последняя работа в папке — время последней записи пользователя или ассистента, а не mtime журнала', () => {
  const { runner, home } = makeRunner();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-last-')));
  assert.equal(runner.lastActivity(dir), 0);
  const projectDir = path.join(home, '.claude', 'projects', projectSlug(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  const write = (name, text, mtimeSeconds) => {
    fs.writeFileSync(path.join(projectDir, name), text);
    fs.utimesSync(path.join(projectDir, name), mtimeSeconds, mtimeSeconds);
  };
  // a: ответ был давно, а Desktop только что дописал служебные записи — mtime самый свежий.
  write('a.jsonl', record('user', 1_000_000) + record('assistant', 2_000_000) + record('last-prompt', null) + record('mode', null), 9_000);
  // b: настоящая работа новее, чем у a, mtime — по ней.
  write('b.jsonl', record('user', 3_000_000) + record('assistant', 5_000_000) + record('cost-state', null), 5_000);
  write('notes.txt', 'не журнал', 9_500);
  assert.equal(runner.lastActivity(dir), 5_000_000);
  // Ошибка API в самом конце — не работа: берётся запись перед ней.
  write('c.jsonl', record('user', 6_000_000) + record('assistant', 8_000_000, { isApiErrorMessage: true, message: { model: '<synthetic>', content: [] } }), 9_800);
  assert.equal(runner.lastActivity(dir), 6_000_000);
  // Самый свежий чат папки — тот, где последняя живая запись, а не самый свежий файл.
  assert.deepEqual(runner.latestChat(dir), { sessionId: 'c', at: 6_000_000 });
  // Отбор чатов (например, только те, что есть в Desktop): свежайший среди подходящих.
  assert.deepEqual(runner.latestChat(dir, (sessionId) => sessionId === 'b'), { sessionId: 'b', at: 5_000_000 });
  assert.equal(runner.latestChat(dir, () => false), null);
  assert.equal(runner.latestChat(path.join(dir, 'нет')), null);
});

test('последняя запись находится в хвосте большого журнала, за служебными записями', () => {
  const { runner, home } = makeRunner();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-tail-')));
  const projectDir = path.join(home, '.claude', 'projects', projectSlug(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  const filler = record('attachment', 1_000, { content: 'x'.repeat(100 * 1024) });
  fs.writeFileSync(path.join(projectDir, 'big.jsonl'), record('user', 7_000_000) + filler + filler + record('last-prompt', null));
  assert.equal(runner.lastActivity(dir), 7_000_000);
});

test('живая работа в чате — сообщение человека или ответ ассистента; результат инструмента, служебное, наша побудка, очередь и ошибка API не в счёт', () => {
  const { runner, home } = makeRunner();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-live-')));
  const projectDir = path.join(home, '.claude', 'projects', projectSlug(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'chat.jsonl');
  fs.writeFileSync(file, record('user', 1_000_000) + record('assistant', 2_000_000) + record('last-prompt', null) + record('mode', null));
  const append = (text) => fs.appendFileSync(file, text);
  append(record('user', 4_000_000, { message: { content: [{ type: 'tool_result', content: 'ок' }] } }));
  append(record('user', 4_100_000, { isMeta: true, message: { content: 'служебное' } }));
  append(record('user', 4_200_000, { message: { content: '[Kwork-побудка #ab12] Клиент' } }));
  append(record('queue-operation', 4_300_000, { content: 'x' }));
  append(record('assistant', 4_400_000, { isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection lost' }] } }));
  assert.equal(runner.lastActivity(dir), 2_000_000);

  append(record('user', 5_000_000, { message: { role: 'user', content: [{ type: 'text', text: 'привет' }, { type: 'image' }] } }));
  assert.equal(runner.lastActivity(dir), 5_000_000);
  append(record('assistant', 6_000_000, { message: { content: [] } }));
  append('{"type":"user","timestamp":"2026-10-1');
  assert.equal(runner.lastActivity(dir), 6_000_000, 'оборванная последняя строка пропускается');
});

// Запись реестра живой сессии claude (~/.claude/sessions/<pid>.json).
function register(home, entry) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify({ kind: 'interactive', entrypoint: 'claude-desktop', messagingSocketPath: `/tmp/none-${entry.pid}.sock`, updatedAt: 1, ...entry }));
}

test('открытый в Desktop чат: этот чат, а в папке заказа — открытый чат с самой свежей живой записью; мёртвые, чужой pid, T3 и чужие папки не в счёт', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-open-'))).normalize('NFC');
  const order = path.join(dir, 'Заказ-й');
  fs.mkdirSync(order);
  const { runner, home } = makeRunner({ processes: [...[101, 102, 103, 104, 105].map((pid) => ({ pid, args: '/Applications/Claude.app/Contents/MacOS/claude --resume=x' })), { pid: 107, args: '/usr/sbin/nginx' }] });
  register(home, { pid: 101, sessionId: ID, cwd: order });
  register(home, { pid: 199, sessionId: 'dead', cwd: order, updatedAt: 99 });
  register(home, { pid: 102, sessionId: 't3', cwd: order, entrypoint: 'sdk-ts', updatedAt: 98 });
  register(home, { pid: 103, sessionId: 'user-new', cwd: order.normalize('NFD'), updatedAt: 50 });
  register(home, { pid: 104, sessionId: 'user-old', cwd: order, updatedAt: 10 });
  register(home, { pid: 105, sessionId: 'elsewhere', cwd: dir, updatedAt: 97 });
  register(home, { pid: 107, sessionId: 'reused', cwd: order });
  fs.writeFileSync(path.join(home, '.claude', 'sessions', '106.json'), '{"pid":10');
  const projectDir = path.join(home, '.claude', 'projects', projectSlug(order));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${ID}.jsonl`), record('assistant', 2_000_000));
  fs.writeFileSync(path.join(projectDir, 'user-new.jsonl'), record('user', 3_000_000));
  fs.writeFileSync(path.join(projectDir, 'user-old.jsonl'), record('user', 1_000_000));

  assert.equal(runner.openChat(order, ID, false).pid, 101);
  assert.equal(runner.openChat(order, 'нет', false), null);
  // Свой чат открыт, но пользователь работает в другом — побудка туда, где он.
  assert.equal(runner.openChat(order, ID, true).sessionId, 'user-new');
  fs.appendFileSync(path.join(projectDir, `${ID}.jsonl`), record('user', 4_000_000));
  assert.equal(runner.openChat(order, ID, true).sessionId, ID);
  assert.equal(runner.openChat(order, 'нет', true).sessionId, ID);
  assert.equal(runner.openChat(order, 'reused', false), null, 'номер умершего чата занял другой процесс');
  assert.equal(runner.openChat(order, 'dead', false), null, 'процесса уже нет');
  assert.equal(runner.openChat(order, 't3', false), null, 'чаты T3 не трогаем');
});

test('сообщение в открытый чат: строка auth с ключом чата, затем строка user; нет сокета — ошибка', async () => {
  const { runner, home } = makeRunner();
  const sessionsDir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, '321.deadbeef.key'), 'секрет\n');
  const socketPath = path.join(home, 'in.sock');
  const lines = await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => { buffer += chunk; });
      socket.on('end', () => { server.close(); resolve(buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line))); });
    });
    server.listen(socketPath, () => runner.deliver({ pid: 321, socket: socketPath }, 'текст «побудки»\nвторая строка').catch(reject));
  });
  assert.deepEqual(lines, [{ type: 'auth', token: 'секрет' }, { type: 'user', message: { role: 'user', content: 'текст «побудки»\nвторая строка' } }]);
  await assert.rejects(runner.deliver({ pid: 321, socket: path.join(home, 'нет.sock') }, 'т'));
});

test('дошло ли сообщение до чата — метка побудки в журнале после позиции; чат в списке Desktop — по метаданным Desktop', () => {
  const { runner, home } = makeRunner();
  const file = path.join(home, 'chat.jsonl');
  const old = `${JSON.stringify({ type: 'user', message: { content: '[Kwork-побудка #aa] старое' } })}\n`;
  fs.writeFileSync(file, old);
  assert.equal(runner.received(file, 0, '[Kwork-побудка #aa]'), true);
  assert.equal(runner.received(file, Buffer.byteLength(old), '[Kwork-побудка #aa]'), false);
  // Занятый чат сначала кладёт сообщение в очередь — это ещё не доставка.
  fs.appendFileSync(file, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '[Kwork-побудка #bb] Клиент' })}\n`);
  assert.equal(runner.received(file, Buffer.byteLength(old), '[Kwork-побудка #bb]'), false);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'Another Claude session sent a message:\n[Kwork-побудка #bb] Клиент' } })}\n`);
  assert.equal(runner.received(file, Buffer.byteLength(old), '[Kwork-побудка #bb]'), true);
  assert.equal(runner.received(path.join(home, 'нет.jsonl'), 0, '[Kwork-побудка #bb]'), false);
  // Чат был занят: сообщение из очереди вошло в его ход вложением queued_command (так в живом журнале).
  const busyFrom = fs.statSync(file).size;
  fs.appendFileSync(file, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '[Kwork-побудка #cc] Клиент' })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: ['[Kwork-побудка #cc]'] } })}\n`);
  assert.equal(runner.received(file, busyFrom, '[Kwork-побудка #cc]'), false);
  fs.appendFileSync(file, `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'Another Claude session sent a message:\n[Kwork-побудка #cc] Клиент' } })}\n`);
  assert.equal(runner.received(file, busyFrom, '[Kwork-побудка #cc]'), true);

  assert.equal(runner.inDesktop(ID), false);
  const meta = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(path.join(meta, 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(meta, 'local_x.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: OTHER }));
  assert.equal(runner.inDesktop(ID), false);
  fs.writeFileSync(path.join(meta, 'local_y.json'), JSON.stringify({ sessionId: 'local_y', cliSessionId: ID }));
  assert.equal(runner.inDesktop(ID), true);
  // Чат в архиве Desktop — тоже в Desktop, но в списке его не видно.
  fs.writeFileSync(path.join(meta, 'local_z.json'), JSON.stringify({ sessionId: 'local_z', cliSessionId: OTHER, isArchived: true, cwd: '/k/shop' }));
  assert.deepEqual(runner.desktopChats().get(OTHER), { localId: 'local_z', archived: true, cwd: '/k/shop' });
  assert.deepEqual(runner.desktopChats().get(ID), { localId: 'local_y', archived: false, cwd: null });
});

test('ответил ли агент — по строке итога запуска в логе с его позиции, а не по журналу чата', () => {
  const { runner, home, logFile } = makeRunner();
  const line = (record) => `${JSON.stringify(record)}\n`;
  const result = (isError, text = 'ок') => line({ type: 'result', subtype: 'success', is_error: isError, result: text, session_id: ID });
  const noise = 'Warning: no stdin data received in 3s\n[claude-code:warn] {"x":1}\n';
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  fs.writeFileSync(logFile, noise + result(false));
  assert.equal(runner.succeeded(logFile, 0), true);
  // Ошибка API и лимит — is_error: true при subtype "success", в том числе после вызовов инструментов.
  fs.writeFileSync(logFile, noise + result(true, 'API Error: Connection lost mid-response'));
  assert.equal(runner.succeeded(logFile, 0), false);
  fs.writeFileSync(logFile, result(true, "You've hit your usage limit"));
  assert.equal(runner.succeeded(logFile, 0), false);
  // Процесс оборвался: строки итога нет, а удачный итог прошлого запуска того же чата — до позиции.
  const old = result(false);
  fs.writeFileSync(logFile, old + noise);
  assert.equal(runner.succeeded(logFile, Buffer.byteLength(old)), false);
  fs.writeFileSync(logFile, old + result(true, 'API Error'));
  assert.equal(runner.succeeded(logFile, Buffer.byteLength(old)), false);
  fs.writeFileSync(logFile, result(true, 'API Error') + result(false));
  assert.equal(runner.succeeded(logFile, Buffer.byteLength(result(true, 'API Error'))), true);
  // Оборванная строка итога и пустой лог — не ответ.
  fs.writeFileSync(logFile, result(false).slice(0, 30));
  assert.equal(runner.succeeded(logFile, 0), false);
  fs.writeFileSync(logFile, '');
  assert.equal(runner.succeeded(logFile, 0), false);
  // Лога нет — тревога лучше молчания.
  assert.equal(runner.succeeded(path.join(home, 'нет.log'), 0), false);
});

test('служебная просьба будильщика и ответ на неё — не работа в чате: чат давнего заказа не становится «последним, где работали»', () => {
  const { runner, home } = makeRunner();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-service-')));
  const projectDir = path.join(home, '.claude', 'projects', projectSlug(dir));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'chat.jsonl');
  fs.writeFileSync(file, record('user', 1_000_000) + record('assistant', 2_000_000));
  const append = (text) => fs.appendFileSync(file, text);
  append(record('user', 3_000_000, { message: { content: 'Another Claude session sent a message:\n[Kwork-служебное] Чат-диспетчер уснул' } }));
  append(record('assistant', 3_100_000, { message: { content: [{ type: 'tool_use', id: 't1', name: 'send_message' }] } }));
  append(record('user', 3_200_000, { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered' }] } }));
  append(record('assistant', 3_300_000, { message: { content: [{ type: 'text', text: 'диспетчер поднят' }] } }));
  assert.equal(runner.lastActivity(dir), 2_000_000);

  // Дальше обычная работа — снова в счёт; ответ на побудку — тоже.
  append(record('user', 4_000_000));
  assert.equal(runner.lastActivity(dir), 4_000_000);
  append(record('user', 5_000_000, { message: { content: '[Kwork-побудка #ab12] Клиент' } }));
  append(record('assistant', 5_100_000));
  assert.equal(runner.lastActivity(dir), 5_100_000);
});
