// Время в сводке — по часам мака; в тестах часы зафиксированы.
process.env.TZ = 'Europe/Moscow';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const load = () => import('../scripts/kwork-drafts.mjs');

const AT = '2026-10-14T05:40:00.000Z';
const at = (minutes) => new Date(Date.parse(AT) + minutes * 60000).toISOString();

function dialog(slug, messages) {
  return { slug, record: { key: slug, clientId: '501', messages } };
}

function out(id, minutes, text) {
  return { id: String(id), time: at(minutes), authorId: '900', text };
}

function incoming(id, minutes, text) {
  return { id: String(id), time: at(minutes), authorId: '501', text };
}

function draft(extra) {
  return {
    id: 'd1',
    session: 's1',
    order: 'shop',
    nicks: ['ivan'],
    kind: 'message',
    at: AT,
    body: 'Сделаю каталог за 5 дней, цена 7 500 ₽. Начну завтра после доступа к хостингу.',
    prices: [7500],
    terms: [5],
    ...extra,
  };
}

test('черновик вынимается из блока кода, цитаты и абзаца без пояснений агента', async () => {
  const { extractDrafts } = await load();

  const fenced = extractDrafts('Вот ответ.\n\n**Сообщение клиенту:**\n```\nЗдравствуйте!\nСделаю за 3 дня.\n```\nПояснение: срок с запасом.');
  assert.deepEqual(fenced.map((item) => [item.kind, item.body]), [['message', 'Здравствуйте!\nСделаю за 3 дня.']]);
  assert.deepEqual(fenced[0].terms, [3]);

  const quoted = extractDrafts('Ответ клиенту:\n> Добрый день.\n> Файл получил.\n\nДальше проверю доступы.');
  assert.equal(quoted[0].body, 'Добрый день.\nФайл получил.');

  const plain = extractDrafts('Текст для клиента: Пришлите логотип в SVG.\nИ доступ к админке.\n\n## Что дальше\nЖду ответа.');
  assert.equal(plain[0].body, 'Пришлите логотип в SVG.\nИ доступ к админке.');
});

test('отклик и цена со сроком распознаются отдельно', async () => {
  const { extractDrafts } = await load();

  const offer = extractDrafts('Название заказа: Лендинг для школы\nЦена: 10 000 ₽\nСрок: 5 дней\n\nСделаю лендинг на Tilda.');
  assert.equal(offer.length, 1);
  assert.equal(offer[0].kind, 'offer');
  assert.equal(offer[0].title, 'Лендинг для школы');
  assert.deepEqual(offer[0].prices, [10000]);
  assert.deepEqual(offer[0].terms, [5]);

  const price = extractDrafts('Оценка:\nЦена: 4 500 ₽\nСрок: 2 рабочих дня');
  assert.deepEqual(price.map((item) => [item.kind, item.prices, item.terms]), [['price', [4500], [2]]]);
});

test('последний ход берётся после настоящего сообщения пользователя', async () => {
  const { readLastTurn } = await load();
  const lines = [
    { type: 'user', message: { content: 'старый вопрос' } },
    { type: 'assistant', uuid: 'a0', timestamp: AT, message: { content: [{ type: 'text', text: 'Сообщение клиенту: старое' }] } },
    { type: 'user', message: { content: 'напиши клиенту про сроки https://kwork.ru/projects/3266878' } },
    { type: 'assistant', uuid: 'a1', timestamp: AT, message: { content: [{ type: 'text', text: 'Смотрю.' }, { type: 'tool_use', id: 't' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: AT, message: { content: [{ type: 'text', text: 'Сообщение клиенту: новое' }] } },
    '{не json',
  ].map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));

  const turn = readLastTurn(lines);
  assert.match(turn.prompt, /напиши клиенту/);
  assert.deepEqual(turn.replies.map((reply) => reply.uuid), ['a1', 'a2']);
});

test('отправка с правками и другой ценой записывается с фактическим текстом', async () => {
  const { resolveDrafts } = await load();
  const results = resolveDrafts({
    pending: [draft()],
    dialogs: [dialog('ivan', [incoming(1, -30, 'Сколько?'), out(2, 10, 'Сделаю каталог за 5 дней, цена 7 000 ₽. Начну завтра после доступа к хостингу.')])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.equal(results.length, 1);
  assert.match(results[0].line, /^- 2026-10-14 \| ivan \(shop\) \| предложено: 7 500 ₽ \/ 5 дн/);
  assert.match(results[0].line, /отправлено 14\.10 08:50 \(авто\): с правками; цена 7500 → 7000 ₽ «Сделаю каталог/);
  assert.match(results[0].line, /\| session s1 \| draft d1$/);
});

test('постороннее сообщение тому же клиенту отправкой черновика не считается', async () => {
  const { resolveDrafts } = await load();
  const dialogs = [dialog('ivan', [out(2, 10, 'Добрый день, по ломбарду обновил отчёт, посмотрите.')])];

  assert.deepEqual(resolveDrafts({ pending: [draft()], dialogs, claimed: [], now: Date.parse(at(20)) }), []);
});

test('«не нашёл» пишется только когда переписка за окно точно выгружена', async () => {
  const { resolveDrafts } = await load();
  const dialogs = [dialog('ivan', [out(2, 10, 'Добрый день, обновил отчёт.')])];
  const later = Date.parse(at(73 * 60));

  assert.deepEqual(resolveDrafts({ pending: [draft()], dialogs, claimed: [], now: later, sync: { ok: true, at: at(60) } }), []);

  const [result] = resolveDrafts({ pending: [draft()], dialogs, claimed: [], now: later, sync: { ok: true, at: at(72 * 60 + 5) } });
  assert.match(result.line, /похожей отправки за 3 дня нет \(авто\); другие исходящие этому клиенту: «Добрый день, обновил отчёт\.»/);
});

test('одна отправка не закрывает два черновика', async () => {
  const { resolveDrafts } = await load();
  const dialogs = [dialog('ivan', [out(2, 10, 'Сделаю каталог за 5 дней, цена 7 500 ₽. Начну завтра после доступа к хостингу.')])];
  const results = resolveDrafts({
    pending: [draft(), draft({ id: 'd2', at: at(1) })],
    dialogs,
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.deepEqual(results.map((item) => item.draft.id), ['d1']);
});

test('черновик без известного клиента подтверждается только почти дословной отправкой', async () => {
  const { resolveDrafts } = await load();
  const pending = [draft({ nicks: [], kind: 'price', body: 'Цена: 7 500 ₽\nСрок: 5 дней' })];
  const dialogs = [dialog('petr', [out(2, 10, 'По другому проекту 7 500 ₽ за всё')])];

  assert.deepEqual(resolveDrafts({ pending, dialogs, claimed: [], now: Date.parse(at(20)) }), []);
});

test('отклик сверяется с биржей по номеру проекта', async () => {
  const { resolveDrafts } = await load();
  const pending = [draft({ kind: 'offer', projectId: '3266878', title: 'Лендинг', body: 'Цена: 10 000 ₽\nСрок: 5 дней\nСделаю лендинг', prices: [10000], terms: [5], nicks: [] })];
  const offersFile = { updatedAt: at(30), offers: [{ offerId: '40685415', projectId: '3266878', price: 9000, days: 5, text: 'Сделаю лендинг на Tilda' }] };

  const [result] = resolveDrafts({ pending, dialogs: [], offersFile, claimed: [], now: Date.parse(at(40)) });
  assert.match(result.line, /отклик проект 3266878 «Лендинг»/);
  assert.match(result.line, /отправлено \(с биржи, авто\): 9 000 ₽ \/ 5 дн; текст правился; цена 10000 → 9000 ₽/);
  assert.match(result.claims[0], /^offer:40685415:[0-9a-f]{10}$/);
});

test('захват и сверка пишут строку в журнал один раз', async () => {
  const { capture, sync, listPending } = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-drafts-'));
  const kworkRoot = path.join(home, 'Projects', 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(path.join(targetDir, 'ivan'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'Активные', 'shop'), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), '- shop: ivan\n');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sent.md'), '# Журнал\n');

  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { content: 'ответь клиенту' } },
    { type: 'assistant', uuid: 'u1', timestamp: AT, message: { content: [{ type: 'text', text: 'Сообщение клиенту:\n> Пришлите доступ к хостингу, начну завтра.' }] } },
  ].map((item) => JSON.stringify(item)).join('\n'));

  const options = { home, kworkRoot, targetDir, dataDir, orderMapPath: path.join(kworkRoot, 'docs', 'заказы-клиенты.md') };
  const input = { session_id: 's9', transcript_path: transcript, cwd: path.join(kworkRoot, 'Активные', 'shop') };

  assert.equal(capture(input, options).length, 1);
  assert.equal(capture(input, options).length, 0);
  assert.deepEqual(listPending(options)[0].nicks, ['ivan']);
  assert.deepEqual(sync({ ...options, now: Date.parse(at(5)) }), []);

  fs.writeFileSync(path.join(targetDir, 'ivan', 'данные.json'), JSON.stringify({ key: 'ivan', clientId: '501', messages: [out(7, 3, 'Пришлите доступ к хостингу, начну завтра.')] }));
  assert.equal(sync({ ...options, now: Date.parse(at(5)) }).length, 1);
  assert.equal(sync({ ...options, now: Date.parse(at(6)) }).length, 0);

  const journal = fs.readFileSync(path.join(dataDir, 'sent.md'), 'utf8');
  assert.equal(journal.match(/draft /g).length, 1);
  assert.match(journal, /ivan \(shop\) \| предложено: «Пришлите доступ к хостингу, начну завтра\.» \| отправлено 14\.10 08:43 \(авто\): дословно \| session s9/);
  assert.deepEqual(listPending(options), []);
  assert.equal(capture(input, options).length, 0);
});

test('неотправленный черновик без цены и срока снимается без строки в журнале', async () => {
  const { resolveDrafts } = await load();
  const [result] = resolveDrafts({
    pending: [draft({ body: 'Пришлите доступ к хостингу.', prices: [], terms: [] })],
    dialogs: [dialog('ivan', [])],
    claimed: [],
    now: Date.parse(at(73 * 60)),
    sync: { ok: true, at: at(72 * 60 + 5) },
  });

  assert.equal(result.line, null);
});

test('черновики вне папок Kwork не ловятся', async () => {
  const { capture } = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-drafts-'));
  const transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { content: 'ответь клиенту' } },
    { type: 'assistant', uuid: 'u1', timestamp: AT, message: { content: [{ type: 'text', text: 'Текст клиенту:\n> Цена 5 000 ₽.' }] } },
  ].map((item) => JSON.stringify(item)).join('\n'));

  const written = capture(
    { session_id: 's1', transcript_path: transcript, cwd: path.join(home, 'Projects', 'Активные', 'app') },
    { home, kworkRoot: path.join(home, 'Projects', 'Kwork'), dataDir: path.join(home, 'data'), targetDir: path.join(home, 'none') },
  );
  assert.deepEqual(written, []);
});

test('склейка отправок останавливается на реплике клиента', async () => {
  const { resolveDrafts } = await load();
  const second = 'Сделаю каталог с импортом за 7 дней, цена 10 000 ₽. Начну завтра после доступа к хостингу.';
  const results = resolveDrafts({
    pending: [draft(), draft({ id: 'd2', at: at(13), body: second, prices: [10000], terms: [7] })],
    dialogs: [dialog('ivan', [
      out(2, 10, 'Сделаю каталог за 5 дней, цена 7 500 ₽. Начну завтра после доступа к хостингу.'),
      incoming(3, 12, 'А импорт из 1С сделаете?'),
      out(4, 15, second),
    ])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.deepEqual(results.map((item) => item.draft.id), ['d1', 'd2']);
  assert.doesNotMatch(results[0].line, /10000/);
  assert.match(results[1].line, /дословно/);
});

test('сообщение клиенту с ценой и сроком — один черновик, а не два', async () => {
  const { extractDrafts } = await load();
  const drafts = extractDrafts('Сообщение клиенту:\n> Сделаю каталог, начну завтра.\n\nЦена: 7 500 ₽\nСрок: 5 дней');

  assert.deepEqual(drafts.map((item) => [item.kind, item.prices, item.terms]), [['message', [7500], [5]]]);
});

test('короткая вежливость не подтверждает длинное предложение', async () => {
  const { resolveDrafts } = await load();
  const pending = [draft({ body: 'Спасибо за доступы. Сделаю каталог за 5 дней, цена 7 500 ₽. Начну завтра после проверки хостинга и базы.' })];
  const dialogs = [dialog('ivan', [out(2, 10, 'Спасибо за доступы')])];

  assert.deepEqual(resolveDrafts({ pending, dialogs, claimed: [], now: Date.parse(at(20)) }), []);
});

test('старый отклик на тот же проект не подтверждает новый черновик', async () => {
  const { resolveDrafts } = await load();
  const old = { offerId: '40685415', projectId: '3266878', price: 9000, days: 5, text: 'Сделаю лендинг на Tilda' };
  const pending = [draft({
    kind: 'offer', projectId: '3266878', title: 'Лендинг', body: 'Цена: 8 000 ₽\nСрок: 4 дня\nСделаю лендинг быстрее', prices: [8000], terms: [4], nicks: [],
    offerBaseline: { maxOfferId: 40685415, project: '9000|5|Сделаю лендинг на Tilda' },
  })];

  assert.deepEqual(resolveDrafts({ pending, dialogs: [], offersFile: { updatedAt: at(30), offers: [old] }, claimed: [], now: Date.parse(at(40)) }), []);

  const edited = { ...old, price: 8000, days: 4, text: 'Сделаю лендинг быстрее' };
  const [result] = resolveDrafts({ pending, dialogs: [], offersFile: { updatedAt: at(30), offers: [edited] }, claimed: [], now: Date.parse(at(40)) });
  assert.match(result.line, /отправлено \(с биржи, авто\): 8 000 ₽ \/ 4 дн; текст как предложен$|текст как предложен \|/);
});

test('срок голым числом в отклике распознаётся', async () => {
  const { extractDrafts } = await load();
  const [offer] = extractDrafts('Название заказа: Лендинг\nЦена: 10 000 ₽\nСрок: 5\n\nСделаю лендинг.');

  assert.deepEqual(offer.terms, [5]);
});

test('дословный отклик не считается правленым из-за строк цены и срока', async () => {
  const { resolveDrafts } = await load();
  const pending = [draft({ kind: 'offer', projectId: '1', title: 'Сайт', body: 'Цена: 5 000 ₽\nСрок: 3 дня\n\nСделаю сайт на Tilda', prices: [5000], terms: [3], nicks: [] })];
  const offersFile = { updatedAt: at(30), offers: [{ offerId: '2', projectId: '1', price: 5000, days: 3, text: 'Сделаю сайт на Tilda' }] };

  const [result] = resolveDrafts({ pending, dialogs: [], offersFile, claimed: [], now: Date.parse(at(40)) });
  assert.match(result.line, /текст как предложен/);
});

test('пока диалог не дочитан, «не отправлял» не пишется', async () => {
  const { resolveDrafts } = await load();
  const later = Date.parse(at(73 * 60));
  const sync = { ok: false, at: at(72 * 60 + 5), pending: ['Ivan'] };

  assert.deepEqual(resolveDrafts({ pending: [draft()], dialogs: [dialog('ivan', [])], claimed: [], now: later, sync }), []);

  const other = { ...sync, pending: ['petr'] };
  const [result] = resolveDrafts({ pending: [draft()], dialogs: [dialog('ivan', [])], claimed: [], now: later, sync: other });
  assert.match(result.line, /похожей отправки за 3 дня нет/);
});

test('без снимка откликов старый отклик черновик не подтверждает', async () => {
  const { resolveDrafts, offerBaseline } = await load();
  const baseline = offerBaseline(null, '3266878');
  const pending = [draft({ kind: 'offer', projectId: '3266878', title: 'Лендинг', body: 'Цена: 8 000 ₽\nСрок: 4 дня\nСделаю лендинг', prices: [8000], terms: [4], nicks: [], offerBaseline: baseline })];
  const offersFile = { updatedAt: at(30), offers: [{ offerId: '100', projectId: '3266878', price: 10000, days: 5, text: 'Старый отклик' }] };

  assert.deepEqual(resolveDrafts({ pending, dialogs: [], offersFile, claimed: [], now: Date.parse(at(40)) }), []);
});

test('отредактированный отклик подтверждает новый черновик, даже если старая версия уже учтена', async () => {
  const { resolveDrafts } = await load();
  const first = { offerId: '100', projectId: '1', price: 9000, days: 5, text: 'Сделаю лендинг на Tilda' };
  const [old] = resolveDrafts({
    pending: [draft({ kind: 'offer', projectId: '1', title: 'Сайт', body: 'Цена: 9 000 ₽\nСрок: 5 дней\nСделаю лендинг на Tilda', prices: [9000], terms: [5], nicks: [] })],
    dialogs: [], offersFile: { updatedAt: at(30), offers: [first] }, claimed: [], now: Date.parse(at(40)),
  });

  const edited = { ...first, price: 8000, days: 4, text: 'Сделаю лендинг быстрее' };
  const pending = [draft({
    id: 'd2', at: at(50), kind: 'offer', projectId: '1', title: 'Сайт', body: 'Цена: 8 000 ₽\nСрок: 4 дня\nСделаю лендинг быстрее', prices: [8000], terms: [4], nicks: [],
    offerBaseline: { maxOfferId: 100, project: '9000|5|Сделаю лендинг на Tilda' },
  })];
  const [result] = resolveDrafts({ pending, dialogs: [], offersFile: { updatedAt: at(60), offers: [edited] }, claimed: old.claims, now: Date.parse(at(70)) });
  assert.match(result.line, /отправлено \(с биржи, авто\): 8 000 ₽ \/ 4 дн/);
});

test('цена и срок отдельными сообщениями попадают в сверку', async () => {
  const { resolveDrafts } = await load();
  const [result] = resolveDrafts({
    pending: [draft()],
    dialogs: [dialog('ivan', [
      out(2, 10, 'Сделаю каталог за 5 дней, цена 7 500 ₽. Начну завтра после доступа к хостингу.'),
      out(3, 11, 'Цена: 7 000 ₽'),
      out(4, 11, 'Срок: 7 дней'),
    ])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.match(result.line, /цена 7500 → 7500, 7000 ₽|цена 7500 → 7000 ₽/);
  assert.match(result.line, /срок 5 → 5, 7 дн|срок 5 → 7 дн/);
  assert.equal(result.claims.length, 3);
});

test('номер проекта берётся из блока отклика, даже если в ходе много ссылок', async () => {
  const { buildPendingDrafts } = await load();
  const text = 'Подборка: https://kwork.ru/projects/1 https://kwork.ru/projects/2 https://kwork.ru/projects/3\n\nНазвание заказа: Сайт\nhttps://kwork.ru/projects/100\nЦена: 5 000 ₽\nСрок: 3 дня\n\nСделаю сайт.';
  const [offer] = buildPendingDrafts({ turn: { prompt: 'https://kwork.ru/projects/7', replies: [{ uuid: 'u', at: AT, text }] }, sessionId: 's', cwd: '/', order: null, nicks: [] });

  assert.equal(offer.projectId, '100');
});

test('цена и срок, отправленные отдельно без текста, засчитываются в известном диалоге', async () => {
  const { resolveDrafts } = await load();
  const [result] = resolveDrafts({
    pending: [draft({ kind: 'price', body: 'Цена: 7 500 ₽\nСрок: 5 дней' })],
    dialogs: [dialog('ivan', [out(2, 10, 'Цена: 7 000 ₽'), out(3, 11, 'Срок: 7 дней')])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.match(result.line, /цена 7500 → 7000 ₽; срок 5 → 7 дн/);
  assert.equal(result.claims.length, 2);
});

test('голый срок в отправке учитывается при сравнении', async () => {
  const { resolveDrafts } = await load();
  const [result] = resolveDrafts({
    pending: [draft()],
    dialogs: [dialog('ivan', [
      out(2, 10, 'Сделаю каталог, цена 7 500 ₽. Начну завтра после доступа к хостингу.'),
      out(3, 11, 'Срок: 7'),
    ])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.match(result.line, /срок 5 → 7 дн/);
});

test('короткая реплика про предоплату не подтверждает предложение', async () => {
  const { resolveDrafts } = await load();
  const results = resolveDrafts({
    pending: [draft()],
    dialogs: [dialog('ivan', [out(2, 10, 'Предоплату 1 000 ₽ получил, спасибо')])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.deepEqual(results, []);
});

test('недели и часы в сроке не считаются днями, а «р» — это рубли', async () => {
  const { extractPrices, resolveDrafts } = await load();
  assert.deepEqual(extractPrices('Цена: 7 000 р'), [7000]);
  assert.deepEqual(extractPrices('7500Р за все'), [7500]);
  assert.deepEqual(extractPrices('5 работ'), []);

  const [result] = resolveDrafts({
    pending: [draft()],
    dialogs: [dialog('ivan', [
      out(2, 10, 'Сделаю каталог, цена 7 500 ₽. Начну завтра после доступа к хостингу.'),
      out(3, 11, 'Срок: 1 неделя'),
    ])],
    claimed: [],
    now: Date.parse(at(20)),
  });
  assert.doesNotMatch(result.line, /срок 5 → 1/);
});

test('предоплата той же суммой не подтверждает оценку', async () => {
  const { resolveDrafts } = await load();
  const results = resolveDrafts({
    pending: [draft({ kind: 'price', body: 'Цена: 7 500 ₽\nСрок: 5 дней' })],
    dialogs: [dialog('ivan', [out(2, 10, 'Предоплату 7 500 ₽ получил, спасибо')])],
    claimed: [],
    now: Date.parse(at(20)),
  });

  assert.deepEqual(results, []);
});

test('отложенный непрочитанный диалог тоже не даёт решить «не отправлял»', async () => {
  const { resolveDrafts } = await load();
  const later = Date.parse(at(73 * 60));
  const sync = { ok: true, at: at(72 * 60 + 5), pending: ['ivan'] };

  assert.deepEqual(resolveDrafts({ pending: [draft()], dialogs: [dialog('ivan', [])], claimed: [], now: later, sync }), []);
});

test('«сценарию» — не слово о цене, а предоплата со сроком не подтверждает оценку', async () => {
  const { resolveDrafts } = await load();
  for (const text of ['Предоплату 7 500 ₽ получил, завтра приступаю к сценарию', 'Предоплату 7 500 ₽ получил, срок 5 дней']) {
    const results = resolveDrafts({
      pending: [draft({ kind: 'price', body: 'Цена: 7 500 ₽\nСрок: 5 дней' })],
      dialogs: [dialog('ivan', [out(2, 10, text)])],
      claimed: [],
      now: Date.parse(at(20)),
    });
    assert.deepEqual(results, [], text);
  }
});

test('отложенный диалог, которого нет среди прочитанных файлов, не даёт решить «не отправлял»', async () => {
  const { resolveDrafts } = await load();
  const later = Date.parse(at(73 * 60));
  const sync = { ok: true, at: at(72 * 60 + 5), pending: ['ivan'] };

  // Известный клиент, файла переписки ещё нет.
  assert.deepEqual(resolveDrafts({ pending: [draft()], dialogs: [], claimed: [], now: later, sync }), []);
  // Клиент неизвестен, а отложенный диалог старый и в выборку не попал.
  assert.deepEqual(resolveDrafts({ pending: [draft({ nicks: [] })], dialogs: [dialog('petr', [])], claimed: [], now: later, sync }), []);
});

test('черновик из частей ложится для панели на Kwork: чей он, на что опирается, новый заменяет старый', async () => {
  const { capture } = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-drafts-'));
  const kworkRoot = path.join(home, 'Projects', 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  const dataDir = path.join(home, 'data');
  for (const nick of ['ivan', 'petr']) fs.mkdirSync(path.join(targetDir, nick), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), '');
  fs.writeFileSync(path.join(targetDir, 'petr', 'данные.json'), JSON.stringify({
    key: 'Petr', clientId: '77', messages: [
      { id: '1', time: '2026-10-22T09:00:00.000Z', authorId: '77', authorName: 'Petr', text: 'Сколько по срокам?', orderId: '555' },
      { id: '2', time: '2026-10-22T09:01:00.000Z', authorId: '1', authorName: 'me', text: 'Смотрю' },
    ],
  }));
  const options = { home, kworkRoot, targetDir, dataDir, orderMapPath: path.join(kworkRoot, 'docs', 'заказы-клиенты.md') };
  const write = (uuid, text) => fs.writeFileSync(transcript, [
    { type: 'user', message: { content: '[Kwork-побудка #a1b2c3d4] Клиент ivan написал на Kwork.' } },
    { type: 'assistant', uuid: 'u0', timestamp: AT, message: { content: [{ type: 'text', text: 'Готово.' }] } },
    { type: 'user', message: { content: '[Kwork-побудка #b1b2c3d4] Клиент Petr написал на Kwork.' } },
    { type: 'assistant', uuid, timestamp: AT, message: { content: [{ type: 'text', text }] } },
  ].map((item) => JSON.stringify(item)).join('\n'));
  const transcript = path.join(home, 't.jsonl');
  // Корневой чат Kwork: клиент — из последней побудки.
  const input = { session_id: 's1', transcript_path: transcript, cwd: kworkRoot };
  const file = path.join(targetDir, 'data', 'drafts', 'petr.json');

  write('u1', '**1. Ответить на** «Сколько по срокам?»\nСообщение клиенту:\n```\n3 дня.\n```');
  capture(input, options);
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([draft.nick, draft.clientId, draft.basedOn, draft.orderId], ['Petr', '77', '2026-10-22T09:00:00.000Z', '555']);
  assert.deepEqual(draft.parts.map((part) => [part.mode, part.target, part.text]), [['reply', 'Сколько по срокам?', '3 дня.']]);
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'drafts', 'ivan.json')), false);

  write('u2', '**1. Обычным сообщением**\nСообщение клиенту:\n```\nНачинаю.\n```');
  capture(input, options);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).parts[0].text, 'Начинаю.');

  // Ход без частей черновик не трогает.
  write('u3', 'Проверил логи, всё в порядке.');
  capture(input, options);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).parts[0].text, 'Начинаю.');
});

test('агент поправил черновик и не повторил «Ответить на» — в панели ответ остаётся ответом', async () => {
  const { capture } = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kph-drafts-'));
  const kworkRoot = path.join(home, 'Projects', 'Kwork');
  const targetDir = path.join(kworkRoot, 'переписки');
  fs.mkdirSync(path.join(targetDir, 'petr'), { recursive: true });
  fs.mkdirSync(path.join(kworkRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(kworkRoot, 'docs', 'заказы-клиенты.md'), '');
  const writeDialog = (messages) => fs.writeFileSync(path.join(targetDir, 'petr', 'данные.json'), JSON.stringify({ key: 'Petr', clientId: '77', messages }));
  const question = { id: '1', time: '2026-10-22T09:00:00.000Z', authorId: '77', authorName: 'Petr', text: 'ОГРН куда?' };
  writeDialog([question]);
  const options = { home, kworkRoot, targetDir, dataDir: path.join(home, 'data'), orderMapPath: path.join(kworkRoot, 'docs', 'заказы-клиенты.md') };
  const transcript = path.join(home, 't.jsonl');
  const write = (uuid, text) => fs.writeFileSync(transcript, [
    { type: 'user', message: { content: '[Kwork-побудка #b1b2c3d4] Клиент Petr написал на Kwork.' } },
    { type: 'assistant', uuid, timestamp: AT, message: { content: [{ type: 'text', text }] } },
  ].map((item) => JSON.stringify(item)).join('\n'));
  const input = { session_id: 's1', transcript_path: transcript, cwd: kworkRoot };
  const file = path.join(targetDir, 'data', 'drafts', 'petr.json');
  const parts = () => JSON.parse(fs.readFileSync(file, 'utf8')).parts.map((part) => [part.mode, part.target, part.text, 'implicit' in part]);

  write('u1', '**1. Ответить на** «ОГРН куда?»\nСообщение клиенту:\n```\nДлинный ответ про ОГРН.\n```');
  capture(input, options);
  write('u2', 'Короче:\n\nСообщение клиенту:\n```\nОГРН не нужен.\n```');
  capture(input, options);
  assert.deepEqual(parts(), [['reply', 'ОГРН куда?', 'ОГРН не нужен.', false]]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).session, 's1');

  // Тот же клиент, чат другого заказа: черновик оттуда — не прошлый вариант этого.
  write('u2b', 'Сообщение клиенту:\n```\nПо второй задаче всё готово.\n```');
  capture({ ...input, session_id: 's2' }, options);
  assert.deepEqual(parts(), [['plain', null, 'По второй задаче всё готово.', false]]);
  write('u2c', '**1. Ответить на** «ОГРН куда?»\nСообщение клиенту:\n```\nОГРН не нужен.\n```');
  capture(input, options);

  // Ответ ушёл, следующий черновик без заголовка — уже обычное сообщение.
  writeDialog([question, { id: '2', time: '2026-10-22T09:05:00.000Z', authorId: '1', authorName: 'me', text: 'ОГРН не нужен.' }]);
  write('u3', 'Сообщение клиенту:\n```\nИ ещё: выложил на оба стенда.\n```');
  capture(input, options);
  assert.deepEqual(parts(), [['plain', null, 'И ещё: выложил на оба стенда.', false]]);
});
