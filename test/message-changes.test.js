process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const wakeCore = require('../native_host/wake-core.js');
const { handleCommand } = require('../native_host/store.js');

const CLIENT = 501;
const ME = 900;
// После выкладки учёта правок (CHANGES_TRACKED_SINCE): правки — свежие.
const at = (minute) => Date.UTC(2026, 10, 22, 16, minute) / 1000;
const before = (minute) => Date.UTC(2026, 10, 20, 9, minute) / 1000;

// Сообщение обычной выгрузки Kwork (/inbox_more_messages): свой id и MID ленты.
function raw(id, mid, minute, from, text, extra = {}) {
  return { id, MID: mid, MSGFROM: from, MSGTO: from === CLIENT ? ME : CLIENT, mfrom: from === CLIENT ? 'ivan' : 'me', mto: from === CLIENT ? 'me' : 'ivan', time: at(minute), message: text, updated_at: null, ...extra };
}

const norm = (item) => core.normalizeMessage(item);

test('правка сообщения: прежний текст остаётся в edits, без новой отметки Kwork правкой не считается', () => {
  const saved = [norm(raw(11, 401, 0, CLIENT, 'Сделайте к пятнице'))];
  assert.equal(saved[0].mid, '401');
  assert.equal(saved[0].editedAt, undefined);

  const edited = norm(raw(11, 401, 0, CLIENT, 'Сделайте к понедельнику', { updated_at: at(5) }));
  const merged = core.mergeMessages(saved, [edited]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'Сделайте к понедельнику');
  assert.deepEqual(merged[0].edits, [{ text: 'Сделайте к пятнице', at: new Date(at(5) * 1000).toISOString() }]);

  // Та же правка пришла ещё раз — вторая запись в edits не появляется.
  assert.equal(core.mergeMessages(merged, [edited])[0].edits.length, 1);
  // Текст другой, а отметки правки нет (сменился разбор) — не правка.
  assert.equal(core.mergeMessages(saved, [norm(raw(11, 401, 0, CLIENT, 'Сделайте  к пятнице'))])[0].edits, undefined);
  // Старая копия после новой не откатывает правку.
  const stale = core.mergeMessages(merged, [norm(raw(11, 401, 0, CLIENT, 'Сделайте к пятнице', { updated_at: at(3) }))]);
  assert.equal(stale[0].edits.length, 1);
});

test('копия getnewmessages (id = MID) и правленая копия обычной выгрузки — одно сообщение с прежним номером', () => {
  const quiet = core.parseNewMessages({ success: true, data: { messagesData: [{ MID: 401, MSGFROM: CLIENT, MSGTO: ME, time: at(0), message: 'Сделайте к пятнице' }] } }, { dialogKey: 'ivan', clientId: String(CLIENT) }).messages;
  assert.equal(quiet[0].id, '401');

  const merged = core.mergeMessages(quiet, [norm(raw(11, 401, 0, CLIENT, 'Сделайте к понедельнику', { updated_at: at(5) }))]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, '401');
  assert.equal(merged[0].edits[0].text, 'Сделайте к пятнице');

  // Номер ленты совпал у чужой реплики (другие автор и время) — склейки нет.
  const other = core.mergeMessages(quiet, [norm(raw(999, 401, 9, ME, 'Ответ'))]);
  assert.equal(other.length, 2);
});

test('удалённое: сохранённой реплики новее начала первой страницы в ответе нет — отметка; вернулась — снята', () => {
  const saved = [
    norm(raw(10, 400, 0, CLIENT, 'Старое, за краем страницы')),
    norm(raw(11, 401, 5, CLIENT, 'Передумал')),
    { ...norm(raw(12, 402, 6, ME, 'Принято')), id: '402' },
    norm(raw(13, 403, 7, CLIENT, 'Ещё')),
  ];
  const fresh = [norm(raw(20, 410, 3, CLIENT, 'Первое на странице')), norm(raw(12, 402, 6, ME, 'Принято')), norm(raw(13, 403, 7, CLIENT, 'Ещё'))];
  const now = '2026-11-22T10:00:00.000Z';
  const marked = core.markDeleted(saved, fresh, fresh[0].time, now);

  assert.equal(marked[0].deletedAt, undefined, 'старше страницы — неизвестно');
  assert.equal(marked[1].deletedAt, now);
  assert.equal(marked[2].deletedAt, undefined, 'копия с номером MID узнана');
  assert.equal(marked[3].deletedAt, undefined);
  assert.equal(core.markDeleted(marked, [...fresh, norm(raw(11, 401, 5, CLIENT, 'Передумал'))], fresh[0].time, now)[1].deletedAt, undefined);
  assert.equal(core.markDeleted(saved, [], fresh[0].time, now), saved, 'пустой ответ ничего не говорит');
});

test('мост: удалённое и правленое видно в переписке, а не исчезает', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-changes-'));
  const dialog = (messages, extra = {}) => ({ command: 'save-dialog', dialog: { key: 'ivan', title: 'ivan', clientId: String(CLIENT), messages, ...extra } });
  handleCommand(targetDir, dialog([norm(raw(11, 401, 5, CLIENT, 'Передумал')), norm(raw(12, 402, 6, CLIENT, 'Сделайте к пятнице')), norm(raw(13, 403, 7, ME, 'Хорошо'))]));
  // Без windowFrom (вкладка Kwork, тихая выгрузка) пропажа ничего не значит.
  handleCommand(targetDir, dialog([norm(raw(13, 403, 7, ME, 'Хорошо'))]));
  const fresh = [norm(raw(12, 402, 6, CLIENT, 'Сделайте к понедельнику', { updated_at: at(9) })), norm(raw(13, 403, 7, ME, 'Хорошо'))];
  handleCommand(targetDir, dialog(fresh, { windowFrom: norm(raw(9, 399, 1, CLIENT, '-')).time }));

  const record = JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan', core.DIALOG_DATA_NAME), 'utf8'));
  assert.equal(record.messages.length, 3);
  assert.ok(record.messages[0].deletedAt);
  assert.equal(record.messages[1].edits[0].text, 'Сделайте к пятнице');

  const markdown = fs.readFileSync(path.join(targetDir, 'ivan', core.DIALOG_MARKDOWN_NAME), 'utf8');
  assert.match(markdown, /## ivan — 22\.11\.2026, 19:05 МСК \(удалено, замечено /);
  assert.match(markdown, /\(изменено 22\.11\.2026, 19:09 МСК\)\n\nСделайте к понедельнику\n\n> Текст до правки 22\.11\.2026, 19:09 МСК:\n> Сделайте к пятнице/);
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('побудка: правка или удаление разобранного сообщения — событие для агента, один раз', () => {
  const record = { key: 'ivan', clientId: String(CLIENT), messages: [norm(raw(11, 401, 0, CLIENT, 'Сделайте к пятнице')), norm(raw(12, 402, 1, ME, 'Хорошо'))] };
  const handled = { handled: '12', events: wakeCore.currentEventMarks(record) };
  assert.equal(wakeCore.findWakeNews(record, handled), null);

  record.messages = core.mergeMessages(record.messages, [norm(raw(11, 401, 0, CLIENT, 'Сделайте к понедельнику', { updated_at: at(5) }))]);
  const news = wakeCore.findWakeNews(record, handled);
  assert.equal(news.reason, 'event');
  assert.equal(news.messages.length, 0);
  assert.equal(news.events.length, 1);
  assert.equal(news.events[0].actor, 'client');
  const text = wakeCore.buildWakeText({ wakeId: 'w1', nick: 'ivan', record, messages: news.messages, events: news.events, reason: news.reason, route: {}, dialogDir: '/tmp/ivan', chatScript: 'chat.mjs', rerouteScript: 'reroute.mjs', rulesPath: 'rules.md' });
  assert.match(text, /Клиент изменил сообщение от 22\.11 19:00\. Было: «Сделайте к пятнице»\. Стало: «Сделайте к понедельнику»/);

  // Разобрано — повторно не будит; своё удаление — новое событие «Вы удалили».
  const settled = { handled: news.lastId, events: news.marks };
  assert.equal(wakeCore.findWakeNews(record, settled), null);
  record.messages = core.markDeleted(record.messages, [record.messages[0]], record.messages[0].time, '2026-11-22T10:00:00.000Z');
  const deleted = wakeCore.findWakeNews(record, settled);
  assert.equal(deleted.events[0].actor, 'me');
  assert.match(wakeCore.describeEvent(deleted.events[0]), /^Вы удалили сообщение от 22\.11 19:01: «Хорошо»/);
});

test('неразобранное удалённое приходит с пометкой, а список диалогов замечает правку последнего сообщения', () => {
  const message = { ...norm(raw(11, 401, 0, CLIENT, 'Передумал')), deletedAt: '2026-11-22T10:00:00.000Z' };
  assert.equal(core.changeNote(message, String), '(удалено)');
  const text = wakeCore.buildWakeText({ wakeId: 'w2', nick: 'ivan', record: { clientId: String(CLIENT) }, messages: [message], route: {}, dialogDir: '/tmp/ivan', chatScript: 'c', rerouteScript: 'r', rulesPath: 'p' });
  assert.match(text, /\] Передумал \(удалено\)/);

  const markup = (updated) => `<script>window.chatList=${JSON.stringify([{ username: 'ivan', USERID: CLIENT, MID: 401, time: at(0), lastMessage: { MID: 401, updated_at: updated } }])};</script>`;
  const before = core.parseChatList(markup(null))[0];
  const seen = { ivan: before.lastId };
  assert.equal(core.selectChangedDialogs([before], seen).length, 0);
  assert.equal(core.selectChangedDialogs(core.parseChatList(markup(String(at(5)))), seen).length, 1);
});

test('копия из вкладки, видевшая сообщение до правки, не откатывает текст и не укорачивает историю правок', () => {
  const quiet = core.parseNewMessages({ success: true, data: { messagesData: [{ MID: 401, MSGFROM: CLIENT, MSGTO: ME, mfrom: 'ivan', mto: 'me', time: at(0), message: 'orig' }] } }, { dialogKey: 'ivan', clientId: String(CLIENT) }).messages;
  let saved = core.mergeMessages(quiet, [norm(raw(11, 401, 0, CLIENT, 'NEW', { updated_at: at(5) }))]);
  saved = core.mergeMessages(saved, [norm(raw(11, 401, 0, CLIENT, 'NEWER', { updated_at: at(8) }))]);
  assert.deepEqual(saved[0].edits.map((edit) => edit.text), ['orig', 'NEW']);

  const tab = core.mergeMessages(quiet, [norm(raw(11, 401, 0, CLIENT, 'NEW', { updated_at: at(5) }))]);
  const merged = core.mergeMessages(saved, quiet, tab);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'NEWER');
  assert.deepEqual(merged[0].edits.map((edit) => edit.text), ['orig', 'NEW']);
});

test('двойная отправка: удалили одну из двух одинаковых копий — живая не помечается удалённой', () => {
  const saved = core.mergeMessages([norm(raw(11, 401, 5, ME, 'Готово')), norm(raw(12, 402, 5, ME, 'Готово'))]);
  assert.equal(saved.length, 1);
  const fresh = [norm(raw(9, 399, 1, CLIENT, 'Начало')), norm(raw(12, 402, 5, ME, 'Готово'))];
  assert.equal(core.markDeleted(saved, fresh, fresh[0].time, 'now')[0].deletedAt, undefined);
});

test('мост: давние правки и удаления старого диалога агенту не шлются, свежие — шлются', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-changes-'));
  const read = () => JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan', core.DIALOG_DATA_NAME), 'utf8'));
  const save = (messages, extra = {}) => handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', title: 'ivan', clientId: String(CLIENT), messages, ...extra } });
  const old = (id, minute, text, extra) => norm({ ...raw(id, id + 390, 0, CLIENT, text, extra), time: before(minute) });
  // Запись до выкладки: полей сверки нет.
  fs.mkdirSync(path.join(targetDir, 'ivan'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'ivan', core.DIALOG_DATA_NAME), JSON.stringify({ key: 'ivan', clientId: String(CLIENT), messages: [old(10, 1, 'старое'), old(11, 2, 'давно удалено'), old(12, 3, 'было'), old(13, 4, 'правили давно'), norm(raw(14, 404, 1, CLIENT, 'Бюджет 5000'))] }));

  const fresh = [old(10, 1, 'старое'), old(12, 3, 'стало', { updated_at: at(7) }), old(13, 4, 'правили давно, итог', { updated_at: before(30) })];
  save(fresh, { windowFrom: fresh[0].time });
  let record = read();
  assert.ok(record.messages[1].deletedAt && record.messages[1].deletedQuiet, 'давняя пропажа — тихо');
  assert.equal(record.messages[4].deletedQuiet, undefined, 'реплика после выкладки удалена — новость');
  assert.equal(record.messages[3].edits.length, 1);
  assert.deepEqual(record.messages.map(core.changeMark), [null, null, '1', null, '0d']);
  assert.equal(record.deletionsChecked, true);

  // Дальше удаление и старой реплики — новость.
  save([old(12, 3, 'стало', { updated_at: at(7) })], { windowFrom: new Date(before(0) * 1000).toISOString() });
  assert.equal(core.changeMark(read().messages[0]), '0d');
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('мост: новый клиент — удаление после тихой первой записи будит', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-changes-'));
  const save = (messages, extra = {}) => handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', title: 'ivan', clientId: String(CLIENT), messages, ...extra } });
  save([norm(raw(11, 401, 0, CLIENT, 'Здравствуйте, нужен сайт')), norm(raw(12, 402, 1, CLIENT, 'Бюджет 5000'))]);
  const first = [norm(raw(11, 401, 0, CLIENT, 'Здравствуйте, нужен сайт'))];
  save(first, { windowFrom: first[0].time });
  const record = JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan', core.DIALOG_DATA_NAME), 'utf8'));
  assert.equal(core.changeMark(record.messages[1]), '0d');
  assert.ok(wakeCore.findWakeNews(record, { handled: '12', events: {} }).events.some((event) => event.id === 'chg:12'));
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test('длинное удалённое сообщение в побудке не теряет пометку', () => {
  const message = { ...norm(raw(11, 401, 0, CLIENT, 'ТЗ '.repeat(1200))), deletedAt: '2026-11-22T10:00:00.000Z' };
  const text = wakeCore.buildWakeText({ wakeId: 'w3', nick: 'ivan', record: { clientId: String(CLIENT) }, messages: [message], route: {}, dialogDir: '/tmp/ivan', chatScript: 'c', rerouteScript: 'r', rulesPath: 'p' });
  assert.match(text, /… \(удалено\)/);
});

test('мост: запись событий заказа не сбрасывает сверку удалений — свежее удаление старой реплики будит', () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-changes-'));
  const read = () => JSON.parse(fs.readFileSync(path.join(targetDir, 'ivan', core.DIALOG_DATA_NAME), 'utf8'));
  const old = norm({ ...raw(11, 401, 0, CLIENT, 'до выкладки'), time: before(1) });
  const keep = norm(raw(12, 402, 1, CLIENT, 'после'));
  const from = new Date(before(0) * 1000).toISOString();
  handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: String(CLIENT), messages: [old, keep] } });
  handleCommand(targetDir, { command: 'save-order-events', dialogKey: 'ivan', clientId: String(CLIENT), orderId: '7', events: [{ id: 'track-900', orderId: '7', type: 32, time: new Date(at(2) * 1000).toISOString(), title: 'Вы сдали заказ на проверку' }] });
  assert.equal(read().events.length, 1);
  assert.equal(read().deletionsChecked, true);
  handleCommand(targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: String(CLIENT), messages: [keep], windowFrom: from } });
  assert.equal(core.changeMark(read().messages[0]), '0d');
  fs.rmSync(targetDir, { recursive: true, force: true });
});
