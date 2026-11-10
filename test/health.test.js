const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const health = require('../native_host/health.js');

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
