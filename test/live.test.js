const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../src/live-main.js'), 'utf8');

// Страница Kwork: pathname, ответ getnewtracks, самый новый трек на странице заказа,
// последний элемент диалога в списке и сообщения открытой переписки.
function runLive({ pathname = '/inbox/client', response = null, maxTrackId = 100, chat = null, messages = [], deferTimers = false } = {}) {
  const timers = [];
  const calls = { restore: 0, orderTracks: [], posts: [], triggers: [] };
  let tick = null;
  let now = 1_000_000;
  const listeners = {};
  const stream = { onmessage: () => 'kwork' };
  const conversation = {
    conversationUserId: 42,
    messages,
    onNewOrderTrack: (event) => calls.orderTracks.push(event),
  };
  const jQuery = (target) => ({ trigger: (name, args) => calls.triggers.push({ target, name, args }) });
  jQuery.post = (url, data) => {
    calls.posts.push({ url, data });
    const chain = {
      done: (fn) => { fn(response); return chain; },
      always: (fn) => { fn(); return chain; },
    };
    return chain;
  };
  const document = {
    visibilityState: 'visible',
    querySelector: (selector) => (selector === '.conversation-messages-list' ? { __vue__: conversation } : null),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const window = {
    location: { pathname },
    PushStreamManager: [stream],
    bus: { $emit: (name) => { if (name === 'pushsteam-connection-restore') calls.restore += 1; } },
    appChatList: { $refs: { chatList: { chatList: chat ? [chat] : [] } } },
    jQuery,
    Track: { orderId: 7 },
    appTracks: { $refs: { trackList: { getMaxTrackId: () => maxTrackId } } },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  vm.runInNewContext(source, {
    window,
    document,
    setInterval: (fn) => { tick = fn; return 1; },
    // Список диалогов «успел» обновиться сразу, если ожидание не отложено тестом.
    setTimeout: (fn) => { if (deferTimers) timers.push(fn); else fn(); return 1; },
    Date: { now: () => now },
  });
  return {
    calls,
    document,
    stream,
    installed: Boolean(tick),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
    wait: (ms) => { now += ms; },
    tick: () => { now += 20_000; tick(); },
    focus: () => { now += 20_000; listeners.focus(); },
  };
}

test('открытая переписка сама догоняет пропущенное тем же путём, что сайт после обрыва канала, пока вкладка видна', () => {
  const page = runLive();
  page.tick();
  page.tick();
  assert.equal(page.calls.restore, 2);

  page.document.visibilityState = 'hidden';
  page.tick();
  assert.equal(page.calls.restore, 2);

  page.document.visibilityState = 'visible';
  page.focus();
  assert.equal(page.calls.restore, 3);
});

test('пока живой канал присылает события, опрос молчит; канал замолчал на 2 минуты — опрос возвращается', () => {
  const page = runLive();
  page.tick();
  assert.equal(page.stream.onmessage('{}', 5, 'cnl'), 'kwork');
  page.tick();
  assert.equal(page.calls.restore, 1);

  page.wait(2 * 60 * 1000);
  page.tick();
  assert.equal(page.calls.restore, 2);
});

test('вкладку скрыли, пока ждали список диалогов, — сообщение заказа не дорисовывается', () => {
  const chat = { USERID: 42, type: 'track', MID: 500, MSGFROM: 42, MSGTO: 1 };
  const page = runLive({ chat, deferTimers: true });
  page.tick();
  page.document.visibilityState = 'hidden';
  page.runTimers();
  assert.equal(page.calls.orderTracks.length, 0);

  // Вернулись — дорисовка на следующем проходе.
  page.document.visibilityState = 'visible';
  page.tick();
  page.runTimers();
  assert.equal(page.calls.orderTracks.length, 1);
});

test('сообщение заказа, которого нет в открытой переписке, сайт дорисовывает своим разбором, один раз', () => {
  const chat = { USERID: '42', type: 'track', MID: 500, MSGFROM: '42', MSGTO: 1, lastMessage: { type_id: 1 } };
  const page = runLive({ chat, messages: [{ MID: 499 }] });
  page.tick();
  assert.equal(page.calls.orderTracks.length, 1);
  const event = page.calls.orderTracks[0];
  assert.equal(event.track_id, 500);
  assert.equal(event.from_user_id, '42');
  assert.equal(event.to_user_id, 1);

  page.tick();
  assert.equal(page.calls.orderTracks.length, 1);
});

test('последнее сообщение уже на странице или оно личное — сообщение заказа не дорисовывается', () => {
  const shown = runLive({ chat: { USERID: 42, type: 'track', MID: 500, MSGFROM: 42, MSGTO: 1 }, messages: [{ MID: 500 }] });
  shown.tick();
  assert.equal(shown.calls.orderTracks.length, 0);

  const inbox = runLive({ chat: { USERID: 42, type: 'inbox', MID: 600, MSGFROM: 42, MSGTO: 1 } });
  inbox.tick();
  assert.equal(inbox.calls.orderTracks.length, 0);
});

test('страница заказа перерисовывается сайтом только при новом видимом треке и один раз на трек', () => {
  const page = runLive({
    pathname: '/track',
    response: { success: true, tracksToAdd: [{ id: 100, type: 24 }, { id: 101 }, { id: 102, isHiddenConversation: true }] },
  });
  page.tick();
  // Объект запроса создан в другом контексте vm — сравнение по полям.
  const { url, data } = page.calls.posts[0];
  assert.equal(url, 'api/track/getnewtracks');
  assert.equal(data.orderId, 7);
  assert.equal(data.lastTrackId, 100);
  assert.equal(data.withData, true);
  assert.equal(page.calls.triggers.length, 1);
  assert.equal(page.calls.triggers[0].name, 'refresh_track.pull');
  assert.equal(page.calls.triggers[0].args[0].order_id, 7);
  assert.equal(page.calls.restore, 1);

  // Сайт трек не нарисовал (getMaxTrackId всё ещё 100) — повторной перерисовки нет.
  page.tick();
  assert.equal(page.calls.posts.length, 2);
  assert.equal(page.calls.triggers.length, 1);
});

test('ответ без данных треков (словарь номеров) тоже узнаётся', () => {
  const page = runLive({ pathname: '/track', response: { success: true, tracksToAdd: { 100: '', 101: '' } } });
  page.tick();
  assert.equal(page.calls.triggers.length, 1);
});

test('нового трека нет — страница заказа не перерисовывается', () => {
  const page = runLive({ pathname: '/track', response: { success: true, tracksToAdd: [{ id: 100, type: 24 }] } });
  page.tick();
  assert.equal(page.calls.posts.length, 1);
  assert.equal(page.calls.triggers.length, 0);
});

test('на прочих страницах Kwork опрос не ставится', () => {
  assert.equal(runLive({ pathname: '/projects' }).installed, false);
  assert.equal(runLive({ pathname: '/inbox' }).installed, true);
});
