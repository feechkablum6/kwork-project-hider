const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const health = require('../native_host/health.js');
const { projectSlug } = require('../native_host/claude-runner.js');

const NOW = Date.parse('2026-11-10T10:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

function facts(patch = {}) {
  return {
    now: NOW,
    manifestVersion: '1.33.0',
    bridge: { pid: 1, node: 'v24.0.0', at: ago(5000), wakerAt: ago(3000) },
    bridgeAlive: true,
    launcherNode: { path: '/opt/homebrew/opt/node/bin/node', exists: true },
    extension: { version: '1.33.0', at: ago(1000), tabs: [{ site: 'kwork', path: 'kwork.ru/inbox', state: 'ok' }, { site: 'yougile', path: 'ru.yougile.com/team', state: 'ok' }], pullAt: null, blockedUntil: 0 },
    sync: { ok: true, at: ago(60 * 1000) },
    yougileRouted: true,
    desktopRunning: true,
    dispatcher: { configured: true, inDesktop: true, pid: 77 },
    inboundAccept: true,
    pending: [],
    ...patch,
  };
}

const dead = (patch) => health.evaluate(facts(patch)).filter((link) => !link.ok).map((link) => link.id);

test('живая цепочка — мёртвых звеньев нет', () => {
  assert.deepEqual(dead(), []);
});

test('мост: старый пульс или мёртвый процесс — мертво, вкладки без отчёта не судятся', () => {
  assert.deepEqual(dead({ bridge: { pid: 1, node: 'v24', at: ago(5 * 60 * 1000) } }), ['bridge', 'extension']);
  assert.deepEqual(dead({ bridgeAlive: false }), ['bridge', 'extension']);
  assert.deepEqual(dead({ launcherNode: { path: '/gone/node', exists: false } }), ['node']);
});

test('расширение: не перезагружено после обновления — мертво', () => {
  const links = health.evaluate(facts({ manifestVersion: '1.34.0' }));
  assert.match(links.find((link) => link.id === 'extension').detail, /работает версия 1\.33\.0, на диске 1\.34\.0/);
  assert.deepEqual(dead({ extension: null }), ['extension']);
});

test('вкладка без скрипта (05.11.2026) и YouGile без открытой вкладки — мертво; спящая вкладка — нет', () => {
  const tab = (site, state) => ({ site, path: `${site}/x`, state });
  const withTabs = (tabs, more = {}) => dead({ extension: { ...facts().extension, tabs }, ...more });
  assert.deepEqual(withTabs([tab('kwork', 'ok'), tab('yougile', 'silent')]), ['tabs-yougile']);
  assert.deepEqual(withTabs([tab('kwork', 'silent'), tab('yougile', 'ok')]), ['tabs-kwork']);
  assert.deepEqual(withTabs([tab('kwork', 'ok')]), ['tabs-yougile']);
  assert.deepEqual(withTabs([tab('kwork', 'ok'), tab('yougile', 'sleep')]), ['tabs-yougile']);
  assert.deepEqual(withTabs([tab('kwork', 'sleep')], { yougileRouted: false }), []);
});

test('новые сообщения: молчащий канал при свежем проходе — живо; блок Kwork и стоящий проход — мертво', () => {
  assert.deepEqual(dead({ sync: { ok: true, at: ago(20 * 60 * 1000) } }), ['incoming']);
  assert.deepEqual(dead({ sync: { ok: true, at: ago(20 * 60 * 1000) }, extension: { ...facts().extension, pullAt: ago(60 * 1000) } }), []);
  assert.deepEqual(dead({ extension: { ...facts().extension, blockedUntil: NOW + 60000 } }), ['incoming']);
});

test('новые сообщения: свежий проход «вышли из Kwork» или с ошибкой — мертво, причина названа', () => {
  const detail = (sync) => health.evaluate(facts({ sync })).find((link) => link.id === 'incoming');
  assert.deepEqual(dead({ sync: { ok: false, signedOut: true, at: ago(1000) } }), ['incoming']);
  assert.match(detail({ ok: false, signedOut: true, at: ago(1000) }).detail, /вышли из Kwork/);
  assert.equal(detail({ ok: false, error: 'HTTP 500', at: ago(1000) }).ok, false);
  assert.match(detail({ ok: false, error: 'HTTP 500', at: ago(1000) }).detail, /HTTP 500/);
});

test('будильщик: тактов нет или давно не было при живом мосте — мертво', () => {
  const bridge = facts().bridge;
  assert.deepEqual(dead({ bridge: { ...bridge, wakerAt: null } }), ['waker']);
  assert.deepEqual(dead({ bridge: { ...bridge, wakerAt: ago(5 * 60 * 1000) } }), ['waker']);
});

test('диспетчер: чат без процесса (27.10.2026) — мертво, и причина названа', () => {
  const links = health.evaluate(facts({ dispatcher: { configured: true, inDesktop: true, pid: null } }));
  const link = links.find((item) => item.id === 'dispatcher');
  assert.equal(link.ok, false);
  assert.match(link.detail, /спит/);
  assert.deepEqual(dead({ desktopRunning: false, dispatcher: { configured: true, inDesktop: true, pid: null } }), ['dispatcher']);
  assert.deepEqual(dead({ inboundAccept: false }), ['inbound']);
});

test('побудка в пути дольше 10 минут — мертво, свежая — нет', () => {
  assert.deepEqual(dead({ pending: [{ slug: 'ivan', since: NOW - 60 * 1000 }] }), []);
  const links = health.evaluate(facts({ pending: [{ slug: 'ivan', since: NOW - 34 * 60 * 1000, error: 'диспетчер спит' }] }));
  assert.match(links.find((link) => link.id === 'pending').detail, /ivan ждёт 34 мин \(диспетчер спит\)/);
});

test('мост: пульс раз в 10 с, заявка проверки — один push расширению, отчёт ложится в файл', () => {
  const serviceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-health-'));
  const dir = path.join(serviceDir, health.HEALTH_DIR);
  const sent = [];
  let now = NOW;
  const beat = health.createHealthBeat({ serviceDir, send: (message) => sent.push(message), now: () => now });
  beat.wakerDone();
  beat.tick();
  const pulse = JSON.parse(fs.readFileSync(path.join(dir, health.BRIDGE_FILE), 'utf8'));
  assert.equal(pulse.pid, process.pid);
  assert.equal(pulse.wakerAt, new Date(NOW).toISOString());
  assert.deepEqual(sent, []);

  fs.writeFileSync(path.join(dir, health.REQUEST_FILE), '');
  beat.tick();
  beat.tick();
  assert.deepEqual(sent, [{ push: 'health' }]);

  now += 1000;
  beat.save({ version: '1.33.0', tabs: [] });
  const report = JSON.parse(fs.readFileSync(path.join(dir, health.EXTENSION_FILE), 'utf8'));
  assert.equal(report.version, '1.33.0');
  assert.equal(report.at, new Date(now).toISOString());
  fs.rmSync(serviceDir, { recursive: true, force: true });
});

test('пробная побудка убирает за собой: папки заказов, строки списка, переписку, журналы чатов; чужое не трогает', async () => {
  const { cleanupTrial, prepareTrial } = await import('../scripts/kwork-health.mjs');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-trial-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const projectsDir = path.join(home, 'projects');
  const where = { targetDir, kworkRoot, serviceDir: path.join(targetDir, 'data') };
  const mapPath = path.join(kworkRoot, 'docs', 'заказы-клиенты.md');
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'Активные', 'shop'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'ivan'), { recursive: true });
  fs.writeFileSync(mapPath, '# Заказы\n\n- shop: ivan (выкладка: да)\n');

  // Остатки прерванной пробы: папка, её журнал, строка, старая переписка.
  const stale = path.join(kworkRoot, 'Активные', 'kph-proverka-a-old1');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(path.join(projectsDir, projectSlug(stale)), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'kph-selftest'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'kph-selftest', 'данные.json'), JSON.stringify({ messages: [{ id: 'старое' }] }));
  fs.appendFileSync(mapPath, '- kph-proverka-a-old1: kph-selftest (выкладка: нет)\nне строка заказа\n');

  const trial = prepareTrial(where, projectsDir);
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(fs.readdirSync(projectsDir), []);
  assert.doesNotMatch(fs.readFileSync(mapPath, 'utf8'), /old1/);
  assert.equal(JSON.parse(fs.readFileSync(trial.file, 'utf8')).messages.length, 1);
  assert.match(fs.readFileSync(mapPath, 'utf8'), /kph-proverka-a-[a-z0-9]+: kph-selftest \(выкладка: нет\)/);
  for (const dir of trial.dirs) fs.mkdirSync(path.join(projectsDir, projectSlug(dir)), { recursive: true });

  // Диспетчер убрал в архив один чат из двух: второй назван, остальное убрано.
  let chats = new Map(trial.dirs.map((dir, index) => [`cli-${index}`, { localId: `local_${index}`, cwd: dir, title: path.basename(dir) }]));
  chats.set('disp', { localId: 'local_disp', cwd: home });
  fs.writeFileSync(path.join(where.serviceDir, 'dispatcher.json'), JSON.stringify({ localId: 'local_disp' }));
  const sent = [];
  // Будильщик снимает побудку на третьей паузе: до этого уборка файлы не трогает.
  fs.writeFileSync(path.join(where.serviceDir, 'wake-state.json'), JSON.stringify({ pending: { 'kph-selftest': {} } }));
  let pauses = 0;
  const pause = async () => {
    pauses += 1;
    if (pauses === 3) {
      assert.equal(fs.existsSync(trial.dirs[0]), true);
      fs.writeFileSync(path.join(where.serviceDir, 'wake-state.json'), '{}');
      fs.rmSync(path.join(where.serviceDir, 'wake-dirty'), { recursive: true });
    }
  };
  const runner = {
    desktopChats: () => chats,
    openChat: () => ({ pid: 1 }),
    deliver: async (open, text) => {
      sent.push(text);
      chats.get('cli-0').archived = true;
    },
  };
  const left = await cleanupTrial(where, trial, { runner, projectsDir, pause });
  assert.deepEqual(sent, ['[Kwork-диспетчер] убрать проверочные чаты\nубрать: local_0\nубрать: local_1']);
  assert.match(left.join(), /^kph-proverka-b-[a-z0-9]+$/);
  assert.equal(fs.readFileSync(mapPath, 'utf8'), '# Заказы\n\n- shop: ivan (выкладка: да)\nне строка заказа\n');
  assert.deepEqual(fs.readdirSync(path.join(kworkRoot, 'Активные')), ['shop']);
  assert.deepEqual(fs.readdirSync(targetDir).sort(), ['data', 'ivan']);
  assert.deepEqual(fs.readdirSync(projectsDir), []);
  fs.rmSync(home, { recursive: true, force: true });
});
