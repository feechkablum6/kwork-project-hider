// Отметка агента «ждём клиента»: node kwork-snooze.mjs <ключ маршрута из побудки> <24h|3d|время ISO>.
// Заявку подхватит будильщик (native_host/snooze.js); ответ клиента снимет отметку
// и разбудит агента.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChatsDir } from './kwork-shared.mjs';

const require = createRequire(import.meta.url);
const snooze = require('../native_host/snooze.js');
const { formatMoment } = require('../native_host/wake-core.js');

export function runSnooze(args, { home = homedir(), now = Date.now() } = {}) {
  const [key, term] = args;
  if (!key || !term) {
    return { code: 2, text: 'Нужно: node kwork-snooze.mjs <ключ маршрута из побудки> <24h|3d|время ISO>.' };
  }

  const until = snooze.parseSnoozeUntil(term, now);
  if (until === null) {
    return { code: 2, text: `Срок «${term}» не подходит: от минуты до ${snooze.MAX_SNOOZE_MS / 3600000} часов, например 24h, 3d или 2026-10-24T10:00:00+03:00.` };
  }

  const serviceDir = join(resolveChatsDir(join(home, 'Projects', 'Kwork')), 'data');
  snooze.writeRequest(serviceDir, { key, until, at: now });
  return { code: 0, text: `Отметка «ждём клиента» до ${formatMoment(new Date(until).toISOString())}. Ответ клиента снимет её раньше и разбудит агента.` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, text } = runSnooze(process.argv.slice(2));
  console.log(text);
  process.exit(code);
}
