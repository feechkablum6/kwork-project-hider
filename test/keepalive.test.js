const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEAD = 'Could not establish connection. Receiving end does not exist.';
const keepalive = fs.readFileSync(path.resolve(__dirname, '../src/keepalive-content.js'), 'utf8');
const restartPage = fs.readFileSync(path.resolve(__dirname, '../src/restart.js'), 'utf8');

function runKeepalive({ body = true } = {}) {
  const frames = [];
  let tick = null;
  let ready = null;
  const chrome = { runtime: { id: 'ext', getURL: (file) => `chrome-extension://ext/${file}` } };
  const element = () => {
    const frame = { style: {}, src: '', removed: false, remove() { frame.removed = true; } };
    return frame;
  };
  const document = {
    createElement: element,
    body: body ? { append: (frame) => frames.push(frame) } : null,
    documentElement: { append: (frame) => frames.push(frame) },
    addEventListener: (type, fn) => { ready = fn; },
  };
  vm.runInNewContext(keepalive, { chrome, document, setInterval: (fn) => { tick = fn; return 1; } });
  return { chrome, document, frames, tick: () => tick(), ready: () => ready() };
}

test('страница Kwork сразу и раз в минуту подгружает скрытую служебную страницу, прошлую рамку убирает', () => {
  const page = runKeepalive();
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].src, 'chrome-extension://ext/src/restart.html');
  assert.equal(page.frames[0].style.display, 'none');
  page.tick();
  assert.equal(page.frames.length, 2);
  assert.equal(page.frames[0].removed, true);
  assert.equal(page.frames[1].removed, false);
});

test('после перезапуска расширения осиротевший скрипт продолжает подгружать рамку по прежнему адресу', () => {
  const page = runKeepalive();
  delete page.chrome.runtime.id;
  page.chrome.runtime.getURL = () => { throw new Error('Extension context invalidated.'); };
  page.tick();
  assert.equal(page.frames.at(-1).src, 'chrome-extension://ext/src/restart.html');
});

test('страница ещё без body — первая рамка после загрузки разметки', () => {
  const page = runKeepalive({ body: false });
  assert.equal(page.frames.length, 0);
  page.ready();
  assert.equal(page.frames.length, 1);
});

// Служебная страница: alive — что вернёт ping (true — фоновый скрипт ответил, строка — ошибка Chrome).
function runRestart({ answer, store = {}, now }) {
  const calls = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, callback) {
        assert.equal(message.type, 'kph-ping');
        chrome.runtime.lastError = answer === true ? undefined : { message: answer };
        callback();
        chrome.runtime.lastError = undefined;
      },
      reload: () => calls.push('reload'),
    },
    storage: { local: {
      get: (keys, callback) => callback(Object.fromEntries(keys.map((key) => [key, store[key]]))),
      set: (values, callback) => { Object.assign(store, values); callback?.(); },
      remove: (key) => { delete store[key]; },
    } },
  };
  vm.runInNewContext(restartPage, { chrome, Date: { now: () => now } });
  return { calls, store };
}

const T = 1_000_000_000;

test('фоновый скрипт молчит дольше минуты подряд, в том числе между страницами и вкладками, — перезапуск', () => {
  const store = {};
  assert.deepEqual(runRestart({ answer: DEAD, store, now: T }).calls, []);
  assert.deepEqual(runRestart({ answer: DEAD, store, now: T + 30 * 1000 }).calls, []);
  const done = runRestart({ answer: DEAD, store, now: T + 60 * 1000 });
  assert.deepEqual(done.calls, ['reload']);
  assert.equal(store.autoRestartAt, T + 60 * 1000);
  assert.equal(store.autoRestartMissSince, undefined);
});

test('ответ фонового скрипта или живого попапа сбрасывает счёт; давний промах не в счёт', () => {
  const store = {};
  runRestart({ answer: DEAD, store, now: T });
  runRestart({ answer: 'The message port closed before a response was received.', store, now: T + 30 * 1000 });
  assert.equal(store.autoRestartMissSince, undefined);
  assert.deepEqual(runRestart({ answer: DEAD, store, now: T + 60 * 1000 }).calls, []);
  assert.deepEqual(runRestart({ answer: true, store, now: T + 70 * 1000 }).calls, []);
  assert.equal(store.autoRestartMissSince, undefined);
  // Промах пятиминутной давности (страниц Kwork не было) — новая полоса.
  runRestart({ answer: DEAD, store, now: T + 100 * 1000 });
  assert.deepEqual(runRestart({ answer: DEAD, store, now: T + 400 * 1000 }).calls, []);
});

test('перезапуск не чаще раза в 10 минут; время прошлого из будущего (часы перевели назад) не держит', () => {
  const recent = { autoRestartAt: T - 5 * 60 * 1000, autoRestartMissSince: { first: T - 60 * 1000, last: T - 30 * 1000 } };
  assert.deepEqual(runRestart({ answer: DEAD, store: recent, now: T }).calls, []);
  const future = { autoRestartAt: T + 60 * 60 * 1000, autoRestartMissSince: { first: T - 60 * 1000, last: T - 30 * 1000 } };
  assert.deepEqual(runRestart({ answer: DEAD, store: future, now: T }).calls, ['reload']);
});

test('фоновый скрипт отвечает на проверку страницы Kwork сразу и первым', () => {
  const background = fs.readFileSync(path.resolve(__dirname, '../src/background.js'), 'utf8');
  const listener = background.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  assert.ok(listener > 0);
  assert.match(background.slice(listener, listener + 300), /if \(message\?\.type === 'kph-ping'\) \{\s*sendResponse\(\{ ok: true \}\);\s*return false;/);
});
