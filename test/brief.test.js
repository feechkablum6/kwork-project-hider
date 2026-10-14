// Время в сводке — по часам мака; в тестах часы зафиксированы.
process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const load = () => import('../scripts/kwork-brief.mjs');

function message(id, minute, author, text, extra = {}) {
  return {
    id: String(id),
    time: new Date(Date.UTC(2026, 9, 14, 9, minute)).toISOString(),
    authorId: author === 'client' ? '501' : '900',
    authorName: author === 'client' ? 'ivan' : 'me',
    text,
    attachments: [],
    ...extra,
  };
}

function createWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-brief-'));
  const kworkRoot = path.join(home, 'Projects', 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const orderDir = path.join(kworkRoot, 'Активные', 'shop');
  fs.mkdirSync(path.join(targetDir, 'ivan'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(orderDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(orderDir, 'CLAUDE.md'), '# Магазин\n\nПереписка: https://kwork.ru/inbox/Ivan\n');

  function writeDialog(messages) {
    fs.writeFileSync(path.join(targetDir, 'ivan', 'данные.json'), JSON.stringify({ key: 'ivan', clientId: '501', messages }));
  }

  function writeSync(status) {
    fs.writeFileSync(path.join(targetDir, 'data', '_sync.json'), JSON.stringify(status));
  }

  return { home, kworkRoot, targetDir, orderDir, writeDialog, writeSync };
}

test('чат вне заказов Kwork сводку не получает', async () => {
  const { resolveContext } = await load();

  assert.equal(resolveContext('/Users/test/Projects/Активные/app', '/Users/test/Projects/Kwork'), null);
  assert.deepEqual(resolveContext('/Users/test/Projects/Kwork', '/Users/test/Projects/Kwork'), { mode: 'root' });
  assert.equal(resolveContext('/Users/test/Projects/Kwork/Активные/shop/src', '/Users/test/Projects/Kwork').orderDir, '/Users/test/Projects/Kwork/Активные/shop');
});

test('ник клиента берётся только из ссылки на сохранённую переписку', async () => {
  const { findOrderNicks } = await load();
  const world = createWorld();
  fs.appendFileSync(path.join(world.orderDir, 'CLAUDE.md'), 'Похожий проект: https://kwork.ru/inbox/stranger\n');

  assert.deepEqual(findOrderNicks(world.orderDir, ['ivan']), ['ivan']);
});

test('ник клиента берётся и из общего списка заказов', async () => {
  const { findOrderNicks, readOrderMap } = await load();
  const world = createWorld();
  fs.writeFileSync(path.join(world.orderDir, 'CLAUDE.md'), '# Магазин\n');
  const mapPath = path.join(world.kworkRoot, 'map.md');
  fs.writeFileSync(mapPath, '# Список\n\n- shop: Ivan, petr\n- other: anna\n');

  assert.deepEqual(readOrderMap(mapPath), { shop: ['Ivan', 'petr'], other: ['anna'] });
  assert.deepEqual(findOrderNicks(world.orderDir, ['ivan', 'anna'], readOrderMap(mapPath)), ['ivan']);
});

test('в начале сессии агент видит хвост переписки, дальше только новое', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  const stateDir = path.join(world.home, 'state');
  const options = { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir, now: Date.UTC(2026, 9, 14, 10, 0) };
  world.writeSync({ ok: true, at: new Date(options.now - 60000).toISOString() });
  world.writeDialog([message(1, 0, 'client', 'Нужен магазин'), message(2, 5, 'me', 'Сделаю за неделю')]);

  const start = runBrief({ session_id: 's1', cwd: path.join(world.orderDir, 'src'), hook_event_name: 'SessionStart' }, options);
  assert.match(start, /Переписка Kwork с ivan/);
  assert.match(start, /Последним писал я 14\.10 12:05/);
  assert.match(start, /\[клиент 14\.10 12:00\] Нужен магазин/);

  const quiet = runBrief({ session_id: 's1', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' }, options);
  assert.equal(quiet, null);

  world.writeDialog([
    message(1, 0, 'client', 'Нужен магазин'),
    message(2, 5, 'me', 'Сделаю за неделю'),
    message(3, 40, 'client', 'Вот макет', { attachments: [{ id: 'f1', name: 'макет.png', url: 'https://kwork.ru/files/uploaded/1/макет.png' }] }),
  ]);

  const fresh = runBrief({ session_id: 's1', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' }, options);
  assert.match(fresh, /Новое с прошлого раза:/);
  assert.match(fresh, /\[клиент 14\.10 12:40\] Вот макет/);
  assert.match(fresh, /файл «макет\.png» ещё качается/);
  assert.match(fresh, /ждёт ответа 20 мин/);
  assert.doesNotMatch(fresh, /Нужен магазин/);
});

test('сводка предупреждает, что автосохранение давно не шло', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  const now = Date.UTC(2026, 9, 14, 10, 0);
  world.writeSync({ ok: true, at: new Date(now - 3 * 60 * 60 * 1000).toISOString() });
  world.writeDialog([message(1, 0, 'client', 'Привет')]);

  const text = runBrief(
    { session_id: 's2', cwd: world.orderDir, hook_event_name: 'SessionStart' },
    { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir: path.join(world.home, 'state'), now },
  );

  assert.match(text, /^Автосохранение переписок не шло с 14\.10 10:00/);
});

test('битая переписка на диске не ломает хук', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  fs.writeFileSync(path.join(world.targetDir, 'ivan', 'данные.json'), '{"messages": [');

  assert.doesNotThrow(() => runBrief(
    { session_id: 's3', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' },
    { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir: path.join(world.home, 'state') },
  ));
});

test('в корне Kwork видны клиенты, которые ждут ответа', async () => {
  const { buildRootBrief } = await load();
  const now = Date.UTC(2026, 9, 14, 10, 0);
  const text = buildRootBrief([
    { slug: 'ivan', record: { key: 'ivan', clientId: '501', messages: [message(1, 0, 'client', 'Когда будет?')] } },
    { slug: 'petr', record: { key: 'petr', clientId: '777', messages: [message(2, 0, 'me', 'Готово')] } },
  ], now);

  assert.match(text, /- ivan: ждёт 1 ч — «Когда будет\?»/);
  assert.doesNotMatch(text, /petr/);
});

test('рабочая копия T3 сводится к папке заказа', async () => {
  const { normalizeWorkspace } = await load();
  const world = createWorld();

  assert.equal(normalizeWorkspace(path.join(world.home, '.t3', 'worktrees', 'Kwork', 't3-abc', 'Активные', 'shop'), world.kworkRoot, world.home), path.join(world.kworkRoot, 'Активные', 'shop'));
  assert.equal(normalizeWorkspace(path.join(world.home, '.t3', 'worktrees', 'shop', 't3-abc', 'src'), world.kworkRoot, world.home), path.join(world.orderDir, 'src'));
  assert.equal(normalizeWorkspace(path.join(world.home, '.t3', 'worktrees', 'other', 't3-abc'), world.kworkRoot, world.home), path.join(world.home, '.t3', 'worktrees', 'other', 't3-abc'));
});

test('файл, который качался, сообщается, когда ляжет на диск', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  const options = { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir: path.join(world.home, 'state'), now: Date.UTC(2026, 9, 14, 10, 0) };
  world.writeSync({ ok: true, at: new Date(options.now).toISOString() });
  world.writeDialog([message(3, 40, 'client', 'Вот макет', { attachments: [{ id: 'f1', name: 'макет.png', url: 'https://kwork.ru/files/uploaded/1/макет.png' }] })]);

  const start = runBrief({ session_id: 's5', cwd: world.orderDir, hook_event_name: 'SessionStart' }, options);
  assert.match(start, /ещё качается/);

  fs.mkdirSync(path.join(world.targetDir, 'ivan', 'файлы'), { recursive: true });
  fs.writeFileSync(path.join(world.targetDir, 'ivan', 'файлы', '2026-10-14 12-40-00 макет.png'), 'png');

  const next = runBrief({ session_id: 's5', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' }, options);
  assert.match(next, /Догрузились файлы клиента:\n  файл: .*макет\.png/);
  assert.equal(runBrief({ session_id: 's5', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' }, options), null);
});

test('неотправленный черновик виден в сводке заказа', async () => {
  const { describePendingDrafts } = await load();
  const text = describePendingDrafts([{ kind: 'message', nicks: ['ivan'], at: '2026-10-14T09:40:00.000Z' }], ['ivan']);

  assert.match(text, /Черновик клиенту от 14\.10 12:40 в переписке пока не появился/);
  assert.equal(describePendingDrafts([{ kind: 'message', nicks: ['petr'], at: '2026-10-14T09:40:00.000Z' }], ['ivan']), null);
});

test('хук сводки запускается командой и отдаёт JSON для Claude Code', async () => {
  const { spawnSync } = require('node:child_process');
  const world = createWorld();
  world.writeSync({ ok: true, at: new Date().toISOString() });
  world.writeDialog([message(1, 0, 'client', 'Нужен магазин')]);

  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'kwork-brief.mjs')], {
    input: JSON.stringify({ session_id: 'cli1', cwd: world.orderDir, hook_event_name: 'SessionStart' }),
    env: { ...process.env, HOME: world.home, KPH_CHATS_DIR: world.targetDir },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /unsettled/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /Нужен магазин/);
});

test('длинная пачка новых сообщений не теряет последние', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  const options = { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir: path.join(world.home, 'state'), now: Date.UTC(2026, 9, 14, 10, 0) };
  world.writeSync({ ok: true, at: new Date(options.now).toISOString() });
  world.writeDialog([message(1, 0, 'client', 'Нужен магазин')]);
  runBrief({ session_id: 's6', cwd: world.orderDir, hook_event_name: 'SessionStart' }, options);

  const many = Array.from({ length: 12 }, (_, index) => message(10 + index, 10 + index, 'client', `Требование ${index + 1}: ${'подробности '.repeat(55)}`));
  world.writeDialog([message(1, 0, 'client', 'Нужен магазин'), ...many]);

  const text = runBrief({ session_id: 's6', cwd: world.orderDir, hook_event_name: 'UserPromptSubmit' }, options);
  assert.match(text, /Требование 12:/);
  assert.match(text, /ещё \d+ раньше — в полной переписке/);
  assert.doesNotMatch(text, /…$/);
  assert.ok(text.length <= 6000, `длина ${text.length}`);
});

test('в корне Kwork агент узнаёт, что ожидающих ответа больше нет', async () => {
  const { runBrief } = await load();
  const world = createWorld();
  let now = Date.UTC(2026, 9, 14, 10, 0);
  const options = () => ({ home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, stateDir: path.join(world.home, 'state'), now });
  world.writeSync({ ok: true, at: new Date(now).toISOString() });
  world.writeDialog([message(1, 0, 'client', 'Когда будет?')]);

  const start = runBrief({ session_id: 'r1', cwd: world.kworkRoot, hook_event_name: 'SessionStart' }, options());
  assert.match(start, /ivan: ждёт/);

  world.writeDialog([message(1, 0, 'client', 'Когда будет?'), message(2, 50, 'me', 'Завтра')]);
  now += 60 * 60 * 1000;
  const touched = new Date(now - 60000);
  fs.utimesSync(path.join(world.targetDir, 'ivan', 'данные.json'), touched, touched);
  world.writeSync({ ok: true, at: new Date(now).toISOString() });
  const next = runBrief({ session_id: 'r1', cwd: world.kworkRoot, hook_event_name: 'UserPromptSubmit' }, options());
  assert.match(next, /ответа больше никто не ждёт/);
});
