const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reply = require('../src/reply-core.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
// Комментарии не в счёт: проверяется только код.
const code = (name) => read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('панель ничего не отправляет: ни submit, ни клавиш, ни кнопок отправки', () => {
  for (const name of ['reply-main.js', 'reply-content.js']) {
    const source = code(name);
    assert.doesNotMatch(source, /\.submit\s*\(|requestSubmit|submitOffer|dispatchEvent\(\s*new\s+(?:Keyboard|Submit)Event|KeyboardEvent|keydown|keypress|['"]Enter['"]|keyCode/, name);
    assert.doesNotMatch(source, /\$\([^)]*\)\.trigger\(\s*['"](?:submit|click|keydown|keyup)/, name);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|\.ajax\(|\$\.post|sendBeacon/, name);
  }

  // Нажатия — только через safeClick по списку открывающих кнопок.
  const main = code('reply-main.js');
  const clicks = [...main.matchAll(/\.click\(\)/g)];
  assert.equal(clicks.length, 1, 'единственный .click() — внутри safeClick');
  const safeBlock = /const SAFE_CLICKS = \{([\s\S]*?)\};/.exec(main)[1];
  assert.doesNotMatch(safeBlock, /submit|send|offer-individual__submit|pass-work/i);
  assert.match(main, /FORBIDDEN_TARGET[\s\S]*js-box-submit[\s\S]*js-suggest-offer-submit[\s\S]*offer-individual__submit/);
  // В изолированной части кликов по странице нет вовсе.
  assert.doesNotMatch(code('reply-content.js'), /\.click\(\)/);
});

test('панель подключена в оба мира, ядро черновиков — до панели', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const [main, isolated] = manifest.content_scripts;
  assert.equal(main.world, 'MAIN');
  assert.ok(main.js.includes('src/reply-main.js'));
  assert.ok(isolated.js.indexOf('src/reply-core.js') < isolated.js.indexOf('src/reply-content.js'));
  assert.ok(isolated.js.indexOf('src/inbox-core-isolated.js') < isolated.js.indexOf('src/reply-content.js'));
});

const DRAFT = {
  id: 'd1',
  at: '2026-10-22T10:05:00Z',
  parts: reply.parseDraftParts(`**1. Ответить на** «А сколько по срокам?»
Сообщение клиенту:
\`\`\`
3 дня.
\`\`\`

**2. Опция**
Опция клиенту:
\`\`\`
Название: Форма оплаты
Цена: 2 300 ₽
Срок: 1 день
\`\`\`

**3. Обычным сообщением**
Сообщение клиенту: Подтвердите, пожалуйста.`),
};

test('вид панели: заголовок с числом частей, текущая часть и кнопка с её номером', () => {
  const progress = reply.draftProgress(DRAFT, [{ id: '9', authorId: '1', text: '3 дня', time: '2026-10-22T10:06:00Z' }], { clientId: '2' });
  const view = reply.panelView(DRAFT, progress);
  assert.equal(view.title, 'Черновик агента · 3 части');
  assert.equal(view.counter, 'готово 1 из 3');
  assert.equal(view.button, 'Подготовить часть 2');
  assert.deepEqual(view.rows.map((row) => [row.n, row.label, row.state]), [
    [1, 'Ответить на', 'done'],
    [2, 'Опция', 'current'],
    [3, 'Обычным сообщением', 'next'],
  ]);
  assert.equal(view.rows[0].target, '«А сколько по срокам?»');
  // Цена опции — ближайшая из списка Kwork.
  assert.equal(view.rows[1].target, '«Форма оплаты»');
  assert.match(view.rows[1].text, /^2 500 ₽ · 1 день$/);
});

test('цена опции берётся ближайшей из списка Kwork, при равенстве — бо́льшая', () => {
  assert.equal(reply.snapOptionPrice(2300), 2500);
  assert.equal(reply.snapOptionPrice(4200), 4000);
  assert.equal(reply.snapOptionPrice(26500), 28000);
  assert.equal(reply.snapOptionPrice(250000), 100000);
  assert.equal(reply.snapOptionPrice(0), null);
});

test('опция считается выставленной по доходу при любой ставке комиссии Kwork', () => {
  const draft = { ...DRAFT, skipped: [1] };
  // 2 300 → в Kwork 2 500, клиенту с оборотом больше 30 тыс. комиссия 12%: доход 2 200.
  const events = [{ type: 13, time: '2026-10-22T10:08:00Z', options: [{ name: 'Форма оплаты', price: 2200 }] }];
  const progress = reply.draftProgress(draft, [], { clientId: '2', events });
  assert.deepEqual(progress.done, [1, 2]);
  assert.equal(progress.current.n, 3);
});

test('слова «часть» склоняются по числу', () => {
  const view = (count) => reply.panelView({ parts: Array.from({ length: count }, (_, index) => ({ n: index + 1, mode: 'plain', text: 'x' })) }, { done: [], current: { n: 1 } }).title;
  assert.equal(view(1), 'Черновик агента · 1 часть');
  assert.equal(view(4), 'Черновик агента · 4 части');
  assert.equal(view(5), 'Черновик агента · 5 частей');
  assert.equal(view(11), 'Черновик агента · 11 частей');
});

test('пропущенная часть видна как пропущенная, а не как отправленная', () => {
  const progress = reply.draftProgress({ ...DRAFT, skipped: [1] }, [], { clientId: '2' });
  assert.deepEqual(progress.skipped, [1]);
  const view = reply.panelView(DRAFT, progress);
  assert.deepEqual(view.rows.map((row) => row.state), ['skipped', 'current', 'next']);
  assert.equal(view.counter, 'готово 1 из 3');
});

test('одна выставленная опция закрывает одну часть, даже если у двух частей одна цена', () => {
  const draft = {
    at: '2026-10-22T10:05:00Z',
    parts: reply.parseDraftParts('Опция клиенту:\nНазвание: Форма оплаты\nЦена: 2000 ₽\nСрок: 1 день\n\nОпция клиенту:\nНазвание: Импорт\nЦена: 2000 ₽\nСрок: 1 день'),
  };
  const events = [{ id: 'track:9', type: 13, time: '2026-10-22T10:08:00Z', options: [{ name: 'Импорт', price: 1600 }] }];
  const progress = reply.draftProgress(draft, [], { clientId: '2', events });
  // Совпало по названию — закрыта именно «Импорт», «Форма оплаты» ждёт.
  assert.deepEqual(progress.done, [2]);
  assert.equal(progress.current.n, 1);
});

test('два одинаковых ответа в черновике не закрываются одним отправленным сообщением', () => {
  const draft = { at: '2026-10-22T10:05:00Z', parts: reply.parseDraftParts('Сообщение клиенту: Да.\n\nСообщение клиенту: Да.') };
  const progress = reply.draftProgress(draft, [{ id: '9', authorId: '1', text: 'Да', time: '2026-10-22T10:06:00Z' }], { clientId: '2' });
  assert.deepEqual(progress.done, [1]);
});

test('предложение дешевле минимума Kwork считается отправленным по цене, которую поставила форма', () => {
  const draft = { at: '2026-10-22T10:05:00Z', parts: reply.parseDraftParts('Предложение клиенту:\nОписание: Мелкая правка.\nЦена: 400 ₽\nСрок: 1 день') };
  const sent = [{ id: '9', authorId: '1', text: 'Предложение индивидуального кворка', time: '2026-10-22T10:06:00Z', event: { type: 'offer_kwork_new', price: 500, status: 'new' } }];
  assert.equal(reply.draftProgress(draft, sent, { clientId: '2' }).finished, true);
});

test('пропущенная часть не забирает отправленное у следующей с тем же текстом', () => {
  const draft = {
    at: '2026-10-22T09:00:00Z',
    basedOn: '2026-10-22T09:00:00Z',
    skipped: [1],
    parts: [
      { n: 1, mode: 'reply', target: 'Сделаете форму?', text: 'Да, сделаю' },
      { n: 2, mode: 'reply', target: 'А лендинг?', text: 'Да, сделаю' },
    ],
  };
  const sent = [{ id: '10', time: '2026-10-22T09:05:00Z', authorId: '1', authorName: 'me', text: 'Да, сделаю' }];
  const progress = reply.draftProgress(draft, sent, { clientId: '2' });
  assert.deepEqual(progress.skipped, [1]);
  assert.deepEqual(progress.done, [1, 2]);
  assert.equal(progress.finished, true);
});

test('своё сообщение, которое Kwork уже показал, закрывает часть сразу, без ожидания диска', () => {
  const draft = { at: '2026-10-22T10:05:00Z', parts: reply.parseDraftParts('Сообщение клиенту: Да.\n\nСообщение клиенту: Да.') };
  const disk = [{ id: '1', time: '2026-10-22T10:00:00Z', authorId: '2', text: 'Подойдёт?' }];
  const page = [{ id: 'page:1:1', time: '2026-10-22T10:06:00Z', authorId: '1', text: 'Да.' }];
  const options = { clientId: '2' };
  assert.equal(reply.draftProgress(draft, disk, options).current.n, 1);
  assert.equal(reply.draftProgress(draft, reply.withPageMessages(disk, page), options).current.n, 2);
  // То же сообщение уже на диске (секунда другая) — не считается дважды.
  const saved = [...disk, { id: '7', time: '2026-10-22T10:06:01Z', authorId: '1', text: 'Да.' }];
  assert.equal(reply.withPageMessages(saved, page).length, saved.length);
  assert.equal(reply.draftProgress(draft, reply.withPageMessages(saved, page), options).current.n, 2);
});

test('правка черновика без «Ответить на» сохраняет, на что отвечала та же неотправленная часть', () => {
  const previous = { parts: reply.parseDraftParts('**1. Ответить на** «ОГРН куда?»\nСообщение клиенту:\n```\nДлинный ответ.\n```\n\n**2. Опция**\nОпция клиенту:\n```\nНазвание: Адрес\nЦена: 1 000 ₽\nСрок: 2 дня\n```') };
  const plain = reply.parseDraftParts('Сообщение клиенту:\n```\nКороткий ответ.\n```', { markImplicit: true });
  assert.deepEqual(reply.inheritTargets(plain, previous), [{ n: 1, mode: 'reply', target: 'ОГРН куда?', text: 'Короткий ответ.' }]);
  // Явное «Обычным сообщением» — решение агента, не наследуется.
  const explicit = reply.parseDraftParts('**1. Обычным сообщением**\nСообщение клиенту: Короткий ответ.', { markImplicit: true });
  assert.equal(reply.inheritTargets(explicit, previous)[0].mode, 'plain');
  // Та часть уже ушла — новый текст про другое.
  assert.equal(reply.inheritTargets(plain, previous, [1])[0].mode, 'plain');
  // Частей стало больше — какая чему соответствует, не угадать.
  const two = reply.parseDraftParts('Сообщение клиенту: Раз.\n\nСообщение клиенту: Два.', { markImplicit: true });
  assert.deepEqual(reply.inheritTargets(two, previous).map((part) => part.mode), ['plain', 'plain']);
  assert.equal('implicit' in reply.inheritTargets(two, previous)[0], false);
  // Без флага разбор прежний.
  assert.equal('implicit' in reply.parseDraftParts('Сообщение клиенту: Да.')[0], false);
});

test('панель видит отправленное на странице и подменяет в поле свой устаревший текст', () => {
  const content = code('reply-content.js');
  assert.match(content, /withPageMessages\(snapshot\.messages, pageOwnMessages\(\)\)/);
  assert.match(content, /attributeFilter: \['data-kph-key'\]/);
  assert.match(content, /onlyIf: last\.text/);
  const main = code('reply-main.js');
  assert.match(main, /onlyIf[\s\S]*quiet: true/);
  // Правка пользователя в один знак — уже его текст: сравнение без отбрасывания пунктуации.
  assert.match(main, /if \(onlyIf && !sameText\(editorText\(\), onlyIf\) && !\(typed && sameText\(typed\.text, onlyIf\)\)\)/);
  assert.match(main, /known \|\| \[\]\)\.some\(\(item\) => sameText\(item, current\)\)/);
  assert.doesNotMatch(content, /normalizeText\(last\.text\)/);
});

test('своё поле панель узнаёт точно: текст после вставки совпадает, правка в знак или в теге — уже нет', () => {
  const vm = require('node:vm');
  const main = read('reply-main.js');
  const pick = (name) => {
    const start = main.indexOf(`  function ${name}(`);
    const end = main.indexOf('\n  }\n', start);
    return main.slice(start, end + 4);
  };
  const sandbox = {};
  vm.runInNewContext(`${['escapeHtml', 'textToEditorHtml', 'plain', 'sameText'].map(pick).join('\n')}; this.api = { textToEditorHtml, plain, sameText };`, sandbox);
  const { textToEditorHtml, plain, sameText } = sandbox.api;
  const field = (text) => plain(textToEditorHtml(text)).trim();
  const text = 'Да, «так» & <div> подойдёт.\n\nВторая строка — и третья!';
  assert.equal(sameText(field(text), text), true);
  assert.equal(sameText(field(text), text.replace('!', '?')), false);
  assert.equal(sameText(field('Используйте <div> для блока.'), 'Используйте <section> для блока.'), false);
});

test('по кнопке текст печатается по знаку и Kwork показывает клиенту «печатает»', () => {
  const main = code('reply-main.js');
  const content = code('reply-content.js');
  // Подмена по новому черновику — сразу, по кнопке — шагами из ядра.
  assert.match(content, /steps: onlyIf \? null : reply\.typingSteps\(part\.text\)/);
  assert.match(main, /if \(onlyIf \|\| !steps\?\.length\)/);
  // Сигнал «печатает» — собственный обработчик Kwork, без клавиш.
  assert.match(main, /window\.pullIsTypeMessage/);
  assert.match(main, /kwork\?\._typeText\?\.\(\)/);
  // Поле изменил не набор панели — печать останавливается.
  // Поле сверяется по редактору: textarea Kwork догоняет его только на keyup.
  assert.match(main, /window\.location\.href !== run\.href \|\| !sameText\(editorText\(\), run\.written\)/);
  assert.match(main, /return editor \? plain\(editor\.innerHTML\)\.trim\(\) : fieldText\(\)/);
  // «Отправить» во время печати сначала дописывает весь текст; скрытая вкладка — тоже.
  assert.match(main, /\['pointerdown', 'click'\][\s\S]*event\.isTrusted && event\.target\?\.closest\?\.\(SEND_BUTTON\)\) finishTyping\(\)/);
  assert.match(main, /if \(document\.hidden\) finishTyping\(\)/);
  assert.match(main, /finally \{\s*run\.active = false;/);
  // «Пропустить» и «Скрыть черновик» останавливают печать.
  assert.match(content, /function skipCurrent\(\) \{[\s\S]*?stopTyping\(\);/);
  assert.match(content, /'Скрыть черновик', \(\) => \{\s*stopTyping\(\);/);
  assert.match(main, /kind === 'stop-typing'/);
  // «Своё ли поле» решает редактор, а не отстающая textarea.
  assert.match(main, /const typed = typing && sameText\(editorText\(\), typing\.written\)/);
  assert.match(main, /const current = editorText\(\);/);
  // Эмодзи в поле — <img alt>: сверка по тексту их не теряет.
  assert.match(main, /\.replace\(\/<img\\b\[\^>\]\*\\balt="\(\[\^"\]\*\)"\[\^>\]\*>\/gi, '\$1'\)/);
  assert.match(main, /kind: 'typed'/);
  assert.match(content, /kind !== 'typed'/);
});
