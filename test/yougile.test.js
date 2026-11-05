process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const yougile = require('../src/yougile-core.js');
const reply = require('../src/reply-core.js');
const wakeCore = require('../native_host/wake-core.js');
const { handleCommand } = require('../native_host/store.js');
const { createWaker } = require('../native_host/waker.js');
const { createFakeClaude } = require('./helpers/fake-claude.js');

const ME = 'me-0594';
const at = (minute) => Date.UTC(2026, 10, 4, 16, minute);
const raw = (minute, from, text, properties = {}) => ({ timestamp: at(minute), from, text, properties });
const names = { [ME]: 'Никита', 'u-ivan': 'Иван П', 'u-petr': 'Пётр' };

test('ключ чата YouGile: компания и 12 знаков из адреса чата', () => {
  assert.equal(yougile.dialogKey('Acme', 'c1', '11111111-2222-3333-4444-0f1e2d3c4b5a'), 'yougile-acme-0f1e2d3c4b5a');
  assert.equal(yougile.dialogKey('Рога и копыта', 'c1', '11111111-2222-3333-4444-0f1e2d3c4b5a'), 'yougile-рога-и-копыта-0f1e2d3c4b5a');
  // Название из знаков, которых нет в ключе, — компания по номеру.
  assert.equal(yougile.dialogKey('✦✦', '7c3bb598-afb8-4fae', '11111111-2222-3333-4444-0f1e2d3c4b5a'), 'yougile-7c3bb598-0f1e2d3c4b5a');
  assert.equal(yougile.dialogKey('Acme', 'c1', 'short'), null);
  assert.equal(yougile.isDialogKey('yougile-acme-0f1e2d3c4b5a'), true);
  assert.equal(yougile.isDialogKey('stroisnab2007'), false);
  assert.equal(yougile.isDialogKey('yougile-acme-e0c2'), false);
});

test('сообщения чата: системные и удалённые не берутся, ответ и цитата — с текстом цели, имя автора', () => {
  const messages = yougile.normalizeMessages([
    raw(3, 'u-ivan', 'а сроки?', { replyTo: String(at(1)), replySnippetHtml: '<p>к пятнице</p>' }),
    raw(0, 'u-ivan', 'добавил вас', { fromSystem: true }),
    raw(1, ME, 'Сделаю к пятнице'),
    { ...raw(2, 'u-petr', 'лишнее'), deleted: true },
    raw(4, 'u-petr', '', { textHtml: '<p>Схема&nbsp;<b>готова</b></p><p>смотрите</p>' }),
    raw(5, 'u-petr', 'ответ без цитаты', { replyTo: at(3) }),
  ], (id) => names[id]);
  assert.deepEqual(messages.map((item) => [item.id, item.authorName, item.text]), [
    [String(at(1)), 'Никита', 'Сделаю к пятнице'],
    [String(at(3)), 'Иван П', 'а сроки?'],
    [String(at(4)), 'Пётр', 'Схема готова\nсмотрите'],
    [String(at(5)), 'Пётр', 'ответ без цитаты'],
  ]);
  assert.equal(messages[0].time, new Date(at(1)).toISOString());
  assert.deepEqual(messages[1].replyTo, { kind: 'quote', id: String(at(1)), text: 'к пятнице' });
  assert.deepEqual(messages[3].replyTo, { kind: 'reply', id: String(at(3)), text: 'а сроки?' });
  assert.equal(yougile.normalizeMessages([raw(1, ME, 'a'), raw(2, ME, 'b'), raw(3, ME, 'c')], () => null, 2).length, 2);
  // Картинка без подписи — тоже сообщение: иначе клиент прислал скриншот, а агент не узнал.
  assert.equal(yougile.normalizeMessages([raw(1, 'u-petr', '')])[0].text, '(файл без подписи, смотрите в YouGile)');
});

test('текст в поле YouGile: абзацы и переносы, разметка экранирована', () => {
  assert.equal(yougile.textToHtml('Да <b>\nзавтра\n\nВторое'), '<p>Да &lt;b&gt;<br>завтра</p><p>Второе</p>');
});

test('список заказов: несколько строк одного заказа складываются; шаблон чатов компании и точная строка', () => {
  const map = wakeCore.parseOrderMap('- veb: stroisnab2007 (выкладка: да)\n- veb: yougile-acme-*\n- lombard: yougile-acme-0f1e2d3c4b5a\n');
  assert.deepEqual(map.veb, { nicks: ['stroisnab2007', 'yougile-acme-*'], deploy: true });
  assert.equal(wakeCore.nickMatch('yougile-acme-*', 'yougile-acme-1a2b3c4d5e6f'), 'pattern');
  assert.equal(wakeCore.nickMatch('yougile-acme-0f1e2d3c4b5a', 'yougile-acme-0f1e2d3c4b5a'), 'exact');
  assert.equal(wakeCore.nickMatch('yougile-acme-*', 'yougile-akashidevelop-1a2b3c4d5e6f'), null);
  // Компания с похожим названием («Acme Test») под шаблон не попадает.
  assert.equal(wakeCore.nickMatch('yougile-acme-*', 'yougile-acme-test-1a2b3c4d5e6f'), null);
  assert.equal(wakeCore.nickMatch('*', 'ivan'), null);
  assert.equal(wakeCore.isRoutedSlug(map, 'yougile-acme-1a2b3c4d5e6f'), true);
  assert.equal(wakeCore.isRoutedSlug(map, 'yougile-akashidevelop-1a2b3c4d5e6f'), false);
});

test('в чате YouGile клиент — любой участник, кроме меня; у Kwork по-прежнему по номеру клиента', () => {
  const record = { key: 'yougile-acme-1', selfId: ME };
  assert.equal(wakeCore.isClientMessage({ authorId: 'u-petr' }, record), true);
  assert.equal(wakeCore.isClientMessage({ authorId: ME }, record), false);
  assert.equal(wakeCore.isClientMessage({ authorId: '501' }, { key: 'ivan', clientId: '501' }), true);
  assert.equal(wakeCore.isClientMessage({ authorId: '900' }, { key: 'ivan', clientId: '501' }), false);
});

test('побудка из YouGile: где написали, кто написал; ник в шапке узнаёт сверка черновиков', () => {
  const record = { key: 'yougile-acme-1a2b3c4d5e6f', source: 'yougile', title: 'Acme · личный чат с Иван П', selfId: ME };
  const messages = [{ id: '1', time: new Date(at(1)).toISOString(), authorId: 'u-ivan', authorName: 'Иван П', text: 'Посмотрите задачу', attachments: [] }];
  const text = wakeCore.buildWakeText({
    wakeId: 'abc123', nick: record.key, record, messages,
    route: { dir: '/k/Активные/veb', key: '/k/Активные/veb', order: { name: 'veb', dir: '/k/Активные/veb' } },
    dialogDir: '/k/переписки/yougile-acme-1a2b3c4d5e6f', chatScript: '/x/kwork-chat.mjs', rerouteScript: '/x/kwork-reroute.mjs', rulesPath: '/k/docs/побудка.md',
  });
  assert.match(text, /^\[Kwork-побудка #abc123\] Клиент yougile-acme-1a2b3c4d5e6f написал в YouGile\./);
  // Название чата и имя автора задают участники — они внутри блока данных.
  assert.match(text, /"""\n\(чат YouGile: Acme · личный чат с Иван П\)\n\[/);
  assert.match(text, /\] «Иван П»: Посмотрите задачу/);
  const own = wakeCore.buildWakeText({ wakeId: 'abc124', nick: record.key, record, messages: [], reason: 'own', route: { dir: '/k' }, dialogDir: '/k/x', chatScript: 'c', rerouteScript: 'r', rulesPath: 'p' });
  assert.match(own, /Вы написали клиенту yougile-acme-1a2b3c4d5e6f в YouGile/);
});

test('черновик в чате YouGile: новое сообщение любого участника делает его устаревшим, своё — закрывает часть', () => {
  const draft = { id: 'd1', at: new Date(at(2)).toISOString(), basedOn: new Date(at(1)).toISOString(), parts: [{ n: 1, mode: 'reply', target: 'сроки', text: 'Сделаю к пятнице' }] };
  const base = [{ id: '1', time: new Date(at(1)).toISOString(), authorId: 'u-ivan', text: 'а сроки?' }];
  const options = { clientId: null, dialogKey: 'yougile-acme-1', selfId: ME };
  assert.equal(reply.findTargetMessage(base, 'сроки', options).id, '1');
  // Одинаковый текст от двух участников: ответ встаёт на последнее, а панель знает, что выбор неоднозначен.
  const twins = [...base, { id: '4', time: new Date(at(2)).toISOString(), authorId: 'u-petr', authorName: 'Пётр', text: 'А сроки?' }];
  assert.deepEqual(reply.matchingMessages(twins, 'сроки', options).map((item) => item.id), ['1', '4']);
  assert.equal(reply.findTargetMessage(twins, 'сроки', options).id, '4');
  assert.deepEqual(reply.matchingMessages(twins, 'нет такого', options), []);
  const sent = reply.draftProgress(draft, [...base, { id: '2', time: new Date(at(3)).toISOString(), authorId: ME, text: 'Сделаю к пятнице' }], options);
  assert.deepEqual([sent.stale, sent.finished], [false, true]);
  const stale = reply.draftProgress(draft, [...base, { id: '3', time: new Date(at(3)).toISOString(), authorId: 'u-petr', text: 'и ещё' }], options);
  assert.equal(stale.stale, true);
});

function createWorld(mapText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-yougile-'));
  const kworkRoot = path.join(home, 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  for (const order of ['veb', 'lombard']) fs.mkdirSync(path.join(kworkRoot, 'Активные', order), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), mapText);
  return { home, kworkRoot, targetDir };
}

const dialog = (key, messages, extra = {}) => ({
  key, source: 'yougile', title: 'Acme · Чат CRM', url: 'https://ru.yougile.com/team/messenger#chat:0f1e2d3c4b5a', selfId: ME, messages, ...extra,
});
const message = (minute, authorId, text) => ({ id: String(at(minute)), time: new Date(at(minute)).toISOString(), authorId, authorName: names[authorId], text, replyTo: null });

test('мост пишет только чаты YouGile, подключённые к заказу; личный чат — под ключом подключённой компании', () => {
  const world = createWorld('- veb: stroisnab2007, yougile-acme-*\n');
  const skipped = handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-akashidevelop-0f1e2d3c4b5a', [message(1, 'u-petr', 'привет')]) });
  assert.equal(skipped.skipped, true);
  // Страница YouGile не может записать в переписку Kwork, даже если ник подключён к заказу.
  const spoofed = handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('stroisnab2007', [message(1, 'u-petr', 'подделка')], { alternatives: ['stroisnab2007'] }) });
  assert.equal(spoofed.skipped, true);
  assert.equal(fs.existsSync(path.join(world.targetDir, 'stroisnab2007')), false);
  assert.equal(fs.existsSync(path.join(world.targetDir, 'yougile-akashidevelop-0f1e2d3c4b5a')), false);

  const personal = handleCommand(world.targetDir, {
    command: 'save-dialog',
    dialog: dialog('yougile-akashidevelop-1a2b3c4d5e6f', [message(1, 'u-ivan', 'Посмотрите'), message(2, 'u-petr', 'И я'), message(3, ME, 'Смотрю')], { alternatives: ['yougile-acme-1a2b3c4d5e6f'] }),
  });
  assert.equal(personal.messages, 3);
  const record = JSON.parse(fs.readFileSync(path.join(world.targetDir, 'yougile-acme-1a2b3c4d5e6f', 'данные.json'), 'utf8'));
  assert.deepEqual([record.key, record.source, record.selfId, record.url], ['yougile-acme-1a2b3c4d5e6f', 'yougile', ME, 'https://ru.yougile.com/team/messenger#chat:0f1e2d3c4b5a']);
  assert.deepEqual(record.messages.map((item) => item.authorName), ['Иван П', 'Пётр', 'Никита']);

  fs.mkdirSync(path.join(world.targetDir, 'data', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(world.targetDir, 'data', 'drafts', 'yougile-acme-1a2b3c4d5e6f.json'), JSON.stringify({ id: 'd1', parts: [{ n: 1, mode: 'plain', text: 'Да' }] }));
  const draft = handleCommand(world.targetDir, { command: 'get-draft', dialogKey: 'yougile-acme-1a2b3c4d5e6f' });
  assert.equal(draft.selfId, ME);
  assert.equal(draft.messages.length, 3);
});

test('сводка заказа находит чаты компании по шаблону, кроме уведённых точной строкой в другой заказ', async () => {
  const { findOrderNicks } = await import('../scripts/kwork-shared.mjs');
  const map = { veb: ['stroisnab2007', 'yougile-acme-*'], lombard: ['stroisnab2007', 'yougile-acme-0f1e2d3c4b5a'] };
  const known = ['stroisnab2007', 'yougile-acme-0f1e2d3c4b5a', 'yougile-acme-1a2b3c4d5e6f', 'yougile-akashidevelop-111111111111'];
  assert.deepEqual(findOrderNicks('/k/Активные/veb', known, map), ['stroisnab2007', 'yougile-acme-1a2b3c4d5e6f']);
  assert.deepEqual(findOrderNicks('/k/Активные/lombard', known, map), ['stroisnab2007', 'yougile-acme-0f1e2d3c4b5a']);
});

test('будильщик: чат компании идёт в заказ по шаблону, точная строка другого заказа важнее; отключённый чат в корень Kwork не будит', async () => {
  const clock = Date.parse('2026-11-04T17:00:00Z');
  const world = createWorld('- veb: stroisnab2007, yougile-acme-*\n- lombard: yougile-acme-0f1e2d3c4b5a\n');
  const claude = createFakeClaude({ home: world.home, now: () => clock });
  const logs = [];
  const waker = createWaker({ targetDir: world.targetDir, kworkRoot: world.kworkRoot, runner: claude.runner, log: (line) => logs.push(line), now: () => clock });
  const save = (key, messages) => handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog(key, messages) });
  save('yougile-acme-1a2b3c4d5e6f', [message(1, ME, 'жду')]);
  await waker.tick();

  save('yougile-acme-1a2b3c4d5e6f', [message(1, ME, 'жду'), message(2, 'u-ivan', 'Посмотрите задачу')]);
  save('yougile-acme-0f1e2d3c4b5a', [message(3, 'u-petr', 'По CRM вопрос')]);
  await waker.tick();
  const state = JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8'));
  const veb = path.join(world.kworkRoot, 'Активные', 'veb');
  const lombard = path.join(world.kworkRoot, 'Активные', 'lombard');
  assert.ok(state.chats[veb], 'чат компании — в заказ по шаблону');
  assert.ok(state.chats[lombard], 'чат с точной строкой — в свой заказ');

  // Строки заказа больше нет: новое сообщение в чате не будит корень Kwork.
  fs.writeFileSync(path.join(world.kworkRoot, 'docs', 'заказы-клиенты.md'), '- veb: stroisnab2007\n');
  fs.writeFileSync(path.join(world.targetDir, 'yougile-acme-1a2b3c4d5e6f', 'данные.json'), JSON.stringify({
    ...dialog('yougile-acme-1a2b3c4d5e6f', [message(1, ME, 'жду'), message(2, 'u-ivan', 'Посмотрите задачу'), message(4, 'u-ivan', 'Ещё')]),
  }));
  fs.writeFileSync(path.join(world.targetDir, 'data', 'wake-dirty', 'yougile-acme-1a2b3c4d5e6f'), '');
  await waker.tick();
  const after = JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8'));
  assert.equal(Object.keys(after.chats).some((key) => key.includes('::')), false);
  assert.ok(logs.some((line) => /не подключён к заказу/.test(line)));
  claude.closeDesktopChats();
});

test('побочный чат, запущенный из чата заказа, побудку не забирает, даже если он свежее и уже записан чатом заказа', async () => {
  const clock = Date.parse('2026-11-04T17:00:00Z');
  const world = createWorld('- veb: yougile-acme-*\n');
  const veb = path.join(world.kworkRoot, 'Активные', 'veb');
  const claude = createFakeClaude({ home: world.home, now: () => clock });
  const waker = createWaker({ targetDir: world.targetDir, kworkRoot: world.kworkRoot, runner: claude.runner, now: () => clock });
  const save = (messages) => handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-acme-1a2b3c4d5e6f', messages) });
  save([message(1, ME, 'жду')]);
  await waker.tick();
  claude.say(veb, 'main-chat', clock - 60 * 60 * 1000);
  claude.addToDesktop('main-chat', { cwd: veb });
  claude.say(veb, 'side-chat', clock - 60 * 1000);
  claude.addToDesktop('side-chat', { cwd: veb, side: true });
  const statePath = path.join(world.targetDir, 'data', 'wake-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chats[veb] = { sessionId: 'side-chat', dir: veb, nick: 'yougile-acme-1a2b3c4d5e6f', startedAt: clock };
  fs.writeFileSync(statePath, JSON.stringify(state));
  claude.openDesktopChat(veb, 'main-chat');
  claude.openDesktopChat(veb, 'side-chat');
  save([message(1, ME, 'жду'), message(2, 'u-ivan', 'Посмотрите задачу')]);
  await waker.tick();
  await claude.waitInbox(1);
  assert.deepEqual(claude.inbox.map((item) => item.sessionId), ['main-chat']);
  claude.closeDesktopChats();
});

test('чат YouGile впервые лёг на диск: прочитанное в YouGile не будит, новое после — будит', async () => {
  const clock = Date.parse('2026-11-04T17:00:00Z');
  const world = createWorld('- veb: yougile-acme-*\n');
  const veb = path.join(world.kworkRoot, 'Активные', 'veb');
  const claude = createFakeClaude({ home: world.home, now: () => clock });
  const waker = createWaker({ targetDir: world.targetDir, kworkRoot: world.kworkRoot, runner: claude.runner, now: () => clock });
  // Первый такт будильщика — исходное состояние; чата YouGile на диске ещё нет.
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-acme-111111111111', [message(0, ME, 'старт')]) });
  await waker.tick();
  const save = (messages, seenUntil) => handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-acme-1a2b3c4d5e6f', messages, { seenUntil }) });
  save([message(1, 'u-ivan', 'старый вопрос')], new Date(at(1)).toISOString());
  await waker.tick();
  assert.equal(JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8')).chats[veb], undefined, 'прочитанное не будит');
  save([message(1, 'u-ivan', 'старый вопрос'), message(2, 'u-ivan', 'новый вопрос')], new Date(at(2)).toISOString());
  await waker.tick();
  assert.ok(JSON.parse(fs.readFileSync(path.join(world.targetDir, 'data', 'wake-state.json'), 'utf8')).chats[veb], 'новое будит');
  assert.equal(JSON.parse(fs.readFileSync(path.join(world.targetDir, 'yougile-acme-1a2b3c4d5e6f', 'данные.json'), 'utf8')).seenUntil, new Date(at(1)).toISOString(), 'прочитанное запоминается при первой записи');
  claude.closeDesktopChats();
});

test('черновик в заказе с Kwork и чатами YouGile: чей — по сообщению из «Ответить на», без побудок — клиенту Kwork', async () => {
  const { capturePanelDraft } = await import('../scripts/kwork-drafts.mjs');
  const world = createWorld('- veb: ivan, yougile-acme-*\n');
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-acme-1a2b3c4d5e6f', [message(1, 'u-ivan', 'Когда схема базы?')]) });
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: { key: 'ivan', clientId: '501', messages: [{ id: '7', time: new Date(at(2)).toISOString(), authorId: '501', authorName: 'ivan', text: 'Сроки по этапу?' }] } });
  const nicks = ['ivan', 'yougile-acme-1a2b3c4d5e6f'];
  const paths = { targetDir: world.targetDir };
  const draftFor = (uuid, text) => capturePanelDraft({ turn: { replies: [{ uuid, at: new Date(at(5)).toISOString(), text }] }, nicks, transcriptText: '', sessionId: 's1', order: 'veb', paths });
  assert.equal(draftFor('a', '**1. Ответить на** «Когда схема базы?»\nСообщение клиенту:\n```\nВ пятницу\n```\n').slug, 'yougile-acme-1a2b3c4d5e6f');
  assert.equal(draftFor('b', '**1. Ответить на** «Сроки по этапу?»\nСообщение клиенту:\n```\nДо 10.11\n```\n').slug, 'ivan');
  assert.equal(draftFor('c', 'Сообщение клиенту:\n```\nНовости по этапу\n```\n').slug, 'ivan');
});

test('свежесть чата YouGile — по времени записи самого чата, а не по Kwork: без неё «не отправлен» не утверждается', async () => {
  const { panelDraftLines, runBrief } = await import('../scripts/kwork-brief.mjs');
  const world = createWorld('- veb: ivan, yougile-acme-*\n');
  const key = 'yougile-acme-1a2b3c4d5e6f';
  fs.mkdirSync(path.join(world.targetDir, 'data', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(world.targetDir, 'data', 'drafts', `${key}.json`), JSON.stringify({
    id: 'd1', at: new Date(at(5)).toISOString(), basedOn: new Date(at(4)).toISOString(), parts: [{ n: 1, mode: 'plain', text: 'Сделаю к пятнице' }],
  }));
  const now = Date.now();
  const lines = () => panelDraftLines(world.targetDir, { nicks: [key], now, fresh: true }).join('\n');
  const dataPath = path.join(world.targetDir, key, 'данные.json');

  // Вкладка прислала чат — записан только что, сводка уверена.
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog(key, [message(4, 'u-ivan', 'Когда?')]) });
  assert.match(lines(), /НЕ отправлен/);

  // Другой чат YouGile (не из заказа) свежести этому чату не прибавляет.
  const old = new Date(now - 16 * 60 * 1000);
  fs.utimesSync(dataPath, old, old);
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog('yougile-other-111111111111', [message(6, 'u-ivan', 'не наш чат')]) });
  assert.match(lines(), /отправлен ли он, неизвестно/);

  // Сводка заказа сама говорит, что чаты YouGile не сохраняются.
  const orderDir = path.join(world.kworkRoot, 'Активные', 'veb');
  const brief = runBrief({ session_id: 's1', cwd: orderDir, hook_event_name: 'SessionStart' }, { home: world.home, kworkRoot: world.kworkRoot, targetDir: world.targetDir, now, pending: [] });
  assert.match(brief, /Чаты YouGile не сохранялись с .*: вкладка YouGile в Chrome закрыта/);

  // Вкладка снова прислала чат — свежо.
  handleCommand(world.targetDir, { command: 'save-dialog', dialog: dialog(key, [message(4, 'u-ivan', 'Когда?')]) });
  assert.match(lines(), /НЕ отправлен/);
});
