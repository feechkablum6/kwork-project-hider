const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  REFRESH_MS,
  buildSession,
  cleanCookies,
  handleSessionSync,
  pushOverSsh,
  resolveTarget,
} = require('../native_host/session-push.js');

const COOKIES = [
  { name: 'sid', value: 'abc', domain: 'kwork.ru' },
  { name: 'remember', value: 'xyz', domain: '.kwork.ru' },
  { name: '_ym_uid', value: '1', domain: '.kwork.ru' },
  { name: 'evil', value: 'x', domain: 'example.com' },
  { name: 'bad', value: 'a;b', domain: 'kwork.ru' },
];

function tempState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kph-session-')), 'state.json');
}

test('чужие домены и значения с ; отбрасываются', () => {
  assert.deepEqual(cleanCookies(COOKIES).map((c) => c.name), ['sid', 'remember', '_ym_uid']);
});

test('сессия — строка Cookie без повторов имён', () => {
  const s = buildSession(
    [...cleanCookies(COOKIES), { name: 'sid', value: 'other', domain: 'kwork.ru' }],
    'Chrome/154',
    Date.UTC(2026, 8, 28),
  );
  assert.equal(s.cookie, 'sid=abc; remember=xyz; _ym_uid=1');
  assert.equal(s.userAgent, 'Chrome/154');
  assert.equal(s.updatedAt, '2026-09-28T00:00:00.000Z');
});

test('без изменений повторно не отправляет, аналитика изменением не считается', async () => {
  const statePath = tempState();
  const sent = [];
  const push = async (target, body) => sent.push({ target, body: JSON.parse(body) });
  const now = Date.UTC(2026, 8, 28);

  assert.deepEqual(await handleSessionSync({ cookies: COOKIES }, { statePath, push, now }), { pushed: true });
  assert.equal(sent[0].target.sshHost, 'firstbyte');
  assert.equal(sent[0].target.path, '/srv/apps/kwork-hunter/data/kwork-session.json');
  assert.match(sent[0].body.cookie, /sid=abc/);

  const noisy = COOKIES.map((c) => (c.name === '_ym_uid' ? { ...c, value: '2' } : c));
  assert.deepEqual(await handleSessionSync({ cookies: noisy }, { statePath, push, now: now + 1000 }), { skipped: 'без изменений' });

  const relogin = COOKIES.map((c) => (c.name === 'sid' ? { ...c, value: 'new' } : c));
  assert.deepEqual(await handleSessionSync({ cookies: relogin }, { statePath, push, now: now + 2000 }), { pushed: true });

  assert.deepEqual(await handleSessionSync({ cookies: relogin }, { statePath, push, now: now + 2000 + REFRESH_MS }), { pushed: true });
  assert.equal(sent.length, 3);

  const saved = fs.readFileSync(statePath, 'utf8');
  assert.doesNotMatch(saved, /abc|new|xyz/, 'на маке хранится только отпечаток, не куки');
});

test('без кук входа ничего не отправляет', async () => {
  const push = async () => assert.fail('не должно отправлять');
  const result = await handleSessionSync({ cookies: [{ name: '_ga', value: '1', domain: 'kwork.ru' }] }, { statePath: tempState(), push });
  assert.deepEqual(result, { skipped: 'нет кук входа' });
});

test('ошибка отправки не запоминает отпечаток — следующая попытка снова отправит', async () => {
  const statePath = tempState();
  await assert.rejects(handleSessionSync({ cookies: COOKIES }, { statePath, push: async () => { throw new Error('offline'); } }));
  let pushed = 0;
  await handleSessionSync({ cookies: COOKIES }, { statePath, push: async () => { pushed += 1; } });
  assert.equal(pushed, 1);
});

test('путь и сервер из настроек проверяются, подстановка команд невозможна', () => {
  assert.throws(() => resolveTarget({ sessionTarget: { path: "/tmp/x.json'; rm -rf /; '" } }));
  assert.throws(() => resolveTarget({ sessionTarget: { sshHost: 'host; reboot' } }));
  assert.deepEqual(resolveTarget({ sessionTarget: { sshHost: 'vps', path: '/srv/a/data/s.json' } }), { sshHost: 'vps', path: '/srv/a/data/s.json' });
});

test('ssh получает тело на вход и пишет файл атомарно', async () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    let body = '';
    child.stdin = Object.assign(new EventEmitter(), {
      end(data) {
        body = data;
        process.nextTick(() => child.emit('close', 0));
      },
    });
    child.kill = () => {};
    calls.push({ cmd, args, get body() { return body; } });
    return child;
  };
  await pushOverSsh({ sshHost: 'firstbyte', path: '/srv/k/data/s.json' }, '{"cookie":"a=b"}', spawnFn);
  assert.equal(calls[0].cmd, '/usr/bin/ssh');
  assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.equal(calls[0].args.at(-2), 'firstbyte');
  assert.equal(calls[0].args.at(-1), "umask 077 && cat > '/srv/k/data/s.json.tmp' && mv '/srv/k/data/s.json.tmp' '/srv/k/data/s.json'");
  assert.equal(calls[0].body, '{"cookie":"a=b"}');
});

test('ssh закрылся, не дочитав тело: ошибка записи не роняет мост', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end() {
        process.nextTick(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      },
    });
    child.kill = () => {};
    return child;
  };

  await assert.rejects(pushOverSsh({ sshHost: 'firstbyte', path: '/srv/x.json' }, 'тело', spawnFn), /EPIPE/);
});
