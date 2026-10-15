// Общее для хука сводки (kwork-brief.mjs) и сверки черновиков (kwork-drafts.mjs):
// где лежат переписки, какой заказ открыт в чате, кто в переписке клиент.
// Отдельный модуль нужен, чтобы сводка звала сверку без циклического импорта.

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('../src/inbox-core.js');
const wakeCore = require('../native_host/wake-core.js');

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORDER_FILES = ['CLAUDE.md', 'AGENTS.md', 'ROADMAP.md', 'README.md', 'STATE.md'];
const ORDER_FILE_BYTES = 40 * 1024;
const INBOX_LINK = /kwork\.ru\/(?:new_)?inbox\/([A-Za-z0-9_.-]{2,40})/gi;

export function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Папка переписок — из настройки моста; KPH_CHATS_DIR подменяет её в тестах.
export function resolveChatsDir(kworkRoot) {
  if (process.env.KPH_CHATS_DIR) {
    return process.env.KPH_CHATS_DIR;
  }

  const config = readJson(join(projectRoot, 'native_host', 'bridge-config.json'));
  return config?.targetDir || join(kworkRoot, 'переписки');
}

// Чаты T3 и Claude Code работают в отдельных рабочих копиях: путь копии
// переводится обратно в папку Kwork, чтобы сводка нашла заказ и переписку.
export function normalizeWorkspace(cwd, kworkRoot, home = homedir()) {
  if (!cwd || !kworkRoot) {
    return cwd;
  }

  const current = resolve(cwd);
  const t3 = join(home, '.t3', 'worktrees');
  if (current.startsWith(`${t3}${sep}`)) {
    const [repo, , ...rest] = relative(t3, current).split(sep);
    if (repo === basename(kworkRoot)) {
      return join(kworkRoot, ...rest);
    }

    for (const folder of [wakeCore.ACTIVE_DIR, wakeCore.DONE_DIR]) {
      const orderDir = join(kworkRoot, folder, repo);
      if (existsSync(orderDir)) {
        return join(orderDir, ...rest);
      }
    }

    return cwd;
  }

  const claudeWorktrees = join(resolve(kworkRoot), '.claude', 'worktrees');
  if (current.startsWith(`${claudeWorktrees}${sep}`)) {
    const [, ...rest] = relative(claudeWorktrees, current).split(sep);
    return join(kworkRoot, ...rest);
  }

  return cwd;
}

export function resolveContext(cwd, kworkRoot) {
  if (!cwd || !kworkRoot) {
    return null;
  }

  const root = resolve(kworkRoot);
  const current = resolve(cwd);
  if (current === root) {
    return { mode: 'root' };
  }

  // Сданный заказ тоже заказ: прошлый клиент пишет туда же, где работали.
  for (const folder of [wakeCore.ACTIVE_DIR, wakeCore.DONE_DIR]) {
    const base = join(root, folder);
    if (current.startsWith(`${base}${sep}`)) {
      const name = relative(base, current).split(sep)[0];
      return name ? { mode: 'order', orderDir: join(base, name), order: name } : null;
    }
  }

  return null;
}

// Заказ связан с клиентом строкой в общем списке Kwork/docs/заказы-клиенты.md
// или ссылкой на переписку в файлах заказа. Ник сверяется со списком
// сохранённых переписок, поэтому опечатка или случайное слово клиента не породит.
export function readOrderMap(mapPath) {
  if (!mapPath || !existsSync(mapPath)) {
    return {};
  }

  const parsed = wakeCore.parseOrderMap(readFileSync(mapPath, 'utf8'));
  return Object.fromEntries(Object.entries(parsed).map(([order, item]) => [order, item.nicks]));
}

export function findOrderNicks(orderDir, knownSlugs, orderMap = {}) {
  const known = new Set(knownSlugs);
  const nicks = [];
  const add = (value) => {
    const slug = core.buildDialogSlug(value);
    if (slug && known.has(slug) && !nicks.includes(slug)) {
      nicks.push(slug);
    }
  };

  for (const nick of orderMap[orderDir.split(sep).pop()] || []) {
    add(nick);
  }

  for (const name of ORDER_FILES) {
    const filePath = join(orderDir, name);
    if (!existsSync(filePath)) {
      continue;
    }

    const text = readFileSync(filePath, 'utf8').slice(0, ORDER_FILE_BYTES);
    for (const match of text.matchAll(INBOX_LINK)) {
      add(match[1]);
    }
  }

  return nicks;
}

export const { isClientMessage } = wakeCore;

// Время по часам мака: так же его показывает Kwork в браузере пользователя.
const MOMENT_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatMoment(isoTime) {
  const date = new Date(isoTime);
  return Number.isNaN(date.getTime()) ? 'без даты' : MOMENT_FORMAT.format(date).replace(',', '');
}
