// Сверка «что агент предложил клиенту» ↔ «что пользователь отправил на самом деле».
// capture — Stop-хук: вынимает из ответа агента черновики (сообщение клиенту, цена и
// срок, отклик) и кладёт каждый отдельным файлом в pending/.
// sync — сверяет черновики с сохранёнными переписками и откликами с биржи и сама
// дописывает итог в журнал оценок sent.md. Пользователя ни о чём не спрашивает.
// Любой сбой — тихий выход с кодом 0: хук не должен мешать работе.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findOrderNicks, formatMoment, isClientMessage, normalizeWorkspace, readJson, readOrderMap,
  resolveChatsDir, resolveContext,
} from './kwork-shared.mjs';

const require = createRequire(import.meta.url);
const core = require('../src/inbox-core.js');

// Агенты называют черновик по-разному: «Сообщение клиенту:», «Текст клиенту:»,
// «Черновик клиенту, отправлять после выкладки:», «Предлагаю ответить клиенту так:».
// Общее — слово о тексте и «клиенту» в короткой строке, кончающейся двоеточием.
const MESSAGE_MARKER = /^(?:[^:\n]{0,30}\s)?(?:текст[а-яё]*|сообщени[а-яё]*|ответ[а-яё]*|черновик[а-яё]*|предлагаю ответить)(?:\s[^:\n]{0,40})?\s(?:для\sклиента|клиенту)(?:[\s,][^:\n]{0,50})?:\s*(.*)$/i;
const MARKER_START = /^(?:текст|сообщени|ответ|черновик)/i;
const OFFER_MARKER = /^Название заказа\s*:\s*(.+)$/i;
const PRICE_LINE = /^Цена\s*:.*(?:₽|руб)/i;
const TERM_LINE = /^Срок\s*:/i;
const PROJECT_LINK = /kwork\.ru\/projects\/(\d+)/g;
const BODY_LIMIT = 4000;
const EARLY_MS = 2 * 60 * 1000;
const MESSAGE_WINDOW_MS = 72 * 60 * 60 * 1000;
const OFFER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FOLLOW_UP_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;

// ---------- разбор ответа агента ----------

function stripDecoration(line) {
  return line.replace(/^\s*(?:#+\s*|>\s*)?/, '').replace(/\*\*/g, '').trim();
}

function isFence(line) {
  return /^\s*(```|~~~)/.test(line);
}

function isBoundary(line) {
  const clean = stripDecoration(line);
  return /^\s*(#|---|\*\*\*)/.test(line)
    || /^\*\*[^*]+\*\*\s*$/.test(line.trim())
    || MESSAGE_MARKER.test(clean)
    || OFFER_MARKER.test(clean);
}

// Текст черновика идёт за маркером: блоком кода, цитатой или абзацами до
// следующего заголовка, черты или маркера. Пояснения агента после пустой строки
// и заголовка в черновик не попадают.
function readBlock(lines, start, inFence) {
  const body = [];
  let index = start;

  while (index < lines.length && lines[index].trim() === '') {
    index += 1;
  }

  if (inFence) {
    for (; index < lines.length && !isFence(lines[index]); index += 1) {
      body.push(lines[index]);
    }

    return body;
  }

  if (index < lines.length && isFence(lines[index])) {
    for (index += 1; index < lines.length && !isFence(lines[index]); index += 1) {
      body.push(lines[index]);
    }

    return body;
  }

  if (index < lines.length && /^\s*>/.test(lines[index])) {
    for (; index < lines.length && /^\s*>/.test(lines[index]); index += 1) {
      body.push(lines[index].replace(/^\s*>\s?/, ''));
    }

    return body;
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (isBoundary(line) || isFence(line)) {
      break;
    }

    if (line.trim() === '' && index + 1 < lines.length && (isBoundary(lines[index + 1]) || lines[index + 1].trim() === '')) {
      break;
    }

    body.push(line);
  }

  return body;
}

export function extractPrices(text) {
  return [...String(text || '').matchAll(/(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:₽|руб|р\.|[рР](?![а-яёa-z]))/g)]
    .map((match) => Number(match[1].replace(/[  ]/g, '')))
    .filter((value) => value >= 100);
}

export function extractTerms(text) {
  return [...String(text || '').matchAll(/(\d+)\s*(?:рабоч[а-яё]*\s+)?(?:дн[а-яё]*|день|дня)/gi)].map((match) => Number(match[1]));
}

// В шаблоне отклика срок бывает голым числом: «Срок: 5».
function lineTerms(line) {
  const terms = extractTerms(line);
  if (terms.length > 0) {
    return terms.slice(0, 1);
  }

  const bare = /^Срок\s*:\s*(\d+)\s*$/i.exec(stripDecoration(line || ''));
  return bare ? [Number(bare[1])] : [];
}

// Сроки текста: «5 дней» и голое «Срок: 7» отдельной строкой.
function textTerms(text) {
  return String(text || '').split('\n').flatMap((line) => {
    const terms = extractTerms(line);
    return terms.length > 0 ? terms : lineTerms(line);
  });
}

// Комментарий отклика без строк цены и срока: на бирже они в отдельных полях.
function offerComment(body) {
  return String(body || '').split('\n').filter((line) => !/^(?:Цена|Срок)\s*:/i.test(stripDecoration(line))).join('\n').trim();
}

export function extractDrafts(text) {
  const lines = String(text || '').split('\n');
  const drafts = [];
  let inFence = false;
  const hasOffer = lines.some((line) => OFFER_MARKER.test(stripDecoration(line)));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }

    const clean = stripDecoration(line);
    const message = MESSAGE_MARKER.exec(clean);
    // Текст сразу за двоеточием — черновик, только если строка с маркера и
    // начинается: «В тексте есть вопрос клиенту: …» — это рассуждение агента.
    if (message && (!message[1].trim() || MARKER_START.test(clean))) {
      const body = [message[1], ...readBlock(lines, index + 1, inFence)].join('\n').trim();
      if (body) {
        drafts.push({ kind: 'message', body: body.slice(0, BODY_LIMIT) });
      }
      continue;
    }

    const offer = OFFER_MARKER.exec(clean);
    if (offer) {
      // Отклик — весь блок от названия до конца: в нём цена, срок и текст.
      const rest = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (isFence(lines[next]) && inFence) {
          break;
        }

        if (OFFER_MARKER.test(stripDecoration(lines[next]))) {
          break;
        }

        rest.push(lines[next]);
      }

      const body = rest.join('\n').trim();
      drafts.push({
        kind: 'offer',
        title: offer[1].trim(),
        body: body.slice(0, BODY_LIMIT),
        // В строке цены бывает и сумма «на руки»: ставкой считается первая.
        prices: extractPrices(body.split('\n').find((item) => PRICE_LINE.test(stripDecoration(item))) || '').slice(0, 1),
        terms: lineTerms(body.split('\n').find((item) => TERM_LINE.test(stripDecoration(item))) || ''),
      });
    }
  }

  if (!hasOffer) {
    const priceLine = lines.find((line) => PRICE_LINE.test(stripDecoration(line)));
    const termLine = lines.find((line) => TERM_LINE.test(stripDecoration(line)));
    // Цена и срок рядом с сообщением клиенту — та же оценка, а не вторая:
    // числа уходят в сообщение, отдельного черновика цены нет.
    const message = drafts.find((draft) => draft.kind === 'message');
    if (priceLine && termLine && message) {
      message.prices = extractPrices(priceLine).slice(0, 1);
      message.terms = lineTerms(termLine);
    } else if (priceLine && termLine) {
      drafts.push({
        kind: 'price',
        body: `${stripDecoration(priceLine)}\n${stripDecoration(termLine)}`,
        prices: extractPrices(priceLine).slice(0, 1),
        terms: lineTerms(termLine),
      });
    }
  }

  return drafts.map((draft) => ({
    prices: extractPrices(draft.body),
    terms: extractTerms(draft.body),
    ...draft,
  }));
}

// ---------- транскрипт Claude Code ----------

function contentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  return Array.isArray(content)
    ? content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n')
    : '';
}

function isRealPrompt(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.toolUseResult) {
    return false;
  }

  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
    return false;
  }

  const text = contentText(content).trim();
  return Boolean(text) && !/^<(command-|local-command|system-reminder|task-notification)/.test(text);
}

// Последний ход — всё, что агент написал после настоящего сообщения пользователя:
// результаты инструментов и служебные вставки ход не начинают.
export function readLastTurn(transcriptLines) {
  const entries = [];
  for (const line of transcriptLines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Недописанная строка журнала не мешает разбору остальных.
    }
  }

  let start = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isRealPrompt(entries[index])) {
      start = index;
      break;
    }
  }

  const prompt = start >= 0 ? contentText(entries[start].message?.content) : '';
  const replies = entries.slice(start + 1)
    .filter((entry) => entry?.type === 'assistant' && !entry.isSidechain)
    .map((entry) => ({ uuid: entry.uuid || null, at: entry.timestamp || null, text: contentText(entry.message?.content) }))
    .filter((entry) => entry.text.trim());

  return { prompt, replies };
}

function uniqueProject(...texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const match of String(text || '').matchAll(PROJECT_LINK)) {
      ids.add(match[1]);
    }
  }

  return ids.size === 1 ? [...ids][0] : null;
}

export function buildPendingDrafts({ turn, sessionId, cwd, order, nicks }) {
  const pending = [];
  const turnText = turn.replies.map((reply) => reply.text).join('\n');

  for (const reply of turn.replies) {
    extractDrafts(reply.text).forEach((draft, index) => {
      const id = createHash('sha1').update(`${reply.uuid || reply.at}:${draft.kind}:${index}`).digest('hex').slice(0, 12);
      pending.push({
        id,
        session: sessionId || null,
        cwd: cwd || null,
        order: order || null,
        nicks: nicks || [],
        // Ссылка в самом блоке отклика надёжнее: в подборке их в ходе много.
        projectId: draft.kind === 'offer' ? uniqueProject(draft.body) || uniqueProject(draft.body, turnText, turn.prompt) : null,
        at: reply.at || new Date().toISOString(),
        ...draft,
      });
    });
  }

  return pending;
}

// ---------- сверка ----------

function tokens(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]{2,}/gu) || [];
}

function normalize(text) {
  return tokens(text).join(' ');
}

export function containment(sent, draft) {
  const sentTokens = tokens(sent);
  if (sentTokens.length === 0) {
    return 0;
  }

  const draftTokens = new Set(tokens(draft));
  return sentTokens.filter((token) => draftTokens.has(token)).length / sentTokens.length;
}

function matchesDraft(message, draft, strict) {
  const text = message.text || '';
  const size = tokens(text).length;
  if (normalize(text) && normalize(text) === normalize(draft.body)) {
    return true;
  }

  // Совпадение одной цены доказывает отправку только внутри известного диалога:
  // по всем клиентам сразу та же сумма найдётся и в чужой переписке.
  if (!strict && draft.kind === 'price' && draft.prices.length > 0 && isPriceOffer(text, draft)) {
    const sentPrices = extractPrices(text);
    if (sentPrices.some((price) => draft.prices.includes(price))) {
      return true;
    }
  }

  if (isPaymentNote(text, draft)) {
    return false;
  }

  return strict
    ? size >= 5 && containment(text, draft.body) >= 0.8
    : size >= 3 && containment(text, draft.body) >= 0.6;
}

// Цену и срок пишут и отдельным коротким сообщением: «Цена: 7 000 ₽». Такое
// сообщение — часть той же отправки, хотя словами на черновик не похоже.
function isNumbersNote(text, draft) {
  if (!draft.prices?.length && !draft.terms?.length) {
    return false;
  }

  // Только реплика, которая задаёт цену или срок: «Цена: 7 000 ₽», «7 дней».
  // «Предоплату 1 000 ₽ получил» — про деньги, но не предложение.
  const lines = String(text || '').split('\n').map((line) => stripDecoration(line)).filter(Boolean);
  const statement = (line) => /^(?:цена|стоимость|итого|бюджет|срок)(?![а-яё])/i.test(line)
    || /^\d[\d  ]*(?:[.,]\d+)?\s*(?:₽|руб[а-яё.]*|р\.?|рабоч[а-яё]*\s+дн[а-яё]*|дн[а-яё]*|день|дня)?\.?$/i.test(line);
  const hasNumbers = extractPrices(text).length > 0 || textTerms(text).length > 0;
  return hasNumbers && lines.length > 0 && lines.length <= 3 && lines.every(statement);
}

// Сумма в реплике — предложение цены, а не «предоплату получил»: строка-
// заявление или слово о цене рядом.
function isPriceOffer(text, draft) {
  return isNumbersNote(text, draft) || /(?<![а-яё])(?:цен[аыуе]|стоимост|стои(?:т|ть)|обойд[её]тся|бюджет|итого|сделаю\s+за)/i.test(String(text || ''));
}

// Деньги в реплике про оплату («предоплату получил») — не отправка оценки,
// даже если остальные слова похожи на черновик.
function isPaymentNote(text, draft) {
  return draft.kind === 'price'
    && extractPrices(text).length > 0
    && !isPriceOffer(text, draft)
    && /(?<![а-яё])(?:(?:пред)?оплат|получил|поступил|перев[её]л|скинул)/i.test(String(text || ''));
}

// Отправка должна нести заметную часть черновика: «Спасибо за доступы» из
// начала длинного предложения с ценой его не подтверждает.
function coversDraft(sentText, draft, strict) {
  if (normalize(sentText) && normalize(sentText) === normalize(draft.body)) {
    return true;
  }

  if (!strict && draft.kind === 'price' && isPriceOffer(sentText, draft) && extractPrices(sentText).some((price) => draft.prices.includes(price))) {
    return true;
  }

  return !isPaymentNote(sentText, draft) && containment(draft.body, sentText) >= 0.3;
}

function clip(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

function describeNumbers(prices, terms) {
  const parts = [];
  if (prices?.length) {
    parts.push(prices.map((price) => `${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`).join(', '));
  }

  if (terms?.length) {
    parts.push(terms.map((term) => `${term} дн`).join(', '));
  }

  return parts.join(' / ');
}

function changedNumbers(label, proposed, sent, unit) {
  if (!sent.length || !proposed.length) {
    return null;
  }

  const same = sent.length === proposed.length && sent.every((value) => proposed.includes(value));
  return same ? null : `${label} ${proposed.join(', ')} → ${sent.join(', ')}${unit}`;
}

function draftDate(draft) {
  const date = new Date(draft.at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function draftWho(draft) {
  if (draft.kind === 'offer') {
    return `отклик${draft.projectId ? ` проект ${draft.projectId}` : ''} «${clip(draft.title, 80)}»`;
  }

  const who = draft.nicks.length ? draft.nicks.join(', ') : 'клиент не определён';
  return draft.order ? `${who} (${draft.order})` : who;
}

export function formatSentLine(draft, outcome) {
  const proposedNumbers = describeNumbers(draft.prices, draft.terms);
  const proposed = [proposedNumbers, draft.kind === 'price' ? null : `«${clip(draft.body, 160)}»`].filter(Boolean).join(' ');
  return `- ${draftDate(draft)} | ${draftWho(draft)} | предложено: ${proposed || '—'} | ${outcome} | session ${draft.session || '—'} | draft ${draft.id}`;
}

function outgoingMessages(record, from, until, claimed) {
  return (record?.messages || [])
    .filter((message) => !isClientMessage(message, record))
    .filter((message) => {
      const time = Date.parse(message.time);
      return time >= from && time <= until;
    })
    .filter((message) => !claimed.has(messageKey(record, message)));
}

function messageKey(record, message) {
  return `${record.key}:${message.id || message.time}`;
}

function windowMessages(record, from, until) {
  return (record?.messages || [])
    .filter((message) => {
      const time = Date.parse(message.time);
      return time >= from && time <= until;
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

// Полнота переписки на момент sync: при сорвавшемся проходе годится, только
// если сорвались другие диалоги, а не этот. slugs === null — клиент неизвестен,
// и любой недочитанный диалог может оказаться его.
function coverageFor(sync, slugs) {
  if (!sync?.at) {
    return 0;
  }

  // В pending и сорвавшиеся, и отложенные непрочитанные диалоги — даже при ok.
  const pendingList = Array.isArray(sync.pending) ? sync.pending : [];
  const pending = new Set(pendingList.map((key) => String(key).toLowerCase()));
  if (slugs === null ? pendingList.length > 0 : slugs.some((slug) => pending.has(slug.toLowerCase()))) {
    return 0;
  }

  if (sync.ok !== false) {
    return Date.parse(sync.at);
  }

  return Array.isArray(sync.pending) && slugs !== null && slugs.length > 0 ? Date.parse(sync.at) : 0;
}

function resolveMessageDraft(draft, dialogs, claimed, now, sync) {
  const at = Date.parse(draft.at);
  const strict = draft.nicks.length === 0;
  const pool = strict ? dialogs : dialogs.filter((item) => draft.nicks.includes(item.slug));

  for (const { record } of pool) {
    const sequence = windowMessages(record, at - EARLY_MS, at + MESSAGE_WINDOW_MS);
    for (let index = 0; index < sequence.length; index += 1) {
      const first = sequence[index];
      // Начать отправку может и короткое «Цена: 7 000 ₽» — но только в
      // диалоге клиента заказа: по всем диалогам сумма найдётся и у чужих.
      const numbersFirst = !strict && isNumbersNote(first.text, draft);
      if (isClientMessage(first, record) || claimed.has(messageKey(record, first)) || !(matchesDraft(first, draft, strict) || numbersFirst)) {
        continue;
      }

      // Черновик, разбитый на несколько сообщений, склеивается, пока не
      // ответил клиент: после его реплики идёт уже следующий черновик.
      const firstTime = Date.parse(first.time);
      const sent = [first];
      for (const next of sequence.slice(index + 1)) {
        if (isClientMessage(next, record) || Date.parse(next.time) - firstTime > FOLLOW_UP_MS) {
          break;
        }

        if (!claimed.has(messageKey(record, next)) && (matchesDraft(next, draft, strict) || isNumbersNote(next.text, draft))) {
          sent.push(next);
        }
      }

      const sentText = sent.map((message) => message.text).join('\n');
      const numbersOnly = sent.every((message) => isNumbersNote(message.text, draft));
      if (!(numbersOnly ? !strict : coversDraft(sentText, draft, strict))) {
        continue;
      }

      const verdict = normalize(sentText) === normalize(draft.body) ? 'дословно' : 'с правками';
      const notes = [
        changedNumbers('цена', draft.prices, extractPrices(sentText), ' ₽'),
        changedNumbers('срок', draft.terms, textTerms(sentText), ' дн'),
      ].filter(Boolean);
      const outcome = `отправлено ${formatMoment(first.time)} (авто): ${verdict}${notes.length ? `; ${notes.join('; ')}` : ''}${verdict === 'дословно' ? '' : ` «${clip(sentText, 300)}»`}`;

      return {
        line: formatSentLine(draft, outcome),
        claims: sent.map((message) => messageKey(record, message)),
      };
    }
  }

  // Не нашли — это ещё не «не отправлял»: решение только когда автовыгрузка
  // успешно прошла позже конца окна, то есть переписка за окно точно на диске.
  // Список берётся из черновика, а не из прочитанных файлов: отложенного
  // диалога может не быть на диске или среди свежих.
  const coverage = coverageFor(sync, strict ? null : draft.nicks);
  if (now - at <= MESSAGE_WINDOW_MS || !coverage || coverage < at + MESSAGE_WINDOW_MS) {
    return null;
  }

  // Журнал нужен оценке цен и сроков: черновик без чисел, который так и не
  // ушёл (или был рассуждением, похожим на черновик), просто снимается.
  if (!draft.prices?.length && !draft.terms?.length) {
    return { line: null, claims: [] };
  }

  const other = pool
    .flatMap(({ record }) => outgoingMessages(record, at - EARLY_MS, at + MESSAGE_WINDOW_MS, claimed))
    .slice(0, 2)
    .map((message) => `«${clip(message.text, 150)}»`);
  const outcome = `похожей отправки за 3 дня нет (авто)${other.length && !strict ? `; другие исходящие этому клиенту: ${other.join(', ')}` : ''}`;
  return { line: formatSentLine(draft, outcome), claims: [] };
}

function offerSignature(offer) {
  return `${offer.price ?? ''}|${offer.days ?? ''}|${offer.text ?? ''}`;
}

// Учтённой считается версия отклика, а не номер: отредактированный отклик —
// новая отправка.
function offerClaim(offer) {
  return `offer:${offer.offerId}:${createHash('sha1').update(offerSignature(offer)).digest('hex').slice(0, 10)}`;
}

// Снимок откликов на момент черновика: подтверждает его только отклик,
// который появился или изменился после, а не давний ответ на тот же проект.
export function offerBaseline(offersFile, projectId) {
  // Откликов с биржи ещё нет — прежнее состояние неизвестно, и любой
  // найденный потом отклик мог быть давним.
  if (!Array.isArray(offersFile?.offers)) {
    return { maxOfferId: null, project: null };
  }

  const offers = offersFile.offers;
  const current = projectId ? offers.find((offer) => offer.projectId === projectId) : null;
  return {
    maxOfferId: offers.reduce((max, offer) => Math.max(max, Number(offer.offerId) || 0), 0),
    project: current ? offerSignature(current) : null,
  };
}

function resolveOfferDraft(draft, offersFile, claimed, now) {
  const base = draft.offerBaseline;
  const comment = offerComment(draft.body);
  const offers = (offersFile?.offers || [])
    .filter((offer) => !claimed.has(offerClaim(offer)))
    .filter((offer) => !base || (base.maxOfferId !== null && (
      Number(offer.offerId) > base.maxOfferId
      || (draft.projectId && offer.projectId === draft.projectId && offerSignature(offer) !== base.project))));
  const match = draft.projectId
    ? offers.find((offer) => offer.projectId === draft.projectId)
    : offers.find((offer) => tokens(offer.text).length >= 5 && containment(offer.text, comment) >= 0.6);

  if (match) {
    const textVerdict = containment(match.text, comment) >= 0.98 && containment(comment, match.text) >= 0.9
      ? 'текст как предложен'
      : 'текст правился';
    const notes = [
      changedNumbers('цена', draft.prices, match.price ? [match.price] : [], ' ₽'),
      changedNumbers('срок', draft.terms, match.days ? [match.days] : [], ' дн'),
    ].filter(Boolean);
    const outcome = `отправлено (с биржи, авто): ${describeNumbers(match.price ? [match.price] : [], match.days ? [match.days] : [])}; ${textVerdict}${notes.length ? `; ${notes.join('; ')}` : ''}`;
    return { line: formatSentLine({ ...draft, projectId: draft.projectId || match.projectId }, outcome), claims: [offerClaim(match)] };
  }

  const at = Date.parse(draft.at);
  const coverage = offersFile?.updatedAt ? Date.parse(offersFile.updatedAt) : 0;
  if (now - at <= OFFER_WINDOW_MS || coverage < at + OFFER_WINDOW_MS) {
    return null;
  }

  // Без снимка «не отправлен» тоже не доказать: черновик снимается молча.
  if (base && base.maxOfferId === null) {
    return { line: null, claims: [] };
  }

  return { line: formatSentLine(draft, 'отклик за неделю не отправлен (авто)'), claims: [] };
}

export function resolveDrafts({ pending, dialogs, offersFile, sync, claimed, now }) {
  const results = [];
  const taken = new Set(claimed);

  for (const draft of [...pending].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    const result = draft.kind === 'offer'
      ? resolveOfferDraft(draft, offersFile, taken, now)
      : resolveMessageDraft(draft, dialogs, taken, now, sync);

    if (result) {
      result.claims.forEach((claim) => taken.add(claim));
      results.push({ draft, ...result });
    }
  }

  return results;
}

// ---------- файлы ----------

export function resolvePaths(options = {}) {
  const home = options.home || homedir();
  const dataDir = options.dataDir || join(home, '.claude', 'skills', 'estimate', 'data');
  const kworkRoot = options.kworkRoot || join(home, 'Projects', 'Kwork');
  return {
    home,
    kworkRoot,
    dataDir,
    pendingDir: join(dataDir, 'pending'),
    sentPath: join(dataDir, 'sent.md'),
    claimedPath: join(dataDir, 'sent-claimed.json'),
    lockDir: join(dataDir, '.sent-lock'),
    targetDir: options.targetDir || resolveChatsDir(kworkRoot),
    orderMapPath: options.orderMapPath || join(kworkRoot, 'docs', 'заказы-клиенты.md'),
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// Замок — папка: её создание атомарно. Чужой замок снимается, только если его
// процесс умер или он висит дольше пяти минут.
function acquireLock(lockDir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return false;
      }

      const owner = readJson(join(lockDir, 'owner.json'));
      let age = Infinity;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        // Замок исчез между проверками — попробуем ещё раз.
      }

      const dead = owner?.pid ? !isAlive(owner.pid) : age > 10 * 1000;
      if (!dead && age < LOCK_STALE_MS) {
        return false;
      }

      rmSync(lockDir, { recursive: true, force: true });
    }
  }

  return false;
}

function releaseLock(lockDir) {
  const owner = readJson(join(lockDir, 'owner.json'));
  if (owner?.pid === process.pid) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function contextFor(cwd, paths) {
  const context = resolveContext(normalizeWorkspace(cwd, paths.kworkRoot, paths.home), paths.kworkRoot);
  if (!context) {
    return null;
  }

  if (context.mode !== 'order' || !existsSync(paths.targetDir)) {
    return { order: null, nicks: [] };
  }

  const slugs = readdirSync(paths.targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return { order: context.order, nicks: findOrderNicks(context.orderDir, slugs, readOrderMap(paths.orderMapPath)) };
}

export function capture(input, options = {}) {
  const paths = resolvePaths(options);
  if (!input?.transcript_path || !existsSync(input.transcript_path)) {
    return [];
  }

  // Черновики ловятся только в чатах Kwork: у клиентов вне биржи нет переписки
  // на диске, и их черновики засоряли бы журнал оценок Kwork.
  const context = contextFor(input.cwd, paths);
  if (!context) {
    return [];
  }

  const turn = readLastTurn(readFileSync(input.transcript_path, 'utf8').split('\n'));
  const { order, nicks } = context;
  const drafts = buildPendingDrafts({ turn, sessionId: input.session_id, cwd: input.cwd, order, nicks });
  if (drafts.length === 0) {
    return [];
  }

  const offersFile = readJson(join(paths.targetDir, 'data', '_offers.json'));
  for (const draft of drafts.filter((item) => item.kind === 'offer')) {
    draft.offerBaseline = offerBaseline(offersFile, draft.projectId);
  }

  mkdirSync(paths.pendingDir, { recursive: true });
  const sent = existsSync(paths.sentPath) ? readFileSync(paths.sentPath, 'utf8') : '';
  const written = [];

  for (const draft of drafts) {
    if (sent.includes(`draft ${draft.id}`)) {
      continue;
    }

    try {
      writeFileSync(join(paths.pendingDir, `${draft.id}.json`), JSON.stringify(draft), { flag: 'wx' });
      written.push(draft);
    } catch {
      // Тот же ход уже записан прошлым срабатыванием Stop.
    }
  }

  return written;
}

function loadPending(pendingDir) {
  if (!existsSync(pendingDir)) {
    return [];
  }

  return readdirSync(pendingDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(join(pendingDir, name)))
    .filter((draft) => draft?.id && draft.at);
}

function loadDialogs(targetDir, pending) {
  if (!existsSync(targetDir)) {
    return [];
  }

  const wanted = new Set(pending.flatMap((draft) => draft.nicks || []));
  const anyone = pending.some((draft) => draft.kind !== 'offer' && !(draft.nicks || []).length);
  const since = Math.min(...pending.map((draft) => Date.parse(draft.at))) - EARLY_MS;

  return readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => {
      const filePath = join(targetDir, slug, core.DIALOG_DATA_NAME);
      if (!existsSync(filePath)) {
        return false;
      }

      return wanted.has(slug) || (anyone && statSync(filePath).mtimeMs >= since);
    })
    .map((slug) => ({ slug, record: readJson(join(targetDir, slug, core.DIALOG_DATA_NAME)) }))
    .filter((item) => item.record);
}

export function sync(options = {}) {
  const paths = resolvePaths(options);
  const now = options.now ?? Date.now();
  const pending = loadPending(paths.pendingDir);
  if (pending.length === 0 || !acquireLock(paths.lockDir)) {
    return [];
  }

  try {
    const claimedFile = readJson(paths.claimedPath) || { claims: [] };
    const results = resolveDrafts({
      pending: loadPending(paths.pendingDir),
      dialogs: loadDialogs(paths.targetDir, pending),
      offersFile: readJson(join(paths.targetDir, 'data', '_offers.json')),
      sync: readJson(join(paths.targetDir, 'data', '_sync.json')),
      claimed: claimedFile.claims || [],
      now,
    });

    for (const result of results) {
      // Сначала строка в журнале, потом удаление черновика: упадём между ними —
      // следующий запуск увидит метку draft в журнале и второй строки не допишет.
      const sent = existsSync(paths.sentPath) ? readFileSync(paths.sentPath, 'utf8') : '';
      if (result.line && !sent.includes(`draft ${result.draft.id}`)) {
        appendFileSync(paths.sentPath, `${sent.endsWith('\n') || !sent ? '' : '\n'}${result.line}\n`);
      }

      claimedFile.claims = [...new Set([...(claimedFile.claims || []), ...result.claims])].slice(-2000);
      writeFileSync(paths.claimedPath, JSON.stringify(claimedFile));
      rmSync(join(paths.pendingDir, `${result.draft.id}.json`), { force: true });
    }

    return results;
  } finally {
    releaseLock(paths.lockDir);
  }
}

export function listPending(options = {}) {
  return loadPending(resolvePaths(options).pendingDir);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'capture') {
      const input = JSON.parse(readStdin() || '{}');
      capture(input);
      sync();
    } else if (command === 'sync') {
      sync();
    }
  } catch {
    // Сверка — помощь, а не условие работы: при сбое молчим.
  }

  process.exit(0);
}
