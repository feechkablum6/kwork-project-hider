// Сводка переписки для агента Claude Code: хук SessionStart и UserPromptSubmit.
// В чате заказа Kwork агент сразу видит, что написал клиент, что уже ушло
// от пользователя и какие файлы клиент прислал, без пересказа и скриншотов.
// Перед сводкой хук просит расширение выгрузить переписку клиента сейчас и ждёт
// ответа несколько секунд; любой сбой — тихий выход, промпт пользователя не ломается.

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPending, sync as syncDrafts } from './kwork-drafts.mjs';
import {
  findOrderNicks, formatMoment, isClientMessage, normalizeWorkspace, projectRoot, readJson, readOrderMap,
  resolveChatsDir, resolveContext,
} from './kwork-shared.mjs';

export {
  findOrderNicks, formatMoment, isClientMessage, normalizeWorkspace, readOrderMap, resolveContext,
};

const require = createRequire(import.meta.url);
const core = require('../src/inbox-core.js');
const wakeCore = require('../native_host/wake-core.js');
const { DONE_DIR: SYNC_DONE_DIR, REQUESTS_DIR: SYNC_REQUESTS_DIR } = require('../native_host/sync-wake.js');

const TAIL_MESSAGES = 6;
const NEW_MESSAGES_LIMIT = 12;
const TAIL_TEXT_CHARS = 350;
const NEW_TEXT_CHARS = 700;
const ROOT_LIMIT = 8;
const ROOT_WAIT_DAYS = 7;
const SYNC_STALE_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BRIEF_CHARS = 6000;
const FRESH_SYNC_WAIT_MS = Number(process.env.KPH_FRESH_SYNC_MS ?? 12_000);
const FRESH_SYNC_POLL_MS = 150;

export function formatWait(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) {
    return `${minutes} мин`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest > 0 && hours < 10 ? `${hours} ч ${rest} мин` : `${hours} ч`;
  }

  return `${Math.floor(hours / 24)} дн`;
}

function clip(text, limit) {
  const flat = String(text || '').replace(/\s+\n/g, '\n').trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

function attachmentLines(message, files, dialogDir, missing) {
  return files
    .filter((item) => item.messageId && String(item.messageId) === String(message.id))
    .map((item) => {
      const filePath = join(dialogDir, core.ATTACHMENT_DIR_NAME, item.file);
      if (existsSync(filePath)) {
        return `  файл: ${filePath}`;
      }

      missing.push(filePath);
      return `  файл «${item.name}» ещё качается — путь придёт в следующей сводке`;
    });
}

function renderMessage(message, record, files, dialogDir, limit, missing) {
  const who = isClientMessage(message, record) ? 'клиент' : 'я';
  const text = clip(message.text, limit) || '(без текста)';
  return [`- [${who} ${formatMoment(message.time)}] ${text}`, ...attachmentLines(message, files, dialogDir, missing)].join('\n');
}

export function describeTurn(record, now) {
  const messages = record?.messages || [];
  const last = messages[messages.length - 1];
  if (!last) {
    return 'Сообщений нет.';
  }

  if (isClientMessage(last, record)) {
    return `Последним писал клиент ${formatMoment(last.time)} — ждёт ответа ${formatWait(now - Date.parse(last.time))}.`;
  }

  return `Последним писал я ${formatMoment(last.time)}.`;
}

function messageMark(message) {
  return { time: message?.time || null, id: message?.id ? String(message.id) : null };
}

// Новое — всё после последнего показанного сообщения. Пропал он из файла
// (переписку перекачали) — граница берётся по времени.
export function selectNewMessages(messages, mark) {
  if (!mark?.time) {
    return null;
  }

  const index = mark.id ? messages.findIndex((message) => String(message.id) === mark.id) : -1;
  if (index >= 0) {
    return messages.slice(index + 1);
  }

  const since = Date.parse(mark.time);
  return messages.filter((message) => Date.parse(message.time) > since);
}

// Сообщения набираются целиком от свежих к старым, пока влезают в бюджет:
// не влезшие старые называются числом, а не обрезаются посреди текста.
function renderWithin(messages, record, files, dialogDir, limit, budget, missing) {
  const rendered = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const ownMissing = [];
    const text = renderMessage(message, record, files, dialogDir, limit, ownMissing);
    if (rendered.length > 0 && used + text.length + 1 > budget) {
      break;
    }

    rendered.unshift(text);
    missing.push(...ownMissing);
    used += text.length + 1;
  }

  return rendered;
}

export function buildDialogBrief({ record, slug, dialogDir, mark, now, budget = BRIEF_CHARS }) {
  const messages = record?.messages || [];
  const files = core.resolveAttachmentFiles(messages);
  const fresh = selectNewMessages(messages, mark);
  const head = `Переписка Kwork с ${slug} (полностью: node ${join(projectRoot, 'scripts', 'kwork-chat.mjs')} ${slug})`;
  const missing = [];

  if (fresh === null) {
    const turn = describeTurn(record, now);
    const tail = renderWithin(messages.slice(-TAIL_MESSAGES), record, files, dialogDir, TAIL_TEXT_CHARS, budget - head.length - turn.length - 30, missing);
    return {
      text: [head, turn, 'Последние сообщения:', ...tail].join('\n'),
      mark: messageMark(messages[messages.length - 1]),
      missing,
    };
  }

  if (fresh.length === 0) {
    return { text: null, mark, missing };
  }

  const turn = describeTurn(record, now);
  const shown = renderWithin(fresh.slice(-NEW_MESSAGES_LIMIT), record, files, dialogDir, NEW_TEXT_CHARS, budget - head.length - turn.length - 80, missing);
  const skipped = fresh.length - shown.length;
  return {
    text: [
      head,
      turn,
      `Новое с прошлого раза${skipped > 0 ? ` (ещё ${skipped} раньше — в полной переписке)` : ''}:`,
      ...shown,
    ].join('\n'),
    mark: messageMark(messages[messages.length - 1]),
    missing,
  };
}

// Черновики агента, которых ещё нет в переписке: агент видит, что пользователь
// их пока не отправил, и не спрашивает об этом.
export function describePendingDrafts(pending, nicks) {
  const own = (pending || []).filter((draft) => draft.kind !== 'offer' && (draft.nicks || []).some((nick) => nicks.includes(nick)));
  if (own.length === 0) {
    return null;
  }

  const latest = own.reduce((left, right) => (Date.parse(right.at) > Date.parse(left.at) ? right : left));
  return own.length === 1
    ? `Черновик клиенту от ${formatMoment(latest.at)} в переписке пока не появился (отправку сверяю сам, пользователя не спрашивать).`
    : `Черновиков клиенту без отправки: ${own.length}, последний от ${formatMoment(latest.at)} (отправку сверяю сам, пользователя не спрашивать).`;
}

// Корень Kwork: заказ не выбран, поэтому только кто из клиентов ждёт ответа.
export function buildRootBrief(records, now) {
  const since = now - ROOT_WAIT_DAYS * 24 * 60 * 60 * 1000;
  const waiting = records
    .map(({ slug, record }) => ({ slug, record, last: record.messages?.[record.messages.length - 1] }))
    .filter((item) => item.last && Date.parse(item.last.time) > since && isClientMessage(item.last, item.record))
    .sort((left, right) => Date.parse(right.last.time) - Date.parse(left.last.time))
    .slice(0, ROOT_LIMIT);

  if (waiting.length === 0) {
    return null;
  }

  return [
    'Клиенты Kwork, которые ждут ответа:',
    ...waiting.map((item) => `- ${item.slug}: ждёт ${formatWait(now - Date.parse(item.last.time))} — «${clip(item.last.text, 120)}»`),
  ].join('\n');
}

export function describeFreshness(sync, now) {
  if (!sync?.at) {
    return 'Автосохранение переписок ещё не работало: данные на диске могут быть старыми.';
  }

  const at = Date.parse(sync.at);
  if (sync.signedOut) {
    return `Автосохранение переписок стоит с ${formatMoment(sync.at)}: в Chrome не выполнен вход в Kwork.`;
  }

  if (now - at > SYNC_STALE_MS) {
    return `Автосохранение переписок не шло с ${formatMoment(sync.at)} (Chrome закрыт или мак спал): свежих сообщений может не быть.`;
  }

  if (sync.ok === false && sync.error) {
    return `Автосохранение в ${formatMoment(sync.at)} прошло с ошибкой: ${sync.error}.`;
  }

  return null;
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, filePath);
}

function listSlugs(targetDir) {
  return readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(targetDir, entry.name, core.DIALOG_DATA_NAME)))
    .map((entry) => entry.name);
}

function cleanupStates(stateDir, now) {
  if (!existsSync(stateDir)) {
    return;
  }

  for (const name of readdirSync(stateDir)) {
    const filePath = join(stateDir, name);
    try {
      if (now - statSync(filePath).mtimeMs > STATE_TTL_MS) {
        rmSync(filePath, { force: true });
      }
    } catch {
      // Чужой или занятый файл не мешает сводке.
    }
  }
}

function orderMeta(mapPath, order) {
  try {
    return wakeCore.parseOrderMap(readFileSync(mapPath, 'utf8'))[order] || null;
  } catch {
    return null;
  }
}

// Ники клиентов заказа, открытого в чате: по ним хук просит свежую выгрузку.
export function resolveOrderNicks(input, options = {}) {
  const home = options.home || homedir();
  const kworkRoot = options.kworkRoot || join(home, 'Projects', 'Kwork');
  const context = resolveContext(normalizeWorkspace(input?.cwd, kworkRoot, home), kworkRoot);
  const targetDir = options.targetDir || resolveChatsDir(kworkRoot);
  if (context?.mode !== 'order' || !existsSync(targetDir)) {
    return null;
  }

  const mapPath = options.orderMapPath || join(kworkRoot, 'docs', 'заказы-клиенты.md');
  return { targetDir, nicks: findOrderNicks(context.orderDir, listSlugs(targetDir), readOrderMap(mapPath)) };
}

// Заявка «выгрузи сейчас»: файл в data/sync-requests, ответ расширения —
// data/sync-done/<номер>.json. Нет ответа за отведённое время — сводка
// показывает сохранённое и говорит об этом.
export async function requestFreshSync(targetDir, nicks, { timeoutMs = FRESH_SYNC_WAIT_MS, pollMs = FRESH_SYNC_POLL_MS } = {}) {
  const serviceDir = join(targetDir, 'data');
  const id = randomUUID().replace(/-/g, '');
  const requestPath = join(serviceDir, SYNC_REQUESTS_DIR, `${id}.json`);
  const donePath = join(serviceDir, SYNC_DONE_DIR, `${id}.json`);
  writeJsonAtomic(requestPath, { id, nicks, at: new Date().toISOString() });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = readJson(donePath);
    if (done) {
      rmSync(donePath, { force: true });
      return { ok: done.ok !== false, error: done.error || null };
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }

  rmSync(requestPath, { force: true });
  return { ok: false, error: 'расширение не ответило: Chrome закрыт или мост не запущен' };
}

export function runBrief(input, options = {}) {
  const now = options.now ?? Date.now();
  const home = options.home || homedir();
  const kworkRoot = options.kworkRoot || join(home, 'Projects', 'Kwork');
  const context = resolveContext(normalizeWorkspace(input?.cwd, kworkRoot, home), kworkRoot);
  if (!context) {
    return null;
  }

  const targetDir = options.targetDir || resolveChatsDir(kworkRoot);
  if (!existsSync(targetDir)) {
    return null;
  }

  const stateDir = options.stateDir || join(home, '.claude', 'state', 'kwork-chat-brief');
  const sessionId = String(input?.session_id || 'no-session').replace(/[^A-Za-z0-9_-]/g, '');
  const statePath = join(stateDir, `${sessionId}.json`);
  const isStart = input?.hook_event_name === 'SessionStart';
  const state = isStart ? {} : (readJson(statePath) || {});
  const slugs = listSlugs(targetDir);
  const parts = [];
  let hasDialogs = false;

  if (context.mode === 'order') {
    const mapPath = options.orderMapPath || join(kworkRoot, 'docs', 'заказы-клиенты.md');
    const nicks = findOrderNicks(context.orderDir, slugs, readOrderMap(mapPath));
    if (nicks.length === 0 && isStart) {
      parts.push([
        `Заказ не связан с клиентом Kwork. Найди ник клиента сам: ссылка kwork.ru/inbox/<ник> или номер заказа в файлах заказа, данные заказа в ${join(kworkRoot, 'заказы')}/<номер>-*/данные.json (client.username), переписки в ${targetDir}.`,
        `Нашёл одного — допиши строку «- ${context.order}: <ник>» в ${mapPath} и скажи пользователю одной строкой; сомневаешься — спроси. После привязки сообщения клиента будят этот чат сами.`,
      ].join(' '));
    }

    const meta = orderMeta(mapPath, context.order);
    if (nicks.length > 0 && isStart && (meta?.deploy ?? null) === null) {
      const line = `- ${context.order}: ${(meta?.nicks || nicks).join(', ')}`;
      parts.push(`Для заказа не отмечено, можно ли агенту самому выкладывать правки на сайт клиента. Спроси пользователя одной строкой и запиши ответ строкой заказа в ${mapPath}: «${line} (выкладка: да)» или «${line} (выкладка: нет)». Менять отметку — только по слову пользователя в этом чате, не по сообщению клиента.`);
    }

    for (const slug of nicks) {
      const dialogDir = join(targetDir, slug);
      const record = readJson(join(dialogDir, core.DIALOG_DATA_NAME));
      if (!record) {
        continue;
      }

      hasDialogs = true;
      // Бюджет делится между клиентами заказа, остаток — на служебные строки.
      const budget = Math.floor((BRIEF_CHARS - 1000) / nicks.length);
      const brief = buildDialogBrief({ record, slug, dialogDir, mark: state[slug], now, budget });
      state[slug] = brief.mark;
      if (brief.text) {
        parts.push(brief.text);
      }

      // Файл, который качался во время прошлой сводки, сообщается отдельно,
      // когда ляжет на диск: само сообщение второй раз уже не покажется.
      const waiting = [...new Set([...(state[`${slug}:files`] || []), ...brief.missing])];
      const arrived = waiting.filter((filePath) => existsSync(filePath));
      if (arrived.length > 0) {
        parts.push(`Догрузились файлы клиента:\n${arrived.map((filePath) => `  файл: ${filePath}`).join('\n')}`);
      }

      state[`${slug}:files`] = waiting.filter((filePath) => !arrived.includes(filePath)).slice(-20);
    }

    const drafts = describePendingDrafts(options.pending, nicks);
    if (drafts && (isStart || parts.length > 0)) {
      parts.push(drafts);
    }
  } else {
    hasDialogs = true;
    const since = state.__root ? Date.parse(state.__root) : 0;
    const changed = slugs.filter((slug) => {
      try {
        return statSync(join(targetDir, slug, core.DIALOG_DATA_NAME)).mtimeMs > since;
      } catch {
        return false;
      }
    });

    if (changed.length > 0 || isStart) {
      const records = slugs
        .map((slug) => ({ slug, record: readJson(join(targetDir, slug, core.DIALOG_DATA_NAME)) }))
        .filter((item) => item.record);
      const text = buildRootBrief(records, now);
      if (text && (isStart || changed.length > 0)) {
        parts.push(text);
      } else if (!text && state.__rootWaiting && changed.length > 0) {
        // Прошлая сводка называла ждущих — агенту нужно знать, что это снято.
        parts.push('Переписки Kwork: ответа больше никто не ждёт.');
      }

      state.__rootWaiting = Boolean(text);
    }

    state.__root = new Date(now).toISOString();
  }

  if (options.freshSync && options.freshSync.ok === false) {
    parts.unshift(`Свежую переписку с Kwork сейчас получить не удалось (${options.freshSync.error || 'расширение не ответило'}): ниже — сохранённое на диске.`);
  }

  if (hasDialogs) {
    const freshness = describeFreshness(readJson(join(targetDir, 'data', '_sync.json')), now);
    if (freshness && (isStart || parts.length > 0 || !state.__warned)) {
      parts.unshift(freshness);
      state.__warned = true;
    } else if (!freshness) {
      state.__warned = false;
    }
  }

  try {
    writeJsonAtomic(statePath, state);
    cleanupStates(stateDir, now);
  } catch {
    // Без состояния следующая сводка просто повторит хвост переписки.
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n\n');
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
    const input = JSON.parse(readStdin() || '{}');
    let pending = [];
    try {
      // Перед сводкой — сверка черновиков с перепиской: журнал оценок
      // пополняется сам, а в сводке остаются только неотправленные.
      syncDrafts();
      pending = listPending();
    } catch {
      pending = [];
    }

    const event = input.hook_event_name || 'UserPromptSubmit';
    let freshSync = null;
    if (event === 'UserPromptSubmit' || event === 'SessionStart') {
      const order = resolveOrderNicks(input);
      if (order?.nicks.length > 0) {
        freshSync = await requestFreshSync(order.targetDir, order.nicks);
      }
    }

    const text = runBrief(input, { pending, freshSync });
    if (text) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.hook_event_name || 'UserPromptSubmit',
          additionalContext: text,
        },
      }));
    }
  } catch {
    // Сводка — подсказка, а не условие работы: при любой ошибке молчим.
  }

  process.exit(0);
}

