process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const { createWaker } = require('../native_host/waker.js');
const { handleCommand } = require('../native_host/store.js');
const { createFakeClaude } = require('./helpers/fake-claude.js');

// Свои сообщения — как в настоящей переписке: адресат — клиент.
function message(id, minute, author, text, extra = {}) {
  const client = author === 'client';
  return {
    id: String(id),
    time: new Date(Date.UTC(2026, 9, 22, 9, minute)).toISOString(),
    authorId: client ? '501' : '900',
    authorName: client ? 'ivan' : 'me',
    recipientId: client ? '900' : '501',
    recipientName: client ? 'me' : 'ivan',
    text,
    attachments: [],
    ...extra,
  };
}

function optionsTrack(id, title, minute) {
  return {
    id,
    type: 13,
    time: Date.UTC(2026, 9, 22, 9, minute) / 1000,
    message: '',
    html: `<h3 class="f15">${title}</h3><table class="mt10 track-extra-table"><tbody><tr><td>Форма оплаты</td><td>1</td><td>1 день</td><td>1 600 ₽</td></tr></tbody></table>`,
  };
}

function createWorld({ withOrder = true, startMinute = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-news-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const orderDir = path.join(kworkRoot, 'Активные', 'shop');
  fs.mkdirSync(orderDir, { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), withOrder ? '- shop: ivan\n' : '');
  let clock = Date.UTC(2026, 9, 22, 9, startMinute);
  const save = (messages) => handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: '501', messages } });
  const saveTracks = (tracks) => handleCommand(targetDir, { command: 'save-order-events', dialogKey: 'ivan', clientId: '501', orderId: '777', events: core.parseTrackEvents(tracks, '777') });
  // Чат заказа уже есть и открыт в Desktop, как у настоящего заказа в работе: побудки приходят в его сокет.
  const claude = createFakeClaude({ home, now: () => clock });
  claude.front = true;
  if (withOrder) {
    fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'data', 'wake-state.json'), JSON.stringify({ chats: { [orderDir]: { sessionId: 'seed-chat', dir: orderDir, startedAt: 0 } } }));
    claude.say(orderDir, 'seed-chat', clock - 60 * 1000);
    claude.addToDesktop('seed-chat', { cwd: orderDir });
    claude.openDesktopChat(orderDir, 'seed-chat');
  }

  const waker = createWaker({ targetDir, kworkRoot, runner: claude.runner, now: () => clock });
  // Такт моста, приём сокетом и подтверждение по метке в журнале чата (через 2 с).
  const tick = async () => {
    await waker.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    clock += 2000;
    await waker.tick();
  };
  const writeDraft = (draft) => {
    const dir = path.join(targetDir, 'data', 'drafts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ivan.json'), JSON.stringify(draft));
  };
  return {
    save, saveTracks, claude, targetDir, waker, tick, writeDraft, kworkRoot,
    setClock: (minute) => { clock = Date.UTC(2026, 9, 22, 9, minute); },
    // Побудки, которые дошли до чатов.
    get sent() { return claude.inbox.map((item) => ({ text: item.user.message.content })); },
  };
}

test('ваше сообщение клиенту будит агента: что вы написали и как это сверилось с его черновиком', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'client', 'Сколько по срокам?')]);
  await world.tick();
  world.writeDraft({ at: new Date(Date.UTC(2026, 9, 22, 9, 1)).toISOString(), parts: [{ n: 1, mode: 'reply', target: 'Сколько по срокам?', text: '3 дня.' }] });

  world.setClock(3);
  world.save([message(1, 0, 'client', 'Сколько по срокам?'), message(2, 2, 'me', '3 дня')]);
  await world.tick();
  assert.equal(world.sent.length, 1);
  assert.match(world.sent[0].text, /\] Вы написали клиенту ivan на Kwork\./);
  assert.match(world.sent[0].text, /\] Вы: 3 дня\n {2}\(часть 1 черновика агента — отправлена как есть\)/);
  assert.doesNotMatch(world.sent[0].text, /Telegram/);

  world.save([message(1, 0, 'client', 'Сколько по срокам?'), message(2, 2, 'me', '3 дня'), message(3, 4, 'me', 'Завтра пришлю макет')]);
  await world.tick();
  assert.match(world.sent[1].text, /Вы: Завтра пришлю макет\n {2}\(своё сообщение, не из черновика агента\)/);
});

test('клиент написал, вы ответили до побудки — агент получает обоих', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'Готово')]);
  await world.tick();
  world.save([message(1, 0, 'me', 'Готово'), message(2, 1, 'client', 'Спасибо, а логотип?'), message(3, 2, 'me', 'Поменяю сегодня')]);
  await world.tick();
  assert.equal(world.sent.length, 1);
  assert.match(world.sent[0].text, /Клиент ivan написал/);
  assert.match(world.sent[0].text, /Спасибо, а логотип\?[\s\S]*Вы: Поменяю сегодня/);
});

test('оплата опций будит агента; ваше предложение — тоже агенту', async () => {
  const world = createWorld({ startMinute: 5 });
  world.save([message(1, 0, 'client', 'Нужна форма оплаты')]);
  await world.tick();

  world.saveTracks([optionsTrack(50, 'Вы предложили опции', 10)]);
  await world.tick();
  assert.equal(world.sent.length, 1);
  assert.match(world.sent[0].text, /Клиент ivan: событие по заказу/);
  assert.match(world.sent[0].text, /Событие: Заказ №777: Вы предложили опции — «Форма оплаты», вам 1\s600 ₽, \+1 день/);

  // Тот же трек сменил статус: клиент оплатил.
  world.saveTracks([optionsTrack(50, 'К заказу добавлены дополнительные опции', 10)]);
  await world.tick();
  assert.equal(world.sent.length, 2);
  assert.match(world.sent[1].text, /Событие: Заказ №777: К заказу добавлены дополнительные опции — «Форма оплаты», вам 1\s600 ₽, \+1 день\. Клиент оплатил/);

  // Повторный опрос того же — без новой побудки.
  world.saveTracks([optionsTrack(50, 'К заказу добавлены дополнительные опции', 10)]);
  await world.tick();
  assert.equal(world.sent.length, 2);
});

test('история заказа, прочитанная впервые, не будит; смена статуса старого предложения — будит', async () => {
  const world = createWorld({ startMinute: 30 });
  world.save([message(1, 0, 'client', 'Привет')]);
  await world.tick();

  // Треки созданы до начала учёта событий — только запоминаются.
  world.saveTracks([optionsTrack(60, 'Вы предложили опции', 10), { id: 61, type: 16, time: Date.UTC(2026, 9, 22, 9, 12) / 1000, message: '', html: '' }]);
  await world.tick();
  assert.equal(world.sent.length, 0);

  world.saveTracks([optionsTrack(60, 'Покупатель отказался от опций', 10)]);
  await world.tick();
  assert.equal(world.sent.length, 1);
  assert.match(world.sent[0].text, /Покупатель отказался от опций/);
});

test('переход с прошлой версии будильщика не будит по уже лежащим сообщениям', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'client', 'Вопрос'), message(2, 1, 'me', 'Ответ')]);
  // Состояние прошлой версии: разобрано было только сообщение клиента.
  const statePath = path.join(path.dirname(path.dirname(world.save([message(1, 0, 'client', 'Вопрос'), message(2, 1, 'me', 'Ответ')]).path)), 'data', 'wake-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ baselineDone: true, handled: { ivan: '1' }, notified: { ivan: '1' }, pending: {}, rootThreads: {} }));
  await world.tick();
  assert.equal(world.sent.length, 0);

  world.save([message(1, 0, 'client', 'Вопрос'), message(2, 1, 'me', 'Ответ'), message(3, 2, 'client', 'Ещё вопрос')]);
  await world.tick();
  assert.equal(world.sent.length, 1);
});

test('своё сообщение клиенту без заказа и без чата — новый чат ради него не заводится', async () => {
  const world = createWorld({ withOrder: false });
  world.save([message(1, 0, 'client', 'Здравствуйте')]);
  await world.tick();
  world.save([message(1, 0, 'client', 'Здравствуйте'), message(2, 1, 'me', 'Добрый день')]);
  await world.tick();
  assert.equal(world.sent.length, 0);
});

test('предложение кворка: «Заказ создан» — агенту словами, одной строкой', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'me', 'Предложение индивидуального кворка', { event: { type: 'offer_kwork_new', title: 'Предложение индивидуального кворка', price: 3000, days: 2, status: 'new' } })]);
  await world.tick();
  world.save([
    message(1, 0, 'me', 'Предложение индивидуального кворка', { event: { type: 'offer_kwork_new', title: 'Предложение индивидуального кворка', price: 3000, days: 2, status: 'done' } }),
    message(2, 3, 'client', 'Заказ создан', { event: { type: 'offer_kwork_done', title: 'Заказ создан', orderId: '888' } }),
  ]);
  await world.tick();
  assert.equal(world.sent.length, 1);
  assert.match(world.sent[0].text, /Заказ создан \[Заказ создан №888 — клиент принял и оплатил предложение\]/);
});

test('мост отдаёт панели черновик по нику и по номеру заказа, с хвостом переписки и событиями', async () => {
  const world = createWorld();
  world.save([message(1, 0, 'client', 'Сколько по срокам?', { orderId: '777' })]);
  world.saveTracks([optionsTrack(50, 'Вы предложили опции', 1)]);
  const targetDir = path.dirname(path.dirname(world.save([message(1, 0, 'client', 'Сколько по срокам?', { orderId: '777' })]).path));
  assert.deepEqual(handleCommand(targetDir, { command: 'get-draft', dialogKey: 'ivan' }).draft, null);

  world.writeDraft({ id: 'd1', at: '2026-10-22T09:02:00.000Z', parts: [{ n: 1, mode: 'reply', target: 'Сколько по срокам?', text: '3 дня.' }] });
  const byKey = handleCommand(targetDir, { command: 'get-draft', dialogKey: 'Ivan' });
  assert.equal(byKey.draft.id, 'd1');
  assert.equal(byKey.clientId, '501');
  assert.deepEqual(byKey.messages.map((item) => [item.id, item.orderId]), [['1', '777']]);
  assert.equal(byKey.events.length, 1);
  assert.equal(byKey.messages[0].recipientId, undefined, 'панели — только нужные поля');
  assert.equal(handleCommand(targetDir, { command: 'get-draft', orderId: '777' }).draft.id, 'd1');
  assert.equal(handleCommand(targetDir, { command: 'get-draft', orderId: '999' }).draft, null);
});

test('неоплаченное индивидуальное предложение попадает в список перепроверки, оплаченное — уходит', () => {
  const world = createWorld();
  const offer = (status) => message(1, 0, 'me', 'Предложение индивидуального кворка', { event: { type: 'offer_kwork_new', title: 'Предложение индивидуального кворка', price: 3000, days: 2, status } });
  const targetDir = path.dirname(path.dirname(world.save([offer('new')]).path));
  const now = Date.UTC(2026, 9, 23);
  const listed = handleCommand(targetDir, { command: 'open-offers', now }).dialogs;
  assert.deepEqual(listed.map((item) => [item.dialogKey, item.ids]), [['ivan', ['1']]]);
  // Старше двух недель уже не ждём.
  assert.deepEqual(handleCommand(targetDir, { command: 'open-offers', now: Date.UTC(2026, 10, 10) }).dialogs, []);
  world.save([offer('done')]);
  assert.deepEqual(handleCommand(targetDir, { command: 'open-offers', now }).dialogs, []);
});

test('переход с прошлой версии: старый диалог с копией без номера в хвосте не будит', async () => {
  const world = createWorld();
  const legacy = { ...message(2, 5, 'client', 'скоро гляну'), id: null };
  const saved = world.save([message(1, 0, 'client', 'скоро гляну'), legacy]);
  const statePath = path.join(path.dirname(path.dirname(saved.path)), 'data', 'wake-state.json');
  // Прошлая версия этот диалог не отмечала: последнее сообщение было без номера.
  fs.writeFileSync(statePath, JSON.stringify({ baselineDone: true, handled: {}, notified: {}, pending: {}, rootThreads: {} }));
  await world.tick();
  assert.equal(world.sent.length, 0);
});

test('предложение, сохранённое прошлой версией без события, тоже перепроверяется', () => {
  const world = createWorld();
  const legacy = { ...message(1, 0, 'me', 'Предложение индивидуального кворка'), id: null };
  const targetDir = path.dirname(path.dirname(world.save([legacy, message(2, 1, 'client', 'Подумаю')]).path));
  const listed = handleCommand(targetDir, { command: 'open-offers', now: Date.UTC(2026, 9, 23) }).dialogs;
  assert.deepEqual(listed.map((item) => item.dialogKey), ['ivan']);
});

test('ваше сообщение и оплата клиента в одной пачке: агент разбужен', async () => {
  const world = createWorld({ withOrder: false, startMinute: 5 });
  world.save([message(1, 0, 'client', 'Нужна форма оплаты')]);
  await world.tick();

  world.save([message(1, 0, 'client', 'Нужна форма оплаты'), message(2, 6, 'me', 'Выставил опцию')]);
  world.saveTracks([optionsTrack(50, 'К заказу добавлены дополнительные опции', 10)]);
  await world.tick();
  // Чата не было — мост завёл его; Desktop поднял чат, и побудка пришла туда.
  const { sessionId } = JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8')).chats[`${world.kworkRoot}::ivan`];
  world.claude.openDesktopChat(world.kworkRoot, sessionId);
  await world.tick();
  await world.tick();
  const wake = world.sent.find((command) => command.text);
  assert.ok(wake, 'побудка отправлена');
  assert.match(wake.text, /Клиент ivan: событие по заказу/);
  assert.match(wake.text, /Вы: Выставил опцию/);
});

test('свои опции без чата клиента — новый чат ради них не заводится', async () => {
  const world = createWorld({ withOrder: false, startMinute: 5 });
  world.save([message(1, 0, 'client', 'Нужна форма оплаты')]);
  await world.tick();
  world.saveTracks([optionsTrack(50, 'Вы предложили опции', 10)]);
  await world.tick();
  assert.equal(world.sent.length, 0);
});
