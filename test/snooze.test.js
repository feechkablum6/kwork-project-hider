process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snooze = require('../native_host/snooze.js');
const wakeCore = require('../native_host/wake-core.js');
const { createWaker } = require('../native_host/waker.js');
const { handleCommand } = require('../native_host/store.js');
const { createFakeClaude } = require('./helpers/fake-claude.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-23T10:00:00Z');

test('срок отметки: часы, дни, минуты и точное время; не дольше трёх суток', () => {
  assert.equal(snooze.parseSnoozeUntil('24h', NOW), NOW + 24 * HOUR);
  assert.equal(snooze.parseSnoozeUntil('3d', NOW), NOW + 72 * HOUR);
  assert.equal(snooze.parseSnoozeUntil('90m', NOW), NOW + 90 * 60 * 1000);
  assert.equal(snooze.parseSnoozeUntil('2026-10-24T07:00:00Z', NOW), Date.parse('2026-10-24T07:00:00Z'));
  assert.equal(snooze.parseSnoozeUntil('4d', NOW), null);
  assert.equal(snooze.parseSnoozeUntil('2026-10-23T09:00:00Z', NOW), null);
  assert.equal(snooze.parseSnoozeUntil('завтра', NOW), null);
});

function message(id, minute, author, text) {
  return {
    id: String(id),
    time: new Date(Date.UTC(2026, 9, 23, 9, minute)).toISOString(),
    authorId: author === 'client' ? '501' : '900',
    authorName: author === 'client' ? 'ivan' : 'me',
    text,
    attachments: [],
  };
}

function createWorld() {
  let clock = NOW;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-snooze-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const orderDir = path.join(kworkRoot, 'Активные', 'shop');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), '- shop: ivan\n');
  const save = (messages) => handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: '501', messages } });
  const claude = createFakeClaude({ home, now: () => clock });
  // Пользователь в Desktop — чат заказа в список Desktop не попадает, побудки идут фоновым агентом.
  claude.front = true;
  const logs = [];
  const waker = createWaker({ targetDir, kworkRoot, runner: claude.runner, log: (line) => logs.push(line), now: () => clock });
  const serviceDir = path.join(targetDir, 'data');
  const stateOf = () => JSON.parse(fs.readFileSync(path.join(serviceDir, 'wake-state.json'), 'utf8'));
  return { save, claude, runs: claude.runs, waker, logs, serviceDir, orderDir, stateOf, advance: (ms) => { clock += ms; }, now: () => clock };
}

// Клиент написал, агент разбужен и отметил «ждём клиента» на сутки.
async function worldWaitingForClient() {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  world.save([message(1, 0, 'me', 'жду'), message(2, 1, 'client', 'вопрос')]);
  await world.waker.tick();
  assert.equal(world.runs.length, 1);
  world.advance(60 * 1000);
  snooze.writeRequest(world.serviceDir, { key: world.orderDir, until: world.now() + 24 * HOUR, at: world.now() });
  await world.waker.tick();
  return world;
}

test('заявка агента переезжает в состояние будильщика как отметка «ждём клиента»', async () => {
  const world = await worldWaitingForClient();
  assert.deepEqual(world.stateOf().snoozed[world.orderDir], { until: world.now() + 24 * HOUR, at: world.now() });
  assert.deepEqual(snooze.listRequests(world.serviceDir), []);
  assert.equal(world.runs.length, 1);

  // Срок вышел — отметка уходит сама.
  world.advance(25 * HOUR);
  await world.waker.tick();
  assert.deepEqual(world.stateOf().snoozed, {});
});

test('заявка, оставленная до нового запуска агента, устарела и отметки не ставит', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'жду')]);
  await world.waker.tick();
  const at = world.now();
  world.advance(60 * 1000);
  world.save([message(1, 0, 'me', 'жду'), message(2, 1, 'client', 'вопрос')]);
  await world.waker.tick();
  assert.equal(world.runs.length, 1);
  // Заявка датирована раньше запуска, который уже идёт: клиент успел ответить.
  snooze.writeRequest(world.serviceDir, { key: world.orderDir, until: world.now() + 24 * HOUR, at });
  await world.waker.tick();
  assert.deepEqual(world.stateOf().snoozed, {});
  assert.deepEqual(snooze.listRequests(world.serviceDir), []);
});

test('клиент ответил по отмеченному маршруту — агент будится, отметка снята', async () => {
  const world = await worldWaitingForClient();
  world.advance(2 * HOUR);
  world.save([message(1, 0, 'me', 'жду'), message(2, 1, 'client', 'вопрос'), message(3, 30, 'client', 'ок, посмотрю вечером')]);
  await world.waker.tick();
  assert.equal(world.runs.length, 2);
  assert.deepEqual(world.runs[1].args.slice(0, 3), ['-p', '--resume', world.runs[0].sessionId]);
  assert.match(world.runs[1].text, /ок, посмотрю вечером/);
  assert.ok(world.logs.some((line) => /отметка «ждём клиента» снята/.test(line)));
  assert.deepEqual(world.stateOf().snoozed, {});
});

test('чат держит терминал, а клиент ответил по отмеченному маршруту — агент не запущен, отметка снята', async () => {
  const world = await worldWaitingForClient();
  // Пользователь продолжил чат в терминале и написал в нём уже после нашего запуска.
  world.claude.holdInTerminal(world.runs[0].sessionId);
  world.advance(5 * 60 * 1000);
  world.claude.say(world.orderDir, world.runs[0].sessionId, world.now() - 60 * 1000);
  world.save([message(1, 0, 'me', 'жду'), message(2, 1, 'client', 'вопрос'), message(3, 3, 'client', 'ок, посмотрю вечером')]);
  await world.waker.tick();
  assert.equal(world.runs.length, 1);
  assert.ok(world.logs.some((line) => /занят процессом вне Desktop — пропущено, отметка «ждём клиента» снята/.test(line)));
  assert.deepEqual(world.stateOf().snoozed, {});
});

test('команда агента оставляет заявку будильщику и объясняет неверный срок', async () => {
  const { runSnooze } = await import('../scripts/kwork-snooze.mjs');
  const chatsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-snooze-cli-'));
  const previous = process.env.KPH_CHATS_DIR;
  process.env.KPH_CHATS_DIR = chatsDir;
  try {
    const ok = runSnooze(['/k/Активные/shop', '24h'], { now: NOW });
    assert.equal(ok.code, 0);
    assert.match(ok.text, /24\.10 13:00/);
    assert.deepEqual(snooze.listRequests(path.join(chatsDir, 'data')).map((item) => [item.key, item.until, item.at]), [['/k/Активные/shop', NOW + 24 * HOUR, NOW]]);

    assert.equal(runSnooze(['/k/Активные/shop', '5d'], { now: NOW }).code, 2);
    assert.equal(runSnooze(['/k/Активные/shop'], { now: NOW }).code, 2);
  } finally {
    if (previous === undefined) delete process.env.KPH_CHATS_DIR;
    else process.env.KPH_CHATS_DIR = previous;
  }
});
