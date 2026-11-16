'use strict';

// Побудка в T3 Code (13.11.2026): доставка каналом приложения T3 (steer в идущий ход) и CLI `t3 thread start`, без сокетов и диспетчера Desktop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWaker } = require('../native_host/waker.js');
const { createT3Runner } = require('../native_host/t3-runner.js');
const { handleCommand } = require('../native_host/store.js');
const { createFakeClaude } = require('./helpers/fake-claude.js');

function message(id, minute, author, text) {
  return {
    id: String(id),
    time: new Date(Date.UTC(2026, 9, 14, 9, minute)).toISOString(),
    authorId: author === 'client' ? '501' : '900',
    authorName: author === 'client' ? 'ivan' : 'me',
    text,
    attachments: [],
  };
}

// Поддельный T3: чаты по папке проекта; sent/started — что ушло; fail — ошибка CLI на следующий вызов.
function createFakeT3() {
  const t3 = { threads: {}, sent: [], started: [], missing: new Set(), fail: null, closed: false };
  t3.runner = {
    serverPid: () => (t3.closed ? null : 4242),
    threadId: (id) => (String(id).includes(':') ? String(id) : `import:claudeAgent:${id}`),
    latestThread: async (dir) => t3.threads[dir] || null,
    send: async (threadId, text) => {
      if (t3.fail) throw t3.fail;
      if (t3.missing.has(threadId)) return false;
      t3.sent.push({ threadId, text });
      return true;
    },
    start: async (dir, title, text) => {
      if (t3.fail) throw t3.fail;
      const threadId = `mcp:new-${t3.started.length + 1}`;
      t3.started.push({ dir, title, text, threadId });
      return threadId;
    },
  };
  return t3;
}

function createWorld({ orders = '- shop: ivan\n', toggle = false } = {}) {
  let clock = Date.parse('2026-10-14T10:00:00Z');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-wake-t3-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const orderDir = path.join(kworkRoot, 'Активные', 'shop');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), orders);
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  const save = (messages) => handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: '501', messages } });
  const claude = createFakeClaude({ home, now: () => clock });
  const t3 = createFakeT3();
  const logs = [];
  // toggle — переключатель моста: функция на каждый такт, T3 только при world.useT3.
  const world = { useT3: false };
  const waker = createWaker({ targetDir, kworkRoot, runner: claude.runner, t3: toggle ? () => (world.useT3 ? t3.runner : null) : t3.runner, log: (line) => logs.push(line), now: () => clock });
  const statePath = path.join(targetDir, 'data', 'wake-state.json');
  const stateOf = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const setChat = (key, sessionId) => {
    const state = stateOf();
    state.chats[key] = { sessionId, dir: key, nick: 'ivan', startedAt: clock };
    fs.writeFileSync(statePath, JSON.stringify(state));
  };
  const advance = (ms) => {
    clock += ms;
  };
  return Object.assign(world, { save, claude, t3, waker, logs, stateOf, setChat, advance, kworkRoot, targetDir, orderDir });
}

// Первый такт — опорная точка (старое не будит), второй — сообщение клиента.
async function clientWrites(world, text = 'новое') {
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', text)]);
  await world.waker.tick();
}

test('T3: чат заказа из Desktop — побудка в импортированный чат T3 и сразу разобрана, без диспетчера', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  world.setChat(world.orderDir, '11111111-2222-4333-8444-555555555555');
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', 'второе')]);
  await world.waker.tick();

  assert.equal(world.t3.sent.length, 1);
  assert.equal(world.t3.sent[0].threadId, 'import:claudeAgent:11111111-2222-4333-8444-555555555555');
  assert.match(world.t3.sent[0].text, /^\[Kwork-побудка #\w+\] Клиент ivan написал/);
  assert.match(world.t3.sent[0].text, /второе/);
  const state = world.stateOf();
  assert.equal(state.pending.ivan, undefined);
  assert.equal(state.handled.ivan, '2');
  assert.equal(state.chats[world.orderDir].sessionId, 'import:claudeAgent:11111111-2222-4333-8444-555555555555');
  assert.deepEqual(world.t3.started, []);
  assert.deepEqual(world.claude.dispatched, []);
  assert.deepEqual(world.claude.opened, []);
});

test('T3: своего чата нет — побудка в самый свежий чат проекта заказа', async () => {
  const world = createWorld();
  world.t3.threads[world.orderDir] = 'mcp:user-chat';
  await clientWrites(world);
  assert.deepEqual(world.t3.sent.map((item) => item.threadId), ['mcp:user-chat']);
  assert.equal(world.stateOf().chats[world.orderDir].sessionId, 'mcp:user-chat');
  assert.deepEqual(world.t3.started, []);
});

test('T3: чата заказа нет — новый чат T3 с побудкой первым сообщением и одно уведомление, открывающее T3', async () => {
  const world = createWorld();
  await clientWrites(world);
  assert.equal(world.t3.started.length, 1);
  const [started] = world.t3.started;
  assert.equal(started.dir, world.orderDir);
  assert.equal(started.title, 'shop');
  assert.match(started.text, /новое/);
  assert.equal(world.stateOf().chats[world.orderDir].sessionId, started.threadId);
  assert.equal(world.stateOf().pending.ivan, undefined);
  assert.equal(world.claude.notified.length, 1);
  assert.equal(world.claude.notified[0].activate, 'com.t3tools.t3code');
  assert.equal(world.claude.notified[0].url, undefined);

  // Следующее сообщение — в тот же чат, нового не заводим.
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', 'новое'), message(3, 6, 'client', 'ещё')]);
  world.advance(2000);
  await world.waker.tick();
  assert.deepEqual(world.t3.sent.map((item) => item.threadId), [started.threadId]);
  assert.equal(world.t3.started.length, 1);
});

test('T3: прошлый чат удалён в T3 — побудка в свежий чат заказа, иначе в новый', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  world.setChat(world.orderDir, 'mcp:gone');
  world.t3.missing.add('mcp:gone');
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', 'второе')]);
  await world.waker.tick();
  assert.equal(world.t3.started.length, 1);
  assert.equal(world.stateOf().chats[world.orderDir].sessionId, world.t3.started[0].threadId);
});

test('T3: клиент без заказа — свой новый чат в корне Kwork, чужие чаты корня не берутся', async () => {
  const world = createWorld({ orders: '' });
  world.t3.threads[path.join(os.tmpdir(), 'never')] = 'mcp:other';
  await clientWrites(world);
  assert.deepEqual(world.t3.sent, []);
  assert.equal(world.t3.started.length, 1);
  assert.equal(world.t3.started[0].dir, world.kworkRoot);
  assert.equal(world.t3.started[0].title, 'ivan');
});

test('T3 не ответил — сбой в журнал и повтор, побудка не теряется', async () => {
  const world = createWorld();
  world.t3.fail = new Error('t3 thread start: connect ECONNREFUSED');
  await clientWrites(world);
  const pending = world.stateOf().pending.ivan;
  assert.equal(pending.attempts, 1);
  assert.match(pending.error, /ECONNREFUSED/);
  assert.ok(world.logs.some((line) => /не удалась \(попытка 1\)/.test(line)));

  world.t3.fail = null;
  world.advance(2000);
  await world.waker.tick();
  assert.equal(world.t3.started.length, 1);
  assert.equal(world.stateOf().pending.ivan, undefined);
});

test('T3: своё сообщение без чата клиента — новый чат не заводится', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'client', 'старое')]);
  await world.waker.tick();
  world.save([message(1, 0, 'client', 'старое'), { ...message(2, 5, 'me', 'моё'), recipientId: '501', recipientName: 'ivan' }]);
  await world.waker.tick();
  assert.deepEqual(world.t3.started, []);
  assert.deepEqual(world.t3.sent, []);
});

test('переключатель выключен — путь Desktop, чат из T3 «import:…» — тот же чат Desktop; включён — снова T3', async () => {
  const world = createWorld({ toggle: true });
  const id = '11111111-2222-4333-8444-555555555555';
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  world.setChat(world.orderDir, `import:claudeAgent:${id}`);
  world.claude.addToDesktop(id, { cwd: world.orderDir });
  world.claude.openDesktopChat(world.orderDir, id);
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', 'в Desktop')]);
  await world.waker.tick();
  await world.claude.waitInbox(1);
  assert.equal(world.claude.inbox[0].sessionId, id);
  assert.match(world.claude.inbox[0].user.message.content, /в Desktop/);
  assert.deepEqual(world.t3.sent, []);
  assert.deepEqual(world.t3.started, []);

  // Запись чата приведена к виду Desktop: из неё строятся ссылка resume и уведомление.
  assert.equal(world.stateOf().chats[world.orderDir].sessionId, id);

  // Включили T3, а Desktop ещё держит этот же сеанс — вторую копию не поднимаем: ждём, одно уведомление.
  world.useT3 = true;
  world.save([message(1, 0, 'me', 'жду'), message(2, 5, 'client', 'в Desktop'), message(3, 6, 'client', 'в T3')]);
  world.advance(2000);
  await world.waker.tick();
  world.advance(10 * 1000);
  await world.waker.tick();
  assert.deepEqual(world.t3.sent, []);
  assert.equal(world.claude.notified.filter((note) => /закройте Desktop/.test(note.message)).length, 1);
  assert.equal(Object.values(world.stateOf().pending)[0].attempts || 0, 0);

  world.claude.closeDesktopChats();
  world.advance(10 * 1000);
  await world.waker.tick();
  assert.deepEqual(world.t3.sent.map((item) => item.threadId), [`import:claudeAgent:${id}`]);
  assert.match(world.t3.sent[0].text, /в T3/);
  // Прежний чат остаётся в своей папке (путь Desktop записал её настоящим путём).
  assert.equal(world.stateOf().chats[world.orderDir].dir, fs.realpathSync(world.orderDir));
});

test('T3 закрыт — побудка ждёт без счёта попыток и уходит, как только T3 открыли', async () => {
  const world = createWorld();
  world.t3.closed = true;
  await clientWrites(world);
  world.advance(60 * 1000);
  await world.waker.tick();
  assert.deepEqual(world.t3.sent, []);
  assert.deepEqual(world.t3.started, []);
  const item = Object.values(world.stateOf().pending)[0];
  assert.equal(item.error, 'T3 Code закрыт');
  assert.equal(item.attempts || 0, 0);

  world.t3.closed = false;
  world.advance(10 * 1000);
  await world.waker.tick();
  assert.equal(world.t3.started.length, 1);
  assert.deepEqual(world.stateOf().pending, {});
});

test('прежний чат T3 в другой папке — после побудки запись чата хранит его папку', async () => {
  const world = createWorld();
  await world.waker.tick();
  world.setChat(world.orderDir, 'mcp:old');
  const state = world.stateOf();
  state.chats[world.orderDir].dir = world.kworkRoot;
  fs.writeFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), JSON.stringify(state));
  world.save([message(1, 0, 'client', 'привет')]);
  await world.waker.tick();
  assert.deepEqual(world.t3.sent.map((item) => item.threadId), ['mcp:old']);
  assert.equal(world.stateOf().chats[world.orderDir].dir, world.kworkRoot);
});

test('t3-runner: свежий чат заказа без задач по расписанию и побочных; удалённый чат — false; уже заведённый проект — не ошибка', async () => {
  const calls = [];
  const threads = [
    { threadId: 'a', title: 'Разбор Директа осетровой фермы 13.11 12:10', updatedAt: '2026-11-13T05:00:00Z', parentThreadId: null },
    { threadId: 'b', title: 'Чат клиента sobolevs', updatedAt: '2026-11-12T05:00:00Z', parentThreadId: null },
    { threadId: 'c', title: 'Подзадача', updatedAt: '2026-11-13T06:00:00Z', parentThreadId: 'b' },
    { threadId: 'd', title: '<scheduled-task name="osetr-direct-daily"', updatedAt: '2026-11-13T07:00:00Z', parentThreadId: null },
    { threadId: 'e', title: 'Правка лендинга', updatedAt: '2026-11-12T09:00:00Z', parentThreadId: null },
  ];
  const fail = (t3) => Object.assign(new Error(t3), { t3 });
  const exec = async (bin, args, input) => {
    calls.push({ args, input });
    if (args[1] === 'remove') throw fail("ProjectNotFoundError: No active project found for '/x'.");
    if (args[0] === 'project') throw fail("ProjectAlreadyExistsError: An active project already exists for '/x'.");
    if (args[1] === 'list') return JSON.stringify(threads);
    if (args[1] === 'start') return '{"threadId":"mcp:new","projectId":"p"}';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const sent = [];
  const chats = {
    e: { archivedAt: null, deletedAt: null },
    deleted: { archivedAt: null, deletedAt: '2026-11-13T16:41:57Z' },
    archived: { archivedAt: '2026-11-14T10:00:00Z', deletedAt: null },
    vanished: { archivedAt: null, deletedAt: null },
  };
  const session = async (work) => work({
    thread: async (id) => {
      if (!chats[id]) throw new Error(`T3 /api/orchestration/threads/${id}/bounded: 404`);
      return { projection: { thread: chats[id] } };
    },
    dispatch: async (command) => {
      if (command.threadId === 'vanished') throw new Error('T3 отклонил команду message.dispatch: No orchestration projection exists for thread vanished.');
      sent.push(command);
      return { sequence: 1 };
    },
  });
  const t3 = createT3Runner({ bin: '/t3', exec, session });
  assert.equal(await t3.latestThread('/x', 'osetr'), 'e');
  assert.equal(await t3.send('e', 'текст'), true);
  // Занятый чат получает побудку steer в идущий ход, не в очередь: решает сервер T3 по deliveryIntent 'auto'.
  assert.equal(sent.at(-1).type, 'message.dispatch');
  assert.equal(sent.at(-1).deliveryIntent, 'auto');
  assert.deepEqual([sent.at(-1).threadId, sent.at(-1).text], ['e', 'текст']);
  // Каждая отправка — свой номер команды: отклонённый T3 номер не залипает на повторах.
  await t3.send('e', 'текст');
  assert.notEqual(sent.at(-1).commandId, sent.at(-2).commandId);
  // Удалённый и архивный чат T3 принял бы молча — для будильщика их нет, как и пропавшего.
  for (const gone of ['deleted', 'archived', 'missing', 'vanished']) assert.equal(await t3.send(gone, 'текст'), false, gone);
  assert.equal(sent.length, 2);
  assert.equal(await t3.start('/x', 'osetr', 'первое'), 'mcp:new');
  assert.deepEqual(calls.at(-1).args, ['thread', 'start', '/x', '-', '--title', 'osetr', '--provider', 'claudeAgent', '--model', 'claude-opus-5-5', '--json']);
  assert.equal(t3.threadId('11111111-2222-4333-8444-555555555555'), 'import:claudeAgent:11111111-2222-4333-8444-555555555555');
  assert.equal(t3.threadId('mcp:x'), 'mcp:x');
  await t3.removeProject('/x');
  assert.deepEqual(calls.at(-1).args, ['project', 'remove', '--force', '/x']);

  // Другая ошибка — не «удалён»: наружу, будильщик повторит.
  const refused = async () => { throw fail('connect ECONNREFUSED'); };
  const broken = createT3Runner({ bin: '/t3', exec: refused, session: refused });
  await assert.rejects(broken.send('e', 'x'), /ECONNREFUSED/);
  await assert.rejects(broken.removeProject('/x'), /ECONNREFUSED/);
});
