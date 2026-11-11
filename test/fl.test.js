process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fl = require('../src/fl-core.js');
const health = require('../native_host/health.js');
const wakeCore = require('../native_host/wake-core.js');
const { handleCommand } = require('../native_host/store.js');
const { createWaker } = require('../native_host/waker.js');
const { createFakeClaude } = require('./helpers/fake-claude.js');

// Поля ответов — как у живого FL.ru 11.11.2026 (отклик 75961540 на заказ 5528814), без личных данных.
const ME = 9885875;
const CUSTOMER = 3756535;
const at = (minute) => Date.UTC(2026, 10, 11, 9, minute);
const PROJECT_URL = 'https://www.fl.ru/projects/5528814/sdelat-odnostranichnyiy-sayt-v-tilde.html';

const offer = (patch = {}) => ({
  id: 75961540, project_id: 5528814, messages_count: 1, last_message_at: null, is_candidate: false, is_chosen: false,
  title: 'Сделать одностраничный сайт в Тильде', author: { id: ME, username: 'me-login' }, ...patch,
});
const offersResponse = (items, projects) => ({
  has_next_page: false,
  items,
  messages: [],
  projects: projects || [{ id: 5528814, name: 'Сделать одностраничный сайт в Тильде', url: PROJECT_URL, author: { id: CUSTOMER, username: 'Fentezi11', role: 'customer' } }],
});
const chatMessage = (id, minute, from, text, patch = {}) => ({ id, from_id: from, time: at(minute), text, format: 'raw', offer_id: 75961540, files: [], reply_to: null, ...patch });
const chatResponse = (items, patch = {}) => ({ items, replied_messages: [], users: [{ id: ME, username: 'me-login' }, { id: CUSTOMER, username: 'Fentezi11' }], has_next_page: false, ...patch });
const MESSAGES_PATH = '/projects/5528814/offers/75961540/messages/?limit=40&mark_read=0';

test('ключ диалога FL.ru: «fl-<логин>», ник Kwork им не считается', () => {
  assert.equal(fl.dialogKey('Fentezi11'), 'fl-fentezi11');
  assert.equal(fl.dialogKey(' Ivan.Petrov '), 'fl-ivan-petrov');
  assert.equal(fl.dialogKey(''), null);
  assert.equal(fl.isDialogKey('fl-fentezi11'), true);
  assert.equal(fl.isDialogKey('stroisnab2007'), false);
  assert.equal(fl.isDialogKey('fl-'), false);
});

test('отклики: без изменений — ничего; свой отклик без ответа чат не читает; ответ заказчика — читает', () => {
  const quiet = fl.planOffers(offersResponse([offer()]), {});
  assert.equal(quiet.items.length, 1);
  assert.equal(quiet.items[0].messagesPath, null, 'в чате только сам отклик');
  assert.equal(quiet.selfId, String(ME));
  const seen = { [quiet.items[0].sigKey]: quiet.items[0].signature };
  assert.deepEqual(fl.planOffers(offersResponse([offer()]), seen).items, []);

  const answered = fl.planOffers(offersResponse([offer({ messages_count: 2, last_message_at: at(5) })]), seen).items;
  assert.equal(answered.length, 1);
  assert.deepEqual(
    [answered[0].key, answered[0].title, answered[0].clientId, answered[0].selfId, answered[0].url, answered[0].messagesPath],
    ['fl-fentezi11', 'Fentezi11', String(CUSTOMER), String(ME), PROJECT_URL, MESSAGES_PATH],
  );
  assert.deepEqual(answered[0].events, []);
});

test('отклики: кандидат и выбор исполнителя — событие один раз; отклик без заказчика в ответе считается неразобранным', () => {
  const base = fl.planOffers(offersResponse([offer()]), {}).items[0];
  const seen = { [base.sigKey]: base.signature };
  const candidate = fl.planOffers(offersResponse([offer({ is_candidate: true })]), seen, at(7)).items[0];
  assert.deepEqual(candidate.events.map((event) => [event.id, event.authorId, event.time, event.text]), [[
    'fl-offer-75961540-candidate', String(CUSTOMER), new Date(at(7)).toISOString(),
    'Событие FL.ru: заказчик добавил вас в кандидаты по заказу «Сделать одностраничный сайт в Тильде».',
  ]]);
  assert.equal(candidate.messagesPath, MESSAGES_PATH, 'к событию читается чат отклика');
  seen[candidate.sigKey] = candidate.signature;
  // Заказчик написал, отметка кандидата прежняя — события нет.
  assert.deepEqual(fl.planOffers(offersResponse([offer({ is_candidate: true, messages_count: 2 })]), seen).items[0].events, []);
  const chosen = fl.planOffers(offersResponse([offer({ is_candidate: true, is_chosen: true })]), seen).items[0];
  assert.deepEqual(chosen.events.map((event) => event.id), ['fl-offer-75961540-chosen']);

  const lost = fl.planOffers(offersResponse([offer()], []), {});
  assert.deepEqual([lost.items.length, lost.unparsed], [0, 1]);
});

test('чат отклика: номера с приставкой, автор по списку участников, ответ на сообщение, файл без текста', () => {
  const messages = fl.normalizeMessages(chatResponse([
    chatMessage(12, 5, CUSTOMER, 'Сколько по времени?', { reply_to: 11 }),
    chatMessage(11, 1, ME, ' Сделаю за два дня '),
    chatMessage(13, 6, CUSTOMER, '', { files: [{ id: 1 }] }),
    chatMessage(14, 7, CUSTOMER, 'макет', { files: [{ id: 2 }, { id: 3 }] }),
    chatMessage(15, 8, CUSTOMER, ''),
    { id: 16, from_id: CUSTOMER, time: null, text: 'без времени' },
  ]));
  assert.deepEqual(messages.map((message) => [message.id, message.authorId, message.authorName, message.text]), [
    ['o11', String(ME), 'me-login', 'Сделаю за два дня'],
    ['o12', String(CUSTOMER), 'Fentezi11', 'Сколько по времени?'],
    ['o13', String(CUSTOMER), 'Fentezi11', '(файл без текста, смотрите на FL.ru)'],
    ['o14', String(CUSTOMER), 'Fentezi11', 'макет\n(файлов: 2, смотрите на FL.ru)'],
  ]);
  assert.deepEqual(messages[1].replyTo, { kind: 'reply', id: 'o11', time: new Date(at(1)).toISOString(), authorId: String(ME), text: 'Сделаю за два дня' });
  assert.equal(messages[0].time, new Date(at(1)).toISOString());
  // Цель ответа вне пачки приходит отдельным списком; сделки — со своей приставкой.
  const far = fl.normalizeMessages(chatResponse([chatMessage(20, 9, CUSTOMER, 'да', { reply_to: 3 })], { replied_messages: [chatMessage(3, 0, ME, 'старое')] }), 'd');
  assert.deepEqual([far[0].id, far[0].replyTo.id, far[0].replyTo.text], ['d20', 'd3', 'старое']);
});

test('диалог для моста: только когда заказчик написал или есть событие', () => {
  const item = fl.planOffers(offersResponse([offer({ messages_count: 2 })]), {}).items[0];
  assert.equal(fl.buildDialog(item, chatResponse([chatMessage(11, 1, ME, 'мой отклик'), chatMessage(12, 2, ME, 'и ещё от меня')])), null);
  const dialog = fl.buildDialog(item, chatResponse([chatMessage(11, 1, ME, 'мой отклик'), chatMessage(12, 5, CUSTOMER, 'Здравствуйте')]), at(6));
  assert.deepEqual(
    [dialog.source, dialog.key, dialog.title, dialog.url, dialog.clientId, dialog.selfId, dialog.updatedAt, dialog.messages.length],
    ['fl', 'fl-fentezi11', 'Fentezi11', PROJECT_URL, String(CUSTOMER), String(ME), new Date(at(6)).toISOString(), 2],
  );
  const event = fl.planOffers(offersResponse([offer({ is_chosen: true })]), {}).items[0];
  assert.deepEqual(fl.buildDialog(event, chatResponse([chatMessage(11, 1, ME, 'мой отклик')])).messages.map((message) => message.id), ['o75961540-11', 'fl-offer-75961540-chosen']);
});

const deal = (patch = {}) => ({ id: 901, title: 'Сайт кафе', status: 'new', freelancer: { id: ME, username: 'me-login' }, author: { id: CUSTOMER, username: 'Fentezi11' }, ...patch });

test('сделки: новая — событие и чат, смена статуса и новое сообщение — по подписи; без заказчика — неразобранная', () => {
  const fresh = fl.planDeals({ items: [deal()], messages: [] }, {}, String(ME), at(10));
  assert.equal(fresh.items.length, 1);
  const [item] = fresh.items;
  assert.deepEqual([item.key, item.clientId, item.selfId, item.idPrefix, item.messagesPath], ['fl-fentezi11', String(CUSTOMER), String(ME), 'd901-', '/api/orders/messages/?order_id=901&limit=40&mark_read=0']);
  assert.deepEqual(item.events.map((event) => [event.id, event.text]), [['fl-deal-901-new', 'Событие FL.ru: заказчик открыл сделку «Сайт кафе», статус «new».']]);
  const seen = { [item.sigKey]: item.signature };
  assert.deepEqual(fl.planDeals({ items: [deal()], messages: [] }, seen, String(ME)).items, []);

  const message = fl.planDeals({ items: [deal()], messages: [{ id: 55, order_id: 901 }] }, seen, String(ME)).items;
  assert.deepEqual([message.length, message[0].events.length], [1, 0]);
  const status = fl.planDeals({ items: [deal({ status: 'in_work' })], messages: [] }, seen, String(ME)).items[0];
  assert.deepEqual(status.events.map((event) => [event.id, event.text]), [['fl-deal-901-status-in_work', 'Событие FL.ru: сделка «Сайт кафе»: статус «in_work».']]);

  // Мой номер неизвестен из откликов — берётся из сделки; заказчика в ответе нет — неразобранная.
  assert.equal(fl.planDeals({ items: [deal()] }, {}, null).items[0].selfId, String(ME));
  assert.deepEqual(fl.planDeals({ items: [deal({ author: null })] }, {}, String(ME)), { items: [], unparsed: 1 });
});

function createSite({ offers, chat, deals = { items: [], messages: [] } }) {
  const site = { offers, chat, deals, calls: [], saved: [], fail: null };
  site.fetchJson = async (requestPath) => {
    site.calls.push(requestPath);
    if (site.fail) throw site.fail;
    if (requestPath === fl.OFFERS_PATH) return site.offers;
    if (requestPath === fl.DEALS_PATH) return site.deals;
    if (requestPath === MESSAGES_PATH) return site.chat;
    if (site.pages?.[requestPath]) return site.pages[requestPath];
    throw new Error(`неизвестный запрос ${requestPath}`);
  };
  site.saveDialog = async (dialog) => {
    if (site.bridgeDown) throw Object.assign(new Error('мост не ответил'), { abort: true });
    if (site.bridgeRefuses?.(dialog)) throw new Error('диалог уже записан другим источником');
    site.saved.push(dialog);
  };
  return site;
}

test('проход опроса: первый только запоминает, ответ заказчика пишется один раз, сбой моста — повтор', async () => {
  const thread = [chatMessage(11, 1, ME, 'мой отклик'), chatMessage(12, 5, CUSTOMER, 'Здравствуйте')];
  const site = createSite({ offers: offersResponse([offer({ messages_count: 2, last_message_at: at(5) })]), chat: chatResponse(thread) });
  const pass = (stored, previous = {}) => fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored, previous, now: at(20) });

  // Первый проход: чат с давним ответом не читается и не пишется.
  const first = await pass(null);
  assert.deepEqual(site.calls, [fl.OFFERS_PATH, fl.DEALS_PATH]);
  assert.deepEqual([site.saved.length, first.status.okAt, first.status.selfId, first.status.warn], [0, at(20), String(ME), null]);

  // Заказчик дописал — диалог пишется; мост не ответил — подпись не запоминается, следующий проход повторяет.
  site.offers = offersResponse([offer({ messages_count: 3, last_message_at: at(9) })]);
  site.chat = chatResponse([...thread, chatMessage(13, 9, CUSTOMER, 'Когда начнёте?')]);
  site.bridgeDown = true;
  const failed = await pass(first.seen, first.status);
  assert.deepEqual([failed.status.error, failed.status.okAt, failed.seen['offer:75961540']], ['мост не ответил', at(20), first.seen['offer:75961540']]);
  site.bridgeDown = false;
  const saved = await pass(failed.seen, failed.status);
  assert.deepEqual(site.saved.map((dialog) => dialog.messages.map((message) => message.id)), [['o75961540-11', 'o75961540-12', 'o75961540-13']]);
  assert.equal(saved.status.error, undefined);

  // Тот же ответ сайта ещё раз — ни чтения чата, ни записи.
  site.calls.length = 0;
  await pass(saved.seen, saved.status);
  assert.deepEqual([site.calls, site.saved.length], [[fl.OFFERS_PATH, fl.DEALS_PATH], 1]);
});

test('проход опроса: выход из аккаунта и отказ сайта — причина в статусе, первый проход остаётся первым', async () => {
  const site = createSite({ offers: offersResponse([offer()]), chat: chatResponse([]) });
  site.fail = Object.assign(new Error('нет входа на FL.ru'), { signedOut: true });
  const out = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: null, previous: { okAt: at(0), selfId: String(ME) }, now: at(20) });
  assert.deepEqual(out, { seen: null, status: { okAt: at(0), selfId: String(ME), at: at(20), error: 'нет входа на FL.ru', signedOut: true, pausedUntil: 0 } });
  site.fail = Object.assign(new Error('FL.ru не отдал данные (ответ 429)'), { pause: true });
  const paused = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: { a: '1' }, now: at(20) });
  assert.deepEqual([paused.seen, paused.status.pausedUntil, paused.status.signedOut], [{ a: '1' }, at(30), false]);

  // Сделка без заказчика в ответе: проход удачный, но с предупреждением для проверки звеньев.
  site.fail = null;
  site.deals = { items: [deal({ author: null })], messages: [] };
  const warned = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, now: at(20) });
  assert.match(warned.status.warn, /сделок FL\.ru не разобрано: 1/);
});

test('проход опроса: сбой одного чата не останавливает остальные; не читается 10 минут — предупреждение', async () => {
  const second = { id: 75961999, project_id: 5529000 };
  const secondPath = '/projects/5529000/offers/75961999/messages/?limit=40&mark_read=0';
  const projects = [
    { id: 5528814, name: 'Сайт в Тильде', url: PROJECT_URL, author: { id: CUSTOMER, username: 'Fentezi11' } },
    { id: 5529000, name: 'Лендинг', url: 'https://www.fl.ru/projects/5529000/lending.html', author: { id: 444, username: 'Olga' } },
  ];
  const site = createSite({ offers: offersResponse([offer({ messages_count: 2 }), offer({ ...second, messages_count: 2 })], projects), chat: null });
  site.pages = { [secondPath]: chatResponse([chatMessage(31, 6, 444, 'Добрый день')], { users: [{ id: 444, username: 'Olga' }] }) };
  // Чат первого отклика сайт не отдаёт (заказ снят) — это не пауза и не выход из аккаунта.
  const fetchJson = async (requestPath) => {
    if (requestPath === MESSAGES_PATH) throw new Error('FL.ru не нашёл страницу (ответ 404)');
    return site.fetchJson(requestPath);
  };
  const pass = (stored, previous, now) => fl.runPass({ fetchJson, saveDialog: site.saveDialog, stored, previous, now });
  const first = await pass({}, {}, at(20));
  assert.deepEqual(site.saved.map((dialog) => dialog.key), ['fl-olga'], 'ответ второго заказчика дошёл');
  assert.deepEqual([first.seen['offer:75961540'], first.seen['offer:75961999'], first.status.failing, first.status.warn], [undefined, '2||0|0', { 'offer:75961540': { since: at(20), error: 'FL.ru не нашёл страницу (ответ 404)' } }, null]);
  const later = await pass(first.seen, first.status, at(31));
  assert.deepEqual([later.status.failing['offer:75961540'].since, later.status.okAt], [at(20), at(31)]);
  assert.match(later.status.warn, /чатов FL\.ru не читается: 1 \(FL\.ru не нашёл страницу \(ответ 404\)\)/);

  // Мост отказал в одной записи (ключ занят клиентом Kwork) — то же самое; чат починился — предупреждение уходит.
  site.chat = chatResponse([chatMessage(11, 1, ME, 'мой отклик'), chatMessage(12, 5, CUSTOMER, 'Здравствуйте')]);
  site.bridgeRefuses = (dialog) => dialog.key === 'fl-fentezi11';
  const refused = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, previous: {}, now: at(40) });
  assert.deepEqual([Object.keys(refused.status.failing), refused.seen['offer:75961999']], [['offer:75961540'], '2||0|0']);
  site.bridgeRefuses = null;
  const healed = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: refused.seen, previous: refused.status, now: at(55) });
  assert.deepEqual([healed.status.failing, healed.status.warn, healed.seen['offer:75961540']], [{}, null, '2||0|0']);
});

test('проход опроса: незнакомый формат не молчит — сообщения без времени, отклики без заказчика, ответ без списка', async () => {
  const strange = chatResponse([chatMessage(11, 1, ME, 'мой отклик'), { id: 12, from_id: CUSTOMER, created_at: '2026-11-12T10:00:00+03:00', text: 'Когда начнёте?' }]);
  const site = createSite({ offers: offersResponse([offer({ messages_count: 2 })]), chat: strange });
  const lost = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, now: at(20) });
  assert.equal(fl.unreadable(strange, String(ME)), 1);
  // Заказчик написал, а текст лежит в незнакомом поле — тоже не разобрано; пустое своё и служебное — не в счёт.
  assert.equal(fl.unreadable(chatResponse([{ id: 13, from_id: CUSTOMER, time: at(6), message: 'Здравствуйте' }, chatMessage(14, 7, ME, ''), { id: 15, time: at(8), text: '' }, chatMessage(16, 9, CUSTOMER, '', { files: [{ id: 1 }] })]), String(ME)), 1);
  // Время в секундах (так считает часть кода сайта) читается, а не теряется.
  assert.equal(fl.normalizeMessages(chatResponse([{ id: 17, from_id: CUSTOMER, time: at(6) / 1000, text: 'да' }]))[0].time, new Date(at(6)).toISOString());
  assert.deepEqual([lost.seen['offer:75961540'], site.saved.length], [undefined, 0], 'подпись не запомнена: чат перечитается');
  assert.match(lost.status.warn, /чатов FL\.ru не читается: 1 \(сообщений не разобрано: 1 — формат ответа сайта другой\)/);

  site.offers = offersResponse([offer()], []);
  assert.match((await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, now: at(20) })).status.warn, /откликов FL\.ru не разобрано: 1/);
  // Один отклик без заказчика среди разобранных (заказ удалён) — не повод для тревоги.
  site.offers = offersResponse([offer(), offer({ id: 5, project_id: 6 })]);
  assert.equal((await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, now: at(20) })).status.warn, null);

  site.offers = { error: 'что-то новое' };
  const broken = await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, previous: { okAt: at(0) }, now: at(20) });
  assert.deepEqual([broken.status.error, broken.status.okAt], ['FL.ru отдал отклики в незнакомом виде', at(0)]);
  site.offers = offersResponse([offer()]);
  site.deals = {};
  assert.equal((await fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored: {}, now: at(20) })).status.error, 'FL.ru отдал сделки в незнакомом виде');
});

test('проход опроса: дальние страницы откликов — первым проходом и раз в 10 минут; «кандидат» на старом отклике находится', async () => {
  const old = (patch = {}) => offer({ id: 70000001, project_id: 5000001, ...patch });
  const oldProject = { id: 5000001, name: 'Старый заказ', url: 'https://www.fl.ru/projects/5000001/x.html', author: { id: 555, username: 'Petr' } };
  const site = createSite({ offers: { ...offersResponse([offer()]), has_next_page: true }, chat: null });
  site.pages = { [fl.offersPath(20)]: offersResponse([old()], [oldProject]) };
  const pass = (stored, previous, now) => fl.runPass({ fetchJson: site.fetchJson, saveDialog: site.saveDialog, stored, previous, now });
  const first = await pass(null, {}, at(0));
  assert.deepEqual(site.calls, [fl.OFFERS_PATH, fl.offersPath(20), fl.DEALS_PATH]);
  assert.deepEqual([Object.keys(first.seen).sort(), first.status.deepAt], [['offer:70000001', 'offer:75961540'], at(0)]);

  // Заказчик отметил старый отклик кандидатом, ничего не написав: ближний проход его не видит, дальний — находит.
  const oldChat = '/projects/5000001/offers/70000001/messages/?limit=40&mark_read=0';
  site.pages = { [fl.offersPath(20)]: offersResponse([old({ is_candidate: true })], [oldProject]), [oldChat]: chatResponse([chatMessage(1, 0, ME, 'мой отклик')]) };
  site.calls.length = 0;
  const near = await pass(first.seen, first.status, at(4));
  assert.deepEqual([site.calls, site.saved.length, near.status.deepAt], [[fl.OFFERS_PATH, fl.DEALS_PATH], 0, at(0)]);
  const deep = await pass(near.seen, near.status, at(10));
  assert.deepEqual([site.saved.map((dialog) => dialog.key), deep.status.deepAt], [['fl-petr'], at(10)]);
  assert.deepEqual(site.saved[0].messages.map((message) => message.id), ['o70000001-1', 'fl-offer-70000001-candidate']);

  // Чат старого отклика не читается: ближний проход (он дальние страницы не видит) сбой не забывает,
  // и через 10 минут звено мертво с причиной.
  const failingChat = async (requestPath) => {
    if (requestPath === oldChat) throw new Error('FL.ru не нашёл страницу (ответ 404)');
    return site.fetchJson(requestPath);
  };
  const failPass = (stored, previous, now) => fl.runPass({ fetchJson: failingChat, saveDialog: site.saveDialog, stored, previous, now });
  const failedDeep = await failPass(near.seen, near.status, at(10));
  const failedNear = await failPass(failedDeep.seen, failedDeep.status, at(14));
  assert.deepEqual([failedDeep.status.warn, failedNear.status.failing['offer:70000001'].since, failedNear.status.warn], [null, at(10), null]);
  const stuck = await failPass(failedNear.seen, failedNear.status, at(20));
  assert.match(stuck.status.warn, /чатов FL\.ru не читается: 1 \(FL\.ru не нашёл страницу \(ответ 404\)\)/);
  assert.match((await failPass(stuck.seen, stuck.status, at(22))).status.warn, /чатов FL\.ru не читается: 1/, 'ближний проход предупреждение не снимает');
  // Отклик удалён или починился: дальний проход собирает список сбоев заново.
  site.pages = { [fl.offersPath(20)]: offersResponse([old()], [oldProject]) };
  assert.deepEqual((await failPass(stuck.seen, { ...stuck.status, deepAt: at(20) }, at(30))).status.failing, {});

  // Сайт не слушает offset и отдаёт ту же страницу: запросов не больше пяти, отклик не двоится.
  const stubborn = [];
  const sameAgain = async (requestPath) => {
    stubborn.push(requestPath);
    return requestPath === fl.DEALS_PATH ? { items: [], messages: [] } : { ...offersResponse([offer()]), has_next_page: true };
  };
  const looped = await fl.runPass({ fetchJson: sameAgain, saveDialog: site.saveDialog, stored: null, now: at(30) });
  assert.deepEqual([stubborn.length, Object.keys(looped.seen)], [6, ['offer:75961540']]);
  assert.equal(fl.planOffers({ items: [offer(), offer()], projects: offersResponse([]).projects }, {}).items.length, 1);
});

function createWorld() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-fl-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), '');
  return { home, kworkRoot, targetDir };
}

const flDialog = (messages, patch = {}) => ({ source: 'fl', key: 'fl-fentezi11', title: 'Fentezi11', url: PROJECT_URL, clientId: String(CUSTOMER), selfId: String(ME), messages, ...patch });
const saved = (id, minute, from, text) => ({ id, time: new Date(at(minute)).toISOString(), authorId: String(from), authorName: null, text, replyTo: null });

test('мост: диалог FL.ru пишется под своим ключом и не смешивается с перепиской Kwork', () => {
  const world = createWorld();
  const save = (dialog) => handleCommand(world.targetDir, { command: 'save-dialog', dialog });
  // Ключ не FL.ru — в переписку Kwork опрос FL.ru не пишет.
  assert.equal(save(flDialog([saved('o12', 5, CUSTOMER, 'подделка')], { key: 'stroisnab2007' })).skipped, true);
  assert.equal(fs.existsSync(path.join(world.targetDir, 'stroisnab2007')), false);

  save(flDialog([saved('o11', 1, ME, 'мой отклик'), saved('o12', 5, CUSTOMER, 'Здравствуйте')]));
  const dir = path.join(world.targetDir, 'fl-fentezi11');
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'данные.json'), 'utf8'));
  assert.deepEqual([record.source, record.selfId, record.clientId, record.url, record.messages.length], ['fl', String(ME), String(CUSTOMER), PROJECT_URL, 2]);
  const markdown = fs.readFileSync(path.join(dir, 'переписка.md'), 'utf8');
  assert.match(markdown, /## Я — .*\n\nмой отклик/);
  assert.match(markdown, /## Fentezi11 — .*\n\nЗдравствуйте/);

  // Клиент Kwork с ником «fl-fentezi11» чужую переписку не дописывает, и наоборот.
  assert.throws(() => save({ key: 'fl-fentezi11', clientId: '501', messages: [{ id: '7', time: new Date(at(6)).toISOString(), authorId: '501', authorName: 'fl-fentezi11', text: 'я с Kwork' }] }), /другим источником/);
  save({ key: 'fl-ivan', clientId: '502', messages: [{ id: '8', time: new Date(at(6)).toISOString(), authorId: '502', authorName: 'fl-ivan', recipientId: '900', recipientName: 'me', text: 'я с Kwork' }] });
  assert.throws(() => save(flDialog([saved('o20', 7, CUSTOMER, 'привет')], { key: 'fl-ivan' })), /другим источником/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'данные.json'), 'utf8')).messages.length, 2);
});

test('мост: событие FL.ru при повторе прохода остаётся на своём месте — слова заказчика после него видны как новые', () => {
  const world = createWorld();
  const save = (messages) => handleCommand(world.targetDir, { command: 'save-dialog', dialog: flDialog(messages) });
  const event = (minute) => ({ id: 'fl-offer-75961540-candidate', time: new Date(at(minute)).toISOString(), authorId: String(CUSTOMER), authorName: null, text: 'Событие FL.ru: заказчик добавил вас в кандидаты.', replyTo: null });
  save([saved('o11', 1, ME, 'мой отклик'), event(5)]);
  // Подпись не запомнилась (мост ответил поздно): следующий проход шлёт то же событие с новым «сейчас».
  save([saved('o11', 1, ME, 'мой отклик'), saved('o12', 6, CUSTOMER, 'Когда начнёте?'), event(7)]);
  const record = JSON.parse(fs.readFileSync(path.join(world.targetDir, 'fl-fentezi11', 'данные.json'), 'utf8'));
  assert.deepEqual(record.messages.map((message) => [message.id, message.time]), [
    ['o11', new Date(at(1)).toISOString()], ['fl-offer-75961540-candidate', new Date(at(5)).toISOString()], ['o12', new Date(at(6)).toISOString()],
  ]);
  assert.deepEqual(wakeCore.findWakeNews(record, { handled: 'fl-offer-75961540-candidate' }).messages.map((message) => message.id), ['o12']);
});

test('побудка из FL.ru: шапка «на FL.ru», ссылка на заказ в блоке данных, сверка черновиков узнаёт ник', async () => {
  const record = { key: 'fl-fentezi11', source: 'fl', title: 'Fentezi11', url: PROJECT_URL, clientId: String(CUSTOMER), selfId: String(ME) };
  const text = wakeCore.buildWakeText({
    wakeId: 'abc123', nick: record.key, record, messages: [saved('o12', 5, CUSTOMER, 'Здравствуйте')],
    route: { dir: '/k', key: '/k::fl-fentezi11', root: true, reason: 'no-order', order: null, orders: [] },
    dialogDir: '/k/переписки/fl-fentezi11', chatScript: '/x/kwork-chat.mjs', rerouteScript: '/x/kwork-reroute.mjs', rulesPath: '/k/docs/побудка.md',
  });
  assert.match(text, /^\[Kwork-побудка #abc123\] Клиент fl-fentezi11 написал на FL\.ru\./);
  assert.ok(text.includes(`"""\n(заказ на FL.ru: ${PROJECT_URL})\n[`));
  assert.equal(wakeCore.isClientMessage(saved('o12', 5, CUSTOMER, 'x'), record), true);
  assert.equal(wakeCore.isClientMessage(saved('o11', 1, ME, 'x'), record), false);
  const own = wakeCore.buildWakeText({ wakeId: 'abc124', nick: record.key, record, messages: [], reason: 'own', route: { dir: '/k' }, dialogDir: '/k/x', chatScript: 'c', rerouteScript: 'r', rulesPath: 'p' });
  const { capturePanelDraft } = await import('../scripts/kwork-drafts.mjs');
  const world = createWorld();
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: flDialog([saved('o12', 5, CUSTOMER, 'Здравствуйте')]) });
  for (const [uuid, transcriptText] of [['a', text], ['b', own]]) {
    const draft = capturePanelDraft({ turn: { replies: [{ uuid, at: new Date(at(8)).toISOString(), text: 'Сообщение клиенту:\n```\nДобрый день\n```\n' }] }, nicks: [], transcriptText, sessionId: 's1', order: null, paths: { targetDir: world.targetDir } });
    assert.equal(draft?.slug, 'fl-fentezi11');
  }
});

test('ответ заказчика FL.ru будит свой чат в корне Kwork один раз; повторная запись того же — не будит', async () => {
  let clock = at(30);
  const world = createWorld();
  const claude = createFakeClaude({ home: world.home, now: () => clock });
  const waker = createWaker({ targetDir: world.targetDir, kworkRoot: world.kworkRoot, runner: claude.runner, now: () => clock });
  const stateOf = () => JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8'));
  const save = (messages) => handleCommand(world.targetDir, { command: 'save-dialog', dialog: flDialog(messages) });
  // Первый такт будильщика — исходное состояние без переписок FL.ru.
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: '501', messages: [{ id: '1', time: new Date(at(0)).toISOString(), authorId: '900', authorName: 'me', recipientId: '501', recipientName: 'ivan', text: 'жду' }] } });
  await waker.tick();

  const thread = [saved('o11', 1, ME, 'мой отклик'), saved('o12', 5, CUSTOMER, 'Здравствуйте, когда начнёте?')];
  save(thread);
  await waker.tick();
  const key = `${world.kworkRoot}::fl-fentezi11`;
  const chat = stateOf().chats[key];
  assert.ok(chat, 'у заказчика FL.ru свой чат в корне Kwork');
  const seed = fs.readFileSync(claude.runner.transcript(world.kworkRoot, chat.sessionId).file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(seed[0].customTitle, 'fl-fentezi11');
  assert.match(seed[1].message.content, /^Чат клиента fl-fentezi11 на FL\.ru\. /);
  assert.deepEqual(claude.opened, [`claude://resume?session=${chat.sessionId}`]);

  claude.openDesktopChat(world.kworkRoot, chat.sessionId);
  clock += 2000;
  await waker.tick();
  await claude.waitInbox(1);
  clock += 2000;
  await waker.tick();
  assert.equal(stateOf().pending['fl-fentezi11'], undefined, 'побудка подтверждена');
  assert.match(claude.inbox[0].user.message.content, /Клиент fl-fentezi11 написал на FL\.ru\./);
  assert.match(claude.inbox[0].user.message.content, /Здравствуйте, когда начнёте\?/);
  assert.doesNotMatch(claude.inbox[0].user.message.content, /мой отклик/, 'свой отклик до ответа заказчика — не новость');

  // Опрос прислал тот же чат ещё раз (сбой подписи, повтор) — второй побудки нет.
  save(thread);
  clock += 2000;
  await waker.tick();
  clock += 2000;
  await waker.tick();
  assert.equal(claude.inbox.length, 1);

  // Событие биржи приходит сообщением заказчика и будит тот же чат.
  save([...thread, { id: 'fl-offer-75961540-chosen', time: new Date(clock).toISOString(), authorId: String(CUSTOMER), authorName: null, text: 'Событие FL.ru: заказчик выбрал вас исполнителем по заказу «Сайт».', replyTo: null }]);
  clock += 2000;
  await waker.tick();
  await claude.waitInbox(2);
  assert.equal(claude.inbox[1].sessionId, chat.sessionId);
  assert.match(claude.inbox[1].user.message.content, /Событие FL\.ru: заказчик выбрал вас исполнителем/);
  claude.closeDesktopChats();
});

test('проверка звеньев: опрос FL.ru — звено только после первого удачного прохода', () => {
  const NOW = at(40);
  const facts = (flStatus) => ({
    now: NOW,
    manifestVersion: '1.35.0',
    bridge: { pid: 1, node: 'v24.0.0', at: new Date(NOW - 5000).toISOString(), wakerAt: new Date(NOW - 3000).toISOString() },
    bridgeAlive: true,
    extension: { version: '1.35.0', at: new Date(NOW - 1000).toISOString(), tabs: [], pullAt: null, blockedUntil: 0, fl: flStatus },
    sync: { ok: true, at: new Date(NOW - 60 * 1000).toISOString() },
    desktopRunning: true,
    dispatcher: { configured: true, inDesktop: true, pid: 77 },
    inboundAccept: true,
    pending: [],
  });
  const link = (flStatus) => health.evaluate(facts(flStatus)).find((item) => item.id === 'incoming-fl');
  assert.equal(link(null), undefined, 'FL.ru не пользуются — звена нет');
  assert.equal(link({ at: NOW, error: 'нет входа на FL.ru', signedOut: true }), undefined, 'ни разу не прошёл — звена нет');
  assert.deepEqual([link({ at: NOW - 60000, okAt: NOW - 60000 }).ok, link({ at: NOW - 60000, okAt: NOW - 60000 }).detail], [true, 'опрос 1 мин назад']);
  // Один сорвавшийся запрос — не сбой; 10 минут без удачного прохода — мертво.
  assert.equal(link({ at: NOW, okAt: NOW - 3 * 60000, error: 'Failed to fetch' }).ok, true);
  // Отказ сайта ставит паузу 10 минут: следующий удачный проход — через 12, это ещё не сбой.
  assert.equal(link({ at: NOW - 12 * 60000, okAt: NOW - 12 * 60000 - 1, error: 'FL.ru не отдал данные (ответ 502)', pausedUntil: NOW - 2 * 60000 }).ok, true);
  assert.deepEqual([link({ at: NOW, okAt: NOW - 16 * 60000, error: 'Failed to fetch' }).ok, link({ at: NOW, okAt: NOW - 16 * 60000, error: 'Failed to fetch' }).detail], [false, 'опрос не проходит 16 мин: Failed to fetch']);
  assert.deepEqual([link({ at: NOW, okAt: NOW - 60000, error: 'нет входа на FL.ru', signedOut: true }).ok, link({ at: NOW, okAt: NOW - 60000, signedOut: true }).detail], [false, 'вы вышли из FL.ru — войдите на fl.ru']);
  assert.equal(link({ at: NOW, okAt: NOW, warn: 'сделок FL.ru не разобрано: 1' }).ok, false);
});
